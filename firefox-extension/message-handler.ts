import type { ServerMessageRequest } from "@browser-control-mcp/common";
import type { BrowserTab } from "@browser-control-mcp/common/extension-messages";
import { WebsocketClient } from "./client";
import { isCommandAllowed, isDomainInDenyList, COMMAND_TO_TOOL_ID, addAuditLogEntry } from "./extension-config";
import { hasCaptureConsent, markTabAsAwaitingConsent } from "./capture-consent";
import type { TstClient, TstTreeItem } from "./tst-client";
import { WriteLock } from "./write-lock";

// Time to let a newly foregrounded tab paint before capturing it
const TAB_PAINT_DELAY_MS = 250;

// Max time to wait for a reloaded (previously discarded) tab to finish loading
const TAB_LOAD_TIMEOUT_MS = 10_000;

// Max time to wait, after the load-complete event, for the tab to report a
// settled http(s) URL; a freshly reloaded tab can briefly keep reporting a
// transitional URL (e.g. about:blank) during document swap-in.
const TAB_URL_SETTLE_TIMEOUT_MS = 5_000;
const TAB_URL_SETTLE_POLL_MS = 100;

// Delays between retries of a script injection rejected with Firefox's
// generic "Missing host permission for the tab" error. Firefox also reports
// that error when the tab's document navigates between the lookup of the
// target window and the actual execution (Firefox bug 2047009), which can
// happen right after a discarded tab has reloaded.
const TAB_SCRIPT_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000];

// Firefox's generic rejection when no window accepts a script-injection
// query, also produced (misleadingly) when the document navigates during
// the call.
const HOST_PERMISSION_ERROR_PATTERN =
  /Missing host permission for the tab( or frames)?/;

// How long to keep re-reading the Tree Style Tab tree after a write until
// it shows the write's effect, and how often. TST acknowledges commands
// before it has finished re-arranging the tree.
const TREE_SETTLE_TIMEOUT_MS = 2_000;
const TREE_SETTLE_POLL_MS = 100;

// How often, and after how long, to retry building the tree-ordered tab
// list when the tab list and Tree Style Tab's tree disagree.
const TAB_LIST_TREE_RETRIES = 2;
const TAB_LIST_TREE_RETRY_DELAY_MS = 150;

/** A tab's place in the Tree Style Tab tree. */
interface TreeNode {
  windowId: number;
  /** Undefined for a tab at the top level. */
  parentTabId?: number;
  childIds: number[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// True for the (deliberately generic) host-permission rejection that
// Firefox's tabs.executeScript produces when no window accepts the
// injection query.
function isHostPermissionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return HOST_PERMISSION_ERROR_PATTERN.test(message);
}

// Commands that change the tab structure. They run one at a time (see
// WriteLock), and the tab list waits for them to finish.
const WRITE_COMMANDS: ReadonlySet<ServerMessageRequest["cmd"]> = new Set([
  "open-tab",
  "close-tabs",
  "reorder-tabs",
  "group-tabs",
  "move-tabs-to-window",
  "create-window",
  "attach-tabs-to-parent",
]);

export class MessageHandler {
  private client: WebsocketClient;
  private tst?: TstClient;
  private writeLock: WriteLock;

  constructor(client: WebsocketClient, tst?: TstClient, writeLock = new WriteLock()) {
    this.client = client;
    this.tst = tst;
    this.writeLock = writeLock;
  }

  public async handleDecodedMessage(req: ServerMessageRequest): Promise<void> {
    const isAllowed = await isCommandAllowed(req.cmd);
    if (!isAllowed) {
      throw new Error(`Command '${req.cmd}' is disabled in extension settings`);
    }

    this.addAuditLogForReq(req).catch((error) => {
      console.error("Failed to add audit log entry:", error);
    });

    if (WRITE_COMMANDS.has(req.cmd)) {
      await this.writeLock.run(() => this.dispatch(req));
      return;
    }
    if (req.cmd === "get-tab-list") {
      // Do not list a tree that a pending write is still changing.
      await this.writeLock.idle();
    }
    await this.dispatch(req);
  }

  private async dispatch(req: ServerMessageRequest): Promise<void> {
    switch (req.cmd) {
      case "open-tab":
        await this.openUrl(req.correlationId, req.url, req.parentTabId);
        break;
      case "close-tabs":
        await this.closeTabs(
          req.correlationId,
          req.tabIds,
          req.keepChildren,
          req.childPlacement
        );
        break;
      case "get-tab-list":
        await this.sendTabs(req.correlationId);
        break;
      case "get-browser-recent-history":
        await this.sendRecentHistory(req.correlationId, req.searchQuery);
        break;
      case "get-tab-content":
        await this.sendTabsContent(req.correlationId, req.tabId, req.offset);
        break;
      case "load-tab":
        await this.loadTab(req.correlationId, req.tabId);
        break;
      case "reorder-tabs":
        await this.reorderTabs(req.correlationId, req.tabOrder);
        break;
      case "find-highlight":
        await this.findAndHighlightText(
          req.correlationId,
          req.tabId,
          req.queryPhrase
        );
        break;
      case "group-tabs":
        await this.groupTabs(
          req.correlationId,
          req.tabIds,
          req.isCollapsed,
          req.groupColor as browser.tabGroups.Color,
          req.groupTitle
        );
        break;
      case "move-tabs-to-window":
        await this.moveTabsToWindow(
          req.correlationId,
          req.tabIds,
          req.windowId
        );
        break;
      case "create-window":
        await this.createWindow(req.correlationId, req.tabIds);
        break;
      case "attach-tabs-to-parent":
        await this.attachTabsToParent(
          req.correlationId,
          req.tabIds,
          req.parentTabId
        );
        break;
      case "capture-screenshot":
        await this.captureScreenshot(
          req.correlationId,
          req.tabId,
          req.format,
          req.quality,
          req.scale
        );
        break;
      default:
        const _exhaustiveCheck: never = req;
        console.error("Invalid message received:", req);
    }
  }

