import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { BrowserAPI } from "./browser-api";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";

dayjs.extend(relativeTime);

const mcpServer = new McpServer({
  name: "BrowserControl",
  version: "1.6.0",
});

mcpServer.tool(
  "open-browser-tab",
  "Open a new tab in the user's browser (useful when the user asks to open a website). The url must be a full https:// URL — other schemes (http://, about:blank, file://) are rejected by the browser. When Tree Style Tab is installed and enabled, the new tab becomes a child of the active tab, or of the tab given as parentTabId if provided.",
  {
    url: z.string(),
    parentTabId: z
      .number()
      .optional()
      .describe("Open the tab as a child of this tab (Tree Style Tab only; defaults to the active tab)"),
  },
  async ({ url, parentTabId }) => {
    const openedTabId = await browserApi.openTab(url, parentTabId);
    if (openedTabId !== undefined) {
      return {
        content: [
          {
            type: "text",
            text: `${url} opened in tab id ${openedTabId}`,
          },
        ],
      };
    } else {
      return {
        content: [{ type: "text", text: "Failed to open tab", isError: true }],
      };
    }
  }
);

mcpServer.tool(
  "close-browser-tabs",
  "Close tabs in the user's browser by tab IDs. When Tree Style Tab is installed and enabled, use keepChildren to close only the given tabs and keep their child tabs (otherwise closing a collapsed tree would close its hidden children too).",
  {
    tabIds: z.array(z.number()),
    keepChildren: z
      .boolean()
      .default(false)
      .describe("Keep the child tabs of the closed tabs (Tree Style Tab only; defaults to false)"),
  },
  async ({ tabIds, keepChildren }) => {
    await browserApi.closeTabs(tabIds, keepChildren);
    return {
      content: [{ type: "text", text: "Closed tabs" }],
    };
  }
);

mcpServer.tool(
  "get-list-of-open-tabs",
  "Get the list of open tabs in the user's browser. Use offset and limit parameters for pagination when there are many tabs. When Tree Style Tab is installed and enabled, tabs are listed in tree order, indented by their depth, with markers for the active tab, the number of child tabs, and collapsed subtrees (collapsed = the tab's child tabs are hidden). Each tab line includes the ID of the window the tab belongs to.",
  {
    offset: z.number().int().min(0).default(0).describe("Starting index for pagination (0-based, must be >= 0)"),
    limit: z.number().default(100).describe("Maximum number of tabs to return (default: 100, max: 500)"),
  },
  async ({ offset, limit }) => {
    // Validate and cap the limit
    const effectiveLimit = Math.min(Math.max(1, limit), 500);

    const openTabs = await browserApi.getTabList();
    const totalTabs = openTabs.length;

    // Apply pagination
    const paginatedTabs = openTabs.slice(offset, offset + effectiveLimit);
    const hasMore = offset + effectiveLimit < totalTabs;

    // Add pagination info as the first content item
    const paginationInfo = {
      type: "text" as const,
      text: `Showing tabs ${offset + 1}-${offset + paginatedTabs.length} of ${totalTabs} total tabs${hasMore ? ` (use offset=${offset + effectiveLimit} to see more)` : ''}`,
    };

    const tabContent = paginatedTabs.map((tab) => {
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
      const markerSuffix = markers.length > 0 ? ` ${markers.join(" ")}` : "";
      return {
        type: "text" as const,
        text: `${"  ".repeat(tab.depth ?? 0)}tab id=${tab.id}, tab window=${tab.windowId ?? "unknown"}, tab url=${tab.url}, tab title=${tab.title}, last accessed=${lastAccessed}${markerSuffix}`,
      };
    });

    return {
      content: [paginationInfo, ...tabContent],
    };
  }
);

