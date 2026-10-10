import type {
  ExtensionMessage,
  ServerMessage,
} from "@browser-control-mcp/common";

// Default budget for an extension round trip. Commands that need more
// time carry an explicit budget in BROKER_COMMANDS.
export const DEFAULT_EXTENSION_RESPONSE_TIMEOUT_MS = 1000;
// With Tree Style Tab available, fetching the tab list requires one TST
// round trip per window, so it may take noticeably longer than the other
// commands.
export const TAB_LIST_RESPONSE_TIMEOUT_MS = 5000;
// Moving tabs across windows and attaching tabs in the Tree Style Tab
// tree involve a round trip per tab, so allow more time than the default.
export const TAB_STRUCTURE_RESPONSE_TIMEOUT_MS = 5000;
// Capturing may foreground the tab, wait for it to paint, encode the image
// and transfer a payload orders of magnitude larger than the other responses.
export const SCREENSHOT_RESPONSE_TIMEOUT_MS = 10000;

export type BrokerCommand = ServerMessage["cmd"];

// The response resource each command produces, checked against the
// extension protocol at compile time.
type BrokerCommandResources = {
  "open-tab": "opened-tab-id";
  "close-tabs": "tabs-closed";
  "get-tab-list": "tabs";
  "get-browser-recent-history": "history";
  "get-tab-content": "tab-content";
  "reorder-tabs": "tabs-reordered";
  "find-highlight": "find-highlight-result";
  "group-tabs": "new-tab-group";
  "move-tabs-to-window": "tabs-moved-to-window";
  "create-window": "window-created";
  "attach-tabs-to-parent": "tabs-attached-to-parent";
  "capture-screenshot": "screenshot";
} & Record<BrokerCommand, ExtensionMessage["resource"]>;

export interface BrokerCommandSpec<Command extends BrokerCommand = BrokerCommand> {
  resource: BrokerCommandResources[Command];
  // Timeout budget for the leader's extension round trip.
  timeoutMs: number;
  // Validates the forwarded payload before the leader handles it.
  validate: (message: Record<string, unknown>) => boolean;
}

// Single source of truth for the commands the singleton broker forwards
// between BrowserAPI instances: the response resource each command
// produces, its timeout budget, and how the forwarded payload is
// validated. Adding a brokerable command is a single entry here.
export const BROKER_COMMANDS: {
  [Command in BrokerCommand]: BrokerCommandSpec<Command>;
} = {
  "open-tab": {
    resource: "opened-tab-id",
    timeoutMs: DEFAULT_EXTENSION_RESPONSE_TIMEOUT_MS,
    validate: (message) => typeof message.url === "string",
  },
  "close-tabs": {
    resource: "tabs-closed",
    timeoutMs: DEFAULT_EXTENSION_RESPONSE_TIMEOUT_MS,
    validate: (message) => isNumberArray(message.tabIds),
  },
  "get-tab-list": {
    resource: "tabs",
    timeoutMs: TAB_LIST_RESPONSE_TIMEOUT_MS,
    validate: () => true,
  },
  "get-browser-recent-history": {
    resource: "history",
    timeoutMs: DEFAULT_EXTENSION_RESPONSE_TIMEOUT_MS,
    validate: (message) =>
      message.searchQuery === undefined ||
      typeof message.searchQuery === "string",
  },
  "get-tab-content": {
    resource: "tab-content",
    timeoutMs: DEFAULT_EXTENSION_RESPONSE_TIMEOUT_MS,
    validate: (message) =>
      isNumber(message.tabId) &&
      (message.offset === undefined || isNumber(message.offset)),
  },
  "reorder-tabs": {
    resource: "tabs-reordered",
    timeoutMs: DEFAULT_EXTENSION_RESPONSE_TIMEOUT_MS,
    validate: (message) => isNumberArray(message.tabOrder),
  },
  "find-highlight": {
    resource: "find-highlight-result",
    timeoutMs: DEFAULT_EXTENSION_RESPONSE_TIMEOUT_MS,
    validate: (message) =>
      isNumber(message.tabId) && typeof message.queryPhrase === "string",
  },
  "group-tabs": {
    resource: "new-tab-group",
    timeoutMs: DEFAULT_EXTENSION_RESPONSE_TIMEOUT_MS,
    validate: (message) =>
      isNumberArray(message.tabIds) &&
      typeof message.isCollapsed === "boolean" &&
      typeof message.groupColor === "string" &&
      typeof message.groupTitle === "string",
  },
  "move-tabs-to-window": {
    resource: "tabs-moved-to-window",
    timeoutMs: TAB_STRUCTURE_RESPONSE_TIMEOUT_MS,
    validate: (message) =>
      isNumberArray(message.tabIds) && isNumber(message.windowId),
  },
  "create-window": {
    resource: "window-created",
    timeoutMs: TAB_STRUCTURE_RESPONSE_TIMEOUT_MS,
    validate: (message) => isNumberArray(message.tabIds),
  },
  "attach-tabs-to-parent": {
    resource: "tabs-attached-to-parent",
    timeoutMs: TAB_STRUCTURE_RESPONSE_TIMEOUT_MS,
    validate: (message) =>
      isNumberArray(message.tabIds) && isNumber(message.parentTabId),
  },
  "capture-screenshot": {
    resource: "screenshot",
    timeoutMs: SCREENSHOT_RESPONSE_TIMEOUT_MS,
    validate: (message) =>
      isNumber(message.tabId) &&
      (message.format === undefined ||
        message.format === "jpeg" ||
        message.format === "png") &&
      (message.quality === undefined || isNumber(message.quality)) &&
      (message.scale === undefined || isNumber(message.scale)),
  },
};

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every(isNumber);
}

// The broker command carried by a message of unknown shape, or undefined
// when the message carries no brokerable command. Uses an own-property
// check so names inherited from Object.prototype, such as "constructor",
// never match.
export function getBrokerCommand(message: unknown): BrokerCommand | undefined {
  if (typeof message !== "object" || message === null) {
    return undefined;
  }
  const command = (message as Record<string, unknown>).cmd;
  return typeof command === "string" && Object.hasOwn(BROKER_COMMANDS, command)
    ? (command as BrokerCommand)
    : undefined;
}
