// Run with: node --test vscode/test
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { addFilter, addFilterToQmd, qmdHasFilters } = require("../yaml-filter");

test("adds filters when there are none", () => {
  const r = addFilter("project:\n  type: default\n\n");
  assert.equal(r.text, "project:\n  type: default\nfilters:\n  - annotate\n");
});

test("appends to an indented block list", () => {
  const r = addFilter("filters:\n  - a.lua\n  - b\nformat: html\n");
  assert.equal(r.text, "filters:\n  - a.lua\n  - b\n  - annotate\nformat: html\n");
});

test("appends to an unindented block list", () => {
  const r = addFilter("filters:\n- a\nformat: html");
  assert.equal(r.text, "filters:\n- a\n- annotate\nformat: html");
});

test("keeps mapping items together", () => {
  const r = addFilter("filters:\n  - path: x.lua\n    at: pre-ast\ntitle: T");
  assert.equal(r.text, "filters:\n  - path: x.lua\n    at: pre-ast\n  - annotate\ntitle: T");
});

test("appends to a flow list", () => {
  assert.equal(addFilter("filters: [a, b] # note").text, "filters: [a, b, annotate]");
  assert.equal(addFilter("filters: []").text, "filters: [annotate]");
});

test("leaves files that already have the filter alone", () => {
  for (const y of ["filters:\n  - annotate\n", "filters: [a, 'annotate']", 'filters:\n  - "annotate" # yes']) {
    assert.equal(addFilter(y).changed, false, y);
  }
});

test("ignores nested filters keys", () => {
  const r = addFilter("format:\n  html:\n    filters:\n      - a\n");
  assert.equal(r.text, "format:\n  html:\n    filters:\n      - a\nfilters:\n  - annotate\n");
});

test("edits .qmd front matter and keeps the body", () => {
  const r = addFilterToQmd("---\ntitle: Deck\nformat: revealjs\n---\n\n## One\n");
  assert.equal(r.text, "---\ntitle: Deck\nformat: revealjs\nfilters:\n  - annotate\n---\n\n## One\n");
});

test("keeps CRLF line endings", () => {
  const r = addFilterToQmd("---\r\ntitle: Deck\r\n---\r\nBody\r\n");
  assert.equal(r.text, "---\r\ntitle: Deck\r\nfilters:\r\n  - annotate\r\n---\r\nBody\r\n");
});

test("adds front matter when a .qmd has none", () => {
  assert.equal(addFilterToQmd("# Hi\n").text, "---\nfilters:\n  - annotate\n---\n\n# Hi\n");
});

test("detects document-level filters", () => {
  assert.equal(qmdHasFilters("---\nfilters:\n  - a\n---\n"), true);
  assert.equal(qmdHasFilters("---\ntitle: x\n---\nfilters: no\n"), false);
});