mcpServer.tool(
  "get-recent-browser-history",
  "Get the list of recent browser history (to get all, don't use searchQuery)",
  { searchQuery: z.string().optional() },
  async ({ searchQuery }) => {
    const browserHistory = await browserApi.getBrowserRecentHistory(
      searchQuery
    );
    if (browserHistory.length > 0) {
      return {
        content: browserHistory.map((item) => {
          let lastVisited = "unknown";
          if (item.lastVisitTime) {
            lastVisited = dayjs(item.lastVisitTime).fromNow(); // LLM-friendly time ago
          }
          return {
            type: "text",
            text: `url=${item.url}, title="${item.title}", lastVisitTime=${lastVisited}`,
          };
        }),
      };
    } else {
      // If nothing was found for the search query, hint the AI to list
      // all the recent history items instead.
      const hint = searchQuery ? "Try without a searchQuery" : "";
      return { content: [{ type: "text", text: `No history found. ${hint}` }] };
    }
  }
);

mcpServer.tool(
  "get-tab-web-content",
  `
    Get the full text content of the webpage and the list of links in the webpage, by tab ID. 
    Use "offset" only for larger documents when the first call was truncated and if you require more content in order to assist the user.
  `,
  { tabId: z.number(), offset: z.number().default(0) },
  async ({ tabId, offset }) => {
    const content = await browserApi.getTabContent(tabId, offset);
    let links: { type: "text"; text: string }[] = [];
    if (offset === 0) {
      // Only include the links if offset is 0 (default value). Otherwise, we can
      // assume this is not the first call. Adding the links again would be redundant.
      links = content.links.map((link: { text: string; url: string }) => {
        return {
          type: "text",

          text: `Link text: ${link.text}, Link URL: ${link.url}`,
        };
      });
    }

    let text = content.fullText;
    let hint: { type: "text"; text: string }[] = [];
    if (content.isTruncated || offset > 0) {
      // If the content is truncated, add a "tip" suggesting
      // that another tool, search in page, can be used to
      // discover additional data.
      const rangeString = `${offset}-${offset + text.length}`;
      hint = [
        {
          type: "text",
          text:
            `The following text content is truncated due to size (includes character range ${rangeString} out of ${content.totalLength}). ` +
            "If you want to read characters beyond this range, please use the 'get-tab-web-content' tool with an offset. ",
        },
      ];
    }

    return {
      content: [...hint, { type: "text", text }, ...links],
    };
  }
);

mcpServer.tool(
  "reorder-browser-tabs",
  "Change the order of open browser tabs",
  { tabOrder: z.array(z.number()) },
  async ({ tabOrder }) => {
    const newOrder = await browserApi.reorderTabs(tabOrder);
    return {
      content: [
        { type: "text", text: `Tabs reordered: ${newOrder.join(", ")}` },
      ],
    };
  }
);

mcpServer.tool(
  "find-highlight-in-browser-tab",
  "Find and highlight text in a browser tab (use a query phrase that exists in the web content)",
  { tabId: z.number(), queryPhrase: z.string() },
  async ({ tabId, queryPhrase }) => {
    const noOfResults = await browserApi.findHighlight(tabId, queryPhrase);
    return {
      content: [
        {
          type: "text",
          text: `Number of results found and highlighted in the tab: ${noOfResults}`,
        },
      ],
    };
  }
);

mcpServer.tool(
  "group-browser-tabs",
  "Organize opened browser tabs in a new tab group. When Tree Style Tab is installed and enabled, a Tree Style Tab group is created instead (the groupColor option is then ignored), and isCollapsed collapses that group's tree.",
  {
    tabIds: z.array(z.number()),
    isCollapsed: z.boolean().default(false),
    groupColor: z
      .enum([
        "grey",
        "blue",
        "red",
        "yellow",
        "green",
        "pink",
        "purple",
        "cyan",
        "orange",
      ])
      .default("grey"),
    groupTitle: z.string().default("New Group"),
  },
  async ({ tabIds, isCollapsed, groupColor, groupTitle }) => {
    const groupId = await browserApi.groupTabs(
      tabIds,
      isCollapsed,
      groupColor,
      groupTitle
    );
    return {
      content: [
        {
          type: "text",
          text: `Created tab group "${groupTitle}" with ${tabIds.length} tabs (group ID: ${groupId})`,
        },
      ],
    };
  }
);