  private async addAuditLogForReq(req: ServerMessageRequest) {
    // Get the URL in context (either from param or from the tab)
    let contextUrl: string | undefined;
    if ("url" in req && req.url) {
      contextUrl = req.url;
    }
    if ("tabId" in req) {
      try {
        const tab = await browser.tabs.get(req.tabId);
        contextUrl = tab.url;
      } catch (error) {
        console.error("Failed to get tab URL for audit log:", error);
      }
    }

    const toolId = COMMAND_TO_TOOL_ID[req.cmd];
    const auditEntry = {
      toolId,
      command: req.cmd,
      timestamp: Date.now(),
      url: contextUrl
    };
    
    await addAuditLogEntry(auditEntry);
  }

  private async openUrl(
    correlationId: string,
    url: string,
    parentTabId?: number
  ): Promise<void> {
    if (!url.startsWith("https://")) {
      console.error("Invalid URL:", url);
      throw new Error("Invalid URL");
    }

    if (await isDomainInDenyList(url)) {
      throw new Error("Domain in user defined deny list");
    }

    let options: { url: string; openerTabId?: number } = { url };

    // When Tree Style Tab is available, new tabs become children of the
    // opener tab. Use the explicitly requested parent, or the currently
    // active tab so the tab joins the tree the user is looking at.
    if (this.tst?.isAvailable()) {
      try {
        const openerTabId =
          parentTabId ?? (await this.getActiveTabId());
        if (openerTabId !== undefined) {
          options = { url, openerTabId };
        }
      } catch (error) {
        console.error("Failed to determine the opener tab for the new tab:", error);
      }
    }

    const tab = await browser.tabs.create(options);

    await this.client.sendResourceToServer({
      resource: "opened-tab-id",
      correlationId,
      tabId: tab.id,
    });
  }

  private async getActiveTabId(): Promise<number | undefined> {
    const [activeTab] = await browser.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    return activeTab?.id;
  }

  private async closeTabs(
    correlationId: string,
    tabIds: number[],
    keepChildren?: boolean,
    childPlacement: "promote" | "top-level" = "promote"
  ): Promise<void> {
    // With Tree Style Tab, closing a tab whose tree is collapsed would also
    // close its hidden child tabs. Use TST's command to close only the
    // specified tabs, keeping their children.
    if (keepChildren && this.tst?.isAvailable()) {
      await this.closeTabsKeepingChildren(correlationId, tabIds, childPlacement);
      return;
    }

    await browser.tabs.remove(tabIds);
    await this.client.sendResourceToServer({
      resource: "tabs-closed",
      correlationId,
    });
  }

  /**
   * Close the given tabs via Tree Style Tab, keeping their child tabs, and
   * report where the children actually ended up.
   *
   * TST's default ("promote-intelligently") makes the first child of a
   * closed root tab the new parent of its siblings, so closing a group tab
   * would build a deep subtree under one of its former members. Instead,
   * "promote-all" moves the children to the closed tab's parent (the top
   * level for a root tab), and "detach-all" always to the top level.
   *
   * TST acknowledges the command before it has re-parented the children,
   * so the tree is read back until it shows the expected placement. If it
   * does not settle in time, the response still reports the actual
   * placement, marked as unverified.
   */
  private async closeTabsKeepingChildren(
    correlationId: string,
    tabIds: number[],
    childPlacement: "promote" | "top-level"
  ): Promise<void> {
    const tst = this.tst!;
    const before = await this.readTree(await this.windowIdsOf(tabIds));

    const kept = await tst.removeTabsKeepingChildren(
      tabIds,
      childPlacement === "top-level" ? "detach-all" : "promote-all"
    );
    if (!kept) {
      // Do not fall back to tabs.remove: it would close the hidden children
      // of collapsed trees, the opposite of what was asked.
      throw new Error(
        `Tree Style Tab failed to close tabs ${tabIds.join(", ")} keeping ` +
          "their children; some of them may still have been closed, check " +
          "the tab list before retrying"
      );
    }

    if (!before) {
      await this.client.sendResourceToServer({
        resource: "tabs-closed",
        correlationId,
        verified: false,
      });
      return;
    }

    // The parent each kept child is expected to end up under (undefined:
    // top level). A closed tab inside another closed tab passes its
    // children on to the nearest ancestor that stays open.
    const closed = new Set(tabIds);
    const expectedParents = new Map<number, number | undefined>();
    const windowIds = new Set<number>();
    for (const tabId of tabIds) {
      let newParent = before.get(tabId)?.parentTabId;
      while (newParent !== undefined && closed.has(newParent)) {
        newParent = before.get(newParent)?.parentTabId;
      }
      for (const childId of before.get(tabId)?.childIds ?? []) {
        if (closed.has(childId)) continue;
        expectedParents.set(
          childId,
          childPlacement === "top-level" ? undefined : newParent
        );
        windowIds.add(before.get(childId)!.windowId);
      }
    }

    if (expectedParents.size === 0) {
      await this.client.sendResourceToServer({
        resource: "tabs-closed",
        correlationId,
        reparented: [],
        verified: true,
      });
      return;
    }

    const { tree, settled } = await this.waitForTree(windowIds, (tree) =>
      [...expectedParents].every(
        ([childId, parentId]) =>
          tree.has(childId) && tree.get(childId)!.parentTabId === parentId
      )
    );
    await this.client.sendResourceToServer({
      resource: "tabs-closed",
      correlationId,
      ...(tree
        ? {
            reparented: [...expectedParents.keys()]
              .filter((childId) => tree.has(childId))
              .map((childId) => ({
                tabId: childId,
                parentTabId: tree.get(childId)!.parentTabId ?? null,
              })),
          }
        : {}),
      verified: settled,
    });
  }

  /** The IDs of the windows the given tabs are in. */
  private async windowIdsOf(tabIds: number[]): Promise<Set<number>> {
    const wanted = new Set(tabIds);
    const windowIds = new Set<number>();
    for (const tab of await browser.tabs.query({})) {
      if (
        tab.id !== undefined &&
        tab.windowId !== undefined &&
        wanted.has(tab.id)
      ) {
        windowIds.add(tab.windowId);
      }
    }
    return windowIds;
  }

