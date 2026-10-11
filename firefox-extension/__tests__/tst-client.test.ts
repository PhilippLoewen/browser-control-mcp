import { TstClient, TST_ADDON_ID } from "../tst-client";

/** Flush pending microtasks so fire-and-forget async chains can complete. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}

describe("TstClient", () => {
  let client: TstClient;
  let isEnabled: jest.Mock;
  let sendMessage: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    isEnabled = jest.fn().mockResolvedValue(true);
    sendMessage = browser.runtime.sendMessage as jest.Mock;
    (browser.runtime.getManifest as jest.Mock).mockReturnValue({
      name: "test-extension",
      icons: { "48": "icon.png" },
    });
    client = new TstClient(isEnabled);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe("init", () => {
    it("does not try to register when the integration is disabled", async () => {
      isEnabled.mockResolvedValue(false);

      await client.init();

      expect(client.isAvailable()).toBe(false);
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it("does not register when TST is not installed", async () => {
      sendMessage.mockRejectedValue(new Error("no receiving end"));

      await client.init();

      expect(client.isAvailable()).toBe(false);
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage).toHaveBeenCalledWith(TST_ADDON_ID, { type: "ping" });
    });

    it("registers with TST and marks itself available", async () => {
      sendMessage
        .mockResolvedValueOnce(true) // ping
        .mockResolvedValueOnce({ grantedPermissions: [] }) // register-self
        .mockImplementationOnce(
          () => new Promise(() => {})
        ); // wait-for-shutdown: never settles

      await client.init();

      expect(client.isAvailable()).toBe(true);
      expect(sendMessage).toHaveBeenCalledWith(TST_ADDON_ID, {
        type: "ping",
      });
      expect(sendMessage).toHaveBeenCalledWith(TST_ADDON_ID, {
        type: "register-self",
        name: "test-extension",
        icons: { "48": "icon.png" },
        listeningTypes: [],
        permissions: ["tabs"],
      });
      expect(sendMessage).toHaveBeenCalledWith(TST_ADDON_ID, {
        type: "wait-for-shutdown",
      });
    });

    it("re-registers when TST sends a ready notification", async () => {
      // The first attempt fails because TST is not (re)started yet...
      sendMessage.mockRejectedValueOnce(new Error("not yet"));
      await client.init();
      expect(client.isAvailable()).toBe(false);

      const listener = (
        browser.runtime.onMessageExternal.addListener as jest.Mock
      ).mock.calls[0][0];
      expect(listener).toBeDefined();

      // ...then TST (re)starts and notifies us.
      sendMessage
        .mockResolvedValueOnce(true) // ping
        .mockResolvedValueOnce({ grantedPermissions: [] }) // register-self
        .mockImplementationOnce(
          () => new Promise(() => {})
        ); // wait-for-shutdown
      listener({ type: "ready" }, { id: TST_ADDON_ID });
      await flushMicrotasks();

      expect(client.isAvailable()).toBe(true);
      const pings = sendMessage.mock.calls.filter(
        (call) => call[1]?.type === "ping"
      );
      expect(pings).toHaveLength(2);
    });

    it("ignores ready notifications from other add-ons", async () => {
      sendMessage.mockRejectedValue(new Error("no TST"));
      await client.init();

      const listener = (
        browser.runtime.onMessageExternal.addListener as jest.Mock
      ).mock.calls[0][0];
      listener({ type: "ready" }, { id: "other@addon" });
      await flushMicrotasks();

      // No new registration attempt has been made.
      expect(sendMessage).toHaveBeenCalledTimes(1);
    });

    it("marks itself unavailable when TST is disabled (wait-for-shutdown rejects)", async () => {
      sendMessage
        .mockResolvedValueOnce(true) // ping
        .mockResolvedValueOnce({ grantedPermissions: [] }) // register-self
        .mockRejectedValueOnce(new Error("TST disabled")); // wait-for-shutdown

      await client.init();
      expect(sendMessage).toHaveBeenCalledWith(TST_ADDON_ID, {
        type: "wait-for-shutdown",
      });

      // The rejection of the wait-for-shutdown promise is handled
      // asynchronously and takes the client down with it.
      await flushMicrotasks();
      expect(client.isAvailable()).toBe(false);
    });
  });

  describe("retry", () => {
    it("retries registration after the retry interval", async () => {
      sendMessage.mockRejectedValue(new Error("no TST"));
      await client.init();
      expect(sendMessage).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(30_000);
      expect(sendMessage).toHaveBeenCalledTimes(2);
    });

    it("stops retrying once registration succeeds", async () => {
      sendMessage
        .mockRejectedValueOnce(new Error("not yet"))
        .mockResolvedValueOnce(true) // ping (retry)
        .mockResolvedValueOnce({ grantedPermissions: [] }) // register-self (retry)
        .mockImplementationOnce(
          () => new Promise(() => {})
        ); // wait-for-shutdown
      await client.init();
      expect(client.isAvailable()).toBe(false);

      await jest.advanceTimersByTimeAsync(30_000);
      expect(client.isAvailable()).toBe(true);

      const callCount = sendMessage.mock.calls.length;
      await jest.advanceTimersByTimeAsync(30_000);
      expect(sendMessage.mock.calls.length).toBe(callCount);
    });

    it("stops retrying when the integration is disabled in the meantime", async () => {
      sendMessage.mockRejectedValue(new Error("no TST"));
      await client.init();
      expect(sendMessage).toHaveBeenCalledTimes(1);

      // The user disables the integration while the retry timer is
      // pending.
      isEnabled.mockResolvedValue(false);

      // The pending cycle sees the disabled setting, does not ping, and
      // does not schedule another cycle.
      await jest.advanceTimersByTimeAsync(30_000);
      expect(sendMessage).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(30_000);
      expect(sendMessage).toHaveBeenCalledTimes(1);
    });
  });

  describe("commands", () => {
    it("does not send commands when TST is unavailable", async () => {
      sendMessage.mockRejectedValue(new Error("no TST"));
      await client.init();

      expect(await client.getLightTree(1)).toBeNull();
      expect(await client.createGroup([1, 2], "group")).toBeNull();
      expect(await client.collapseTree(1)).toBe(false);
      expect(await client.moveTabToStart(1)).toBe(false);
      expect(await client.moveTabAfter(1, 2)).toBe(false);
      expect(await client.removeTabsKeepingChildren([1])).toBe(false);
      expect(await client.attachTabToParent(1, 2)).toBe(false);
      // Only the initial ping was sent.
      expect(sendMessage).toHaveBeenCalledTimes(1);
    });

    it("getLightTree returns the roots of the tab tree", async () => {
      const tree = [{ id: 1, children: [{ id: 2, children: [] }] }];
      sendMessage
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce({ grantedPermissions: [] })
        .mockImplementationOnce(() => new Promise(() => {}))
        .mockResolvedValueOnce(tree);
      await client.init();

      expect(await client.getLightTree(5)).toEqual(tree);
      expect(sendMessage).toHaveBeenLastCalledWith(TST_ADDON_ID, {
        type: "get-light-tree",
        window: 5,
      });
    });

    it("getLightTree returns null when the response is not a tree", async () => {
      sendMessage
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce({ grantedPermissions: [] })
        .mockImplementationOnce(() => new Promise(() => {}))
        .mockResolvedValueOnce({ error: "no such window" });
      await client.init();

      expect(await client.getLightTree(5)).toBeNull();
    });

    it("createGroup returns the id of the group tab", async () => {
      sendMessage
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce({ grantedPermissions: [] })
        .mockImplementationOnce(() => new Promise(() => {}))
        .mockResolvedValueOnce({ id: 789, title: "My group" });
      await client.init();

      expect(await client.createGroup([1, 2], "My group")).toBe(789);
      expect(sendMessage).toHaveBeenLastCalledWith(TST_ADDON_ID, {
        type: "group-tabs",
        tabs: [1, 2],
        title: "My group",
        temporary: true,
      });
    });

    it("createGroup returns null when the response has no tab id", async () => {
      sendMessage
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce({ grantedPermissions: [] })
        .mockImplementationOnce(() => new Promise(() => {}))
        .mockResolvedValueOnce(null);
      await client.init();

      expect(await client.createGroup([1, 2], "My group")).toBeNull();
    });

    it("sends the boolean commands and reports their results", async () => {
      sendMessage
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce({ grantedPermissions: [] })
        .mockImplementationOnce(() => new Promise(() => {}))
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true);
      await client.init();

      expect(await client.collapseTree(1)).toBe(true);
      expect(sendMessage).toHaveBeenLastCalledWith(TST_ADDON_ID, {
        type: "collapse-tree",
        tab: 1,
      });

      expect(await client.moveTabToStart(2)).toBe(true);
      expect(sendMessage).toHaveBeenLastCalledWith(TST_ADDON_ID, {
        type: "move-to-start",
        tab: 2,
      });

      expect(await client.moveTabAfter(2, 1)).toBe(true);
      expect(sendMessage).toHaveBeenLastCalledWith(TST_ADDON_ID, {
        type: "move-after",
        tab: 2,
        referenceTabId: 1,
        followChildren: true,
      });

      expect(
        await client.removeTabsKeepingChildren([1, 2], "promote-all")
      ).toBe(true);
      expect(sendMessage).toHaveBeenLastCalledWith(TST_ADDON_ID, {
        type: "remove-tab-keeping-children",
        tabs: [1, 2],
        method: "promote-all",
      });

      expect(await client.attachTabToParent(3, 1)).toBe(true);
      expect(sendMessage).toHaveBeenLastCalledWith(TST_ADDON_ID, {
        type: "attach",
        child: 3,
        parent: 1,
      });
    });

    it("marks itself unavailable when a command fails", async () => {
      sendMessage
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce({ grantedPermissions: [] })
        .mockImplementationOnce(() => new Promise(() => {}))
        .mockRejectedValueOnce(new Error("boom"));
      await client.init();
      expect(client.isAvailable()).toBe(true);

      expect(await client.getLightTree(1)).toBeNull();
      expect(client.isAvailable()).toBe(false);
    });
  });
});
