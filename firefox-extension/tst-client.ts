/**
 * Client for the Tree Style Tab add-on API.
 *
 * Tree Style Tab (TST) exposes an external messaging API that lets other
 * add-ons query and manipulate the tab tree. This client:
 *
 * - registers itself with TST when TST becomes available,
 * - keeps track of whether TST is available (retries every 30 seconds and
 *   listens for TST's "ready" notification),
 * - exposes the TST commands this add-on needs, each returning `null` /
 *   `false` when TST is unavailable or the command fails, so callers can
 *   fall back to the standard WebExtensions APIs.
 *
 * See https://github.com/piroor/treestyletab/wiki/API-for-other-addons
 */

export const TST_ADDON_ID = "treestyletab@piro.sakura.ne.jp";

// How long to wait for TST to respond to a command message.
const TST_REQUEST_TIMEOUT_MS = 3000;
// How often to retry registration while TST is unavailable.
const TST_RETRY_INTERVAL_MS = 30_000;

/** A node in the tab tree, as returned by TST's get-tree / get-light-tree commands. */
export interface TstTreeItem {
  id: number;
  windowId?: number;
  type?: string;
  /** States like "collapsed" (own children hidden) or "subtree-collapsed" (hidden under a collapsed ancestor). */
  states?: string[];
  indent?: number;
  children?: TstTreeItem[];
  ancestorTabIds?: number[];
  bundledTabId?: number;
  [key: string]: unknown;
}

export type TstRemoveMethod =
  | "promote-all"
  | "promote-first"
  | "promote-intelligently"
  | "detach-all";

interface TstMessage {
  type: string;
  [key: string]: unknown;
}

export class TstClient {
  private status: "unavailable" | "available" = "unavailable";
  private initializing = false;
  private registering = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly isIntegrationEnabled: () => Promise<boolean>;

  constructor(isIntegrationEnabled: () => Promise<boolean>) {
    this.isIntegrationEnabled = isIntegrationEnabled;
  }