mcpServer.tool(
  "move-tab-to-window",
  "Move one or more browser tabs to a different window. The target window ID is shown in the get-list-of-open-tabs output. When Tree Style Tab is installed, the child tabs of a moved tab stay in the source window; move the child tabs separately if needed.",
  {
    tabIds: z.array(z.number()),
    windowId: z
      .number()
      .describe("ID of the target window, as shown in the get-list-of-open-tabs output"),
  },
  async ({ tabIds, windowId }) => {
    await browserApi.moveTabsToWindow(tabIds, windowId);
    return {
      content: [
        {
          type: "text",
          text: `Moved tabs ${tabIds.join(", ")} to window ${windowId}`,
        },
      ],
    };
  }
);

mcpServer.tool(
  "create-window",
  "Create a new browser window, optionally moving the given tabs into it in the given order. If no tabs are given, the window opens with a single new tab. If tabs are given, the window's own default tab is closed so it contains exactly the moved tabs. Returns the ID of the new window. If a move fails, the already-moved tabs are restored to their original windows and the new window is closed; if a tab cannot be restored, the new window is left open and its ID is reported in the error. When Tree Style Tab is installed, the child tabs of a moved tab stay in the source window; move the child tabs separately if needed.",
  {
    tabIds: z
      .array(z.number())
      .default([])
      .describe("IDs of the tabs to move into the new window; omit for a window with only a new tab"),
  },
  async ({ tabIds }) => {
    const windowId = await browserApi.createWindow(tabIds);
    return {
      content: [
        {
          type: "text",
          text:
            tabIds.length > 0
              ? `Created window ${windowId} with tabs ${tabIds.join(", ")}`
              : `Created window ${windowId} with a new tab`,
        },
      ],
    };
  }
);

mcpServer.tool(
  "attach-tabs-to-parent",
  "Attach one or more tabs as child tabs of a parent tab in the Tree Style Tab tree, re-parenting them from their current parent (e.g. to merge two tab trees into one group). Requires Tree Style Tab to be installed and enabled; the tabs and the parent tab must be in the same window. If an attach fails partway, the tabs that were already attached are restored to their previous position first, so the tab tree is not left partially re-parented.",
  {
    tabIds: z.array(z.number()),
    parentTabId: z
      .number()
      .describe("The tab the given tabs become children of, e.g. a group tab"),
  },
  async ({ tabIds, parentTabId }) => {
    await browserApi.attachTabsToParent(tabIds, parentTabId);
    return {
      content: [
        {
          type: "text",
          text: `Attached tabs ${tabIds.join(", ")} to tab ${parentTabId}`,
        },
      ],
    };
  }
);

mcpServer.tool(
  "capture-tab-screenshot",
  `
    Capture a screenshot of the visible area of a browser tab, by tab ID.
    The user must authorize each tab by clicking the extension's toolbar button while that tab is open.
    If the tab is not authorized, this tool returns an error explaining what to ask the user to do; relay that
    request to the user and retry afterwards. Authorization ends when the tab navigates or closes.
    Capturing brings the tab to the foreground momentarily.
  `,
  {
    tabId: z.number(),
    format: z
      .enum(["jpeg", "png"])
      .default("jpeg")
      .describe("Use png only when exact pixel fidelity matters, as it is much larger"),
    quality: z
      .number()
      .int()
      .min(10)
      .max(100)
      .default(70)
      .describe("JPEG quality, ignored for png"),
    scale: z
      .number()
      .min(0.1)
      .max(2)
      .default(1)
      .describe("Image scale relative to CSS pixels, lower values produce smaller images"),
  },
  async ({ tabId, format, quality, scale }) => {
    const screenshot = await browserApi.captureScreenshot(
      tabId,
      format,
      quality,
      scale
    );
    return {
      content: [
        {
          type: "image",
          data: screenshot.imageData,
          mimeType: screenshot.mimeType,
        },
      ],
    };
  }
);

const browserApi = new BrowserAPI();
browserApi.init().catch((err) => {
  console.error("Browser API init error", err);
  process.exit(1);
});

const transport = new StdioServerTransport();
mcpServer.connect(transport).catch((err) => {
  console.error("MCP Server connection error", err);
  process.exit(1);
});

process.stdin.on("close", async () => {
  await browserApi.close();
  mcpServer.close();
  process.exit(0);
});