  /**
   * Read the Tree Style Tab tree of the given windows into a map from tab
   * ID to its place in the tree, in tree order. Returns null when the tree
   * of one of the windows cannot be read.
   */
  private async readTree(
    windowIds: Iterable<number>
  ): Promise<Map<number, TreeNode> | null> {
    const tst = this.tst;
    if (!tst) return null;
    const nodes = new Map<number, TreeNode>();
    for (const windowId of windowIds) {
      const roots = await tst.getLightTree(windowId);
      if (!roots) return null;
      const visit = (item: TstTreeItem, parentTabId: number | undefined): void => {
        const children = item.children ?? [];
        nodes.set(item.id, {
          windowId,
          parentTabId,
          childIds: children.map((child) => child.id),
        });
        for (const child of children) {
          visit(child, item.id);
        }
      };
      for (const root of roots) {
        visit(root, undefined);
      }
    }
    return nodes;
  }

  /**
   * Re-read the tree of the given windows until it satisfies the
   * predicate or the settle timeout passes. Tree Style Tab acknowledges
   * commands before it has finished re-arranging the tree, so a write's
   * effect is only visible after a moment. Returns the last tree read
   * (null if it could not be read) and whether it satisfied the predicate.
   */
  private async waitForTree(
    windowIds: Iterable<number>,
    predicate: (tree: Map<number, TreeNode>) => boolean
  ): Promise<{ tree: Map<number, TreeNode> | null; settled: boolean }> {
    const windows = [...windowIds];
    const deadline = Date.now() + TREE_SETTLE_TIMEOUT_MS;
    while (true) {
      const tree = await this.readTree(windows);
      if (tree && predicate(tree)) {
        return { tree, settled: true };
      }
      if (Date.now() >= deadline) {
        return { tree, settled: false };
      }
      await sleep(TREE_SETTLE_POLL_MS);
    }
  }

  private async sendTabs(correlationId: string): Promise<void> {
    let tabs = await browser.tabs.query({});

    if (!this.tst?.isAvailable()) {
      await this.client.sendResourceToServer({
        resource: "tabs",
        correlationId,
        tabs,
      });
      return;
    }

    // With Tree Style Tab available, the tabs are sent in tree order with
    // their tree structure, instead of a flat list. The tab list and TST's
    // tree briefly disagree while TST is still processing a change, so a
    // mismatch is retried before falling back to the flat list.
    let treeTabs = await this.buildTreeTabList(tabs);
    for (
      let attempt = 0;
      treeTabs === null && attempt < TAB_LIST_TREE_RETRIES;
      attempt++
    ) {
      await sleep(TAB_LIST_TREE_RETRY_DELAY_MS);
      tabs = await browser.tabs.query({});
      treeTabs = await this.buildTreeTabList(tabs);
    }

    await this.client.sendResourceToServer({
      resource: "tabs",
      correlationId,
      tabs: treeTabs ?? tabs,
      treeAvailable: treeTabs !== null,
    });
  }

  /**
   * Merge the tab data with the Tree Style Tab tree structure, returning
   * the tabs in depth-first (tree) order with the tree fields populated.
   * Returns `null` when the two views do not agree (a tab is missing on
   * one side), so the caller can fall back to the flat list.
   */
  private async buildTreeTabList(
    tabs: browser.tabs.Tab[]
  ): Promise<BrowserTab[] | null> {
    const tst = this.tst;
    if (!tst) return null;

    const tabsById = new Map<number, browser.tabs.Tab>();
    for (const tab of tabs) {
      if (tab.id !== undefined) {
        tabsById.set(tab.id, tab);
      }
    }

    const windowIds = new Set<number>();
    for (const tab of tabs) {
      if (tab.windowId !== undefined) {
        windowIds.add(tab.windowId);
      }
    }

    const windowTrees: TstTreeItem[][] = [];
    for (const tree of await Promise.all(
      [...windowIds].map((windowId) => tst.getLightTree(windowId))
    )) {
      if (tree === null) {
        // The tree query failed for one of the windows.
        return null;
      }
      windowTrees.push(tree);
    }

    const result: BrowserTab[] = [];
    let mismatch = false;

    const visit = (
      item: TstTreeItem,
      depth: number,
      parentTabId: number | undefined
    ): void => {
      const tab = tabsById.get(item.id);
      if (!tab) {
        // TST reported a tab that is not in the open tabs list.
        mismatch = true;
        return;
      }
      tabsById.delete(item.id);
      const states = item.states ?? [];
      result.push({
        id: tab.id,
        url: tab.url,
        title: tab.title,
        lastAccessed: tab.lastAccessed,
        windowId: tab.windowId,
        active: tab.active,
        discarded: tab.discarded,
        depth,
        parentTabId,
        childCount: item.children?.length ?? 0,
        // TST applies "subtree-collapsed" to a tab whose own subtree is
        // collapsed (the visible branch point whose children are hidden),
        // and "collapsed" to the descendant tabs that are thereby hidden.
        // We surface the former: it marks the branch where children are
        // hidden. Hidden descendants are still listed by get-light-tree.
        collapsed: states.includes("subtree-collapsed"),
      });
      for (const child of item.children ?? []) {
        visit(child, depth + 1, item.id);
      }
    };

    for (const tree of windowTrees) {
      for (const root of tree) {
        visit(root, 0, undefined);
      }
    }

    // A tab that was in the open tabs list but not in the tree (e.g. a tab
    // opened in between the two queries, or an incognito tab we cannot see).
    if (mismatch || tabsById.size > 0) {
      return null;
    }
    return result;
  }

  private async sendRecentHistory(
    correlationId: string,
    searchQuery: string | null = null
  ): Promise<void> {
    const historyItems = await browser.history.search({
      text: searchQuery ?? "", // Search for all URLs (empty string matches everything)
      maxResults: 200, // Limit to 200 results
      startTime: 0, // Search from the beginning of time
    });
    const filteredHistoryItems = historyItems.filter((item) => {
      return !!item.url;
    });
    await this.client.sendResourceToServer({
      resource: "history",
      correlationId,
      historyItems: filteredHistoryItems,
    });
  }