  /**
   * Set up listeners and perform the first registration attempt.
   * Safe to call multiple times.
   */
  public async init(): Promise<void> {
    if (this.initializing) return;
    this.initializing = true;

    // Re-register when TST (re-)starts (e.g. after an update or restart),
    // and when the permissions granted to us change. TST caches the IDs of
    // registered add-ons and sends "ready" to them on (re)initialization,
    // so we must keep listening even after a successful registration.
    browser.runtime.onMessageExternal.addListener((message, sender) => {
      if (sender?.id !== TST_ADDON_ID) return;
      const type = (message as { type?: string } | null | undefined)?.type;
      if (type === "ready" || type === "permissions-changed") {
        void this.tryRegister();
      }
    });

    // React immediately when the user toggles the integration setting.
    browser.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !("config" in changes)) return;
      void this.syncWithSetting();
    });

    await this.tryRegister();
  }

  /** Whether TST is installed, enabled, and registered. */
  public isAvailable(): boolean {
    return this.status === "available";
  }

  // ------------------------------------------------------------------
  // Commands
  //
  // Each command returns a sentinel value (null / false) when TST is
  // unavailable or the command fails, so callers can fall back to the
  // standard WebExtensions APIs.
  // ------------------------------------------------------------------

  /**
   * Get the tab tree of a window as a list of root items.
   * Children are included recursively, even when the tree is collapsed.
   */
  public async getLightTree(windowId: number): Promise<TstTreeItem[] | null> {
    const result = await this.command({ type: "get-light-tree", window: windowId });
    return Array.isArray(result) ? (result as TstTreeItem[]) : null;
  }

  /**
   * Group the given tabs into a temporary TST group tab.
   * Returns the ID of the new group tab (parent), or null on failure.
   */
  public async createGroup(tabIds: number[], title: string): Promise<number | null> {
    const result = await this.command({
      type: "group-tabs",
      tabs: tabIds,
      title,
      temporary: true,
    });
    const item = result as TstTreeItem | undefined;
    return item && typeof item.id === "number" ? item.id : null;
  }

  /** Collapse the tree of the given tab. TST reports success even when it had no effect. */
  public async collapseTree(tabId: number): Promise<boolean> {
    const result = await this.command({ type: "collapse-tree", tab: tabId });
    return result === true;
  }

  /** Move the given tab (with its children) to the start of its window. */
  public async moveTabToStart(tabId: number): Promise<boolean> {
    const result = await this.command({ type: "move-to-start", tab: tabId });
    return result === true;
  }

  /** Move the given tab (with its children) after the reference tab. */
  public async moveTabAfter(tabId: number, referenceTabId: number): Promise<boolean> {
    const result = await this.command({
      type: "move-after",
      tab: tabId,
      referenceTabId,
      followChildren: true,
    });
    return result === true;
  }

  /**
   * Close the given tabs, keeping their child tabs.
   * Requires TST 4.4.0 or later.
   */
  public async removeTabsKeepingChildren(
    tabIds: number[],
    method: TstRemoveMethod = "promote-intelligently"
  ): Promise<boolean> {
    const result = await this.command({
      type: "remove-tab-keeping-children",
      tabs: tabIds,
      method,
    });
    return result === true;
  }

  /**
   * Attach the given tab as a child tab of the parent tab, re-parenting
   * it from its current parent if it has one. Both tabs must be in the
   * same window.
   */
  public async attachTabToParent(
    tabId: number,
    parentTabId: number
  ): Promise<boolean> {
    const result = await this.command({
      type: "attach",
      child: tabId,
      parent: parentTabId,
    });
    return result === true;
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  /**
   * Send a command message to TST.
   * Returns the response, or `null` when TST is unavailable or the
   * command fails (a command failure marks TST unavailable, and the
   * retry loop will attempt to re-register).
   */
  private async command(message: TstMessage): Promise<unknown> {
    if (!this.isAvailable()) return null;
    try {
      return await withTimeout(
        browser.runtime.sendMessage(TST_ADDON_ID, message),
        TST_REQUEST_TIMEOUT_MS
      );
    } catch (error) {
      console.error(`Failed to send TST command '${message.type}':`, error);
      this.markUnavailable();
      return null;
    }
  }

  private async tryRegister(): Promise<void> {
    if (this.registering) return;
    this.registering = true;
    try {
      if (!(await this.isIntegrationEnabled())) {
        this.markUnavailable();
        return;
      }
      await withTimeout(
        browser.runtime.sendMessage(TST_ADDON_ID, { type: "ping" }),
        TST_REQUEST_TIMEOUT_MS
      );
      const registration = (await withTimeout(
        browser.runtime.sendMessage(TST_ADDON_ID, {
          type: "register-self",
          name: browser.runtime.getManifest().name,
          icons: browser.runtime.getManifest().icons,
          // We only send commands to TST, so we don't need any of its notifications.
          listeningTypes: [],
          permissions: ["tabs"],
        }),
        TST_REQUEST_TIMEOUT_MS
      )) as { grantedPermissions?: string[] } | undefined;
      // The response lists permissions that were NOT granted (with a "!" prefix).
      const denied = Array.isArray(registration?.grantedPermissions)
        ? registration!.grantedPermissions
        : [];
      if (denied.length > 0) {
        console.warn(`TST registration: not all requested permissions were granted: ${denied.join(", ")}`);
      }
      this.markAvailable();

      // Track TST's lifetime: the promise resolves when the browser shuts
      // down and rejects when TST is disabled or uninstalled.
      browser.runtime
        .sendMessage(TST_ADDON_ID, { type: "wait-for-shutdown" })
        .then(() => this.markUnavailable())
        .catch(() => this.markUnavailable());
    } catch (error) {
      console.log("Tree Style Tab is not available:", error);
      this.markUnavailable();
      // The first failure happens while the status is already "unavailable",
      // where markUnavailable is a no-op, so start the retry loop here.
      this.scheduleRetry();
    } finally {
      this.registering = false;
    }
  }

  private markAvailable(): void {
    if (this.status === "available") return;
    this.status = "available";
    console.log("Tree Style Tab integration enabled");
    this.clearRetryTimer();
  }

  private markUnavailable(): void {
    if (this.status === "unavailable") return;
    this.status = "unavailable";
    console.log("Tree Style Tab integration disabled (TST unavailable)");
    this.scheduleRetry();
  }

  private async syncWithSetting(): Promise<void> {
    const enabled = await this.isIntegrationEnabled();
    if (!enabled) {
      this.markUnavailable();
    } else if (this.status === "unavailable") {
      await this.tryRegister();
    }
  }

  private scheduleRetry(): void {
    if (this.retryTimer !== null) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.tryRegister().finally(() => {
        if (!this.isAvailable()) this.scheduleRetry();
      });
    }, TST_RETRY_INTERVAL_MS);
  }

  private clearRetryTimer(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out after ${ms} ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
