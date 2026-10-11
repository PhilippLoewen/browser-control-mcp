import assert from "node:assert/strict";
import test from "node:test";

import tabFormat from "../dist/tab-format.js";

const {
  formatCloseResult,
  formatGroupResult,
  formatTabListJson,
  formatTabListText,
} = tabFormat;

const treeTabs = [
  { id: 1, windowId: 7, url: "https://a.com", title: "A", depth: 0, childCount: 1, collapsed: false, active: true, discarded: false, lastAccessed: 1000 },
  { id: 2, windowId: 7, url: "https://b.com", title: "B", depth: 1, parentTabId: 1, childCount: 0, collapsed: false, active: false, discarded: true, lastAccessed: 2000 },
  { id: 3, windowId: 8, url: "https://c.com", title: "C", depth: 0, childCount: 0, collapsed: false, active: false, discarded: false, lastAccessed: 3000 },
];

test("the JSON tab list carries the tree structure of each tab", () => {
  const result = JSON.parse(formatTabListJson(treeTabs, { offset: 0, limit: 100 }, true));

  assert.deepEqual(result, {
    total: 3,
    offset: 0,
    limit: 100,
    hasMore: false,
    tree: true,
    tabs: [
      { id: 1, window: 7, depth: 0, parent: null, url: "https://a.com", title: "A", childCount: 1, collapsed: false, active: true, discarded: false, lastAccessed: 1000 },
      { id: 2, window: 7, depth: 1, parent: 1, url: "https://b.com", title: "B", childCount: 0, collapsed: false, active: false, discarded: true, lastAccessed: 2000 },
      { id: 3, window: 8, depth: 0, parent: null, url: "https://c.com", title: "C", childCount: 0, collapsed: false, active: false, discarded: false, lastAccessed: 3000 },
    ],
  });
});

test("the JSON tab list is paginated", () => {
  const result = JSON.parse(formatTabListJson(treeTabs, { offset: 1, limit: 1 }, true));

  assert.equal(result.total, 3);
  assert.equal(result.hasMore, true);
  assert.deepEqual(result.tabs.map((tab) => tab.id), [2]);
});

test("a flat JSON tab list has no tree fields and says so", () => {
  const flat = [{ id: 1, windowId: 7, url: "https://a.com", title: "A" }];

  const result = JSON.parse(formatTabListJson(flat, { offset: 0, limit: 100 }, false));

  assert.equal(result.tree, false);
  assert.equal(result.tabs[0].depth, null);
  assert.equal(result.tabs[0].parent, null);
});

test("the text tab list shows each tab's parent", () => {
  const lines = formatTabListText(treeTabs, { offset: 0, limit: 100 }, true).map(
    (item) => item.text
  );

  assert.match(lines[0], /^Showing tabs 1-3 of 3 total tabs$/);
  assert.match(lines[2], /^  tab id=2, tab window=7, tab parent=1, tab url=https:\/\/b\.com/);
  assert.doesNotMatch(lines[1], /tab parent=/);
});

test("the text tab list warns when the tree could not be matched", () => {
  const flat = [{ id: 1, windowId: 7, url: "https://a.com", title: "A" }];

  const lines = formatTabListText(flat, { offset: 0, limit: 100 }, false).map(
    (item) => item.text
  );

  assert.match(lines[1], /listed flat, without their tree structure/);
});

test("the text tab list does not warn without Tree Style Tab", () => {
  const flat = [{ id: 1, windowId: 7, url: "https://a.com", title: "A" }];

  const lines = formatTabListText(flat, { offset: 0, limit: 100 }, undefined);

  assert.equal(lines.length, 2);
});

test("a fully grouped TST group reports its members", () => {
  const result = formatGroupResult("Docs", [1, 2], {
    groupId: 9,
    memberTabIds: [1, 2],
    missingTabIds: [],
    parentTabId: null,
    verified: true,
  });

  assert.equal(result.isError, false);
  assert.equal(
    result.text,
    'Created tab group "Docs" (group tab id 9) with 2 of 2 tabs, at the top level'
  );
});

test("a partially grouped TST group is an error naming the missing tabs", () => {
  const result = formatGroupResult("Docs", [1, 2, 3], {
    groupId: 9,
    memberTabIds: [1],
    missingTabIds: [2, 3],
    parentTabId: 4,
    verified: false,
  });

  assert.equal(result.isError, true);
  assert.match(result.text, /with 1 of 3 tabs, nested under tab 4/);
  assert.match(result.text, /NOT grouped: 2, 3/);
  assert.match(result.text, /had not settled/);
});

test("a TST group left under the wrong parent says where it belongs", () => {
  const result = formatGroupResult("Docs", [1], {
    groupId: 9,
    memberTabIds: [1],
    missingTabIds: [],
    parentTabId: 141,
    intendedParentTabId: 124,
    verified: false,
  });

  assert.equal(result.isError, false);
  assert.match(result.text, /nested under tab 141/);
  assert.match(
    result.text,
    /Tree Style Tab kept the group tab there, although the grouped tabs shared parent tab 124/
  );
});

test("a TST group that should be at the top level says so", () => {
  const result = formatGroupResult("Docs", [1], {
    groupId: 9,
    memberTabIds: [1],
    missingTabIds: [],
    parentTabId: 141,
    intendedParentTabId: null,
    verified: false,
  });

  assert.match(result.text, /should be at the top level/);
});

test("a TST group whose tree could not be read says so", () => {
  const result = formatGroupResult("Docs", [1, 2], { groupId: 9, verified: false });

  assert.equal(result.isError, false);
  assert.match(result.text, /could not be verified/);
});

test("a native tab group keeps the plain confirmation", () => {
  const result = formatGroupResult("Docs", [1, 2], { groupId: 9 });

  assert.equal(result.isError, false);
  assert.equal(result.text, 'Created tab group "Docs" with 2 tabs (group ID: 9)');
});

test("closing tabs reports where the kept child tabs ended up", () => {
  const text = formatCloseResult({
    reparented: [
      { tabId: 11, parentTabId: null },
      { tabId: 12, parentTabId: 11 },
    ],
    verified: false,
  });

  assert.match(text, /tab 11 at the top level, tab 12 under tab 11/);
  assert.match(text, /had not settled/);
});

test("closing tabs without kept children is a plain confirmation", () => {
  assert.equal(formatCloseResult({}), "Closed tabs");
  assert.equal(formatCloseResult({ reparented: [], verified: true }), "Closed tabs");
});
