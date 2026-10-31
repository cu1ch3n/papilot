import { expect, test, type Page } from "@playwright/test";
import type { PageState, ReferenceChecks, RoundDetail } from "../../src/types.ts";

// A round whose first change adds two bibliography entries, one of which no
// source knows, and whose second modifies a verified entry. The engine's
// answers are served by the page's own routes.
const unit = (id: string, file: string, start: number) => ({
  id, file, status: "modified" as const, kind: "text" as const, whole_file: false, ops: [],
  old_start: start, old_end: start, new_start: start, new_end: start + 8,
  old_text: "", new_text: "@misc{x}", truncated: false, visual: "unmapped" as const, pages: [], section: null,
});
const field = (name: string, value: string, old: string | null = null) => ({ name, old, new: value });
const detail: RoundDetail = {
  task: "refs", round: 1, before: "b", after: "a", warnings: [], files: "/files/refs/1/", sections: [],
  loose: ["c001", "c002", "c003"].map((id) => ({ kind: "change" as const, units: [id], identical: false, before: [], after: [] })),
  units: [unit("c001", "refs.bib", 40), unit("c002", "refs.bib", 3), unit("c003", "main.tex", 12)],
  references: {
    missing: [],
    entries: [
      { id: "refs.bib#real", unit: "c001", file: "refs.bib", key: "real", type: "article", status: "added", lines: [40, 45], problems: [],
        cited: [{ file: "main.tex", line: 12, section: "2 Method" }],
        fields: [field("author", "Donald E. Knuth and Michael F. Plass"), field("title", "Breaking paragraphs into lines"), field("year", "1981"), field("doi", "10.1002/spe.4380111102")] },
      { id: "refs.bib#made-up", unit: "c001", file: "refs.bib", key: "made-up", type: "article", status: "added", lines: [47, 51], problems: [], cited: [],
        fields: [field("author", "Jian Li"), field("title", "A study that was never written"), field("year", "2022")] },
      { id: "refs.bib#knuth", unit: "c002", file: "refs.bib", key: "knuth", type: "book", status: "modified", lines: [3, 8], problems: [], cited: [],
        fields: [field("title", "The TeXbook", "The TeXbook"), field("year", "1984", "1986")] },
    ],
  },
};
const checks: ReferenceChecks = {
  pending: 0,
  checks: {
    "refs.bib#real": { status: "verified", via: "doi", differences: [], unavailable: [], checked: 1,
      record: { source: "doi", title: "Breaking paragraphs into lines", authors: ["Donald E. Knuth", "Michael F. Plass"], year: 1981, venue: "Software: Practice and Experience", doi: "10.1002/spe.4380111102", url: "https://doi.org/10.1002/spe.4380111102" } },
    "refs.bib#made-up": { status: "unverified", via: "title", reason: "no-match", differences: [], unavailable: ["DBLP"], checked: 1 },
    "refs.bib#knuth": { status: "verified", via: "title", differences: [], unavailable: [], checked: 1,
      record: { source: "crossref", title: "The TeXbook", authors: ["Donald E. Knuth"], year: 1984, venue: null, doi: null, url: "https://example.org/texbook" } },
  },
};

async function serve(page: Page) {
  const decisions: Record<string, PageState["decisions"][string]> = { c001: "pending", c002: "pending", c003: "pending" },
    posted: string[][] = [],
    state = (): PageState => ({
      csrf: "token", task: "refs", title: "Add references", closed: false, state: "reviewing", latest: 1, round: 1,
      revision: "a", decisions: { ...decisions }, comments: {}, undo: null, job: null,
    });
  await page.route("**/api/tasks/refs/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/state")) return route.fulfill({ json: state() });
    if (url.pathname.endsWith("/rounds/1")) return route.fulfill({ json: detail });
    if (url.pathname.endsWith("/rounds/1/references")) {
      expect(url.searchParams.get("check")).toBe("1");
      return route.fulfill({ json: checks });
    }
    if (url.pathname.endsWith("/decide")) {
      const body = route.request().postDataJSON();
      posted.push(body.changes);
      for (const id of body.changes) decisions[id] = "accepted";
      return route.fulfill({ json: state() });
    }
    return route.fulfill({ status: 404, json: { error: "Unexpected request" } });
  });
  return posted;
}

test("a .bib change shows every entry and field with its online check", async ({ page }) => {
  await serve(page);
  await page.goto("/?task=refs");
  const added = page.locator("article.change").first();
  await expect(added.locator(".reference-entry")).toHaveCount(2);
  await expect(added.locator('.reference-entry[data-check="verified"] .reference-key')).toHaveText("@article{real}");
  await expect(added.locator('.reference-entry[data-check="unverified"] .reference-check')).toHaveText("Not verified");
  await expect(added.locator(".reference-fields th")).toHaveText(["author", "title", "year", "doi", "author", "title", "year"]);
  await expect(added.locator(".reference-record a")).toHaveAttribute("href", "https://doi.org/10.1002/spe.4380111102");
  await expect(added.locator(".source")).toHaveCount(0);
  const modified = page.locator("article.change").nth(1);
  await expect(modified.locator('tr[data-change="changed"] del')).toHaveText("1986");
  await expect(modified.locator('tr[data-change="changed"] ins')).toHaveText("1984");
  await expect(page.locator(".references-banner")).toContainText("3 entries changed");
  await expect(page.locator(".references-flagged li")).toHaveText([/made-up — Not verified/]);
});

test("Accept all leaves a change with an unverified entry, which is accepted only after confirming", async ({ page }) => {
  const posted = await serve(page);
  await page.goto("/?task=refs");
  await expect(page.locator(".reference-check").first()).toHaveText("Verified");
  const batch = page.locator(".accept-all");
  await expect(batch.locator(".batch-count")).toHaveText("2");
  await expect(batch).toHaveAttribute("title", /Leaves 1 change with bibliography entries to check/);
  await batch.click();
  await expect.poll(() => posted).toEqual([["c002", "c003"]]);
  // The change with the unverified entry is left, and accepting it asks first.
  const current = page.locator("article.change.current");
  await expect(current.locator(".reference-entry")).toHaveCount(2);
  await current.locator(".actions button.accept").click();
  const dialog = page.locator(".references-confirm");
  await expect(dialog).toContainText("made-up — Not verified");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  expect(posted).toHaveLength(1);
  await page.keyboard.press("a");
  await page.locator(".references-confirm").getByRole("button", { name: "Accept anyway" }).click();
  await expect.poll(() => posted).toEqual([["c002", "c003"], ["c001"]]);
});