  // Check that the user has granted permission to access the URL's domain.
  // This will open the options page with a URL parameter to request permission
  // and throw an error to indicate that the request cannot proceed until permission is granted.
  private async checkForUrlPermission(url: string | undefined): Promise<void> {
    if (url) {
      const origin = new URL(url).origin;
      const granted = await browser.permissions.contains({
        origins: [`${origin}/*`],
      });

      if (!granted) {
        // Open the options page with a URL parameter to request permission:
        const optionsUrl = browser.runtime.getURL("options.html");
        const urlWithParams = `${optionsUrl}?requestUrl=${encodeURIComponent(
          url
        )}`;

        await browser.tabs.create({ url: urlWithParams });
        throw new Error(
          `The user has not yet granted permission to access the domain "${origin}". A dialog is now being opened to request permission. If the user grants permission, you can try the request again.`
        );
      }
    }
  }

  private async checkForGlobalPermission(permissions: string[]): Promise<void> {
    const granted = await browser.permissions.contains({
      permissions,
    });

    if (!granted) {
      // Open the options page with a URL parameter to request permission:
      const optionsUrl = browser.runtime.getURL("options.html");
      const urlWithParams = `${optionsUrl}?requestPermissions=${encodeURIComponent(
        JSON.stringify(permissions)
      )}`;

      await browser.tabs.create({ url: urlWithParams });
      throw new Error(
        `The user has not yet granted permission for the following operations: ${permissions.join(
          ", "
        )}. A dialog is now being opened to request permission. If the user grants permission, you can try the request again.`
      );
    }
  }

