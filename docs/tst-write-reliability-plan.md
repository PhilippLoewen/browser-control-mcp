# Tree Style Tab write reliability: findings and plan

Status: verified against the code at `f25539e`. No changes have been made yet.

Scope: the silent partial `group-browser-tabs` failures, the nested group tab,
the `close-browser-tabs({keepChildren: true})` reparenting, and stale reads
seen in a production session (about 77 tabs, 2 windows, sequential awaited
calls).

The tool entry point `mcp-server/dist/server.js` is built from
`mcp-server/server.ts`. The server only relays calls. The TST logic lives in
the Firefox extension (`firefox-extension/message-handler.ts`,
`firefox-extension/tst-client.ts`). Most fixes therefore go into the
extension, not the server.

TST source references are to `piroor/treestyletab` trunk
(`webextensions/background/tabs-group.js`,
`webextensions/background/handle-misc.js`,
`webextensions/common/tabs-internal-operation.js`) and to the
[API wiki](https://github.com/piroor/treestyletab/wiki/API-for-other-addons).

---

## (a) Verdicts

### H1: tree writes report the requested result without reading it back. **Confirmed**

- `group-browser-tabs` builds its success text from the *input*:
  `with ${tabIds.length} tabs` (`mcp-server/server.ts:265`). The only value
  that comes back is `groupId` (`mcp-server/browser-api.ts:369-380`,
  `common/extension-messages.ts:77-80`).
- The extension treats any TST response with a numeric `id` as success
  (`firefox-extension/tst-client.ts:115-124`). It forwards that id without
  checking the children (`firefox-extension/message-handler.ts:1203-1216`).
  The optional `collapseTree` result is ignored (`:1208-1210`).
- TST's `group-tabs` handler returns the exported group tab whether or not
  every child was attached (`handle-misc.js:1036-1044`, `tabs-group.js:80-125`).
  `TSTAPI.getTargetTabs` silently drops unknown ids. So
  "group tab created" does not mean "all requested tabs are members".
- `close-browser-tabs` always answers `"Closed tabs"` (`server.ts:54-59`).
  The extension sends `tabs-closed` without checking where the children
  ended up (`message-handler.ts:216-235`).
- `reorder-browser-tabs` echoes the requested `tabOrder`
  (`message-handler.ts:641-645`, `server.ts:210`).
  `move-tab-to-window` echoes its input too (`message-handler.ts:725-730`).
- `attach-tabs-to-parent` also has no read-back
  (`message-handler.ts:966-974`, `:1017-1022`). It is more reliable because
  it checks TST's per-tab `attach` result (`tst-client.ts:170-180`). TST
  resolves `attach` only after `Tree.attachTabTo` finishes, and it is one
  tab per call. That matches the observation that attach never lied.

### H2: writes resolve before the tree settles, and nothing serializes them. **Confirmed, with nuance**

What *is* awaited: the server awaits the extension's response
(`browser-api.ts:463-500`), and the extension awaits TST's `sendMessage`
reply (`tst-client.ts:192-204`). In a sequential agent script, the next
tool call is therefore not sent before the previous response. The problem
is what that response means, plus three ways requests can still overlap:

1. **TST replies before its tree work has settled.**
   - `remove-tab-keeping-children` (`handle-misc.js:1153-1168`) calls
     `TabsInternalOperation.removeTabs`. That function only flags the tabs and
     stores **one per-window** `win.keepDescendantsBehavior`
     (`tabs-internal-operation.js:149-160`) before removing them. The
     children are re-parented later, in TST's `tabs.onRemoved` handling,
     after `true` has already been returned. A `group-tabs` call that follows
     immediately can run while that re-parenting is still in progress.
     **This matches the "10 closes, then 10 groups → all groups empty" run.**
   - `group-tabs` moves the tabs with real `tabs.move` calls
     (`TabsMove.moveTabsAfter`, `tabs-group.js:112`). TST's own moved-tab
     handling ("autofix") reacts to those moves asynchronously. A temporary
     group tab (we always pass `temporary: true`, `tst-client.ts:120`) also
     runs a delayed cleanup 100 ms later (`tabs-group.js:127-141`), which can
     remove the group tab.
2. **There is no serialization in the extension.** `WebsocketClient` calls the
   message callback without awaiting it (`firefox-extension/client.ts:60`).
   The callback in `background.ts:21-32` is async, and `MessageHandler` has
   no queue or lock (`message-handler.ts:54-132`). The broker leader also
   forwards requests from several MCP clients concurrently
   (`browser-api.ts:502-514`). Requests therefore overlap whenever a second
   request arrives before the first one finishes. That happens with multiple
   MCP clients, or with item 3.
3. **Server timeouts are shorter than TST operations.** `group-tabs` and
   `close-tabs` use the 1000 ms default (`mcp-server/broker-commands.ts:8`,
   `:63-67`, `:100-108`). With 33 tabs, the work can exceed that. When it
   does, the server rejects the call, but the extension **keeps running** the
   old request. The caller's next write then overlaps with it.
   - The late reply is also mishandled: `handleDecodedExtensionMessage`
     destructures `this.extensionRequestMap.get(correlationId)!`, which is
     `undefined` once the request has timed out (`browser-api.ts:516-532`).
     The same applies to `handleExtensionError`.
4. **A TST timeout silently degrades later calls.** A TST command that takes
   longer than `TST_REQUEST_TIMEOUT_MS = 3000` (`tst-client.ts:20`) marks TST
   unavailable (`tst-client.ts:199-203`). The integration then stays off
   until a TST `ready` message or the 30 s retry (`tst-client.ts:22`,
   `:278-292`). During that time:
   - `groupTabs` falls back to native `browser.tabs.group`
     (`message-handler.ts:1218-1237`) and still reports "Created tab group".
   - `closeTabs` falls back to plain `tabs.remove` (`:218-221`). That
     **closes the hidden children of collapsed trees**, which is the opposite
     of `keepChildren`.
   - TST may still finish the original timed-out command in the background.

   The production session can't confirm or rule this out. The extension
   console would show `"Tree Style Tab integration disabled (TST unavailable)"`
   or `"falling back to native tab groups"` if it happened.

Why a list-read between batches "fixed everything": it adds latency (one TST
`get-light-tree` round trip per window, `message-handler.ts:280-289`), so
TST's pending `onRemoved`/`onMoved` handling finishes before the next write.
That is consistent with cause 1. It is luck, not a guarantee.

### H3: structured JSON output for `get-list-of-open-tabs`. **Feasible, and the data already exists**

- `BrowserTab` already carries `id`, `windowId`, `url`, `title`, `depth`,
  `parentTabId`, `childCount`, `collapsed`, `active`, `discarded`, and
  `lastAccessed` (`common/extension-messages.ts:17-34`). The extension fills
  these in tree order (`message-handler.ts:294-327`).
- The server already receives all of it (`browser-api.ts:324-331`). It just
  formats each tab as an indented text line and **drops `parentTabId`**
  (`server.ts:86-109`).
- The change is server-only. Add a parameter `format: "text" | "json"`
  (default `"text"`, so existing behavior stays the same), and return one
  text content item containing JSON:

  ```json
  {
    "total": 77, "offset": 0, "limit": 100, "hasMore": false,
    "tree": true,
    "tabs": [
      { "id": 12, "window": 1, "depth": 0, "parent": null, "url": "…", "title": "…",
        "childCount": 3, "collapsed": false, "active": false, "discarded": true,
        "lastAccessed": 1760000000000 }
    ]
  }
  ```
- Caveat to expose explicitly: `buildTreeTabList` returns `null` when
  `tabs.query` and TST's tree disagree (a tab missing on either side,
  `message-handler.ts:336-341`). In that case `sendTabs` **silently sends the
  flat list** (`:250`), with no depth or parent. That disagreement is exactly
  what happens while the tree is unsettled. Two fixes:
  - Add `treeAvailable: boolean` to `TabsExtensionMessage`
    (`common/extension-messages.ts:36-39`), and surface it as `"tree"` in JSON
    and as a warning line in text mode, so a flat fallback is never mistaken
    for "everything is top level".
  - Retry the tree build once or twice after a short delay before falling
    back (see Step 2).

