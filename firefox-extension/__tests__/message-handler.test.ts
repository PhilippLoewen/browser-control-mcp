import { MessageHandler } from "../message-handler";
import { WebsocketClient } from "../client";
import { TstClient } from "../tst-client";
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

        const mockTabs = [{ id: 123, url: "https://example.com" }];
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
          mockTst.attachTabToParent.mockResolvedValue(true);

          const request: ServerMessageRequest = {
            cmd: "close-tabs",
            tabIds: [123, 456],
            keepChildren: true,
            correlationId: "test-correlation-id",
          };

          // Act
          await tstHandler.handleDecodedMessage(request);

          // Assert
          expect(mockTst.removeTabsKeepingChildren).toHaveBeenCalledWith([
            123, 456,
          ]);
          expect(browser.tabs.remove).not.toHaveBeenCalled();
          expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
            resource: "tabs-closed",
            correlationId: "test-correlation-id",
          });
        });

        it("should fall back to tabs.remove when TST fails to keep the children", async () => {
          // Arrange
          mockTst.isAvailable.mockReturnValue(true);
          mockTst.removeTabsKeepingChildren.mockResolvedValue(false);
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
          expect(browser.tabs.remove).toHaveBeenCalledWith([123, 456]);
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
        it("should create a TST group when TST is available", async () => {
          // Arrange
          mockTst.isAvailable.mockReturnValue(true);
          mockTst.createGroup.mockResolvedValue(789);

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
          expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
            resource: "new-tab-group",
            correlationId: "test-correlation-id",
            groupId: 789,
          });
        });

        it("should not collapse the TST group when not requested", async () => {
          // Arrange
          mockTst.isAvailable.mockReturnValue(true);
          mockTst.createGroup.mockResolvedValue(789);

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
          expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
            resource: "new-tab-group",
            correlationId: "test-correlation-id",
            groupId: 789,
          });
        });

        it("should fall back to native tab groups when TST group creation fails", async () => {
          // Arrange
          mockTst.isAvailable.mockReturnValue(true);
          mockTst.createGroup.mockResolvedValue(null);
          (browser.tabs.group as jest.Mock).mockResolvedValue(100);
          (browser.tabGroups.update as jest.Mock).mockResolvedValue({
            id: 100,
          });

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
          expect(browser.tabs.group).toHaveBeenCalledWith({
            tabIds: [123, 456],
          });
          expect(mockClient.sendResourceToServer).toHaveBeenCalledWith({
            resource: "new-tab-group",
            correlationId: "test-correlation-id",
            groupId: 100,
          });
        });
      });
    });
  });
});