  // Firefox unloads (discards) background tabs to free memory; such tabs
  // must be reloaded before their content can be read. Reload the tab and
  // wait until it reports its load status as "complete". The onUpdated
  // listener is registered before the reload so the completion event
  // cannot be missed.
  private waitForTabComplete(
    tabId: number,
    timeoutMs: number
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      // Latches on the first settle, so a late timeout or reload error
      // can never settle the promise a second time.
      let settled = false;
      const settle = (
        error: unknown,
        success: boolean
      ): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        browser.tabs.onUpdated.removeListener(onComplete);
        if (success) {
          resolve();
        } else {
          reject(
            error instanceof Error ? error : new Error(String(error))
          );
        }
      };
      const onComplete = (
        updatedTabId: number,
        changeInfo: { status?: string }
      ): void => {
        if (updatedTabId === tabId && changeInfo.status === "complete") {
          settle(undefined, true);
        }
      };
      const timeout = setTimeout(() => {
        settle(
          new Error(`Timed out waiting for tab ${tabId} to finish loading`),
          false
        );
      }, timeoutMs);
      browser.tabs.onUpdated.addListener(onComplete);
      browser.tabs
        .reload(tabId)
        .catch((error: unknown) => settle(error, false));
    });
  }

  // Wait until a reloaded tab reports a settled state: status "complete"
  // and a real http(s) URL. The onUpdated "complete" event can fire while
  // the tab still reports a transitional URL (e.g. about:blank) during
  // document swap-in, and injecting a script into such a document fails;
  // poll briefly until the tab settles on its final URL.
  private async waitForTabUrlSettled(
    tabId: number,
    timeoutMs: number
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let tab: browser.tabs.Tab;
      try {
        tab = await browser.tabs.get(tabId);
      } catch (error) {
        // The tab was closed in the meantime; no point waiting.
        throw error instanceof Error ? error : new Error(String(error));
      }
      const url = tab.url;
      if (
        tab.status === "complete" &&
        typeof url === "string" &&
        (url.startsWith("http://") || url.startsWith("https://"))
      ) {
        return;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for tab ${tabId} to settle on a final URL after reload`
        );
      }
      await sleep(TAB_URL_SETTLE_POLL_MS);
    }
  }

  // Run the extraction script, retrying briefly on Firefox's generic
  // "Missing host permission for the tab" rejection: after reloading a
  // discarded tab the document may still be settling, in which case the
  // error is a navigation race (Firefox bug 2047009), not a permission
  // problem. If the error persists, re-run the permission check against
  // the settled URL so a redirect to an ungranted origin produces the
  // usual options-dialog flow instead of Firefox's raw rejection.
  private async executeTabScript(tabId: number, details: { code: string }) {
    let lastError: unknown;
    const attempts = TAB_SCRIPT_RETRY_DELAYS_MS.length + 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) {
        await sleep(TAB_SCRIPT_RETRY_DELAYS_MS[attempt - 1]);
      }
      try {
        return await browser.tabs.executeScript(tabId, details);
      } catch (error) {
        lastError = error;
        if (!isHostPermissionError(error)) {
          throw error instanceof Error ? error : new Error(String(error));
        }
      }
    }
    try {
      const tab = await browser.tabs.get(tabId);
      await this.checkForUrlPermission(tab.url);
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(String(lastError));
  }

  private async loadTab(correlationId: string, tabId: number): Promise<void> {
    const tab = await browser.tabs.get(tabId);
    if (tab.discarded) {
      await this.waitForTabComplete(tabId, TAB_LOAD_TIMEOUT_MS);
      await this.waitForTabUrlSettled(tabId, TAB_URL_SETTLE_TIMEOUT_MS);
    }
    await this.client.sendResourceToServer({
      resource: "tab-loaded",
      correlationId,
      tabId,
    });
  }

  private async sendTabsContent(
    correlationId: string,
    tabId: number,
    offset?: number
  ): Promise<void> {
    const tab = await browser.tabs.get(tabId);
    if (tab.url && (await isDomainInDenyList(tab.url))) {
      throw new Error(`Domain in tab URL is in the deny list`);
    }

    // A discarded (unloaded) tab has no content to read; reload it and
    // wait for it to finish loading before running the extraction script.
    // Reloading a tab does not require the domain's permission, so it
    // happens even when the domain has not been granted yet.
    let loaded = false;
    if (tab.discarded) {
      await this.waitForTabComplete(tabId, TAB_LOAD_TIMEOUT_MS);
      await this.waitForTabUrlSettled(tabId, TAB_URL_SETTLE_TIMEOUT_MS);
      loaded = true;
    }

    // Check the permission against the URL the tab is actually on when
    // the extraction script runs: after a reload it may have changed
    // (e.g. a redirect), and the deny list must hold for that URL too.
    let contentUrl = tab.url;
    if (loaded) {
      const settledTab = await browser.tabs.get(tabId);
      contentUrl = settledTab.url;
      if (settledTab.url && (await isDomainInDenyList(settledTab.url))) {
        throw new Error(`Domain in tab URL is in the deny list`);
      }
    }

    await this.checkForUrlPermission(contentUrl);

    const MAX_CONTENT_LENGTH = 50_000;
    const results = await this.executeTabScript(tabId, {
      code: `
      (function () {
        function getLinks() {
          const linkElements = document.querySelectorAll('a[href]');
          return Array.from(linkElements).map(el => ({
            url: el.href,
            text: el.innerText.trim() || el.getAttribute('aria-label') || el.getAttribute('title') || ''
          })).filter(link => link.text !== '' && link.url.startsWith('https://') && !link.url.includes('#'));
        }

        function getTextContent() {
          let isTruncated = false;
          let text = document.body.innerText.substring(${Number(offset) || 0});
          if (text.length > ${MAX_CONTENT_LENGTH}) {
            text = text.substring(0, ${MAX_CONTENT_LENGTH});
            isTruncated = true;
          }
          return {
            text, isTruncated
          }
        }

        const textContent = getTextContent();

        return {
          links: getLinks(),
          fullText: textContent.text,
          isTruncated: textContent.isTruncated,
          totalLength: document.body.innerText.length
        };
      })();
    `,
    });
    const { isTruncated, fullText, links, totalLength } = results[0];
    await this.client.sendResourceToServer({
      resource: "tab-content",
      tabId,
      correlationId,
      isTruncated,
      fullText,
      links,
      totalLength,
      // Only present when a discarded tab had to be reloaded to get its content.
      ...(loaded ? { loaded: true } : {}),
    });
  }

  private async reorderTabs(
    correlationId: string,
    tabOrder: number[]
  ): Promise<void> {
    const reordered = await this.reorderTabsViaTst(tabOrder);

    if (!reordered) {
      // Fall back to the standard API, moving the tabs one by one. TST's
      // autofixing usually keeps the tree structure intact, but it can be
      // fragile when several tabs are moved in quick succession.
      for (let newIndex = 0; newIndex < tabOrder.length; newIndex++) {
        const tabId = tabOrder[newIndex];
        await browser.tabs.move(tabId, { index: newIndex });
      }
    }

    await this.client.sendResourceToServer({
      resource: "tabs-reordered",
      correlationId,
      tabOrder,
    });
  }

  /**
   * Reorder the tabs using Tree Style Tab's move commands, which move a tab
   * together with its child tabs. Returns true when the reorder was applied
   * and false when no TST move was applied yet (TST unavailable, tabs in
   * different windows, the first move failed), so the caller can fall back
   * to the standard API. Throws when a move fails after earlier moves were
   * already applied: the tab tree was partially reordered by TST at that
   * point, and moving the tabs via the standard API on top of it would fight
   * TST's tree autofixing, so the partial order is left in place instead.
   */
  private async reorderTabsViaTst(tabOrder: number[]): Promise<boolean> {
    const tst = this.tst;
    if (!tst || !tst.isAvailable() || tabOrder.length === 0) {
      return false;
    }

    let applied = 0;
    try {
      // TST's move commands only work within a single window.
      const windowIds = new Set<number>();
      for (const tabId of tabOrder) {
        const tab = await browser.tabs.get(tabId);
        if (tab.windowId === undefined) {
          return false;
        }
        windowIds.add(tab.windowId);
      }
      if (windowIds.size > 1) {
        return false;
      }

      if (!(await tst.moveTabToStart(tabOrder[0]))) {
        return false;
      }
      applied = 1;
      for (let i = 1; i < tabOrder.length; i++) {
        if (!(await tst.moveTabAfter(tabOrder[i], tabOrder[i - 1]))) {
          break;
        }
        applied++;
      }
      if (applied === tabOrder.length) {
        return true;
      }
    } catch (error) {
      console.error("Failed to reorder tabs via Tree Style Tab:", error);
    }

    if (applied === 0) {
      // No TST move was applied, so the standard API fallback cannot
      // conflict with TST's tree.
      return false;
    }
    throw new Error(
      `Reordering tabs via Tree Style Tab failed after ${applied} of ` +
        `${tabOrder.length} moves were applied; the partial order was left ` +
        `in place because the standard API fallback would conflict with ` +
        `Tree Style Tab's tree`
    );
  }

  /**
   * Move the given tabs to a different window, appending them to the end
   * of that window. Uses the standard tabs API, which can move tabs
   * across windows (TST's move commands cannot); index -1 places each tab
   * at the end of the target window, preserving the given order. The
   * child tabs of a moved tab stay behind in the source window; move them
   * separately.
   */
  private async moveTabsToWindow(
    correlationId: string,
    tabIds: number[],
    windowId: number
  ): Promise<void> {
    for (const tabId of tabIds) {
      await browser.tabs.move(tabId, { windowId, index: -1 });
    }
    await this.client.sendResourceToServer({
      resource: "tabs-moved-to-window",
      correlationId,
      tabIds,
      windowId,
    });
  }

  /**
   * Create a new browser window and, when given, move the tabs into it
   * in the given order. A new window is created first and the tabs are
   * moved into it one by one (Firefox's windows.create does not accept
   * multiple existing tabs); without tabs, the window contains only the
   * new tab that Firefox opens by default. Firefox opens every new window
   * with a single default tab, so when tabs are given that default tab is
   * closed again after the moves, leaving exactly the given tabs behind.
   *
   * Firefox closes a window that is left without tabs. A source window
   * that holds only the tab being moved out of it would therefore close
   * itself during the move, and the rollback below could no longer move
   * the tab back to it. Such a window is given a throwaway about:blank
   * placeholder tab before the move so it stays open; the placeholders
   * are closed again at the end of both the success and the failure
   * path, so on success the now-empty source window closes itself (as it
   * would without the placeholders) and on failure the restored tab
   * occupies the window again.
   *
   * If a move fails partway through, the tabs that were already moved
   * into the new window are moved back to their original window and
   * index first (in reverse order, best effort per tab) and only then is
   * the new window removed, so no user tab is lost. If a tab cannot be
   * moved back (e.g. its original window is gone), the new window is kept
   * open instead — closing it would close those tabs as well, since
   * Firefox closes a window together with all of its tabs — and the
   * rethrown error carries the original failure and the new window ID so
   * the caller knows where the tabs ended up.
   */
  private async createWindow(
    correlationId: string,
    tabIds: number[]
  ): Promise<void> {
    const newWindow = await browser.windows.create({});
    const windowId = newWindow.id;
    if (windowId === undefined) {
      throw new Error("Failed to create window: no window ID returned");
    }
    let defaultTabId: number | undefined;
    // Original window and index of every tab about to be moved, so the
    // tabs that are already in the new window can be moved back there
    // again when a later move fails.
    const originalPositions = new Map<
      number,
      { windowId: number; index: number }
    >();
    const movedTabIds: number[] = [];
    // Throwaway placeholder tabs (see the JSDoc): one per source window
    // that would be left without tabs by the move, so the window cannot
    // close itself before a failed move is rolled back.
    const placeholderTabIds: number[] = [];
    try {
      // Firefox opens every new window with a single default tab. Remember
      // it now, before any of the given tabs are moved in, so it can be
      // closed afterwards without touching any other tab.
      if (tabIds.length > 0) {
        const initialTabs = await browser.tabs.query({ windowId });
        if (initialTabs.length === 1) {
          defaultTabId = initialTabs[0].id;
        }
        // Snapshot the current position of the requested tabs with a
        // single query for all tabs (each Tab carries windowId and
        // index).
        const allTabs = await browser.tabs.query({});
        const tabsPerWindow = new Map<number, number>();
        for (const tab of allTabs) {
          if (tab.windowId !== undefined) {
            tabsPerWindow.set(
              tab.windowId,
              (tabsPerWindow.get(tab.windowId) ?? 0) + 1
            );
          }
        }
        for (const tab of allTabs) {
          if (
            tab.id !== undefined &&
            tab.windowId !== undefined &&
            tabIds.includes(tab.id)
          ) {
            originalPositions.set(tab.id, {
              windowId: tab.windowId,
              index: tab.index,
            });
          }
        }
        // Give every source window that would be left without tabs a
        // placeholder tab so it stays open for the duration of the
        // command (see the JSDoc).
        const sourceWindowIds = new Set<number>();
        for (const position of originalPositions.values()) {
          sourceWindowIds.add(position.windowId);
        }
        for (const sourceWindowId of sourceWindowIds) {
          if (tabsPerWindow.get(sourceWindowId) === 1) {
            const placeholder = await browser.tabs.create({
              windowId: sourceWindowId,
              url: "about:blank",
            });
            if (placeholder.id !== undefined) {
              placeholderTabIds.push(placeholder.id);
            }
          }
        }
      }
      for (const tabId of tabIds) {
        await browser.tabs.move(tabId, { windowId, index: -1 });
        movedTabIds.push(tabId);
      }
      if (defaultTabId !== undefined) {
        await browser.tabs.remove(defaultTabId).catch(() => {
          // Best effort: the tab may already be gone; the window then
          // simply contains the given tabs.
        });
      }
      // The placeholders have served their purpose; a source window
      // that is left without tabs afterwards closes itself.
      await this.removePlaceholderTabs(placeholderTabIds);
    } catch (error) {
      // A move failed while some tabs are already in the new window.
      // Firefox's windows.remove closes a window together with all of
      // its tabs, so the moved tabs are moved back to their original
      // window and index first (in reverse order so the indices line up
      // again), and only then is the window removed.
      let allRestored = true;
      for (const tabId of [...movedTabIds].reverse()) {
        const original = originalPositions.get(tabId);
        if (!original) {
          // Should not happen (the snapshot precedes the moves), but
          // with no known original position the tab must not be lost by
          // closing the new window either.
          console.error(
            `No original position recorded for tab ${tabId}; it cannot ` +
              `be restored to its original window`
          );
          allRestored = false;
          continue;
        }
        try {
          await browser.tabs.move(tabId, {
            windowId: original.windowId,
            index: original.index,
          });
        } catch (restoreError) {
          console.error(
            `Failed to move tab ${tabId} back to window ` +
              `${original.windowId} at index ${original.index}:`,
            restoreError
          );
          allRestored = false;
        }
      }
      // Remove the placeholders again; the restored tabs (if any) keep
      // their source windows open on their own.
      await this.removePlaceholderTabs(placeholderTabIds);
      if (!allRestored) {
        // The moved tabs are still in the new window and could not be
        // restored; keep the window open so they are not closed, and
        // report where they are.
        const originalMessage =
          error instanceof Error ? error.message : String(error);
        console.error(
          `Could not restore the moved tabs after: ${originalMessage}; ` +
            `keeping the new window ${windowId} open`
        );
        throw new Error(
          `Could not restore the moved tabs after: ${originalMessage}; ` +
            `the moved tabs are in the new window ${windowId}`
        );
      }
      console.error(
        "Failed to populate the new window, removing the window:",
        error
      );
      await browser.windows.remove(windowId).catch(() => {
        // Best effort: the window may already be gone; the original
        // error takes precedence.
      });
      throw error;
    }
    await this.client.sendResourceToServer({
      resource: "window-created",
      correlationId,
      windowId,
      tabIds,
    });
  }

  /**
   * Close the throwaway placeholder tabs again, best effort per tab: a
   * placeholder may already be gone, and a source window that is left
   * without tabs afterwards closes itself (intended on the success path).
   */
  private async removePlaceholderTabs(
    placeholderIds: number[]
  ): Promise<void> {
    for (const placeholderId of placeholderIds) {
      await browser.tabs.remove(placeholderId).catch(() => {
        // Best effort: the placeholder may already be gone.
      });
    }
  }

  /**
   * Attach the given tabs as child tabs of the parent tab in the Tree
   * Style Tab tree, re-parenting them from their current parent.
   * Requires Tree Style Tab: the standard WebExtensions API has no
   * equivalent. The tabs and the parent tab must be in the same window.
   *
   * If an attach fails partway through, the tabs that were already
   * attached are re-attached to their original parent first (in reverse
   * order, best effort per tab) so the tree is not left partially
   * re-parented. A tab at the root level of its window has no parent to
   * re-attach to, so it is moved to the start of the window instead (root
   * level again, though possibly a different position). If a tab cannot
   * be restored, the rethrown error notes that the tree may be partially
   * re-parented.
   */
  private async attachTabsToParent(
    correlationId: string,
    tabIds: number[],
    parentTabId: number
  ): Promise<void> {
    const tst = this.tst;
    if (!tst || !tst.isAvailable()) {
      throw new Error(
        "Attaching tabs to a parent tab requires Tree Style Tab, which is not available"
      );
    }
    // Original parent of every tab about to be moved, so the tabs that were
    // already attached can be re-attached to it when a later attach fails.
    const originalParents = await this.snapshotTabParents(tabIds);
    let attachedCount = 0;
    try {
      for (const tabId of tabIds) {
        if (!(await tst.attachTabToParent(tabId, parentTabId))) {
          throw new Error(
            `Failed to attach tab ${tabId} to tab ${parentTabId} via Tree Style Tab ` +
              "(both tabs must exist and be in the same window)"
          );
        }
        attachedCount++;
      }
    } catch (error) {
      // An attach failed while some tabs are already children of the new
      // parent. Re-attach them to their original parent first (in reverse
      // order so the tree returns to a consistent state, best effort per
      // tab).
      let allRestored = true;
      for (let i = attachedCount - 1; i >= 0; i--) {
        const tabId = tabIds[i];
        const originalParent = originalParents.get(tabId);
        const restored =
          originalParent !== undefined
            ? await tst.attachTabToParent(tabId, originalParent)
            : await tst.moveTabToStart(tabId);
        if (!restored) {
          console.error(
            `Failed to restore tab ${tabId} to its original position after: ` +
              (error instanceof Error ? error.message : String(error))
          );
          allRestored = false;
        }
      }
      if (!allRestored) {
        const originalMessage =
          error instanceof Error ? error.message : String(error);
        console.error(
          `Could not restore the attached tabs after: ${originalMessage}; ` +
            `the tab tree may be partially re-parented`
        );
        throw new Error(
          `Could not restore the attached tabs after: ${originalMessage}; ` +
            `the tab tree may be partially re-parented`
        );
      }
      if (attachedCount > 0) {
        console.error(
          `Failed to attach tabs to a parent, restoring ` +
            `${attachedCount} already-attached tab(s):`,
          error
        );
      }
      throw error;
    }
    await this.client.sendResourceToServer({
      resource: "tabs-attached-to-parent",
      correlationId,
      tabIds,
      parentTabId,
    });
  }

  /**
   * Map the given tabs to the tab they are currently children of in the
   * Tree Style Tab tree. Tabs at the root level of their window, and tabs
   * that cannot be located in the tree, are left out of the map.
   */
  private async snapshotTabParents(
    tabIds: number[]
  ): Promise<Map<number, number>> {
    const wanted = new Set(tabIds);
    const parents = new Map<number, number>();
    if (wanted.size === 0) {
      return parents;
    }

    // The light tree is per window, so first find the windows of the tabs
    // with a single query for all tabs.
    const allTabs = await browser.tabs.query({});
    const windowIds = new Set<number>();
    for (const tab of allTabs) {
      if (
        tab.id !== undefined &&
        tab.windowId !== undefined &&
        wanted.has(tab.id)
      ) {
        windowIds.add(tab.windowId);
      }
    }
    for (const windowId of windowIds) {
      const tree = await this.tst?.getLightTree(windowId);
      if (!tree) {
        continue;
      }
      const visit = (item: TstTreeItem, parent: number | undefined): void => {
        if (wanted.has(item.id) && parent !== undefined) {
          parents.set(item.id, parent);
        }
        for (const child of item.children ?? []) {
          visit(child, item.id);
        }
      };
      for (const item of tree) {
        visit(item, undefined);
      }
    }
    return parents;
  }

  private async findAndHighlightText(
    correlationId: string,
    tabId: number,
    queryPhrase: string
  ): Promise<void> {
    const tab = await browser.tabs.get(tabId);

    if (tab.url && (await isDomainInDenyList(tab.url))) {
      throw new Error(`Domain in tab URL is in the deny list`);
    }

    await this.checkForGlobalPermission(["find"]);

    const findResults = await browser.find.find(queryPhrase, {
      tabId,
      caseSensitive: true,
    });

    // If there are results, highlight them
    if (findResults.count > 0) {
      // But first, activate the tab. In firefox, this would also enable
      // auto-scrolling to the highlighted result.
      await browser.tabs.update(tabId, { active: true });
      browser.find.highlightResults({
        tabId,
      });
    }

    await this.client.sendResourceToServer({
      resource: "find-highlight-result",
      correlationId,
      noOfResults: findResults.count,
    });
  }

  private async captureScreenshot(
    correlationId: string,
    tabId: number,
    format: "jpeg" | "png" = "jpeg",
    quality: number = 70,
    scale: number = 1
  ): Promise<void> {
    const tab = await browser.tabs.get(tabId);

    if (tab.url && (await isDomainInDenyList(tab.url))) {
      throw new Error(`Domain in tab URL is in the deny list`);
    }

    if (!hasCaptureConsent(tabId, tab.url)) {
      await markTabAsAwaitingConsent(tabId);
      throw new Error(
        `The user has not authorized screenshots of tab ${tabId} ("${
          tab.title ?? tab.url
        }"). The extension's toolbar button is now marked with a "!" badge on that tab. ` +
          `Ask the user to click the Browser Control MCP button in the Firefox toolbar while that tab is open, then try again. ` +
          `The authorization covers only that tab, and ends when the tab navigates or closes.`
      );
    }

    if (tab.windowId === undefined) {
      throw new Error(`Tab ${tabId} does not belong to a window`);
    }

    // captureVisibleTab() captures whichever tab is active in the window, and activeTab is
    // only granted for the tab the user clicked, so the target tab has to be foregrounded
    // first. Restore the previous tab afterwards so the capture is not disruptive.
    const restoreTabId = tab.active
      ? undefined
      : await this.activateTabForCapture(tabId, tab.windowId);

    try {
      let dataUrl: string;
      try {
        dataUrl = await browser.tabs.captureVisibleTab(tab.windowId, {
          format,
          quality,
          scale,
        });
      } catch (error) {
        // The browser is the real enforcer of the activeTab grant, so it can still refuse
        // even when the tracked consent looks valid.
        throw new Error(
          `Firefox refused to capture tab ${tabId}: ${
            error instanceof Error ? error.message : String(error)
          }. Capturing with per-tab authorization requires Firefox 126 or later. ` +
            `Otherwise, ask the user to click the extension's toolbar button on that tab again.`
        );
      }
      const { mimeType, imageData } = parseImageDataUrl(dataUrl);
      await this.client.sendResourceToServer({
        resource: "screenshot",
        correlationId,
        tabId,
        imageData,
        mimeType,
      });
    } finally {
      if (restoreTabId !== undefined) {
        try {
          await browser.tabs.update(restoreTabId, { active: true });
        } catch (error) {
          console.error("Failed to restore the previously active tab:", error);
        }
      }
    }
  }

  // Foregrounds the tab to be captured, returning the tab that was active before, if any.
  private async activateTabForCapture(
    tabId: number,
    windowId: number
  ): Promise<number | undefined> {
    const [previouslyActive] = await browser.tabs.query({
      active: true,
      windowId,
    });
    await browser.tabs.update(tabId, { active: true });
    await new Promise((resolve) => setTimeout(resolve, TAB_PAINT_DELAY_MS));
    return previouslyActive?.id;
  }

  private async groupTabs(
    correlationId: string,
    tabIds: number[],
    isCollapsed: boolean,
    groupColor: browser.tabGroups.Color,
    groupTitle: string
  ): Promise<void> {
    // When Tree Style Tab is available, create a TST group tab instead of a
    // native tab group. The TST API has no color parameter, so the color is
    // ignored on this path.
    if (this.tst?.isAvailable()) {
      await this.groupTabsViaTst(correlationId, tabIds, isCollapsed, groupTitle);
      return;
    }

    const nativeGroupId = await browser.tabs.group({
      tabIds,
    });

    let tabGroup = await browser.tabGroups.update(nativeGroupId, {
      collapsed: isCollapsed,
      color: groupColor,
      title: groupTitle,
    });

    await this.client.sendResourceToServer({
      resource: "new-tab-group",
      correlationId,
      groupId: tabGroup.id,
    });
  }

  /**
   * Group the tabs under a new Tree Style Tab group tab and report the
   * group's actual membership and position, read back from the tree.
   *
   * TST acknowledges the command before it has finished moving the tabs,
   * and can leave some of them out, so the tree is read back until every
   * requested tab is in the group (directly or below another grouped tab).
   *
   * TST creates the group tab under the parent of the first grouped tab.
   * When the grouped tabs did not all share that parent, this nests the
   * group inside an unrelated tree, so the group tab is moved under the
   * parent the tabs shared, or to the top level when they shared none.
   */
  private async groupTabsViaTst(
    correlationId: string,
    tabIds: number[],
    isCollapsed: boolean,
    groupTitle: string
  ): Promise<void> {
    const tst = this.tst!;
    const windowIds = await this.windowIdsOf(tabIds);
    const before = await this.readTree(windowIds);

    const groupId = await tst.createGroup(tabIds, groupTitle);
    if (groupId === null) {
      // Do not fall back to native tab groups: after a timeout TST may
      // still apply the grouping, and the two would fight over the tabs.
      throw new Error(
        `Tree Style Tab failed to create the group "${groupTitle}"; it may ` +
          "still have been created, check the tab list before retrying"
      );
    }

    const isMember = (tree: Map<number, TreeNode>, tabId: number): boolean => {
      let parentId = tree.get(tabId)?.parentTabId;
      while (parentId !== undefined) {
        if (parentId === groupId) return true;
        parentId = tree.get(parentId)?.parentTabId;
      }
      return false;
    };
    const grouping = await this.waitForTree(windowIds, (tree) =>
      tabIds.every((tabId) => isMember(tree, tabId))
    );
    let tree = grouping.tree;
    let verified = grouping.settled;

    if (before && tree?.has(groupId)) {
      const originalParents = new Set(
        tabIds.map((tabId) => before.get(tabId)?.parentTabId)
      );
      const expectedParent =
        originalParents.size === 1 ? [...originalParents][0] : undefined;
      if (tree.get(groupId)!.parentTabId !== expectedParent) {
        const moved =
          expectedParent === undefined
            ? await tst.detachTab(groupId)
            : await tst.attachTabToParent(groupId, expectedParent);
        if (!moved) {
          console.error(
            `Failed to move group tab ${groupId} out of the tree TST created it in`
          );
        }
        const placing = await this.waitForTree(
          windowIds,
          (tree) => tree.get(groupId)?.parentTabId === expectedParent
        );
        tree = placing.tree;
        verified = verified && placing.settled;
      }
    }

    // Collapse the group's tree if requested. TST reports success even
    // when the group has no (or not enough) child tabs to collapse.
    if (isCollapsed) {
      await tst.collapseTree(groupId);
    }

    await this.client.sendResourceToServer({
      resource: "new-tab-group",
      correlationId,
      groupId,
      ...(tree
        ? {
            memberTabIds: tabIds.filter((tabId) => isMember(tree, tabId)),
            missingTabIds: tabIds.filter((tabId) => !isMember(tree, tabId)),
            parentTabId: tree.get(groupId)?.parentTabId ?? null,
          }
        : {}),
      verified,
    });
  }
}

function parseImageDataUrl(dataUrl: string): {
  mimeType: string;
  imageData: string;
} {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl);
  if (!match) {
    throw new Error("The browser returned a screenshot in an unexpected format");
  }
  return { mimeType: match[1], imageData: match[2] };
}
