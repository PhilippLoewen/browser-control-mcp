export interface ExtensionMessageBase {
  resource: string;
  correlationId: string;
}

export interface TabContentExtensionMessage extends ExtensionMessageBase {
  resource: "tab-content";
  tabId: number;
  fullText: string;
  isTruncated: boolean;
  totalLength: number;
  links: { url: string; text: string }[];
  /** Set when the tab was discarded (unloaded) and had to be reloaded to fetch its content. */
  loaded?: boolean;
}

export interface BrowserTab {
  id?: number;
  url?: string;
  title?: string;
  lastAccessed?: number;
  windowId?: number;
  active?: boolean;
  /** Whether the tab was discarded (unloaded) by the browser to free memory. */
  discarded?: boolean;
  /** Tree Style Tab integration: depth of the tab in the tab tree (0 = root tab). */
  depth?: number;
  /** Tree Style Tab integration: the ID of the tab this tab is a child of. */
  parentTabId?: number;
  /** Tree Style Tab integration: number of child tabs (0 when the tab has no children). */
  childCount?: number;
  /** Tree Style Tab integration: whether the child tabs of this tab are currently hidden (collapsed tree). */
  collapsed?: boolean;
}

export interface TabsExtensionMessage extends ExtensionMessageBase {
  resource: "tabs";
  tabs: BrowserTab[];
  /**
   * Set when Tree Style Tab is available: true when the tabs carry the tree
   * structure, false when the tree could not be matched to the tab list and
   * a flat list without tree fields was sent instead.
   */
  treeAvailable?: boolean;
}

export interface OpenedTabIdExtensionMessage extends ExtensionMessageBase {
  resource: "opened-tab-id";
  tabId: number | undefined;
}

export interface TabLoadedExtensionMessage extends ExtensionMessageBase {
  resource: "tab-loaded";
  tabId: number;
}

export interface BrowserHistoryItem {
  url?: string;
  title?: string;
  lastVisitTime?: number;
}

export interface BrowserHistoryExtensionMessage extends ExtensionMessageBase {
  resource: "history";

  historyItems: BrowserHistoryItem[];
}

export interface ReorderedTabsExtensionMessage extends ExtensionMessageBase {
  resource: "tabs-reordered";
  tabOrder: number[];
}

export interface FindHighlightExtensionMessage extends ExtensionMessageBase {
  resource: "find-highlight-result";
  noOfResults: number;
}

/** Where a tab ended up in the Tree Style Tab tree after a write. */
export interface TabPlacement {
  tabId: number;
  /** The tab's parent tab, or null when it is at the top level. */
  parentTabId: number | null;
}

export interface TabsClosedExtensionMessage extends ExtensionMessageBase {
  resource: "tabs-closed";
  /**
   * Tree Style Tab integration, keepChildren only: the kept child tabs and
   * the parent each one actually ended up under, read back from the tree.
   * Absent when the tree could not be read.
   */
  reparented?: TabPlacement[];
  /**
   * Tree Style Tab integration, keepChildren only: whether the tree
   * settled into the expected placement before the response was sent.
   */
  verified?: boolean;
}

export interface TabGroupCreatedExtensionMessage extends ExtensionMessageBase {
  resource: "new-tab-group";
  /** The Tree Style Tab group tab ID, or the native tab group ID. */
  groupId: number;
  /**
   * Tree Style Tab integration: the requested tabs that are in the group,
   * and those that are not, read back from the tree. Absent when the tree
   * could not be read.
   */
  memberTabIds?: number[];
  missingTabIds?: number[];
  /** Tree Style Tab integration: the group tab's parent, or null at the top level. */
  parentTabId?: number | null;
  /**
   * Tree Style Tab integration: set when TST placed the group tab under a
   * different parent than the one the grouped tabs shared (null: the top
   * level) and moving it there did not take effect.
   */
  intendedParentTabId?: number | null;
  /**
   * Tree Style Tab integration: whether the tree settled into the expected
   * state (all tabs grouped, group tab placed) before the response was sent.
   */
  verified?: boolean;
}

export interface TabsMovedToWindowExtensionMessage extends ExtensionMessageBase {
  resource: "tabs-moved-to-window";
  tabIds: number[];
  windowId: number;
}

export interface WindowCreatedExtensionMessage extends ExtensionMessageBase {
  resource: "window-created";
  windowId: number;
  tabIds: number[];
}

export interface TabsAttachedToParentExtensionMessage extends ExtensionMessageBase {
  resource: "tabs-attached-to-parent";
  tabIds: number[];
  parentTabId: number;
}

export interface ScreenshotExtensionMessage extends ExtensionMessageBase {
  resource: "screenshot";
  tabId: number;
  // Base64-encoded image, without the data-URL prefix
  imageData: string;
  mimeType: string;
}

export type ExtensionMessage =
  | TabContentExtensionMessage
  | TabsExtensionMessage
  | OpenedTabIdExtensionMessage
  | TabLoadedExtensionMessage
  | BrowserHistoryExtensionMessage
  | ReorderedTabsExtensionMessage
  | FindHighlightExtensionMessage
  | TabsClosedExtensionMessage
  | TabGroupCreatedExtensionMessage
  | TabsMovedToWindowExtensionMessage
  | WindowCreatedExtensionMessage
  | TabsAttachedToParentExtensionMessage
  | ScreenshotExtensionMessage;

export interface ExtensionError {
  correlationId: string;
  errorMessage: string;
}