### H4: `close-browser-tabs` with keepChildren reparents under a neighbor. **Confirmed, and the server controls it**

- The extension calls `this.tst.removeTabsKeepingChildren(tabIds)` without a
  method (`message-handler.ts:217`). That defaults to `"promote-intelligently"`
  (`tst-client.ts:153-156`).
- Per the TST wiki and `handle-misc.js:1156-1159`, `promote-intelligently` is
  *"Same as `promote-first` if the closed tab has any sibling tabs or closed
  tab is a root level tab"*. `promote-first` *"Promotes the first left child as
  the new parent of rest children."*
- A group tab at the top level is a root-level tab. Closing it therefore makes
  its **first child** a root tab and attaches the other 20 children under it.
  That first child is the "neighboring top-level content tab" in the report,
  and the result is the fake 21-tab subtree. This is the documented default
  behavior, and we control it by passing a different method.
- Top-level placement is achievable with existing TST methods:
  - `promote-all`: children go to the grandparent, or to the top level when
    the closed tab was a root.
  - `detach-all`: always the top level; each child keeps its own subtree.
- Caveats:
  - TST stores `keepDescendantsBehavior` once per window
    (`tabs-internal-operation.js:159-160`), so concurrent closes in one window
    can affect each other. Step 1 prevents that.
  - The existing fallback to `tabs.remove` when TST fails
    (`message-handler.ts:218-231`) would close hidden children of collapsed
    trees. With `keepChildren: true`, the fallback should be an error instead.

