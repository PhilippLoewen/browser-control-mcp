import { MessageHandler } from "../message-handler";
import { WebsocketClient } from "../client";
import { TstClient } from "../tst-client";
import { WriteLock } from "../write-lock";
import type { ServerMessageRequest } from "@browser-control-mcp/common";
import { ExtensionConfig } from "../extension-config";
import { grantCaptureConsent, revokeCaptureConsent } from "../capture-consent";

// Mock the WebsocketClient
jest.mock("../client", () => {
  return {
    WebsocketClient: jest.fn().mockImplementation(() => {
      return {
        sendResourceToServer: jest.fn().mockResolvedValue(undefined),
        sendErrorToServer: jest.fn().mockResolvedValue(undefined),
      };
    }),
  };
});

// Mock the TstClient so tests can control whether Tree Style Tab is
// available and what its commands return.
jest.mock("../tst-client", () => {
  const mockTstClient = {
    isAvailable: jest.fn(),
    getLightTree: jest.fn(),
    createGroup: jest.fn(),
    collapseTree: jest.fn(),
    moveTabToStart: jest.fn(),
    moveTabAfter: jest.fn(),
    removeTabsKeepingChildren: jest.fn(),
    attachTabToParent: jest.fn(),
    detachTab: jest.fn(),
  };
  return {
    __esModule: true,
    TST_ADDON_ID: "treestyletab@piro.sakura.ne.jp",
    TstClient: jest.fn().mockImplementation(() => mockTstClient),
  };
});

interface MockTstClient {
  isAvailable: jest.Mock;
  getLightTree: jest.Mock;
  createGroup: jest.Mock;
  collapseTree: jest.Mock;
  moveTabToStart: jest.Mock;
  moveTabAfter: jest.Mock;
  removeTabsKeepingChildren: jest.Mock;
  attachTabToParent: jest.Mock;
  detachTab: jest.Mock;
}

/** A promise together with the function that resolves it. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Flush pending microtasks so queued async steps can run. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    await Promise.resolve();
  }
}

/**
 * Mock browser.tabs.reload so that the most recently registered
 * onUpdated listener is immediately notified of a load "complete",
 * the way a reloaded discarded tab reports it.
 */
function mockReloadCompletingLoad(tabId: number): void {
  (browser.tabs.reload as jest.Mock).mockImplementation(() => {
    const listeners = (
      browser.tabs.onUpdated.addListener as jest.Mock
    ).mock.calls;
    const listener = listeners[listeners.length - 1][0];
    listener(tabId, { status: "complete" });
    return Promise.resolve();
  });
}

