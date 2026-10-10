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
}

export interface BrowserTab {
  id?: number;
  url?: string;
  title?: string;
  lastAccessed?: number;
  windowId?: number;
  active?: boolean;
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
}

export interface OpenedTabIdExtensionMessage extends ExtensionMessageBase {
  resource: "opened-tab-id";
  tabId: number | undefined;
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

export interface TabsClosedExtensionMessage extends ExtensionMessageBase {
  resource: "tabs-closed";
}

export interface TabGroupCreatedExtensionMessage extends ExtensionMessageBase {
  resource: "new-tab-group";
  groupId: number;
}

export interface TabsMovedToWindowExtensionMessage extends ExtensionMessageBase {
  resource: "tabs-moved-to-window";
  tabIds: number[];
  windowId: number;
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
  | BrowserHistoryExtensionMessage
  | ReorderedTabsExtensionMessage
  | FindHighlightExtensionMessage
  | TabsClosedExtensionMessage
  | TabGroupCreatedExtensionMessage
  | TabsMovedToWindowExtensionMessage
  | TabsAttachedToParentExtensionMessage
  | ScreenshotExtensionMessage;

export interface ExtensionError {
  correlationId: string;
  errorMessage: string;
}