### Where the new group tab's position is decided (nested group tab)

The position is decided by TST, not by us.
`TabsGroup.groupTabs` opens the group tab with
`parent: parent || rootTabs[0].$TST.parent` and `insertBefore: rootTabs[0]`
(`tabs-group.js:92-97`). `rootTabs` is computed by `Tab.collectRootTabs(tabs)`
(`:81`). We never pass a `parent` (`tst-client.ts:115-121`; the public
`group-tabs` API exposes none, `handle-misc.js:1036-1041`).

So **the new group tab inherits the current parent of the first input tab
whose parent is not itself in the input set.** If that tab is still a child of
"Group 1" when TST looks at it, Group 4 is created inside Group 1. Two ways
that can happen:

- the input deliberately includes tabs that live under Group 1, or
- a previous write has not finished re-parenting yet (H2, cause 1).

The server cannot choose the position up front. It can verify the position
afterwards and correct it with TST `detach` (wiki "Detach existing child tab
from its parent") or `move-to-start`/`move-after`.

---

## (b) Implementation plan (ordered)

The design principle is **read-after-write plus honest errors, not blind
retries.** The code supports this directly:

- `TstClient.getLightTree(windowId)` already returns the full window tree
  (`tst-client.ts:106-109`), including collapsed children.
- `snapshotTabParents` (`message-handler.ts:1030-1070`) already walks it into
  a parent map.

No new TST capability is needed. The only "retry" is a bounded *settle
poll*: re-read the tree until it matches or a deadline passes. Writes are
never re-issued.

### Step 1: serialize write commands in the extension (H2)

- `firefox-extension/message-handler.ts`: add `private writeChain:
  Promise<unknown> = Promise.resolve()`. Wrap the TST/tab-structure writes in
  `handleDecodedMessage` (`open-tab`, `close-tabs`, `reorder-tabs`,
  `group-tabs`, `move-tabs-to-window`, `create-window`,
  `attach-tabs-to-parent`) in a `runExclusive(fn)`. It chains onto
  `writeChain` and swallows errors on the chain, but not for the caller.
- Reads (`get-tab-list`) should also wait for the chain, but not hold it, so a
  list never observes a half-applied write. Content, screenshot, and history
  commands stay unserialized.
- One `MessageHandler` exists per port (`background.ts:15-17`). Put the lock
  at module level (or on the shared `TstClient`) so writes arriving through
  different ports also serialize.

### Step 2: add a tree read-back and settle helper (H1, H2)

- In `message-handler.ts`, factor the tree walk out of `snapshotTabParents`
  into `private async readTree(windowIds): Promise<Map<number, {parent?:
  number; windowId: number; depth: number}> | null>`.
- Add `private async waitForTree(windowIds, predicate, timeoutMs = 2000,
  pollMs = 100)`. It re-reads the tree until `predicate(tree)` holds, and
  returns the last tree plus a `settled` boolean. It must never throw just
  because the predicate is false; the caller decides how to report it.
- Use it in `buildTreeTabList`'s caller (`sendTabs`, `:238-252`): on a
  mismatch, retry the build for up to about 500 ms before falling back to the
  flat list, and set `treeAvailable` (H3).

### Step 3: verify `group-tabs` and report the actual membership (H1, nested group)

- In `groupTabs` (`message-handler.ts:1193-1238`), on the TST path, after
  `createGroup`:
  1. Use `waitForTree` until every requested id has `parent === groupId`, or
     the deadline passes.
  2. Compute `members` (attached), `missing` (requested but not under the
     group), and `groupParent` (the group tab's own parent).
  3. If `groupParent !== undefined` and it differs from the common original
     parent of the inputs (snapshot taken before the call with
     `snapshotTabParents`), the group was nested unexpectedly. Call TST
     `detach` on the group tab (add `TstClient.detachTab(tabId)` →
     `{type: "detach", tab}`), then re-verify.
  4. Respond with the actual state. Extend `TabGroupCreatedExtensionMessage`
     (`common/extension-messages.ts:77-80`) with `memberTabIds: number[]`,
     `missingTabIds: number[]`, `parentTabId?: number`, and `verified:
     boolean`. Keep `groupId` for compatibility.
- Do **not** silently fall back to native `browser.tabs.group` when TST was
  available at the start of the call but the command failed or timed out
  (`:1218-1221`). TST may still finish it. Throw an error naming the
  situation instead. Fall back to native groups only when TST was not
  available to begin with.
- `mcp-server/server.ts:254-269`: build the text from the response, for
  example `Created tab group "X" (group tab 123) with 20 of 33 tabs; NOT
  grouped: 4, 5, …`.
  - Set `isError: true` on the result (top-level `isError`, not inside the
    content item as `server.ts:38` currently does) when `missingTabIds` is
    non-empty.
  - Mention when `verified` is false (the tree did not settle in time).

### Step 4: `close-tabs` with keepChildren — explicit method and verification (H4, H1)

- `tst-client.ts:153-163`: keep the parameter, but have callers pass the
  method explicitly.
- `message-handler.ts:208-236`:
  1. Before closing, snapshot each closed tab's children and its own parent
     (`readTree`).
  2. Call `removeTabsKeepingChildren(tabIds, "promote-all")`.
  3. Use `waitForTree` until no closed id is present and every former child
     has `parent === closedTab's former parent` (`undefined` for roots).
  4. Respond with the children's actual new parents (`TabsClosedExtensionMessage`
     gains `reparented?: {tabId: number; parentTabId: number | null}[]` and
     `verified: boolean`).
  5. With `keepChildren: true` and TST available-but-failing, **throw**
     instead of falling back to `tabs.remove`.
- `mcp-server/server.ts:44-60`:
  - Add an optional `childPlacement: "promote" | "top-level"` enum (default
    `"promote"`). It maps to `promote-all` / `detach-all` and is carried in
    `CloseTabsServerMessage` (`common/server-messages.ts:12-17`).
  - Update the tool description so that the placement is stated.
  - Report re-parented children in the result text.

### Step 5: fix timeouts and late-response handling (H2)

- `mcp-server/broker-commands.ts:63-67`, `:100-108`: give `close-tabs`,
  `group-tabs`, and `reorder-tabs` `TAB_STRUCTURE_RESPONSE_TIMEOUT_MS`. Raise
  that constant to cover the settle poll, for example 10 s.
  *As implemented:* 30 s (with `open-tab` and the tab list at 30 s too, since
  they can wait behind the write lock, and the broker forwarding timeout at
  35 s). The worst case of a group call alone exceeds 15 s.
- `firefox-extension/tst-client.ts:20`, `:192-204`: allow a longer timeout for
  the mutating commands (`group-tabs`, `remove-tab-keeping-children`), and do
  **not** `markUnavailable()` on a timeout. A timeout is not proof that TST is
  gone; a rejected `sendMessage` is. Return a distinct
  `"timeout"` result so callers can tell the two cases apart.
  *As implemented:* no distinct result. Once the group and keep-children
  close paths stopped falling back, every caller reports both cases the same
  honest way ("may still have been applied, check the tab list").
- `mcp-server/browser-api.ts:516-532`: guard `extensionRequestMap.get(...)`
  for late or unknown correlation ids. Log and drop them instead of throwing.

### Step 6: structured tab list (H3)

- `common/extension-messages.ts:36-39`: add `treeAvailable?: boolean`.
  `message-handler.ts:247-251` sets it.
- `mcp-server/server.ts:62-115`: add `format: z.enum(["text","json"]).default("text")`.
  JSON mode returns the shape in H3, paginated the same way. Text mode adds
  `parent=<id>` to each line and a warning line when `treeAvailable === false`.

### Step 7: documentation

- Tool descriptions in `server.ts`:
  - group: the group tab is created at the first input tab's position and
    under that tab's parent; the result lists any tabs that were not grouped.
  - close: describe the `childPlacement` behavior.
  - list: describe the `format` parameter.
- Update `README.md` (tool list) to match.

### How to test

Unit tests (Jest, existing mocks in `firefox-extension/__tests__/`):

- `message-handler.test.ts` › "Tree Style Tab integration" › `group-tabs`
  (`:2308`):
  - `getLightTree` returns all members under the group → `memberTabIds` is
    complete and `missingTabIds` is empty.
  - Returns a partial membership → `missingTabIds` lists the rest.
  - First read is partial, second is complete → `verified: true` after
    polling (use Jest fake timers).
  - The group tab's parent is an unexpected group → `detachTab` is called.
  - TST was available but `createGroup` returned null → error, and **no**
    `browser.tabs.group` call.
- `close-tabs` (`:1858`):
  - `removeTabsKeepingChildren` is called with `"promote-all"`, or with
    `"detach-all"` for `childPlacement: "top-level"`.
  - The reported `reparented` entries match the mocked post-close tree.
  - A TST failure with `keepChildren` throws and does not call `tabs.remove`.
- Serialization: dispatch two `handleDecodedMessage` writes without awaiting,
  where the first one's TST mock resolves on a deferred promise. Assert that
  the second write's TST call has not happened before the first one resolves.
- `get-tab-list`:
  - The first tree build mismatches and the second matches → the tree list is
    returned.
  - A persistent mismatch → `treeAvailable: false`.
- `tst-client.test.ts`:
  - `detachTab` sends `{type: "detach", tab}`.
  - A timeout no longer marks TST unavailable.
- `mcp-server/__tests__/browser-api.test.mjs`: a late response after a
  timeout does not throw. Also add a JSON-format test if the server tests
  cover tool formatting (otherwise extract the formatter into a pure function
  and test that).

Manual check in Firefox with TST (build with `npm run build`, load
`firefox-extension/dist`), repeating the production pattern:

1. Close 10 group tabs with keepChildren. The children appear at the top level
   (or under the grandparent), with no first-child subtree.
2. Immediately afterwards, run 10 `group-browser-tabs` calls. Every response
   lists full membership, or names the missing tabs with `isError`.
3. Run 5 groups in window A, then 5 groups in window B, with no list-read in
   between. No group tab is nested inside another group tab. If TST nests
   one, the response shows that it was detached.
4. Compare each response with `get-list-of-open-tabs format=json`.

---

## (c) Recommendation: close with keepChildren

**Fix it in the server/extension and document it.**

- The fake subtree comes from our implicit choice of TST's default
  `promote-intelligently`, not from TST behavior we can't control. Passing
  `promote-all` makes children of a root-level tab land at the top level,
  and children of a nested tab land under its parent. That is what "keep the
  children" intuitively means.
- Expose `childPlacement: "top-level"` (`detach-all`) for callers that always
  want the top level.
- Document the default in the tool description.
- Verify the result by reading the tree back (Step 4) and report where the
  children actually went, so any remaining TST-side deviation is visible
  rather than silent.
- Remove the `tabs.remove` fallback for `keepChildren: true`: on a collapsed
  tree it closes exactly the children the caller asked to keep.

---

## (d) Findings from the first browser test (2026-10-11)

The read-back reported both remaining problems honestly. Root causes:

- **`promote-all` is ignored by TST when sent through the API.**
  - TST's internal value for it is `0`.
  - `TabsInternalOperation.removeTabs` only stores the requested behavior
    `if (keepDescendantsBehavior)` (`common/tabs-internal-operation.js:159`),
    so `0` is dropped.
  - `getParentTabOperationBehavior` then falls back to the user's
    close-parent setting, which promotes the first child of a root tab.
  - `detach-all` (`1`) is unaffected.
  - Fix: always close with `detach-all`. Children that belong under the
    closed tab's parent are then attached to it again with `attach`,
    positioned where the closed tab was (before its next sibling, or after
    the subtree in front of it).
- **Group tabs nested in a sibling's subtree.**
  - TST opens the group tab with `tabs.create` at the index before the
    first grouped tab (`background/tabs-open.js`). When the preceding tab
    ends another sibling's subtree, TST attaches the new group tab inside
    that subtree.
  - The correction attached it to the right parent without a position, so
    TST also moved it, re-deriving its parent from the new position, and
    the correction did not stick.
  - Fix: attach in place (`insertAfter` the tab in front of the group tab).
    If it still does not stick, the response carries
    `intendedParentTabId`, and the tool result says where the group tab
    belongs.
