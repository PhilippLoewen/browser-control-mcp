/**
 * Structural tests for the options page theme (options.html).
 *
 * The options page is a static HTML file whose entire stylesheet is inlined
 * in the file, and jsdom cannot evaluate `@media (prefers-color-scheme)`
 * queries, so these tests assert on the stylesheet source itself:
 *
 *  - a light and a dark palette are defined as CSS custom properties
 *  - the dark palette is selected under `prefers-color-scheme: dark`
 *  - every concrete color in the stylesheet lives in a variable block
 *  - no inline `style` attribute hardcodes a color
 *
 * Together these guard that the page keeps following the browser theme
 * instead of regressing to a hardcoded light palette.
 */
import * as fs from "fs";
import * as path from "path";

const OPTIONS_HTML_PATH = path.join(__dirname, "..", "options.html");

const DARK_QUERY = "@media (prefers-color-scheme: dark)";

/** Tokens that must exist in both the light and the dark palette. */
const CORE_TOKENS = [
  "--bg-page",
  "--bg-panel",
  "--bg-card",
  "--bg-code",
  "--border",
  "--text-primary",
  "--text-secondary",
  "--accent",
  "--slider-track",
];

const HEX_COLOR = /#[0-9a-fA-F]{3,8}\b/;
const COLOR_KEYWORD =
  /:\s*(red|blue|green|white|black|gray|grey|yellow|orange|purple|navy|maroon|teal)\b/i;

function extractStyleBlock(html: string): string {
  const match = html.match(/<style>([\s\S]*?)<\/style>/);
  expect(match).not.toBeNull();
  return (match as RegExpMatchArray)[1];
}

/** Returns the stylesheet without the two variable definition blocks. */
function withoutVariableBlocks(style: string): string {
  const lightBlock = /:root\s*\{[^{}]*\}/;
  const darkBlock = new RegExp(
    `@media\\s*\\(prefers-color-scheme:\\s*dark\\)\\s*\\{[\\s\\S]*\\}\\s*$`
  );
  return style.replace(lightBlock, "").replace(darkBlock, "");
}

function inlineStyleAttributes(html: string): string[] {
  return [...html.matchAll(/style="([^"]*)"/g)].map((m) => m[1]);
}

describe("options page theme (options.html)", () => {
  const html = fs.readFileSync(OPTIONS_HTML_PATH, "utf-8");
  const style = extractStyleBlock(html);

  it("defines the light palette on :root", () => {
    const rootIndex = style.indexOf(":root");
    const darkIndex = style.indexOf(DARK_QUERY);
    expect(rootIndex).toBeGreaterThan(-1);
    expect(darkIndex).toBeGreaterThan(rootIndex);
    const lightBlock = style.slice(rootIndex, darkIndex);
    for (const token of CORE_TOKENS) {
      expect(lightBlock).toContain(token);
    }
  });

  it("defines the dark palette under prefers-color-scheme: dark", () => {
    const darkBlock = style.slice(style.indexOf(DARK_QUERY));
    for (const token of CORE_TOKENS) {
      expect(darkBlock).toContain(token);
    }
  });

  it("keeps every concrete color inside the variable blocks", () => {
    expect(withoutVariableBlocks(style)).not.toMatch(HEX_COLOR);
  });

  it("hardcodes no color in inline style attributes", () => {
    const inlineStyles = inlineStyleAttributes(html);
    expect(inlineStyles.length).toBeGreaterThan(0);
    for (const inlineStyle of inlineStyles) {
      expect(inlineStyle).not.toMatch(HEX_COLOR);
      expect(inlineStyle).not.toMatch(COLOR_KEYWORD);
    }
  });
});