describe("MessageHandler", () => {
  let messageHandler: MessageHandler;
  let mockClient: jest.Mocked<WebsocketClient>;
  let mockTst: MockTstClient;
  let tstHandler: MessageHandler;

  beforeEach(() => {
    // Clear all mocks before each test
    jest.clearAllMocks();

    // Create a new instance of WebsocketClient and MessageHandler
    mockClient = new WebsocketClient(
      8080,
      "test-secret"
    ) as jest.Mocked<WebsocketClient>;
    messageHandler = new MessageHandler(mockClient);

    // A second handler with a Tree Style Tab client. TST is unavailable by
    // default; the Tree Style Tab tests enable it explicitly.
    mockTst = new TstClient(async () => true) as unknown as MockTstClient;
    mockTst.isAvailable.mockReturnValue(false);
    mockTst.getLightTree.mockResolvedValue([]);
    mockTst.createGroup.mockResolvedValue(null);
    mockTst.collapseTree.mockResolvedValue(true);
    mockTst.moveTabToStart.mockResolvedValue(true);
    mockTst.moveTabAfter.mockResolvedValue(true);
    mockTst.removeTabsKeepingChildren.mockResolvedValue(true);
    mockTst.attachTabToParent.mockResolvedValue(true);
    mockTst.detachTab.mockResolvedValue(true);
    tstHandler = new MessageHandler(
      mockClient,
      mockTst as unknown as TstClient
    );

    // Mock browser.storage.local.get to return default config
    const defaultConfig: ExtensionConfig = {
      secret: "test-secret",
      toolSettings: {
        "open-browser-tab": true,
        "close-browser-tabs": true,
        "get-list-of-open-tabs": true,
        "get-recent-browser-history": true,
        "get-tab-web-content": true,
        "reorder-browser-tabs": true,
        "find-highlight-in-browser-tab": true,
      },
      domainDenyList: [],
      ports: [8089],
      auditLog: [],
    };

    (browser.storage.local.get as jest.Mock).mockResolvedValue({
      config: defaultConfig,
    });
  });

  describe("handleDecodedMessage", () => {
    it("should throw an error if command is not allowed", async () => {
      // Arrange
      const configWithDisabledOpenTab: ExtensionConfig = {
        secret: "test-secret",
        toolSettings: {
          "open-browser-tab": false, // Disable open-tab command
          "close-browser-tabs": true,
          "get-list-of-open-tabs": true,
          "get-recent-browser-history": true,
          "get-tab-web-content": true,
          "reorder-browser-tabs": true,
          "find-highlight-in-browser-tab": true,
        },
        domainDenyList: [],
        ports: [8089],
        auditLog: [],
      };
      (browser.storage.local.get as jest.Mock).mockResolvedValue({
        config: configWithDisabledOpenTab,
      });

      const request: ServerMessageRequest = {
        cmd: "open-tab",
        url: "https://example.com",
        correlationId: "test-correlation-id",
      };

      // Act & Assert
      await expect(
        messageHandler.handleDecodedMessage(request)
      ).rejects.toThrow("Command 'open-tab' is disabled in extension settings");
    });

    describe("open-tab command", () => {
      it("should open a new tab and send the tab ID to the server", async () => {
        // Arrange
        const request: ServerMessageRequest = {
          cmd: "open-tab",
          url: "https://example.com",
          correlationId: "test-correlation-id",
        };

        const mockTab = { id: 123 };
        (browser.tabs.create as jest.Mock).mockResolvedValue(mockTab);

        // Act
        await messageHandler.handleDecodedMessage(request);

        // Assert
        expect(browser.tabs.create).toHaveBeenCalledWith({
          url: "https://example.com",
        });
        expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
          resource: "opened-tab-id",
          correlationId: "test-correlation-id",
          tabId: 123,
        });
      });

      it("should throw an error if URL does not start with https://", async () => {
        // Arrange
        const request: ServerMessageRequest = {
          cmd: "open-tab",
          url: "http://example.com",
          correlationId: "test-correlation-id",
        };

        // Act & Assert
        await expect(
          messageHandler.handleDecodedMessage(request)
        ).rejects.toThrow("Invalid URL");
        expect(browser.tabs.create).not.toHaveBeenCalled();
      });

      it("should throw an error if domain is in deny list", async () => {
        // Arrange
        const configWithDenyList: ExtensionConfig = {
          secret: "test-secret",
          toolSettings: {
            "open-browser-tab": true,
            "close-browser-tabs": true,
            "get-list-of-open-tabs": true,
            "get-recent-browser-history": true,
            "get-tab-web-content": true,
            "reorder-browser-tabs": true,
            "find-highlight-in-browser-tab": true,
          },
          domainDenyList: ["example.com", "another.com"],
          ports: [8089],
          auditLog: [],
        };
        (browser.storage.local.get as jest.Mock).mockResolvedValue({
          config: configWithDenyList,
        });

        const request: ServerMessageRequest = {
          cmd: "open-tab",
          url: "https://example.com",
          correlationId: "test-correlation-id",
        };

        // Act & Assert
        await expect(
          messageHandler.handleDecodedMessage(request)
        ).rejects.toThrow("Domain in user defined deny list");
        expect(browser.tabs.create).not.toHaveBeenCalled();
      });

      it("should open a new tab in the domain is not in the deny list", async () => {
        // Arrange
        const configWithDenyList: ExtensionConfig = {
          secret: "test-secret",
          toolSettings: {
            "open-browser-tab": true,
            "close-browser-tabs": true,
            "get-list-of-open-tabs": true,
            "get-recent-browser-history": true,
            "get-tab-web-content": true,
            "reorder-browser-tabs": true,
            "find-highlight-in-browser-tab": true,
          },
          domainDenyList: ["example.com", "another.com"],
          ports: [8089],
          auditLog: [],
        };
        (browser.storage.local.get as jest.Mock).mockResolvedValue({
          config: configWithDenyList,
        });

        const request: ServerMessageRequest = {
          cmd: "open-tab",
          url: "https://allowed.com",
          correlationId: "test-correlation-id",
        };

        const mockTab = { id: 123 };
        (browser.tabs.create as jest.Mock).mockResolvedValue(mockTab);

        // Act
        await messageHandler.handleDecodedMessage(request);

        // Assert
        expect(browser.tabs.create).toHaveBeenCalledWith({
          url: "https://allowed.com",
        });
        expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
          resource: "opened-tab-id",
          correlationId: "test-correlation-id",
          tabId: 123,
        });
      });
    });

    describe("close-tabs command", () => {
      it("should close tabs and send confirmation to the server", async () => {
        // Arrange
        const request: ServerMessageRequest = {
          cmd: "close-tabs",
          tabIds: [123, 456],
          correlationId: "test-correlation-id",
        };

        (browser.tabs.remove as jest.Mock).mockResolvedValue(undefined);

        // Act
        await messageHandler.handleDecodedMessage(request);

        // Assert
        expect(browser.tabs.remove).toHaveBeenCalledWith([123, 456]);
        expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
          resource: "tabs-closed",
          correlationId: "test-correlation-id",
        });
      });
    });

    describe("get-tab-list command", () => {
      it("should get tabs and send them to the server", async () => {
        // Arrange
        const request: ServerMessageRequest = {
          cmd: "get-tab-list",
          correlationId: "test-correlation-id",
        };

        // A discarded (unloaded) tab is listed like any other; the flag
        // flows through to the server untouched.
        const mockTabs = [
          { id: 123, url: "https://example.com", discarded: true },
        ];
        (browser.tabs.query as jest.Mock).mockResolvedValue(mockTabs);

        // Act
        await messageHandler.handleDecodedMessage(request);

        // Assert
        expect(browser.tabs.query).toHaveBeenCalledWith({});
        expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
          resource: "tabs",
          correlationId: "test-correlation-id",
          tabs: mockTabs,
        });
      });
    });

    describe("get-browser-recent-history command", () => {
      it("should get history items and send them to the server", async () => {
        // Arrange
        const request: ServerMessageRequest = {
          cmd: "get-browser-recent-history",
          searchQuery: "test",
          correlationId: "test-correlation-id",
        };

        const mockHistoryItems = [
          { url: "https://example.com", title: "Example" },
          { url: "https://test.com", title: "Test" },
        ];
        (browser.history.search as jest.Mock).mockResolvedValue(
          mockHistoryItems
        );

        // Act
        await messageHandler.handleDecodedMessage(request);

        // Assert
        expect(browser.history.search).toHaveBeenCalledWith({
          text: "test",
          maxResults: 200,
          startTime: 0,
        });
        expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
          resource: "history",
          correlationId: "test-correlation-id",
          historyItems: mockHistoryItems,
        });
      });

      it("should use empty string for search query if not provided", async () => {
        // Arrange
        const request: ServerMessageRequest = {
          cmd: "get-browser-recent-history",
          correlationId: "test-correlation-id",
        };

        const mockHistoryItems = [
          { url: "https://example.com", title: "Example" },
        ];
        (browser.history.search as jest.Mock).mockResolvedValue(
          mockHistoryItems
        );

        // Act
        await messageHandler.handleDecodedMessage(request);

        // Assert
        expect(browser.history.search).toHaveBeenCalledWith({
          text: "",
          maxResults: 200,
          startTime: 0,
        });
      });

      it("should filter out history items without URLs", async () => {
        // Arrange
        const request: ServerMessageRequest = {
          cmd: "get-browser-recent-history",
          correlationId: "test-correlation-id",
        };

        const mockHistoryItems = [
          { url: "https://example.com", title: "Example" },
          { title: "No URL" }, // This should be filtered out
        ];
        (browser.history.search as jest.Mock).mockResolvedValue(
          mockHistoryItems
        );

        // Act
        await messageHandler.handleDecodedMessage(request);

        // Assert
        expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
          resource: "history",
          correlationId: "test-correlation-id",
          historyItems: [{ url: "https://example.com", title: "Example" }],
        });
      });
    });

    describe("get-tab-content command", () => {
      it("should get tab content and send it to the server", async () => {
        // Arrange
        const request: ServerMessageRequest = {
          cmd: "get-tab-content",
          tabId: 123,
          correlationId: "test-correlation-id",
        };

        const mockTab = { id: 123, url: "https://example.com" };
        (browser.tabs.get as jest.Mock).mockResolvedValue(mockTab);
        (browser.permissions.contains as jest.Mock).mockResolvedValue(true);

        const mockScriptResult = [
          {
            links: [{ url: "https://example.com/page", text: "Page" }],
            fullText: "Page content",
            isTruncated: false,
            totalLength: 12,
          },
        ];
        (browser.tabs.executeScript as jest.Mock).mockResolvedValue(
          mockScriptResult
        );

        // Act
        await messageHandler.handleDecodedMessage(request);

        // Assert
        expect(browser.tabs.get).toHaveBeenCalledWith(123);
        expect(browser.permissions.contains).toHaveBeenCalledWith({
          origins: ["https://example.com/*"],
        });
        expect(browser.tabs.executeScript).toHaveBeenCalled();
        expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
          resource: "tab-content",
          tabId: 123,
          correlationId: "test-correlation-id",
          isTruncated: false,
          fullText: "Page content",
          links: [{ url: "https://example.com/page", text: "Page" }],
          totalLength: 12,
        });
        expect(browser.tabs.reload).not.toHaveBeenCalled();
      });

      it("should reload a discarded tab before fetching its content and report it", async () => {
        // Arrange
        const request: ServerMessageRequest = {
          cmd: "get-tab-content",
          tabId: 123,
          correlationId: "test-correlation-id",
        };

        const mockTab = {
          id: 123,
          url: "https://example.com",
          discarded: true,
          status: "complete",
        };
        (browser.tabs.get as jest.Mock).mockResolvedValue(mockTab);
        (browser.permissions.contains as jest.Mock).mockResolvedValue(true);

        const mockScriptResult = [
          {
            links: [{ url: "https://example.com/page", text: "Page" }],
            fullText: "Page content",
            isTruncated: false,
            totalLength: 12,
          },
        ];
        (browser.tabs.executeScript as jest.Mock).mockResolvedValue(
          mockScriptResult
        );
        mockReloadCompletingLoad(123);

        // Act
        await messageHandler.handleDecodedMessage(request);

        // Assert
        expect(browser.tabs.reload).toHaveBeenCalledWith(123);
        expect(browser.tabs.executeScript).toHaveBeenCalled();
        expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
          resource: "tab-content",
          tabId: 123,
          correlationId: "test-correlation-id",
          isTruncated: false,
          fullText: "Page content",
          links: [{ url: "https://example.com/page", text: "Page" }],
          totalLength: 12,
          loaded: true,
        });
      });

      it("should retry a script injection rejected with the transient host permission error", async () => {
        // Arrange
        const request: ServerMessageRequest = {
          cmd: "get-tab-content",
          tabId: 123,
          correlationId: "test-correlation-id",
        };

        const mockTab = {
          id: 123,
          url: "https://example.com",
          discarded: true,
          status: "complete",
        };
        (browser.tabs.get as jest.Mock).mockResolvedValue(mockTab);
        (browser.permissions.contains as jest.Mock).mockResolvedValue(true);

        const mockScriptResult = [
          {
            links: [{ url: "https://example.com/page", text: "Page" }],
            fullText: "Page content",
            isTruncated: false,
            totalLength: 12,
          },
        ];
        // The first injection fails with Firefox's generic error for the
        // navigation race (bug 2047009); the retry succeeds.
        (browser.tabs.executeScript as jest.Mock)
          .mockRejectedValueOnce(
            new Error("Missing host permission for the tab or frames")
          )
          .mockResolvedValue(mockScriptResult);
        mockReloadCompletingLoad(123);

        // Act
        await messageHandler.handleDecodedMessage(request);

        // Assert
        expect(browser.tabs.executeScript).toHaveBeenCalledTimes(2);
        expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
          resource: "tab-content",
          tabId: 123,
          correlationId: "test-correlation-id",
          isTruncated: false,
          fullText: "Page content",
          links: [{ url: "https://example.com/page", text: "Page" }],
          totalLength: 12,
          loaded: true,
        });
      });

      it("should re-check the settled URL permissions after the script injection retries are exhausted", async () => {
        // Arrange
        const request: ServerMessageRequest = {
          cmd: "get-tab-content",
          tabId: 123,
          correlationId: "test-correlation-id",
        };

        const mockTab = {
          id: 123,
          url: "https://example.com",
          discarded: true,
          status: "complete",
        };
        (browser.tabs.get as jest.Mock).mockResolvedValue(mockTab);
        (browser.permissions.contains as jest.Mock).mockResolvedValue(true);
        (browser.tabs.executeScript as jest.Mock).mockRejectedValue(
          new Error("Missing host permission for the tab or frames")
        );
        mockReloadCompletingLoad(123);

        // Act & Assert
        await expect(
          messageHandler.handleDecodedMessage(request)
        ).rejects.toThrow("Missing host permission for the tab or frames");
        // Initial attempt plus the four backoff retries.
        expect(browser.tabs.executeScript).toHaveBeenCalledTimes(5);
        // Pre-reload check plus the re-check against the settled URL.
        expect(browser.permissions.contains).toHaveBeenCalledTimes(2);
      }, 15000);

      it("should not retry a script injection error that is not the host permission race", async () => {
        // Arrange
        const request: ServerMessageRequest = {
          cmd: "get-tab-content",
          tabId: 123,
          correlationId: "test-correlation-id",
        };

        const mockTab = {
          id: 123,
          url: "https://example.com",
          discarded: true,
          status: "complete",
        };
        (browser.tabs.get as jest.Mock).mockResolvedValue(mockTab);
        (browser.permissions.contains as jest.Mock).mockResolvedValue(true);
        (browser.tabs.executeScript as jest.Mock).mockRejectedValue(
          new Error(
            "Could not establish connection. Receiving end does not exist."
          )
        );
        mockReloadCompletingLoad(123);

        // Act & Assert
        await expect(
          messageHandler.handleDecodedMessage(request)
        ).rejects.toThrow(
          "Could not establish connection. Receiving end does not exist."
        );
        expect(browser.tabs.executeScript).toHaveBeenCalledTimes(1);
      });

      it("should reload a discarded tab before requesting permission for an ungranted domain", async () => {
        // Arrange
        const request: ServerMessageRequest = {
          cmd: "get-tab-content",
          tabId: 123,
          correlationId: "test-correlation-id",
        };

        const mockTab = {
          id: 123,
          url: "https://example.com",
          discarded: true,
          status: "complete",
        };
        (browser.tabs.get as jest.Mock).mockResolvedValue(mockTab);
        // The domain has not been granted yet, so the permission check
        // opens the options dialog and fails.
        (browser.permissions.contains as jest.Mock).mockResolvedValue(false);
        mockReloadCompletingLoad(123);

        // Act & Assert
        // Reloading does not require the domain's permission, so the tab
        // is reloaded first; the request fails only at the permission
        // check and the extraction script never runs.
        await expect(
          messageHandler.handleDecodedMessage(request)
        ).rejects.toThrow("has not yet granted permission");
        expect(browser.tabs.reload).toHaveBeenCalledWith(123);
        expect(browser.permissions.contains).toHaveBeenCalledTimes(1);
        expect(browser.tabs.executeScript).not.toHaveBeenCalled();
        expect(mockClient.sendResourceToServer).not.toHaveBeenCalled();
      });

      it("should reject a discarded tab that settles on a deny-listed domain after reload", async () => {
        // Arrange
        const configWithDenyList: ExtensionConfig = {
          secret: "test-secret",
          toolSettings: {
            "open-browser-tab": true,
            "close-browser-tabs": true,
            "get-list-of-open-tabs": true,
            "get-recent-browser-history": true,
            "get-tab-web-content": true,
            "reorder-browser-tabs": true,
            "find-highlight-in-browser-tab": true,
          },
          domainDenyList: ["denied.example.com"],
          ports: [8089],
          auditLog: [],
        };
        (browser.storage.local.get as jest.Mock).mockResolvedValue({
          config: configWithDenyList,
        });

        const request: ServerMessageRequest = {
          cmd: "get-tab-content",
          tabId: 123,
          correlationId: "test-correlation-id",
        };

        const preReloadTab = {
          id: 123,
          url: "https://ok.example.com",
          discarded: true,
          status: "complete",
        };
        const settledTab = {
          id: 123,
          url: "https://denied.example.com",
          discarded: false,
          status: "complete",
        };
        // The audit log fetches the tab before the handler does, so the
        // first two gets still return the pre-reload tab.
        (browser.tabs.get as jest.Mock)
          .mockResolvedValueOnce(preReloadTab)
          .mockResolvedValueOnce(preReloadTab)
          .mockResolvedValue(settledTab);
        mockReloadCompletingLoad(123);

        // Act & Assert
        await expect(
          messageHandler.handleDecodedMessage(request)
        ).rejects.toThrow("Domain in tab URL is in the deny list");
        expect(browser.tabs.reload).toHaveBeenCalledWith(123);
        expect(browser.permissions.contains).not.toHaveBeenCalled();
        expect(browser.tabs.executeScript).not.toHaveBeenCalled();
      });

      it("should throw an error if tab URL domain is in deny list", async () => {
        // Arrange
        const configWithDenyList: ExtensionConfig = {
          secret: "test-secret",
          toolSettings: {
            "open-browser-tab": true,
            "close-browser-tabs": true,
            "get-list-of-open-tabs": true,
            "get-recent-browser-history": true,
            "get-tab-web-content": true,
            "reorder-browser-tabs": true,
            "find-highlight-in-browser-tab": true,
          },
          domainDenyList: ["example.com"], // Add example.com to deny list
          ports: [8089],
          auditLog: [],
        };
        (browser.storage.local.get as jest.Mock).mockResolvedValue({
          config: configWithDenyList,
        });

        const request: ServerMessageRequest = {
          cmd: "get-tab-content",
          tabId: 123,
          correlationId: "test-correlation-id",
        };

        const mockTab = { id: 123, url: "https://example.com" };
        (browser.tabs.get as jest.Mock).mockResolvedValue(mockTab);

        // Act & Assert
        await expect(
          messageHandler.handleDecodedMessage(request)
        ).rejects.toThrow("Domain in tab URL is in the deny list");
        expect(browser.tabs.executeScript).not.toHaveBeenCalled();
      });

      it("should throw an error if permissions are denied", async () => {
        // Arrange
        const request: ServerMessageRequest = {
          cmd: "get-tab-content",
          tabId: 123,
          correlationId: "test-correlation-id",
        };

        const mockTab = { id: 123, url: "https://example.com" };
        (browser.tabs.get as jest.Mock).mockResolvedValue(mockTab);
        (browser.permissions.contains as jest.Mock).mockResolvedValue(false);

        // Act & Assert
        await expect(
          messageHandler.handleDecodedMessage(request)
        ).rejects.toThrow();
        expect(browser.tabs.executeScript).not.toHaveBeenCalled();
      });
    });

    describe("load-tab command", () => {
      it("should reload a discarded tab and confirm once it has loaded", async () => {
        // Arrange
        const request: ServerMessageRequest = {
          cmd: "load-tab",
          tabId: 123,
          correlationId: "test-correlation-id",
        };

        const mockTab = {
          id: 123,
          url: "https://example.com",
          discarded: true,
          status: "complete",
        };
        (browser.tabs.get as jest.Mock).mockResolvedValue(mockTab);
        mockReloadCompletingLoad(123);

        // Act
        await messageHandler.handleDecodedMessage(request);

        // Assert
        expect(browser.tabs.reload).toHaveBeenCalledWith(123);
        expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
          resource: "tab-loaded",
          correlationId: "test-correlation-id",
          tabId: 123,
        });
      });

      it("should wait for the tab URL to settle after reloading a discarded tab", async () => {
        // Arrange
        const request: ServerMessageRequest = {
          cmd: "load-tab",
          tabId: 123,
          correlationId: "test-correlation-id",
        };

        const discardedTab = {
          id: 123,
          url: "https://example.com",
          discarded: true,
        };
        const transitionalTab = {
          id: 123,
          url: "about:blank",
          discarded: false,
          status: "complete",
        };
        const settledTab = {
          id: 123,
          url: "https://example.com",
          discarded: false,
          status: "complete",
        };
        // The audit log fetches the tab before the handler does, so the
        // first get returns the discarded tab as well.
        (browser.tabs.get as jest.Mock)
          .mockResolvedValueOnce(discardedTab)
          .mockResolvedValueOnce(discardedTab)
          .mockResolvedValueOnce(transitionalTab)
          .mockResolvedValue(settledTab);
        mockReloadCompletingLoad(123);

        // Act
        await messageHandler.handleDecodedMessage(request);

        // Assert
        expect(browser.tabs.reload).toHaveBeenCalledWith(123);
        expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
          resource: "tab-loaded",
          correlationId: "test-correlation-id",
          tabId: 123,
        });
      });

      it("should fail if the tab URL never settles after reloading a discarded tab", async () => {
        // Arrange
        const request: ServerMessageRequest = {
          cmd: "load-tab",
          tabId: 123,
          correlationId: "test-correlation-id",
        };

        const mockTab = {
          id: 123,
          url: "about:blank",
          discarded: true,
          status: "complete",
        };
        (browser.tabs.get as jest.Mock).mockResolvedValue(mockTab);
        mockReloadCompletingLoad(123);

        // Act & Assert
        await expect(
          messageHandler.handleDecodedMessage(request)
        ).rejects.toThrow(
          "Timed out waiting for tab 123 to settle on a final URL after reload"
        );
        expect(mockClient.sendResourceToServer).not.toHaveBeenCalled();
      }, 15000);

      it("should not reload a tab that is already loaded", async () => {
        // Arrange
        const request: ServerMessageRequest = {
          cmd: "load-tab",
          tabId: 123,
          correlationId: "test-correlation-id",
        };

        const mockTab = { id: 123, url: "https://example.com" };
        (browser.tabs.get as jest.Mock).mockResolvedValue(mockTab);

        // Act
        await messageHandler.handleDecodedMessage(request);

        // Assert
        expect(browser.tabs.reload).not.toHaveBeenCalled();
        expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
          resource: "tab-loaded",
          correlationId: "test-correlation-id",
          tabId: 123,
        });
      });

      it("should throw an error if the tab does not exist", async () => {
        // Arrange
        const request: ServerMessageRequest = {
          cmd: "load-tab",
          tabId: 123,
          correlationId: "test-correlation-id",
        };

        (browser.tabs.get as jest.Mock).mockRejectedValue(
          new Error("No such tab")
        );

        // Act & Assert
        await expect(
          messageHandler.handleDecodedMessage(request)
        ).rejects.toThrow("No such tab");
        expect(browser.tabs.reload).not.toHaveBeenCalled();

        // Mock implementations persist across tests in this suite
        // (clearAllMocks only clears calls), so restore a resolved default
        // for the tests that follow.
        (browser.tabs.get as jest.Mock).mockResolvedValue({
          id: 123,
          url: "https://example.com",
        });
      });
    });

    describe("reorder-tabs command", () => {
      it("should reorder tabs and send confirmation to the server", async () => {
        // Arrange
        const request: ServerMessageRequest = {
          cmd: "reorder-tabs",
          tabOrder: [123, 456, 789],
          correlationId: "test-correlation-id",
        };

        (browser.tabs.move as jest.Mock).mockResolvedValue(undefined);

        // Act
        await messageHandler.handleDecodedMessage(request);

        // Assert
        expect(browser.tabs.move).toHaveBeenCalledTimes(3);
        expect(browser.tabs.move).toHaveBeenNthCalledWith(1, 123, { index: 0 });
        expect(browser.tabs.move).toHaveBeenNthCalledWith(2, 456, { index: 1 });
        expect(browser.tabs.move).toHaveBeenNthCalledWith(3, 789, { index: 2 });
        expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
          resource: "tabs-reordered",
          correlationId: "test-correlation-id",
          tabOrder: [123, 456, 789],
        });
      });
    });

    describe("move-tabs-to-window command", () => {
      it("should move the given tabs to the target window and send confirmation", async () => {
        // Arrange
        const request: ServerMessageRequest = {
          cmd: "move-tabs-to-window",
          tabIds: [123, 456],
          windowId: 2,
          correlationId: "test-correlation-id",
        };

        (browser.tabs.move as jest.Mock).mockResolvedValue(undefined);

        // Act
        await messageHandler.handleDecodedMessage(request);

        // Assert
        expect(browser.tabs.move).toHaveBeenCalledTimes(2);
        expect(browser.tabs.move).toHaveBeenNthCalledWith(1, 123, {
          windowId: 2,
          index: -1,
        });
        expect(browser.tabs.move).toHaveBeenNthCalledWith(2, 456, {
          windowId: 2,
          index: -1,
        });
        expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
          resource: "tabs-moved-to-window",
          correlationId: "test-correlation-id",
          tabIds: [123, 456],
          windowId: 2,
        });
      });
    });

    describe("create-window command", () => {
      it("should create a new window, move the given tabs into it, close the default tab and send confirmation", async () => {
        // Arrange
        const request: ServerMessageRequest = {
          cmd: "create-window",
          tabIds: [123, 456],
          correlationId: "test-correlation-id",
        };

        (browser.windows.create as jest.Mock).mockResolvedValue({ id: 7 });
        (browser.tabs.query as jest.Mock).mockImplementation(
          (query: { windowId?: number }) => {
            if (query.windowId === 7) {
              return Promise.resolve([{ id: 900 }]);
            }
            return Promise.resolve([
              { id: 123, windowId: 1, index: 0 },
              { id: 456, windowId: 1, index: 1 },
            ]);
          }
        );
        (browser.tabs.move as jest.Mock).mockResolvedValue(undefined);
        (browser.tabs.remove as jest.Mock).mockResolvedValue(undefined);

        // Act
        await messageHandler.handleDecodedMessage(request);

        // Assert
        expect(browser.windows.create).toHaveBeenCalledWith({});
        expect(browser.tabs.query).toHaveBeenCalledWith({ windowId: 7 });
        // The original position of the requested tabs is snapshotted
        // with a single query for all tabs before the moves.
        expect(browser.tabs.query).toHaveBeenCalledWith({});
        expect(browser.tabs.move).toHaveBeenCalledTimes(2);
        expect(browser.tabs.move).toHaveBeenNthCalledWith(1, 123, {
          windowId: 7,
          index: -1,
        });
        expect(browser.tabs.move).toHaveBeenNthCalledWith(2, 456, {
          windowId: 7,
          index: -1,
        });
        // No placeholder: window 1 still holds a second tab.
        expect(browser.tabs.create).not.toHaveBeenCalled();
        expect(browser.tabs.remove).toHaveBeenCalledWith(900);
        expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
          resource: "window-created",
          correlationId: "test-correlation-id",
          windowId: 7,
          tabIds: [123, 456],
        });
      });

      it("should create a window with only a new tab when no tabs are given", async () => {
        // Arrange
        const request: ServerMessageRequest = {
          cmd: "create-window",
          tabIds: [],
          correlationId: "test-correlation-id",
        };

        (browser.windows.create as jest.Mock).mockResolvedValue({ id: 7 });

        // Act
        await messageHandler.handleDecodedMessage(request);

        // Assert
        expect(browser.windows.create).toHaveBeenCalledWith({});
        expect(browser.tabs.query).not.toHaveBeenCalled();
        expect(browser.tabs.move).not.toHaveBeenCalled();
        expect(browser.tabs.remove).not.toHaveBeenCalled();
        expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
          resource: "window-created",
          correlationId: "test-correlation-id",
          windowId: 7,
          tabIds: [],
        });
      });

      it("should throw if the created window has no ID", async () => {
        // Arrange
        const request: ServerMessageRequest = {
          cmd: "create-window",
          tabIds: [123],
          correlationId: "test-correlation-id",
        };

        (browser.windows.create as jest.Mock).mockResolvedValue({});

        // Act & Assert
        await expect(
          messageHandler.handleDecodedMessage(request)
        ).rejects.toThrow("Failed to create window: no window ID returned");
        expect(browser.tabs.move).not.toHaveBeenCalled();
        expect(mockClient.sendResourceToServer).not.toHaveBeenCalled();
      });

      it("should remove the new window and rethrow if moving a tab fails", async () => {
        // Arrange
        const request: ServerMessageRequest = {
          cmd: "create-window",
          tabIds: [123, 456],
          correlationId: "test-correlation-id",
        };

        (browser.windows.create as jest.Mock).mockResolvedValue({ id: 7 });
        (browser.tabs.query as jest.Mock).mockImplementation(
          (query: { windowId?: number }) => {
            if (query.windowId === 7) {
              return Promise.resolve([{ id: 900 }]);
            }
            return Promise.resolve([
              { id: 123, windowId: 1, index: 0 },
              { id: 456, windowId: 1, index: 1 },
            ]);
          }
        );
        // The first tab is moved into the new window; the second move
        // fails (e.g. a stale tab ID).
        (browser.tabs.move as jest.Mock)
          .mockResolvedValueOnce(undefined)
          .mockRejectedValueOnce(new Error("Tab not found"))
          .mockResolvedValueOnce(undefined);
        (browser.windows.remove as jest.Mock).mockResolvedValue(undefined);

        // Act & Assert
        await expect(
          messageHandler.handleDecodedMessage(request)
        ).rejects.toThrow("Tab not found");
        // The first move, the failed second move, and the move of the
        // first tab back to its original window and index.
        expect(browser.tabs.move).toHaveBeenCalledTimes(3);
        expect(browser.tabs.move).toHaveBeenNthCalledWith(1, 123, {
          windowId: 7,
          index: -1,
        });
        expect(browser.tabs.move).toHaveBeenNthCalledWith(2, 456, {
          windowId: 7,
          index: -1,
        });
        expect(browser.tabs.move).toHaveBeenNthCalledWith(3, 123, {
          windowId: 1,
          index: 0,
        });
        expect(browser.windows.remove).toHaveBeenCalledWith(7);
        expect(mockClient.sendResourceToServer).not.toHaveBeenCalled();
      });

      it("should keep the new window open and rethrow with the window ID if moving a tab back fails", async () => {
        // Arrange
        const request: ServerMessageRequest = {
          cmd: "create-window",
          tabIds: [123, 456],
          correlationId: "test-correlation-id",
        };

        (browser.windows.create as jest.Mock).mockResolvedValue({ id: 7 });
        (browser.tabs.query as jest.Mock).mockImplementation(
          (query: { windowId?: number }) => {
            if (query.windowId === 7) {
              return Promise.resolve([{ id: 900 }]);
            }
            return Promise.resolve([
              { id: 123, windowId: 1, index: 0 },
              { id: 456, windowId: 1, index: 1 },
            ]);
          }
        );
        // The first tab is moved into the new window, the second move
        // fails, and moving the first tab back fails as well (its
        // original window is gone).
        (browser.tabs.move as jest.Mock)
          .mockResolvedValueOnce(undefined)
          .mockRejectedValueOnce(new Error("Tab not found"))
          .mockRejectedValueOnce(new Error("Original window not found"));
        (browser.windows.remove as jest.Mock).mockResolvedValue(undefined);

        // Act & Assert
        const result = messageHandler.handleDecodedMessage(request);
        // The rethrown error carries the original failure and the new
        // window ID so the caller knows where the tabs are.
        await expect(result).rejects.toThrow("Tab not found");
        await expect(result).rejects.toThrow("new window 7");
        // The already-moved tab is restored best effort.
        expect(browser.tabs.move).toHaveBeenNthCalledWith(3, 123, {
          windowId: 1,
          index: 0,
        });
        // The window must not be closed: it still holds the tab that
        // could not be moved back.
        expect(browser.windows.remove).not.toHaveBeenCalled();
        expect(mockClient.sendResourceToServer).not.toHaveBeenCalled();
      });

      it("should still rethrow the original error if removing the new window fails", async () => {
        // Arrange
        const request: ServerMessageRequest = {
          cmd: "create-window",
          tabIds: [123],
          correlationId: "test-correlation-id",
        };

        (browser.windows.create as jest.Mock).mockResolvedValue({ id: 7 });
        (browser.tabs.query as jest.Mock).mockResolvedValue([{ id: 900 }]);
        (browser.tabs.move as jest.Mock).mockRejectedValue(
          new Error("Tab not found")
        );
        (browser.windows.remove as jest.Mock).mockRejectedValue(
          new Error("Window not found")
        );

        // Act & Assert
        await expect(
          messageHandler.handleDecodedMessage(request)
        ).rejects.toThrow("Tab not found");
        expect(browser.windows.remove).toHaveBeenCalledWith(7);
        expect(mockClient.sendResourceToServer).not.toHaveBeenCalled();
      });

      it("should still succeed if closing the default tab fails", async () => {
        // Arrange
        const request: ServerMessageRequest = {
          cmd: "create-window",
          tabIds: [123],
          correlationId: "test-correlation-id",
        };

        (browser.windows.create as jest.Mock).mockResolvedValue({ id: 7 });
        (browser.tabs.query as jest.Mock).mockResolvedValue([{ id: 900 }]);
        (browser.tabs.move as jest.Mock).mockResolvedValue(undefined);
        (browser.tabs.remove as jest.Mock).mockRejectedValue(
          new Error("Tab not found")
        );

        // Act
        await messageHandler.handleDecodedMessage(request);

        // Assert
        expect(browser.tabs.remove).toHaveBeenCalledWith(900);
        expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
          resource: "window-created",
          correlationId: "test-correlation-id",
          windowId: 7,
          tabIds: [123],
        });
      });

      it("should keep a source window open via a placeholder when it holds only the moved tab and close the placeholder afterwards", async () => {
        // Arrange: window 1 holds only tab 123. Moving 123 out would
        // leave the window without tabs, and Firefox would close it.
        const request: ServerMessageRequest = {
          cmd: "create-window",
          tabIds: [123],
          correlationId: "test-correlation-id",
        };

        (browser.windows.create as jest.Mock).mockResolvedValue({ id: 7 });
        (browser.tabs.query as jest.Mock).mockImplementation(
          (query: { windowId?: number }) => {
            if (query.windowId === 7) {
              return Promise.resolve([{ id: 900 }]);
            }
            return Promise.resolve([{ id: 123, windowId: 1, index: 0 }]);
          }
        );
        (browser.tabs.create as jest.Mock).mockResolvedValue({ id: 901 });
        (browser.tabs.move as jest.Mock).mockResolvedValue(undefined);
        (browser.tabs.remove as jest.Mock).mockResolvedValue(undefined);

        // Act
        await messageHandler.handleDecodedMessage(request);

        // Assert: a placeholder is opened in the source window before
        // the move and closed again afterwards.
        expect(browser.tabs.create).toHaveBeenCalledWith({
          windowId: 1,
          url: "about:blank",
        });
        expect(browser.tabs.move).toHaveBeenCalledTimes(1);
        expect(browser.tabs.move).toHaveBeenCalledWith(123, {
          windowId: 7,
          index: -1,
        });
        // The new window's default tab and the placeholder are removed.
        expect(browser.tabs.remove).toHaveBeenCalledWith(900);
        expect(browser.tabs.remove).toHaveBeenCalledWith(901);
        expect(browser.windows.remove).not.toHaveBeenCalled();
        expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
          resource: "window-created",
          correlationId: "test-correlation-id",
          windowId: 7,
          tabIds: [123],
        });
      });

      it("should restore a tab to its source window that would otherwise close itself when a later move fails", async () => {
        // Arrange: window 1 holds only tab 123, so a placeholder keeps
        // it open while 123 is moved out. The second tab (a stale ID)
        // fails the move; the rollback must still be able to move 123
        // back to window 1.
        const request: ServerMessageRequest = {
          cmd: "create-window",
          tabIds: [123, 999999999],
          correlationId: "test-correlation-id",
        };

        (browser.windows.create as jest.Mock).mockResolvedValue({ id: 7 });
        (browser.tabs.query as jest.Mock).mockImplementation(
          (query: { windowId?: number }) => {
            if (query.windowId === 7) {
              return Promise.resolve([{ id: 900 }]);
            }
            return Promise.resolve([{ id: 123, windowId: 1, index: 0 }]);
          }
        );
        (browser.tabs.create as jest.Mock).mockResolvedValue({ id: 901 });
        (browser.tabs.move as jest.Mock)
          .mockResolvedValueOnce(undefined) // 123 into the new window
          .mockRejectedValueOnce(new Error("Invalid tab ID: 999999999"))
          .mockResolvedValueOnce(undefined); // 123 back to window 1
        (browser.tabs.remove as jest.Mock).mockResolvedValue(undefined);
        (browser.windows.remove as jest.Mock).mockResolvedValue(undefined);

        // Act & Assert
        await expect(
          messageHandler.handleDecodedMessage(request)
        ).rejects.toThrow("Invalid tab ID: 999999999");
        expect(browser.tabs.create).toHaveBeenCalledWith({
          windowId: 1,
          url: "about:blank",
        });
        expect(browser.tabs.move).toHaveBeenCalledTimes(3);
        expect(browser.tabs.move).toHaveBeenNthCalledWith(1, 123, {
          windowId: 7,
          index: -1,
        });
        expect(browser.tabs.move).toHaveBeenNthCalledWith(2, 999999999, {
          windowId: 7,
          index: -1,
        });
        // The rollback moves 123 back to window 1 — possible because the
        // placeholder kept the window open.
        expect(browser.tabs.move).toHaveBeenNthCalledWith(3, 123, {
          windowId: 1,
          index: 0,
        });
        // The placeholder is closed and the new window is removed.
        expect(browser.tabs.remove).toHaveBeenCalledWith(901);
        expect(browser.windows.remove).toHaveBeenCalledWith(7);
        expect(mockClient.sendResourceToServer).not.toHaveBeenCalled();
      });

      it("should close the new window and rethrow if opening a placeholder fails", async () => {
        // Arrange: window 1 holds only tab 123, so a placeholder would
        // be needed; opening it fails. Nothing must be moved and the
        // new window must be cleaned up.
        const request: ServerMessageRequest = {
          cmd: "create-window",
          tabIds: [123],
          correlationId: "test-correlation-id",
        };

        (browser.windows.create as jest.Mock).mockResolvedValue({ id: 7 });
        (browser.tabs.query as jest.Mock).mockImplementation(
          (query: { windowId?: number }) => {
            if (query.windowId === 7) {
              return Promise.resolve([{ id: 900 }]);
            }
            return Promise.resolve([{ id: 123, windowId: 1, index: 0 }]);
          }
        );
        (browser.tabs.create as jest.Mock).mockRejectedValue(
          new Error("Cannot open tab")
        );
        (browser.windows.remove as jest.Mock).mockResolvedValue(undefined);

        // Act & Assert
        await expect(
          messageHandler.handleDecodedMessage(request)
        ).rejects.toThrow("Cannot open tab");
        expect(browser.tabs.move).not.toHaveBeenCalled();
        expect(browser.windows.remove).toHaveBeenCalledWith(7);
        expect(mockClient.sendResourceToServer).not.toHaveBeenCalled();
      });
    });

    describe("attach-tabs-to-parent command", () => {
      it("should attach the tabs via Tree Style Tab and send confirmation", async () => {
        // Arrange
        mockTst.isAvailable.mockReturnValue(true);

        const request: ServerMessageRequest = {
          cmd: "attach-tabs-to-parent",
          tabIds: [123, 456],
          parentTabId: 789,
          correlationId: "test-correlation-id",
        };

        // Act
        await tstHandler.handleDecodedMessage(request);

        // Assert
        expect(mockTst.attachTabToParent).toHaveBeenCalledTimes(2);
        expect(mockTst.attachTabToParent).toHaveBeenNthCalledWith(1, 123, 789);
        expect(mockTst.attachTabToParent).toHaveBeenNthCalledWith(2, 456, 789);
        expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
          resource: "tabs-attached-to-parent",
          correlationId: "test-correlation-id",
          tabIds: [123, 456],
          parentTabId: 789,
        });
      });

      it("should reject when Tree Style Tab is not installed", async () => {
        // Arrange (messageHandler has no TST client at all)
        const request: ServerMessageRequest = {
          cmd: "attach-tabs-to-parent",
          tabIds: [123],
          parentTabId: 789,
          correlationId: "test-correlation-id",
        };

        // Act & Assert
        await expect(
          messageHandler.handleDecodedMessage(request)
        ).rejects.toThrow(
          "Attaching tabs to a parent tab requires Tree Style Tab, which is not available"
        );
        expect(mockTst.attachTabToParent).not.toHaveBeenCalled();
        expect(mockClient.sendResourceToServer).not.toHaveBeenCalled();
      });

      it("should reject when Tree Style Tab is unavailable", async () => {
        // Arrange (TST client present but unavailable, as by default)
        const request: ServerMessageRequest = {
          cmd: "attach-tabs-to-parent",
          tabIds: [123],
          parentTabId: 789,
          correlationId: "test-correlation-id",
        };

        // Act & Assert
        await expect(
          tstHandler.handleDecodedMessage(request)
        ).rejects.toThrow(
          "Attaching tabs to a parent tab requires Tree Style Tab, which is not available"
        );
        expect(mockClient.sendResourceToServer).not.toHaveBeenCalled();
      });

      it("should restore the attached tabs to their original parent when a later attach is refused", async () => {
        // Arrange
        mockTst.isAvailable.mockReturnValue(true);
        // Both tabs are currently children of tab 100.
        (browser.tabs.query as jest.Mock).mockResolvedValue([
          { id: 123, windowId: 1 },
          { id: 456, windowId: 1 },
          { id: 789, windowId: 1 },
          { id: 100, windowId: 1 },
        ]);
        mockTst.getLightTree.mockResolvedValue([
          { id: 789, children: [] },
          { id: 100, children: [{ id: 123 }, { id: 456 }] },
        ]);
        // The first tab attaches, the second is refused (e.g. because it
        // is in a different window), and the restore of the first tab to
        // its original parent succeeds.
        mockTst.attachTabToParent
          .mockResolvedValueOnce(true) // 123 -> 789
          .mockResolvedValueOnce(false) // 456 -> 789
          .mockResolvedValueOnce(true); // 123 -> 100 (restore)

        const request: ServerMessageRequest = {
          cmd: "attach-tabs-to-parent",
          tabIds: [123, 456],
          parentTabId: 789,
          correlationId: "test-correlation-id",
        };

        // Act & Assert
        await expect(
          tstHandler.handleDecodedMessage(request)
        ).rejects.toThrow(
          "Failed to attach tab 456 to tab 789 via Tree Style Tab"
        );
        expect(mockTst.attachTabToParent).toHaveBeenCalledTimes(3);
        expect(mockTst.attachTabToParent).toHaveBeenNthCalledWith(1, 123, 789);
        expect(mockTst.attachTabToParent).toHaveBeenNthCalledWith(2, 456, 789);
        expect(mockTst.attachTabToParent).toHaveBeenNthCalledWith(3, 123, 100);
        expect(mockTst.moveTabToStart).not.toHaveBeenCalled();
        expect(mockClient.sendResourceToServer).not.toHaveBeenCalled();
      });

      it("should report a partially re-parented tree when the restore fails", async () => {
        // Arrange
        mockTst.isAvailable.mockReturnValue(true);
        // Both tabs are at the root level of the window, so there is no
        // original parent to re-attach them to.
        (browser.tabs.query as jest.Mock).mockResolvedValue([
          { id: 123, windowId: 1 },
          { id: 456, windowId: 1 },
          { id: 789, windowId: 1 },
        ]);
        mockTst.getLightTree.mockResolvedValue([
          { id: 789, children: [] },
          { id: 123, children: [] },
          { id: 456, children: [] },
        ]);
        mockTst.attachTabToParent
          .mockResolvedValueOnce(true) // 123 -> 789
          .mockResolvedValueOnce(false); // 456 -> 789
        // The restore of tab 123 (root level, so moved to the window
        // start) also fails.
        mockTst.moveTabToStart.mockResolvedValue(false);

        const request: ServerMessageRequest = {
          cmd: "attach-tabs-to-parent",
          tabIds: [123, 456],
          parentTabId: 789,
          correlationId: "test-correlation-id",
        };

        // Act & Assert
        await expect(
          tstHandler.handleDecodedMessage(request)
        ).rejects.toThrow(
          "Could not restore the attached tabs after: Failed to attach tab 456 to tab 789 via Tree Style Tab"
        );
        expect(mockTst.moveTabToStart).toHaveBeenCalledWith(123);
        expect(mockClient.sendResourceToServer).not.toHaveBeenCalled();
      });
    });

    describe("find-highlight command", () => {
      it("should find and highlight text in a tab", async () => {
        // Arrange
        const request: ServerMessageRequest = {
          cmd: "find-highlight",
          tabId: 123,
          queryPhrase: "test",
          correlationId: "test-correlation-id",
        };

        const mockFindResults = { count: 5 };
        (browser.find.find as jest.Mock).mockResolvedValue(mockFindResults);
        (browser.tabs.update as jest.Mock).mockResolvedValue(undefined);
        (browser.permissions.contains as jest.Mock).mockResolvedValue(true);

        // Act
        await messageHandler.handleDecodedMessage(request);

        // Assert
        expect(browser.find.find).toHaveBeenCalledWith("test", {
          tabId: 123,
          caseSensitive: true,
        });
        expect(browser.tabs.update).toHaveBeenCalledWith(123, { active: true });
        expect(browser.find.highlightResults).toHaveBeenCalledWith({
          tabId: 123,
        });
        expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
          resource: "find-highlight-result",
          correlationId: "test-correlation-id",
          noOfResults: 5,
        });
      });

      it("should not highlight or activate tab if no results found", async () => {
        // Arrange
        const request: ServerMessageRequest = {
          cmd: "find-highlight",
          tabId: 123,
          queryPhrase: "test",
          correlationId: "test-correlation-id",
        };

        const mockFindResults = { count: 0 };
        const mockTab = { id: 123, url: "https://example.com" };
        (browser.tabs.get as jest.Mock).mockResolvedValue(mockTab);
        (browser.find.find as jest.Mock).mockResolvedValue(mockFindResults);
        (browser.permissions.contains as jest.Mock).mockResolvedValue(true);

        // Act
        await messageHandler.handleDecodedMessage(request);

        // Assert
        expect(browser.tabs.update).not.toHaveBeenCalled();
        expect(browser.find.highlightResults).not.toHaveBeenCalled();
        expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
          resource: "find-highlight-result",
          correlationId: "test-correlation-id",
          noOfResults: 0,
        });
      });

      it("should throw an error if permissions are denied", async () => {
        // Arrange
        const request: ServerMessageRequest = {
          cmd: "find-highlight",
          tabId: 123,
          queryPhrase: "test",
          correlationId: "test-correlation-id",
        };

        const mockTab = { id: 123, url: "https://example.com" };
        (browser.tabs.get as jest.Mock).mockResolvedValue(mockTab);
        (browser.permissions.contains as jest.Mock).mockResolvedValue(false);

        // Act & Assert
        await expect(
          messageHandler.handleDecodedMessage(request)
        ).rejects.toThrow();
        expect(browser.find.find).not.toHaveBeenCalled();
      });
    });

    describe("capture-screenshot command", () => {
      const request: ServerMessageRequest = {
        cmd: "capture-screenshot",
        tabId: 123,
        correlationId: "test-correlation-id",
      };

      beforeEach(() => {
        revokeCaptureConsent(123);
        (browser.tabs.captureVisibleTab as jest.Mock).mockResolvedValue(
          "data:image/jpeg;base64,QUJD"
        );
      });

      it("should refuse to capture a tab the user has not authorized", async () => {
        // Arrange
        const mockTab = {
          id: 123,
          url: "https://example.com",
          title: "Example",
          windowId: 1,
          active: true,
        };
        (browser.tabs.get as jest.Mock).mockResolvedValue(mockTab);

        // Act & Assert
        await expect(
          messageHandler.handleDecodedMessage(request)
        ).rejects.toThrow(/has not authorized screenshots of tab 123/);
        expect(browser.tabs.captureVisibleTab).not.toHaveBeenCalled();
        // The toolbar button is badged so the user can see which tab is waiting
        expect(browser.browserAction.setBadgeText).toHaveBeenCalledWith({
          text: "!",
          tabId: 123,
        });
      });

      it("should treat consent as revoked once the tab has navigated", async () => {
        // Arrange
        grantCaptureConsent(123, "https://example.com/first");
        const mockTab = {
          id: 123,
          url: "https://example.com/second",
          title: "Example",
          windowId: 1,
          active: true,
        };
        (browser.tabs.get as jest.Mock).mockResolvedValue(mockTab);

        // Act & Assert
        await expect(
          messageHandler.handleDecodedMessage(request)
        ).rejects.toThrow(/has not authorized screenshots of tab 123/);
        expect(browser.tabs.captureVisibleTab).not.toHaveBeenCalled();
      });

      it("should capture an authorized active tab and send the image to the server", async () => {
        // Arrange
        grantCaptureConsent(123, "https://example.com");
        const mockTab = {
          id: 123,
          url: "https://example.com",
          title: "Example",
          windowId: 1,
          active: true,
        };
        (browser.tabs.get as jest.Mock).mockResolvedValue(mockTab);

        // Act
        await messageHandler.handleDecodedMessage(request);

        // Assert
        expect(browser.tabs.captureVisibleTab).toHaveBeenCalledWith(1, {
          format: "jpeg",
          quality: 70,
          scale: 1,
        });
        // An already-active tab must not be re-activated
        expect(browser.tabs.update).not.toHaveBeenCalled();
        expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
          resource: "screenshot",
          correlationId: "test-correlation-id",
          tabId: 123,
          imageData: "QUJD",
          mimeType: "image/jpeg",
        });
      });

      it("should foreground a background tab and restore the previous one", async () => {
        // Arrange
        grantCaptureConsent(123, "https://example.com");
        const mockTab = {
          id: 123,
          url: "https://example.com",
          title: "Example",
          windowId: 1,
          active: false,
        };
        (browser.tabs.get as jest.Mock).mockResolvedValue(mockTab);
        (browser.tabs.query as jest.Mock).mockResolvedValue([{ id: 456 }]);

        // Act
        await messageHandler.handleDecodedMessage(request);

        // Assert
        expect(browser.tabs.query).toHaveBeenCalledWith({
          active: true,
          windowId: 1,
        });
        expect(browser.tabs.update).toHaveBeenNthCalledWith(1, 123, {
          active: true,
        });
        expect(browser.tabs.update).toHaveBeenNthCalledWith(2, 456, {
          active: true,
        });
        expect(browser.tabs.captureVisibleTab).toHaveBeenCalled();
      });

      it("should throw an error if tab URL domain is in deny list", async () => {
        // Arrange
        grantCaptureConsent(123, "https://example.com");
        const configWithDenyList: ExtensionConfig = {
          secret: "test-secret",
          domainDenyList: ["example.com"],
          ports: [8089],
          auditLog: [],
        };
        (browser.storage.local.get as jest.Mock).mockResolvedValue({
          config: configWithDenyList,
        });

        const mockTab = {
          id: 123,
          url: "https://example.com",
          title: "Example",
          windowId: 1,
          active: true,
        };
        (browser.tabs.get as jest.Mock).mockResolvedValue(mockTab);

        // Act & Assert
        await expect(
          messageHandler.handleDecodedMessage(request)
        ).rejects.toThrow("Domain in tab URL is in the deny list");
        expect(browser.tabs.captureVisibleTab).not.toHaveBeenCalled();
      });

      it("should throw an error if the tool is disabled in settings", async () => {
        // Arrange
        grantCaptureConsent(123, "https://example.com");
        (browser.storage.local.get as jest.Mock).mockResolvedValue({
          config: {
            secret: "test-secret",
            toolSettings: { "capture-tab-screenshot": false },
            domainDenyList: [],
            ports: [8089],
            auditLog: [],
          } as ExtensionConfig,
        });

        // Act & Assert
        await expect(
          messageHandler.handleDecodedMessage(request)
        ).rejects.toThrow("Command 'capture-screenshot' is disabled");
        expect(browser.tabs.captureVisibleTab).not.toHaveBeenCalled();
      });
    });

    describe("Tree Style Tab integration", () => {
      describe("write serialization", () => {
        it("does not start a write before the previous write has finished", async () => {
          // Arrange
          mockTst.isAvailable.mockReturnValue(true);
          (browser.tabs.query as jest.Mock).mockResolvedValue([
            { id: 1, windowId: 1 },
            { id: 2, windowId: 1 },
          ]);
          const groupCreated = deferred<number | null>();
          mockTst.createGroup.mockReturnValue(groupCreated.promise);

          // Act: the second write arrives while the first is in progress.
          const grouping = tstHandler.handleDecodedMessage({
            cmd: "group-tabs",
            tabIds: [1],
            isCollapsed: false,
            groupColor: "grey",
            groupTitle: "G",
            correlationId: "first",
          });
          const closing = tstHandler.handleDecodedMessage({
            cmd: "close-tabs",
            tabIds: [2],
            keepChildren: true,
            correlationId: "second",
          });
          await flushMicrotasks();

          // Assert
          expect(mockTst.createGroup).toHaveBeenCalled();
          expect(mockTst.removeTabsKeepingChildren).not.toHaveBeenCalled();

          groupCreated.resolve(null);
          await expect(grouping).rejects.toThrow();
          await closing;
          expect(mockTst.removeTabsKeepingChildren).toHaveBeenCalled();
        });

        it("serializes writes arriving through handlers that share a lock", async () => {
          // Arrange: one handler per configured port, sharing the lock.
          mockTst.isAvailable.mockReturnValue(true);
          (browser.tabs.query as jest.Mock).mockResolvedValue([
            { id: 1, windowId: 1 },
            { id: 2, windowId: 1 },
          ]);
          const lock = new WriteLock();
          const first = new MessageHandler(mockClient, mockTst as unknown as TstClient, lock);
          const second = new MessageHandler(mockClient, mockTst as unknown as TstClient, lock);
          const firstClose = deferred<boolean>();
          mockTst.removeTabsKeepingChildren
            .mockReturnValueOnce(firstClose.promise)
            .mockResolvedValueOnce(true);

          // Act
          const closingFirst = first.handleDecodedMessage({
            cmd: "close-tabs",
            tabIds: [1],
            keepChildren: true,
            correlationId: "first",
          });
          const closingSecond = second.handleDecodedMessage({
            cmd: "close-tabs",
            tabIds: [2],
            keepChildren: true,
            correlationId: "second",
          });
          await flushMicrotasks();

          // Assert
          expect(mockTst.removeTabsKeepingChildren).toHaveBeenCalledTimes(1);
          firstClose.resolve(true);
          await Promise.all([closingFirst, closingSecond]);
          expect(mockTst.removeTabsKeepingChildren).toHaveBeenCalledTimes(2);
        });

        it("lets the tab list wait for a pending write", async () => {
          // Arrange
          mockTst.isAvailable.mockReturnValue(true);
          (browser.tabs.query as jest.Mock).mockResolvedValue([
            { id: 1, windowId: 1 },
          ]);
          const closed = deferred<boolean>();
          mockTst.removeTabsKeepingChildren.mockReturnValue(closed.promise);

          // Act
          const closing = tstHandler.handleDecodedMessage({
            cmd: "close-tabs",
            tabIds: [1],
            keepChildren: true,
            correlationId: "write",
          });
          const listing = tstHandler.handleDecodedMessage({
            cmd: "get-tab-list",
            correlationId: "read",
          });
          await flushMicrotasks();

          // Assert
          const sentResources = () =>
            (mockClient.sendResourceToServer as jest.Mock).mock.calls.map(
              ([message]) => message.correlationId
            );
          expect(sentResources()).not.toContain("read");
          closed.resolve(true);
          await Promise.all([closing, listing]);
          expect(sentResources()).toEqual(["write", "read"]);
        });
      });

      describe("open-tab command", () => {
        it("should open the tab as a child of the active tab when TST is available", async () => {
          // Arrange
          mockTst.isAvailable.mockReturnValue(true);
          (browser.tabs.query as jest.Mock).mockResolvedValue([{ id: 42 }]);
          (browser.tabs.create as jest.Mock).mockResolvedValue({ id: 123 });

          const request: ServerMessageRequest = {
            cmd: "open-tab",
            url: "https://example.com",
            correlationId: "test-correlation-id",
          };

          // Act
          await tstHandler.handleDecodedMessage(request);

          // Assert
          expect(browser.tabs.query).toHaveBeenCalledWith({
            active: true,
            lastFocusedWindow: true,
          });
          expect(browser.tabs.create).toHaveBeenCalledWith({
            url: "https://example.com",
            openerTabId: 42,
          });
        });

        it("should open the tab as a child of the requested parent tab", async () => {
          // Arrange
          mockTst.isAvailable.mockReturnValue(true);
          (browser.tabs.create as jest.Mock).mockResolvedValue({ id: 123 });

          const request: ServerMessageRequest = {
            cmd: "open-tab",
            url: "https://example.com",
            parentTabId: 99,
            correlationId: "test-correlation-id",
          };

          // Act
          await tstHandler.handleDecodedMessage(request);

          // Assert
          expect(browser.tabs.query).not.toHaveBeenCalled();
          expect(browser.tabs.create).toHaveBeenCalledWith({
            url: "https://example.com",
            openerTabId: 99,
          });
        });

        it("should open without an opener when TST is available but there is no active tab", async () => {
          // Arrange
          mockTst.isAvailable.mockReturnValue(true);
          (browser.tabs.query as jest.Mock).mockResolvedValue([]);
          (browser.tabs.create as jest.Mock).mockResolvedValue({ id: 123 });

          const request: ServerMessageRequest = {
            cmd: "open-tab",
            url: "https://example.com",
            correlationId: "test-correlation-id",
          };

          // Act
          await tstHandler.handleDecodedMessage(request);

          // Assert
          expect(browser.tabs.create).toHaveBeenCalledWith({
            url: "https://example.com",
          });
        });

        it("should open without an opener when TST is unavailable", async () => {
          // Arrange
          mockTst.isAvailable.mockReturnValue(false);
          (browser.tabs.create as jest.Mock).mockResolvedValue({ id: 123 });

          const request: ServerMessageRequest = {
            cmd: "open-tab",
            url: "https://example.com",
            parentTabId: 99,
            correlationId: "test-correlation-id",
          };

          // Act
          await tstHandler.handleDecodedMessage(request);

          // Assert
          expect(browser.tabs.create).toHaveBeenCalledWith({
            url: "https://example.com",
          });
        });
      });

      describe("close-tabs command", () => {
        it("should keep the children of closed tabs when TST is available", async () => {
          // Arrange
          mockTst.isAvailable.mockReturnValue(true);
          mockTst.removeTabsKeepingChildren.mockResolvedValue(true);
          (browser.tabs.query as jest.Mock).mockResolvedValue([
            { id: 123, windowId: 1 },
            { id: 456, windowId: 1 },
          ]);
          mockTst.getLightTree.mockResolvedValue([]);

          const request: ServerMessageRequest = {
            cmd: "close-tabs",
            tabIds: [123, 456],
            keepChildren: true,
            correlationId: "test-correlation-id",
          };

          // Act
          await tstHandler.handleDecodedMessage(request);

          // Assert
          expect(mockTst.removeTabsKeepingChildren).toHaveBeenCalledWith(
            [123, 456],
            "detach-all"
          );
          expect(browser.tabs.remove).not.toHaveBeenCalled();
          expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
            resource: "tabs-closed",
            correlationId: "test-correlation-id",
            reparented: [],
            verified: true,
          });
        });

        it("should move the children of a closed root tab to the top level, not under its first child", async () => {
          // Arrange: group tab 10 at the top level with children 11 and 12.
          mockTst.isAvailable.mockReturnValue(true);
          (browser.tabs.query as jest.Mock).mockResolvedValue([
            { id: 10, windowId: 1 },
            { id: 11, windowId: 1 },
            { id: 12, windowId: 1 },
          ]);
          mockTst.getLightTree
            .mockResolvedValueOnce([
              {
                id: 10,
                children: [
                  { id: 11, children: [] },
                  { id: 12, children: [] },
                ],
              },
            ])
            .mockResolvedValue([
              { id: 11, children: [] },
              { id: 12, children: [] },
            ]);

          // Act
          await tstHandler.handleDecodedMessage({
            cmd: "close-tabs",
            tabIds: [10],
            keepChildren: true,
            correlationId: "test-correlation-id",
          });

          // Assert: TST drops "promote-all" sent through its API (the
          // method's internal value is 0, which TST treats as "not given")
          // and falls back to the user's close-parent setting, which
          // promotes the first child of a root tab. "detach-all" works.
          expect(mockTst.removeTabsKeepingChildren).toHaveBeenCalledWith(
            [10],
            "detach-all"
          );
          expect(mockTst.attachTabToParent).not.toHaveBeenCalled();
          expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
            resource: "tabs-closed",
            correlationId: "test-correlation-id",
            reparented: [
              { tabId: 11, parentTabId: null },
              { tabId: 12, parentTabId: null },
            ],
            verified: true,
          });
        });

        it("should move the children of a closed nested tab under its parent, in place", async () => {
          // Arrange: 1 > (10 > (11, 12), 13). TST detaches 11 and 12 to the
          // top level; they are then attached to 1 before 13, where 10 was.
          mockTst.isAvailable.mockReturnValue(true);
          (browser.tabs.query as jest.Mock).mockResolvedValue([
            { id: 1, windowId: 1 },
            { id: 10, windowId: 1 },
          ]);
          mockTst.getLightTree
            .mockResolvedValueOnce([
              {
                id: 1,
                children: [
                  {
                    id: 10,
                    children: [
                      { id: 11, children: [] },
                      { id: 12, children: [] },
                    ],
                  },
                  { id: 13, children: [] },
                ],
              },
            ])
            .mockResolvedValueOnce([
              { id: 1, children: [{ id: 13, children: [] }] },
              { id: 11, children: [] },
              { id: 12, children: [] },
            ])
            .mockResolvedValue([
              {
                id: 1,
                children: [
                  { id: 11, children: [] },
                  { id: 12, children: [] },
                  { id: 13, children: [] },
                ],
              },
            ]);

          // Act
          await tstHandler.handleDecodedMessage({
            cmd: "close-tabs",
            tabIds: [10],
            keepChildren: true,
            correlationId: "test-correlation-id",
          });

          // Assert
          expect(mockTst.removeTabsKeepingChildren).toHaveBeenCalledWith(
            [10],
            "detach-all"
          );
          expect(mockTst.attachTabToParent).toHaveBeenNthCalledWith(1, 11, 1, {
            insertBefore: 13,
          });
          expect(mockTst.attachTabToParent).toHaveBeenNthCalledWith(2, 12, 1, {
            insertBefore: 13,
          });
          expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
            resource: "tabs-closed",
            correlationId: "test-correlation-id",
            reparented: [
              { tabId: 11, parentTabId: 1 },
              { tabId: 12, parentTabId: 1 },
            ],
            verified: true,
          });
        });

        it("should move the children of a closed last child under its parent", async () => {
          // Arrange: 1 > 10 > (11, 12), with nothing after 10 under 1.
          mockTst.isAvailable.mockReturnValue(true);
          (browser.tabs.query as jest.Mock).mockResolvedValue([
            { id: 1, windowId: 1 },
            { id: 10, windowId: 1 },
          ]);
          mockTst.getLightTree
            .mockResolvedValueOnce([
              {
                id: 1,
                children: [
                  {
                    id: 10,
                    children: [
                      { id: 11, children: [] },
                      { id: 12, children: [] },
                    ],
                  },
                ],
              },
            ])
            .mockResolvedValueOnce([
              { id: 1, children: [] },
              { id: 11, children: [] },
              { id: 12, children: [] },
            ])
            .mockResolvedValue([
              {
                id: 1,
                children: [
                  { id: 11, children: [] },
                  { id: 12, children: [] },
                ],
              },
            ]);

          // Act
          await tstHandler.handleDecodedMessage({
            cmd: "close-tabs",
            tabIds: [10],
            keepChildren: true,
            correlationId: "test-correlation-id",
          });

          // Assert: placed where 10 was, each child after the previous one.
          expect(mockTst.attachTabToParent).toHaveBeenNthCalledWith(1, 11, 1, {
            insertAfter: 1,
          });
          expect(mockTst.attachTabToParent).toHaveBeenNthCalledWith(2, 12, 1, {
            insertAfter: 11,
          });
          expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
            resource: "tabs-closed",
            correlationId: "test-correlation-id",
            reparented: [
              { tabId: 11, parentTabId: 1 },
              { tabId: 12, parentTabId: 1 },
            ],
            verified: true,
          });
        });

        it("should detach the children to the top level when requested", async () => {
          // Arrange: 1 > 10 > 11
          mockTst.isAvailable.mockReturnValue(true);
          (browser.tabs.query as jest.Mock).mockResolvedValue([
            { id: 1, windowId: 1 },
            { id: 10, windowId: 1 },
          ]);
          mockTst.getLightTree
            .mockResolvedValueOnce([
              {
                id: 1,
                children: [{ id: 10, children: [{ id: 11, children: [] }] }],
              },
            ])
            .mockResolvedValue([
              { id: 1, children: [] },
              { id: 11, children: [] },
            ]);

          // Act
          await tstHandler.handleDecodedMessage({
            cmd: "close-tabs",
            tabIds: [10],
            keepChildren: true,
            childPlacement: "top-level",
            correlationId: "test-correlation-id",
          });

          // Assert
          expect(mockTst.removeTabsKeepingChildren).toHaveBeenCalledWith(
            [10],
            "detach-all"
          );
          expect(mockTst.attachTabToParent).not.toHaveBeenCalled();
          expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
            resource: "tabs-closed",
            correlationId: "test-correlation-id",
            reparented: [{ tabId: 11, parentTabId: null }],
            verified: true,
          });
        });

        it("should report where the children actually landed when the tree does not settle", async () => {
          jest.useFakeTimers();
          try {
            // Arrange: TST keeps 12 under 11 instead of promoting both.
            mockTst.isAvailable.mockReturnValue(true);
            (browser.tabs.query as jest.Mock).mockResolvedValue([
              { id: 10, windowId: 1 },
            ]);
            mockTst.getLightTree
              .mockResolvedValueOnce([
                {
                  id: 10,
                  children: [
                    { id: 11, children: [] },
                    { id: 12, children: [] },
                  ],
                },
              ])
              .mockResolvedValue([
                { id: 11, children: [{ id: 12, children: [] }] },
              ]);

            // Act
            const closing = tstHandler.handleDecodedMessage({
              cmd: "close-tabs",
              tabIds: [10],
              keepChildren: true,
              correlationId: "test-correlation-id",
            });
            await jest.advanceTimersByTimeAsync(5_000);
            await closing;

            // Assert
            expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
              resource: "tabs-closed",
              correlationId: "test-correlation-id",
              reparented: [
                { tabId: 11, parentTabId: null },
                { tabId: 12, parentTabId: 11 },
              ],
              verified: false,
            });
          } finally {
            jest.useRealTimers();
          }
        });

        it("should not fall back to tabs.remove when TST fails to keep the children", async () => {
          // Arrange
          mockTst.isAvailable.mockReturnValue(true);
          mockTst.removeTabsKeepingChildren.mockResolvedValue(false);
          (browser.tabs.query as jest.Mock).mockResolvedValue([
            { id: 123, windowId: 1 },
          ]);

          const request: ServerMessageRequest = {
            cmd: "close-tabs",
            tabIds: [123, 456],
            keepChildren: true,
            correlationId: "test-correlation-id",
          };

          // Act & Assert: tabs.remove would close the hidden children of
          // collapsed trees, the opposite of keeping them.
          await expect(
            tstHandler.handleDecodedMessage(request)
          ).rejects.toThrow("Tree Style Tab failed to close");
          expect(browser.tabs.remove).not.toHaveBeenCalled();
          expect(mockClient.sendResourceToServer).not.toHaveBeenCalled();
        });

        it("should use tabs.remove when TST is unavailable", async () => {
          // Arrange
          mockTst.isAvailable.mockReturnValue(false);
          (browser.tabs.remove as jest.Mock).mockResolvedValue(undefined);

          const request: ServerMessageRequest = {
            cmd: "close-tabs",
            tabIds: [123, 456],
            keepChildren: true,
            correlationId: "test-correlation-id",
          };

          // Act
          await tstHandler.handleDecodedMessage(request);

          // Assert
          expect(mockTst.removeTabsKeepingChildren).not.toHaveBeenCalled();
          expect(browser.tabs.remove).toHaveBeenCalledWith([123, 456]);
        });
      });

      describe("get-tab-list command", () => {
        it("should send the tabs in tree order with tree fields when TST is available", async () => {
          // Arrange
          mockTst.isAvailable.mockReturnValue(true);
          const mockTabs = [
            {
              id: 1,
              windowId: 1,
              url: "https://a.com",
              title: "A",
              lastAccessed: 1000,
              active: true,
            },
            {
              id: 2,
              windowId: 1,
              url: "https://b.com",
              title: "B",
              lastAccessed: 2000,
              active: false,
            },
            {
              id: 3,
              windowId: 1,
              url: "https://c.com",
              title: "C",
              lastAccessed: 3000,
              active: false,
            },
          ];
          (browser.tabs.query as jest.Mock).mockResolvedValue(mockTabs);
          mockTst.getLightTree.mockResolvedValue([
            {
              id: 1,
              states: [],
              children: [
                {
                  id: 2,
                  states: ["subtree-collapsed"],
                  children: [
                    {
                      id: 3,
                      states: ["collapsed"],
                      children: [],
                    },
                  ],
                },
              ],
            },
          ]);

          const request: ServerMessageRequest = {
            cmd: "get-tab-list",
            correlationId: "test-correlation-id",
          };

          // Act
          await tstHandler.handleDecodedMessage(request);

          // Assert
          expect(mockTst.getLightTree).toHaveBeenCalledWith(1);
          expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
            resource: "tabs",
            correlationId: "test-correlation-id",
            tabs: [
              {
                id: 1,
                url: "https://a.com",
                title: "A",
                lastAccessed: 1000,
                windowId: 1,
                active: true,
                depth: 0,
                parentTabId: undefined,
                childCount: 1,
                collapsed: false,
              },
              {
                id: 2,
                url: "https://b.com",
                title: "B",
                lastAccessed: 2000,
                windowId: 1,
                active: false,
                depth: 1,
                parentTabId: 1,
                childCount: 1,
                collapsed: true,
              },
              {
                id: 3,
                url: "https://c.com",
                title: "C",
                lastAccessed: 3000,
                windowId: 1,
                active: false,
                depth: 2,
                parentTabId: 2,
                childCount: 0,
                collapsed: false,
              },
            ],
            treeAvailable: true,
          });
        });

        it("should carry the discarded flag into the tree list", async () => {
          // Arrange
          mockTst.isAvailable.mockReturnValue(true);
          const mockTabs = [
            {
              id: 1,
              windowId: 1,
              url: "https://a.com",
              title: "A",
              lastAccessed: 1000,
              active: false,
              discarded: false,
            },
            {
              id: 2,
              windowId: 1,
              url: "https://b.com",
              title: "B",
              lastAccessed: 2000,
              active: true,
              discarded: true,
            },
          ];
          (browser.tabs.query as jest.Mock).mockResolvedValue(mockTabs);
          mockTst.getLightTree.mockResolvedValue([
            {
              id: 1,
              states: [],
              children: [{ id: 2, states: [], children: [] }],
            },
          ]);

          const request: ServerMessageRequest = {
            cmd: "get-tab-list",
            correlationId: "test-correlation-id",
          };

          // Act
          await tstHandler.handleDecodedMessage(request);

          // Assert
          expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
            resource: "tabs",
            correlationId: "test-correlation-id",
            tabs: [
              {
                id: 1,
                url: "https://a.com",
                title: "A",
                lastAccessed: 1000,
                windowId: 1,
                active: false,
                discarded: false,
                depth: 0,
                parentTabId: undefined,
                childCount: 1,
                collapsed: false,
              },
              {
                id: 2,
                url: "https://b.com",
                title: "B",
                lastAccessed: 2000,
                windowId: 1,
                active: true,
                discarded: true,
                depth: 1,
                parentTabId: 1,
                childCount: 0,
                collapsed: false,
              },
            ],
            treeAvailable: true,
          });
        });

        it("should retry the tree when it does not match the tab list yet", async () => {
          // Arrange: tab 2 was just opened and is not in TST's tree yet.
          mockTst.isAvailable.mockReturnValue(true);
          const mockTabs = [
            { id: 1, windowId: 1, url: "https://a.com" },
            { id: 2, windowId: 1, url: "https://b.com" },
          ];
          (browser.tabs.query as jest.Mock).mockResolvedValue(mockTabs);
          mockTst.getLightTree
            .mockResolvedValueOnce([{ id: 1, children: [] }])
            .mockResolvedValue([
              { id: 1, children: [{ id: 2, children: [] }] },
            ]);

          // Act
          await tstHandler.handleDecodedMessage({
            cmd: "get-tab-list",
            correlationId: "test-correlation-id",
          });

          // Assert
          expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
            resource: "tabs",
            correlationId: "test-correlation-id",
            tabs: [
              expect.objectContaining({ id: 1, depth: 0 }),
              expect.objectContaining({ id: 2, depth: 1, parentTabId: 1 }),
            ],
            treeAvailable: true,
          });
        });

        it("should fall back to the flat list when a tab is missing from the TST tree", async () => {
          // Arrange
          mockTst.isAvailable.mockReturnValue(true);
          const mockTabs = [
            { id: 1, windowId: 1, url: "https://a.com" },
            { id: 2, windowId: 1, url: "https://b.com" },
          ];
          (browser.tabs.query as jest.Mock).mockResolvedValue(mockTabs);
          mockTst.getLightTree.mockResolvedValue([
            { id: 1, children: [] },
          ]);

          const request: ServerMessageRequest = {
            cmd: "get-tab-list",
            correlationId: "test-correlation-id",
          };

          // Act
          await tstHandler.handleDecodedMessage(request);

          // Assert
          expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
            resource: "tabs",
            correlationId: "test-correlation-id",
            tabs: mockTabs,
            treeAvailable: false,
          });
        });

        it("should fall back to the flat list when the TST tree contains an unknown tab", async () => {
          // Arrange
          mockTst.isAvailable.mockReturnValue(true);
          const mockTabs = [{ id: 1, windowId: 1, url: "https://a.com" }];
          (browser.tabs.query as jest.Mock).mockResolvedValue(mockTabs);
          mockTst.getLightTree.mockResolvedValue([
            { id: 999, children: [] },
          ]);

          const request: ServerMessageRequest = {
            cmd: "get-tab-list",
            correlationId: "test-correlation-id",
          };

          // Act
          await tstHandler.handleDecodedMessage(request);

          // Assert
          expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
            resource: "tabs",
            correlationId: "test-correlation-id",
            tabs: mockTabs,
            treeAvailable: false,
          });
        });

        it("should fall back to the flat list when the tree query fails", async () => {
          // Arrange
          mockTst.isAvailable.mockReturnValue(true);
          const mockTabs = [{ id: 1, windowId: 1, url: "https://a.com" }];
          (browser.tabs.query as jest.Mock).mockResolvedValue(mockTabs);
          mockTst.getLightTree.mockResolvedValue(null);

          const request: ServerMessageRequest = {
            cmd: "get-tab-list",
            correlationId: "test-correlation-id",
          };

          // Act
          await tstHandler.handleDecodedMessage(request);

          // Assert
          expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
            resource: "tabs",
            correlationId: "test-correlation-id",
            tabs: mockTabs,
            treeAvailable: false,
          });
        });

        it("should fall back to the flat list when TST is unavailable", async () => {
          // Arrange
          mockTst.isAvailable.mockReturnValue(false);
          const mockTabs = [{ id: 1, windowId: 1, url: "https://a.com" }];
          (browser.tabs.query as jest.Mock).mockResolvedValue(mockTabs);

          const request: ServerMessageRequest = {
            cmd: "get-tab-list",
            correlationId: "test-correlation-id",
          };

          // Act
          await tstHandler.handleDecodedMessage(request);

          // Assert
          expect(mockTst.getLightTree).not.toHaveBeenCalled();
          expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
            resource: "tabs",
            correlationId: "test-correlation-id",
            tabs: mockTabs,
          });
        });
      });

      describe("reorder-tabs command", () => {
        it("should reorder the tabs via TST when available", async () => {
          // Arrange
          mockTst.isAvailable.mockReturnValue(true);
          (browser.tabs.get as jest.Mock).mockImplementation(
            (tabId: number) => Promise.resolve({ id: tabId, windowId: 1 })
          );

          const request: ServerMessageRequest = {
            cmd: "reorder-tabs",
            tabOrder: [123, 456, 789],
            correlationId: "test-correlation-id",
          };

          // Act
          await tstHandler.handleDecodedMessage(request);

          // Assert
          expect(mockTst.moveTabToStart).toHaveBeenCalledWith(123);
          expect(mockTst.moveTabAfter).toHaveBeenNthCalledWith(1, 456, 123);
          expect(mockTst.moveTabAfter).toHaveBeenNthCalledWith(2, 789, 456);
          expect(browser.tabs.move).not.toHaveBeenCalled();
          expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
            resource: "tabs-reordered",
            correlationId: "test-correlation-id",
            tabOrder: [123, 456, 789],
          });
        });

        it("should fall back to tabs.move when the tabs span multiple windows", async () => {
          // Arrange
          mockTst.isAvailable.mockReturnValue(true);
          (browser.tabs.get as jest.Mock).mockImplementation(
            (tabId: number) =>
              Promise.resolve({ id: tabId, windowId: tabId === 123 ? 1 : 2 })
          );
          (browser.tabs.move as jest.Mock).mockResolvedValue(undefined);

          const request: ServerMessageRequest = {
            cmd: "reorder-tabs",
            tabOrder: [123, 456],
            correlationId: "test-correlation-id",
          };

          // Act
          await tstHandler.handleDecodedMessage(request);

          // Assert
          expect(mockTst.moveTabToStart).not.toHaveBeenCalled();
          expect(mockTst.moveTabAfter).not.toHaveBeenCalled();
          expect(browser.tabs.move).toHaveBeenCalledTimes(2);
        });

        it("should fall back to tabs.move when a TST move command fails", async () => {
          // Arrange
          mockTst.isAvailable.mockReturnValue(true);
          mockTst.moveTabToStart.mockResolvedValue(false);
          (browser.tabs.get as jest.Mock).mockImplementation(
            (tabId: number) => Promise.resolve({ id: tabId, windowId: 1 })
          );
          (browser.tabs.move as jest.Mock).mockResolvedValue(undefined);

          const request: ServerMessageRequest = {
            cmd: "reorder-tabs",
            tabOrder: [123, 456],
            correlationId: "test-correlation-id",
          };

          // Act
          await tstHandler.handleDecodedMessage(request);

          // Assert
          expect(browser.tabs.move).toHaveBeenCalledTimes(2);
        });

        it("should not fall back to tabs.move when a TST move fails after an earlier move was applied", async () => {
          // Arrange
          mockTst.isAvailable.mockReturnValue(true);
          mockTst.moveTabToStart.mockResolvedValue(true);
          mockTst.moveTabAfter.mockResolvedValue(false);
          (browser.tabs.get as jest.Mock).mockImplementation(
            (tabId: number) => Promise.resolve({ id: tabId, windowId: 1 })
          );

          const request: ServerMessageRequest = {
            cmd: "reorder-tabs",
            tabOrder: [123, 456],
            correlationId: "test-correlation-id",
          };

          // Act & Assert
          await expect(
            tstHandler.handleDecodedMessage(request)
          ).rejects.toThrow("failed after 1 of 2 moves were applied");
          // The tree was partially reordered by TST, so the standard API
          // fallback would conflict with it and must not run.
          expect(browser.tabs.move).not.toHaveBeenCalled();
          expect(mockClient.sendResourceToServer).not.toHaveBeenCalled();
        });
      });

      describe("group-tabs command", () => {
        // Tabs 123 and 456 at the top level of window 1 before grouping,
        // and grouped under group tab 789 afterwards.
        function mockGroupingTree(): void {
          (browser.tabs.query as jest.Mock).mockResolvedValue([
            { id: 123, windowId: 1 },
            { id: 456, windowId: 1 },
          ]);
          mockTst.getLightTree
            .mockResolvedValueOnce([
              { id: 123, children: [] },
              { id: 456, children: [] },
            ])
            .mockResolvedValue([
              {
                id: 789,
                children: [
                  { id: 123, children: [] },
                  { id: 456, children: [] },
                ],
              },
            ]);
        }

        it("should create a TST group when TST is available", async () => {
          // Arrange
          mockTst.isAvailable.mockReturnValue(true);
          mockTst.createGroup.mockResolvedValue(789);
          mockGroupingTree();

          const request: ServerMessageRequest = {
            cmd: "group-tabs",
            tabIds: [123, 456],
            isCollapsed: true,
            groupColor: "blue",
            groupTitle: "My group",
            correlationId: "test-correlation-id",
          };

          // Act
          await tstHandler.handleDecodedMessage(request);

          // Assert
          expect(mockTst.createGroup).toHaveBeenCalledWith(
            [123, 456],
            "My group"
          );
          expect(mockTst.collapseTree).toHaveBeenCalledWith(789);
          expect(browser.tabs.group).not.toHaveBeenCalled();
          expect(mockTst.detachTab).not.toHaveBeenCalled();
          expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
            resource: "new-tab-group",
            correlationId: "test-correlation-id",
            groupId: 789,
            memberTabIds: [123, 456],
            missingTabIds: [],
            parentTabId: null,
            verified: true,
          });
        });

        it("should count a tab nested under another grouped tab as a member", async () => {
          // Arrange: 456 is a child of 123 and stays one inside the group.
          mockTst.isAvailable.mockReturnValue(true);
          mockTst.createGroup.mockResolvedValue(789);
          (browser.tabs.query as jest.Mock).mockResolvedValue([
            { id: 123, windowId: 1 },
            { id: 456, windowId: 1 },
          ]);
          mockTst.getLightTree
            .mockResolvedValueOnce([
              { id: 123, children: [{ id: 456, children: [] }] },
            ])
            .mockResolvedValue([
              {
                id: 789,
                children: [{ id: 123, children: [{ id: 456, children: [] }] }],
              },
            ]);

          // Act
          await tstHandler.handleDecodedMessage({
            cmd: "group-tabs",
            tabIds: [123, 456],
            isCollapsed: false,
            groupColor: "grey",
            groupTitle: "My group",
            correlationId: "test-correlation-id",
          });

          // Assert
          expect(mockClient.sendResourceToServer).toHaveBeenCalledWith(
            expect.objectContaining({
              memberTabIds: [123, 456],
              missingTabIds: [],
              verified: true,
            })
          );
        });

        it("should report the tabs that did not end up in the group", async () => {
          jest.useFakeTimers();
          try {
            // Arrange: 456 never joins the group.
            mockTst.isAvailable.mockReturnValue(true);
            mockTst.createGroup.mockResolvedValue(789);
            (browser.tabs.query as jest.Mock).mockResolvedValue([
              { id: 123, windowId: 1 },
              { id: 456, windowId: 1 },
            ]);
            mockTst.getLightTree
              .mockResolvedValueOnce([
                { id: 123, children: [] },
                { id: 456, children: [] },
              ])
              .mockResolvedValue([
                { id: 789, children: [{ id: 123, children: [] }] },
                { id: 456, children: [] },
              ]);

            // Act
            const grouping = tstHandler.handleDecodedMessage({
              cmd: "group-tabs",
              tabIds: [123, 456],
              isCollapsed: false,
              groupColor: "grey",
              groupTitle: "My group",
              correlationId: "test-correlation-id",
            });
            await jest.advanceTimersByTimeAsync(5_000);
            await grouping;

            // Assert
            expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
              resource: "new-tab-group",
              correlationId: "test-correlation-id",
              groupId: 789,
              memberTabIds: [123],
              missingTabIds: [456],
              parentTabId: null,
              verified: false,
            });
          } finally {
            jest.useRealTimers();
          }
        });

        it("should move a group tab that TST nested inside another tree to the top level", async () => {
          // Arrange: 123 is a child of group tab 50, 456 is at the top
          // level. TST creates the new group under the first tab's parent.
          mockTst.isAvailable.mockReturnValue(true);
          mockTst.createGroup.mockResolvedValue(789);
          (browser.tabs.query as jest.Mock).mockResolvedValue([
            { id: 123, windowId: 1 },
            { id: 456, windowId: 1 },
          ]);
          const grouped = [
            { id: 123, children: [] },
            { id: 456, children: [] },
          ];
          mockTst.getLightTree
            .mockResolvedValueOnce([
              { id: 50, children: [{ id: 123, children: [] }] },
              { id: 456, children: [] },
            ])
            .mockResolvedValueOnce([
              { id: 50, children: [{ id: 789, children: grouped }] },
            ])
            .mockResolvedValue([
              { id: 50, children: [] },
              { id: 789, children: grouped },
            ]);

          // Act
          await tstHandler.handleDecodedMessage({
            cmd: "group-tabs",
            tabIds: [123, 456],
            isCollapsed: false,
            groupColor: "grey",
            groupTitle: "My group",
            correlationId: "test-correlation-id",
          });

          // Assert
          expect(mockTst.detachTab).toHaveBeenCalledWith(789);
          expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
            resource: "new-tab-group",
            correlationId: "test-correlation-id",
            groupId: 789,
            memberTabIds: [123, 456],
            missingTabIds: [],
            parentTabId: null,
            verified: true,
          });
        });

        it("should keep the group under the parent all grouped tabs shared", async () => {
          // Arrange: 50 > (123, 456)
          mockTst.isAvailable.mockReturnValue(true);
          mockTst.createGroup.mockResolvedValue(789);
          (browser.tabs.query as jest.Mock).mockResolvedValue([
            { id: 123, windowId: 1 },
            { id: 456, windowId: 1 },
          ]);
          const grouped = [
            { id: 123, children: [] },
            { id: 456, children: [] },
          ];
          mockTst.getLightTree
            .mockResolvedValueOnce([{ id: 50, children: grouped }])
            .mockResolvedValue([
              { id: 50, children: [{ id: 789, children: grouped }] },
            ]);

          // Act
          await tstHandler.handleDecodedMessage({
            cmd: "group-tabs",
            tabIds: [123, 456],
            isCollapsed: false,
            groupColor: "grey",
            groupTitle: "My group",
            correlationId: "test-correlation-id",
          });

          // Assert
          expect(mockTst.detachTab).not.toHaveBeenCalled();
          expect(mockTst.attachTabToParent).not.toHaveBeenCalled();
          expect(mockClient.sendResourceToServer).toHaveBeenCalledWith(
            expect.objectContaining({ parentTabId: 50, verified: true })
          );
        });

        // 124 > (141 > 127, 200): TST opens the group tab for 200 right
        // after 127, the end of 141's subtree, and attaches it to 141.
        function mockGroupNestedAfterSiblingSubtree(): void {
          mockTst.isAvailable.mockReturnValue(true);
          mockTst.createGroup.mockResolvedValue(789);
          (browser.tabs.query as jest.Mock).mockResolvedValue([
            { id: 200, windowId: 1 },
          ]);
          mockTst.getLightTree
            .mockResolvedValueOnce([
              {
                id: 124,
                children: [
                  { id: 141, children: [{ id: 127, children: [] }] },
                  { id: 200, children: [] },
                ],
              },
            ])
            .mockResolvedValueOnce([
              {
                id: 124,
                children: [
                  {
                    id: 141,
                    children: [
                      { id: 127, children: [] },
                      { id: 789, children: [{ id: 200, children: [] }] },
                    ],
                  },
                ],
              },
            ]);
        }

        it("should move a group tab TST nested in a sibling's subtree under the shared parent, in place", async () => {
          // Arrange
          mockGroupNestedAfterSiblingSubtree();
          mockTst.getLightTree.mockResolvedValue([
            {
              id: 124,
              children: [
                { id: 141, children: [{ id: 127, children: [] }] },
                { id: 789, children: [{ id: 200, children: [] }] },
              ],
            },
          ]);

          // Act
          await tstHandler.handleDecodedMessage({
            cmd: "group-tabs",
            tabIds: [200],
            isCollapsed: false,
            groupColor: "grey",
            groupTitle: "My group",
            correlationId: "test-correlation-id",
          });

          // Assert: attached without moving, right after 127, so TST does
          // not re-derive the parent from a new position.
          expect(mockTst.attachTabToParent).toHaveBeenCalledWith(789, 124, {
            insertAfter: 127,
          });
          expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
            resource: "new-tab-group",
            correlationId: "test-correlation-id",
            groupId: 789,
            memberTabIds: [200],
            missingTabIds: [],
            parentTabId: 124,
            verified: true,
          });
        });

        it("should report the intended parent when TST keeps the group tab in the wrong place", async () => {
          jest.useFakeTimers();
          try {
            // Arrange: the group tab stays under 141 despite the attach.
            mockGroupNestedAfterSiblingSubtree();
            mockTst.getLightTree.mockResolvedValue([
              {
                id: 124,
                children: [
                  {
                    id: 141,
                    children: [
                      { id: 127, children: [] },
                      { id: 789, children: [{ id: 200, children: [] }] },
                    ],
                  },
                ],
              },
            ]);

            // Act
            const grouping = tstHandler.handleDecodedMessage({
              cmd: "group-tabs",
              tabIds: [200],
              isCollapsed: false,
              groupColor: "grey",
              groupTitle: "My group",
              correlationId: "test-correlation-id",
            });
            await jest.advanceTimersByTimeAsync(5_000);
            await grouping;

            // Assert
            expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
              resource: "new-tab-group",
              correlationId: "test-correlation-id",
              groupId: 789,
              memberTabIds: [200],
              missingTabIds: [],
              parentTabId: 141,
              intendedParentTabId: 124,
              verified: false,
            });
          } finally {
            jest.useRealTimers();
          }
        });

        it("should judge the group's place by the top tabs of the selection only", async () => {
          // Arrange: 50 > 123 > 456. 456's parent is itself grouped, so the
          // tabs share parent 50 and the group stays there.
          mockTst.isAvailable.mockReturnValue(true);
          mockTst.createGroup.mockResolvedValue(789);
          (browser.tabs.query as jest.Mock).mockResolvedValue([
            { id: 123, windowId: 1 },
            { id: 456, windowId: 1 },
          ]);
          const subtree = [{ id: 123, children: [{ id: 456, children: [] }] }];
          mockTst.getLightTree
            .mockResolvedValueOnce([{ id: 50, children: subtree }])
            .mockResolvedValue([
              { id: 50, children: [{ id: 789, children: subtree }] },
            ]);

          // Act
          await tstHandler.handleDecodedMessage({
            cmd: "group-tabs",
            tabIds: [123, 456],
            isCollapsed: false,
            groupColor: "grey",
            groupTitle: "My group",
            correlationId: "test-correlation-id",
          });

          // Assert
          expect(mockTst.detachTab).not.toHaveBeenCalled();
          expect(mockClient.sendResourceToServer).toHaveBeenCalledWith(
            expect.objectContaining({ parentTabId: 50, verified: true })
          );
        });

        it("should not collapse the TST group when not requested", async () => {
          // Arrange
          mockTst.isAvailable.mockReturnValue(true);
          mockTst.createGroup.mockResolvedValue(789);
          mockGroupingTree();

          const request: ServerMessageRequest = {
            cmd: "group-tabs",
            tabIds: [123, 456],
            isCollapsed: false,
            groupColor: "blue",
            groupTitle: "My group",
            correlationId: "test-correlation-id",
          };

          // Act
          await tstHandler.handleDecodedMessage(request);

          // Assert
          expect(mockTst.collapseTree).not.toHaveBeenCalled();
          expect(mockClient.sendResourceToServer).toHaveBeenCalledWith(
            expect.objectContaining({ groupId: 789, verified: true })
          );
        });

        it("should not fall back to native tab groups when TST group creation fails", async () => {
          // Arrange
          mockTst.isAvailable.mockReturnValue(true);
          mockTst.createGroup.mockResolvedValue(null);
          mockGroupingTree();

          const request: ServerMessageRequest = {
            cmd: "group-tabs",
            tabIds: [123, 456],
            isCollapsed: true,
            groupColor: "blue",
            groupTitle: "My group",
            correlationId: "test-correlation-id",
          };

          // Act & Assert: TST may still apply the grouping after a timeout,
          // and native grouping would then fight with it.
          await expect(
            tstHandler.handleDecodedMessage(request)
          ).rejects.toThrow("Tree Style Tab failed to create the group");
          expect(browser.tabs.group).not.toHaveBeenCalled();
          expect(mockClient.sendResourceToServer).not.toHaveBeenCalled();
        });
      });
    });
  });
});
