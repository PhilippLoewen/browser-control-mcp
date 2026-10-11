import type {
  BrowserTab,
  OpenedTabIdExtensionMessage,
  TabGroupCreatedExtensionMessage,
  TabsClosedExtensionMessage,
} from "@browser-control-mcp/common";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";

dayjs.extend(relativeTime);

export interface TabListPage {
  offset: number;
  limit: number;
}

const NOT_SETTLED_NOTE =
  "The tab tree had not settled when this was checked; verify with get-list-of-open-tabs";

/**
 * The tab list as text items: a pagination line, a warning when Tree Style
 * Tab's tree could not be matched to the tab list, and one line per tab,
 * indented by its depth in the tree.
 */
export function formatTabListText(
  tabs: BrowserTab[],
  { offset, limit }: TabListPage,
  treeAvailable: boolean | undefined
): { type: "text"; text: string }[] {
  const pageTabs = tabs.slice(offset, offset + limit);
  const hasMore = offset + limit < tabs.length;
  const items = [
    {
      type: "text" as const,
      text: `Showing tabs ${offset + 1}-${offset + pageTabs.length} of ${tabs.length} total tabs${hasMore ? ` (use offset=${offset + limit} to see more)` : ''}`,
    },
  ];
  if (treeAvailable === false) {
    items.push({
      type: "text",
      text:
        "Note: Tree Style Tab's tree could not be matched to the tab list (it may still be updating), " +
        "so the tabs are listed flat, without their tree structure. Request the list again to get the tree.",
    });
  }

  for (const tab of pageTabs) {
    let lastAccessed = "unknown";
    if (tab.lastAccessed) {
      lastAccessed = dayjs(tab.lastAccessed).fromNow(); // LLM-friendly time ago
    }
    const markers: string[] = [];
    if (tab.active) {
      markers.push("[active]");
    }
    if (tab.childCount) {
      markers.push(`[${tab.childCount} child tab${tab.childCount === 1 ? "" : "s"}]`);
    }
    if (tab.collapsed) {
      markers.push("[collapsed]");
    }
    if (tab.discarded) {
      markers.push("[discarded]");
    }
    const markerSuffix = markers.length > 0 ? ` ${markers.join(" ")}` : "";
    const parent = tab.parentTabId !== undefined ? `, tab parent=${tab.parentTabId}` : "";
    items.push({
      type: "text",
      text: `${"  ".repeat(tab.depth ?? 0)}tab id=${tab.id}, tab window=${tab.windowId ?? "unknown"}${parent}, tab url=${tab.url}, tab title=${tab.title}, last accessed=${lastAccessed}${markerSuffix}`,
    });
  }
  return items;
}

/**
 * The tab list as a JSON document. Tree fields are null when the list
 * carries no tree structure ("tree": false).
 */
export function formatTabListJson(
  tabs: BrowserTab[],
  { offset, limit }: TabListPage,
  treeAvailable: boolean | undefined
): string {
  return JSON.stringify({
    total: tabs.length,
    offset,
    limit,
    hasMore: offset + limit < tabs.length,
    tree: treeAvailable === true,
    tabs: tabs.slice(offset, offset + limit).map((tab) => ({
      id: tab.id,
      window: tab.windowId ?? null,
      depth: tab.depth ?? null,
      parent: tab.parentTabId ?? null,
      url: tab.url,
      title: tab.title,
      childCount: tab.childCount ?? null,
      collapsed: tab.collapsed ?? null,
      active: tab.active ?? false,
      discarded: tab.discarded ?? false,
      lastAccessed: tab.lastAccessed ?? null,
    })),
  });
}

/**
 * The result of grouping tabs. With Tree Style Tab, it reports the
 * membership read back from the tree, and is an error when some of the
 * requested tabs did not end up in the group.
 */
export function formatGroupResult(
  groupTitle: string,
  tabIds: number[],
  group: Omit<TabGroupCreatedExtensionMessage, "resource" | "correlationId">
): { text: string; isError: boolean } {
  if (group.verified === undefined) {
    // A native tab group.
    return {
      text: `Created tab group "${groupTitle}" with ${tabIds.length} tabs (group ID: ${group.groupId})`,
      isError: false,
    };
  }
  if (!group.memberTabIds || !group.missingTabIds) {
    return {
      text:
        `Created tab group "${groupTitle}" (group tab id ${group.groupId}); its membership ` +
        "could not be verified because the tab tree could not be read, check it with get-list-of-open-tabs",
      isError: false,
    };
  }

  const position =
    group.parentTabId === null || group.parentTabId === undefined
      ? "at the top level"
      : `nested under tab ${group.parentTabId}`;
  let text =
    `Created tab group "${groupTitle}" (group tab id ${group.groupId}) with ` +
    `${group.memberTabIds.length} of ${tabIds.length} tabs, ${position}`;
  if (group.intendedParentTabId !== undefined) {
    text +=
      group.intendedParentTabId === null
        ? ". Tree Style Tab kept the group tab there, although it should be at the top level " +
          "(the grouped tabs shared no parent); moving it did not take effect"
        : ". Tree Style Tab kept the group tab there, although the grouped tabs shared parent " +
          `tab ${group.intendedParentTabId}; moving it did not take effect`;
  }
  if (group.missingTabIds.length > 0) {
    text += `. NOT grouped: ${group.missingTabIds.join(", ")}`;
  }
  if (!group.verified) {
    text += `. ${NOT_SETTLED_NOTE}`;
  }
  return { text, isError: group.missingTabIds.length > 0 };
}

/**
 * The result of opening a tab. With Tree Style Tab, a child tab's parent
 * is read back from the tree, so the result says where the tab actually is.
 */
export function formatOpenResult(
  url: string,
  opened: Omit<OpenedTabIdExtensionMessage, "resource" | "correlationId">
): string {
  const text = `${url} opened in tab id ${opened.tabId}`;
  if (opened.verified === undefined) {
    return text;
  }
  if (opened.parentTabId === undefined) {
    return (
      `${text}; its place in the tab tree could not be verified (the tree could not be read, ` +
      "or the tab was not listed in the tab tree yet); check it with get-list-of-open-tabs"
    );
  }
  const position =
    opened.parentTabId === null ? "at the top level" : `under tab ${opened.parentTabId}`;
  if (opened.verified) {
    return `${text}, ${position}`;
  }
  return (
    `${text}, ${position}: Tree Style Tab had not attached it to the requested parent ` +
    "when this was checked; verify with get-list-of-open-tabs"
  );
}

/**
 * The result of closing tabs, including where kept child tabs ended up
 * when Tree Style Tab reported it.
 */
export function formatCloseResult(
  closed: Omit<TabsClosedExtensionMessage, "resource" | "correlationId">
): string {
  if (!closed.reparented) {
    return closed.verified === false
      ? "Closed tabs; where the kept child tabs ended up could not be verified because the tab tree could not be read"
      : "Closed tabs";
  }
  if (closed.reparented.length === 0) {
    return "Closed tabs";
  }
  const placements = closed.reparented
    .map(({ tabId, parentTabId }) =>
      parentTabId === null
        ? `tab ${tabId} at the top level`
        : `tab ${tabId} under tab ${parentTabId}`
    )
    .join(", ");
  let text = `Closed tabs. Kept child tabs: ${placements}`;
  if (!closed.verified) {
    text += `. ${NOT_SETTLED_NOTE}`;
  }
  return text;
}
