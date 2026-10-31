import { it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { zhCN } from "../../src/web/zh-CN.ts";
import { STATUS } from "../../src/web/overview.tsx";
import { STATE } from "../../src/web/model.ts";
import { pageLanguage } from "../../src/web/i18n.ts";

const web = new URL("../../src/web/", import.meta.url);
// Every literal passed to t(), tn() or a translator, plus the label maps the
// viewer translates where it shows them.
function keys() {
  const found = new Set<string>([
    ...Object.values(STATUS),
    ...Object.values(STATE),
  ]);
  for (const file of readdirSync(web).filter((f) => /\.tsx?$/.test(f))) {
    if (file === "zh-CN.ts" || file === "i18n.ts") continue;
    const source = readFileSync(new URL(file, web), "utf8");
    for (const call of source.matchAll(
      /\b(?:t|tn|say)\(\s*(?:[\w.]+,\s*)?((?:"(?:[^"\\]|\\.)*"\s*[,:?]?\s*)+)/g,
    ))
      for (const [, text] of call[1].matchAll(/"((?:[^"\\]|\\.)*)"/g))
        found.add(text);
    for (const map of source.matchAll(
      /const (?:KIND|PHASE|ACTION|CHANGE_ACTION|CHANGE_STATE|FIELD|ENTRY_STATUS|CHECK|PROBLEM)\b[^{]*\{([^}]*)\}/g,
    ))
      for (const [, text] of map[1].matchAll(/:\s*"([^"]*)"/g))
        found.add(text);
  }
  return [...found];
}
const placeholders = (text: string) =>
  [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

it("translates every viewer string into Simplified Chinese", () => {
  const all = keys();
  expect(all.length).toBeGreaterThan(80);
  expect(all.filter((key) => !(key in zhCN))).toEqual([]);
  for (const key of all)
    expect(placeholders(zhCN[key]), key).toEqual(placeholders(key));
});

it("reads the language from the page address only", () => {
  expect(pageLanguage("?task=a&lang=zh-CN")).toBe("zh-CN");
  expect(pageLanguage("?lang=zh")).toBe("zh-CN");
  expect(pageLanguage("?task=a")).toBe("en");
  expect(pageLanguage("?lang=fr")).toBe("en");
});
