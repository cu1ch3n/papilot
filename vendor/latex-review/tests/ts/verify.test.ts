import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  arxivOf,
  bibAuthors,
  checkEntry,
  checkInputs,
  Confirmations,
  doiOf,
  Http,
  plain,
  ReferenceChecker,
  titleScore,
  type CheckInput,
  type Fetch,
} from "../../src/core/verify.ts";

// Responses in the shapes doi.org, Crossref, DBLP and arXiv return them,
// cut down to the fields the check reads.
const KNUTH_CSL = {
  type: "journal-article",
  title: "Breaking paragraphs into lines",
  author: [{ family: "Knuth", given: "Donald E." }, { family: "Plass", given: "Michael F." }],
  issued: { "date-parts": [[1981, 11]] },
  "container-title": "Software: Practice and Experience",
  DOI: "10.1002/spe.4380111102",
};
const MYERS_CSL = {
  type: "journal-article",
  title: "AnO(ND) difference algorithm and its variations",
  author: [{ family: "Myers", given: "Eugene W." }],
  issued: { "date-parts": [[1986, 11]] },
  "container-title": ["Algorithmica"],
  DOI: "10.1007/BF01840446",
};
// Crossref answers a search for a famous preprint with later copies first.
const COPIES = {
  message: {
    items: [2025, 2025].map((year, i) => ({
      type: "posted-content",
      title: ["Attention Is All You Need"],
      author: [{ family: "Vaswani" }, { family: "Shazeer" }, { family: "Parmar" }],
      issued: { "date-parts": [[year, 8, 23]] },
      DOI: `10.65215/copy${i}`,
    })),
  },
};
const ATTENTION_ATOM = `<?xml version='1.0' encoding='UTF-8'?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <entry>
    <id>http://arxiv.org/abs/1706.03762v7</id>
    <title>Attention Is All You
      Need</title>
    <published>2017-06-12T17:57:34Z</published>
    <author><name>Ashish Vaswani</name></author>
    <author><name>Noam Shazeer</name></author>
    <author><name>Niki Parmar</name></author>
  </entry>
</feed>`;
const EMPTY_ATOM = `<feed xmlns="http://www.w3.org/2005/Atom"><opensearch:totalResults>0</opensearch:totalResults></feed>`;
const BOT_PAGE = "<!doctype html><title>Making sure you&#39;re not a bot!</title>";

type Reply = { status?: number; type?: string; body: unknown } | "offline";
function server(routes: [RegExp, Reply][]) {
  const seen: string[] = [];
  const fetcher: Fetch = async (url) => {
    seen.push(url);
    const reply = routes.find(([pattern]) => pattern.test(decodeURIComponent(url)))?.[1] ?? { status: 404, type: "text/html", body: "Not found" };
    if (reply === "offline") throw new TypeError("fetch failed");
    const body = typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body);
    return new Response(body, {
      status: reply.status ?? 200,
      headers: { "content-type": reply.type ?? (typeof reply.body === "string" ? "application/atom+xml" : "application/json") },
    });
  };
  return { fetcher, seen, http: new Http(fetcher, {}, Date.now, async () => {}) };
}
const NO_PACE = { "doi.org": 0, "api.crossref.org": 0, "dblp.org": 0, "export.arxiv.org": 0 };
const entry = (fields: Record<string, string>, id = "refs.bib#x"): CheckInput => ({ id, type: "article", fields });
const knuth = {
  author: "Donald E. Knuth and Michael F. Plass",
  title: "Breaking paragraphs into lines",
  year: "1981",
};

describe("Reading entries for a check", () => {
  it("turns LaTeX into plain text and reads names as BibTeX does", () => {
    expect(plain(String.raw`J{\'e}r{\^o}me Laurens, Pregui{\c{c}}a, \v{S}ar\'{\i}k, {\TeX}book, \emph{An} {$O(ND)$} 1--2 \rm x`)).toBe(
      "Jerome Laurens, Preguica, Sarik, TeXbook, An O(ND) 1-2 x",
    );
    expect(bibAuthors(String.raw`Knuth, Donald E. and Ludwig van Beethoven and {World Health Organization} and others`)).toEqual({
      names: ["Donald E. Knuth", "Ludwig van Beethoven", "World Health Organization"],
      families: ["knuth", "vanbeethoven", "worldhealthorganization"],
      others: true,
    });
  });
  it("finds DOIs and arXiv identifiers wherever entries keep them", () => {
    expect(doiOf({ doi: "https://doi.org/10.1002/SPE.4380111102." })).toBe("10.1002/SPE.4380111102");
    expect(doiOf({ url: "https://dx.doi.org/10.1145/3290380" })).toBe("10.1145/3290380");
    expect(doiOf({ doi: "not a doi" })).toBeNull();
    expect(arxivOf({ eprint: "1706.03762v2", archiveprefix: "arXiv" })).toBe("1706.03762");
    expect(arxivOf({ journal: "arXiv preprint arXiv:2104.04692" })).toBe("2104.04692");
    expect(arxivOf({ url: "https://arxiv.org/pdf/hep-th/9711200v3" })).toBe("hep-th/9711200");
    expect(arxivOf({ doi: "10.48550/arXiv.1706.03762" })).toBe("1706.03762");
    expect(arxivOf({ eprint: "12345", eprinttype: "pubmed" })).toBeNull();
  });
  it("scores a title with other punctuation or a subtitle as the same", () => {
    expect(titleScore("An {$O(ND)$} difference algorithm and its variations", "AnO(ND) difference algorithm and its variations")).toBe(1);
    expect(titleScore("Conflict-free replicated data types", "Conflict-Free Replicated Data Types: an overview")).toBeGreaterThanOrEqual(0.9);
    expect(titleScore("Deep residual learning", "Attention is all you need")).toBeLessThan(0.6);
    // Words added to a real title, without a subtitle mark, make another title.
    expect(titleScore("Attention is all you need for graphs", "Attention is all you need")).toBeLessThan(0.9);
    expect(titleScore("Attention is not all you need", "Attention is all you need")).toBeLessThan(0.9);
  });
});

describe("Checking an entry", () => {
  it("verifies an entry whose DOI names the same work", async () => {
    const { http, seen } = server([[/doi\.org\/10\.1002\/spe/, { body: KNUTH_CSL }]]);
    const check = await checkEntry(entry({ ...knuth, doi: "10.1002/spe.4380111102" }), http);
    expect(check).toMatchObject({ status: "verified", via: "doi", differences: [], unavailable: [] });
    expect(check.record).toMatchObject({ source: "doi", year: 1981, authors: ["Donald E. Knuth", "Michael F. Plass"], url: "https://doi.org/10.1002/spe.4380111102" });
    expect(seen).toEqual(["https://doi.org/10.1002/spe.4380111102"]);
  });
  it("calls an entry a mismatch when its DOI names another work", async () => {
    const { http } = server([[/doi\.org/, { body: MYERS_CSL }]]);
    const check = await checkEntry(entry({ ...knuth, doi: "10.1007/BF01840446" }), http);
    expect(check.status).toBe("mismatch");
    expect(check.differences.map((d) => [d.field, d.minor ?? false])).toEqual([
      ["title", false],
      ["author", false],
      ["year", false],
    ]);
  });
  it("lists a wrong year and a missing author, and accepts reordered punctuation", async () => {
    const { http } = server([[/doi\.org/, { body: KNUTH_CSL }]]);
    const check = await checkEntry(entry({ author: "Donald E. Knuth", title: "Breaking Paragraphs Into Lines.", year: "1982", doi: "10.1002/spe.4380111102" }), http);
    expect(check.status).toBe("mismatch");
    expect(check.differences).toEqual([
      { field: "author", bib: "Donald E. Knuth", record: "Donald E. Knuth; Michael F. Plass" },
      { field: "year", bib: "1982", record: "1981" },
    ]);
  });
  it("reports a DOI that is not registered, with the work found by its title", async () => {
    const { http } = server([
      [/doi\.org/, { status: 404, type: "text/html", body: "<title>Error: DOI Not Found</title>" }],
      [/api\.crossref\.org\/works\?/, { body: { message: { items: [KNUTH_CSL] } } }],
    ]);
    const check = await checkEntry(entry({ ...knuth, doi: "10.1002/spe.999999" }), http);
    expect(check).toMatchObject({ status: "mismatch", via: "title" });
    expect(check.differences).toEqual([{ field: "doi", bib: "10.1002/spe.999999", record: "10.1002/spe.4380111102" }]);
  });
  it("finds a preprint on arXiv when Crossref has only later copies and DBLP turns clients away", async () => {
    const { http, seen } = server([
      [/api\.crossref\.org/, { body: COPIES }],
      [/dblp\.org/, { status: 202, type: "text/html", body: BOT_PAGE }],
      [/export\.arxiv\.org.*search_query/, { body: ATTENTION_ATOM }],
    ]);
    const check = await checkEntry(entry({ author: "Ashish Vaswani and Noam Shazeer and Niki Parmar", title: "Attention is all you need", year: "2017" }), http);
    expect(check).toMatchObject({ status: "verified", via: "title", unavailable: ["DBLP"] });
    expect(check.record).toMatchObject({ source: "arxiv", year: 2017, url: "https://arxiv.org/abs/1706.03762" });
    expect(seen.map((u) => new URL(u).hostname)).toEqual(["api.crossref.org", "dblp.org", "export.arxiv.org"]);
  });
  it("accepts a conference year after the preprint's, and looks up arXiv identifiers directly", async () => {
    const { http, seen } = server([[/export\.arxiv\.org.*id_list=1706\.03762/, { body: ATTENTION_ATOM }]]);
    const check = await checkEntry(entry({ author: "Vaswani, Ashish and Shazeer, Noam and Parmar, Niki", title: "Attention is All you Need", year: "2018", eprint: "1706.03762", archiveprefix: "arXiv" }), http);
    expect(check).toMatchObject({ status: "verified", via: "arxiv", differences: [{ field: "year", bib: "2018", record: "2017", minor: true }] });
    expect(seen).toHaveLength(1);
  });
  it("leaves an entry no source knows unverified, with the closest record", async () => {
    const { http } = server([
      [/api\.crossref\.org/, { body: { message: { items: [MYERS_CSL] } } }],
      [/dblp\.org/, { body: { result: { hits: { hit: [{ info: { title: "Neural difference algorithms.", authors: { author: { text: "Ann Smith 0001" } }, year: "2021", venue: "NeurIPS", url: "https://dblp.org/rec/x" } }] } } } }],
      [/export\.arxiv\.org/, { body: EMPTY_ATOM }],
    ]);
    const check = await checkEntry(entry({ author: "Ann Smith", title: "Neural difference algorithms and their variations", year: "2021" }), http);
    // A real title with words added is not that work; the closest title is shown.
    expect(check).toMatchObject({ status: "unverified", reason: "no-match", record: { source: "crossref", title: MYERS_CSL.title } });
    const none = await checkEntry(entry({ author: "Nobody", title: "A study that was never written", year: "2023" }), server([[/crossref/, { body: { message: { items: [] } } }], [/dblp/, { body: { result: { hits: {} } } }], [/arxiv/, { body: EMPTY_ATOM }]]).http);
    expect(none).toMatchObject({ status: "unverified", reason: "no-match", differences: [] });
    expect(none.record).toBeUndefined();
  });
  it("does not take a review of a book for the book, and reads titles with markup and Greek letters", async () => {
    const reviewOf = { message: { items: [{ type: "journal-article", title: ["Queueing Systems Volume 1: Theory."], author: [{ family: "Butterworth" }, { family: "Kleinrock" }], issued: { "date-parts": [[1976]] } }] } };
    const { http } = server([[/crossref/, { body: reviewOf }], [/dblp/, { body: { result: { hits: {} } } }], [/arxiv/, { body: EMPTY_ATOM }]]);
    const book = await checkEntry({ id: "k", type: "book", fields: { author: "Leonard Kleinrock", title: "Queueing Systems, Volume 1: Theory", year: "1975" } }, http);
    expect(book).toMatchObject({ status: "unverified", reason: "no-match" });
    expect(book.record).toBeUndefined();
    expect(titleScore(String.raw`A proof for the queuing formula: {$L = \lambda W$}`, "A Proof for the Queuing Formula: <i>L</i> = λ <i>W</i>")).toBe(1);
  });
  it("fails, rather than doubting the entry, when no source can be reached, and skips entries with nothing to look up", async () => {
    const { http } = server([[/./, "offline"]]);
    const check = await checkEntry(entry(knuth), http);
    expect(check).toMatchObject({ status: "failed", unavailable: ["Crossref", "DBLP", "arXiv"] });
    expect(await checkEntry(entry({ howpublished: "\\url{https://example.org}" }), http)).toMatchObject({ status: "skipped", reason: "nothing-to-check" });
  });
});

describe("The checker", () => {
  it("checks in the background, keeps results in a file and redoes unverified entries on request", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "latex-review-verify-")),
      file = path.join(dir, "references.json"),
      { fetcher, seen } = server([[/doi\.org/, { body: KNUTH_CSL }], [/crossref/, { body: { message: { items: [] } } }], [/dblp/, { body: { result: { hits: {} } } }], [/arxiv/, { body: EMPTY_ATOM }]]),
      inputs = [entry({ ...knuth, doi: "10.1002/spe.4380111102" }, "a"), entry({ title: "Unknown work" }, "b")];
    try {
      const checker = new ReferenceChecker(file, { fetch: fetcher, pace: NO_PACE });
      expect(checker.lookup(inputs)).toEqual({ checks: {}, pending: 0 });
      expect(checker.lookup(inputs, true)).toEqual({ checks: {}, pending: 2 });
      expect(checker.lookup(inputs, true).pending).toBe(2);
      await checker.idle();
      const done = checker.lookup(inputs, true);
      expect(done.pending).toBe(0);
      expect(done.checks.a.status).toBe("verified");
      expect(done.checks.b.status).toBe("unverified");
      const requests = seen.length;
      // Another process reads the saved results instead of asking again.
      const later = new ReferenceChecker(file, { fetch: fetcher, pace: NO_PACE });
      expect(later.lookup(inputs, true).pending).toBe(0);
      expect(seen.length).toBe(requests);
      expect(later.lookup(inputs, true, true)).toMatchObject({ pending: 1, checks: { a: { status: "verified" } } });
      await later.idle();
      expect(seen.length).toBeGreaterThan(requests);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it("checks the added and modified entries of a round with their new values", () => {
    expect(
      checkInputs({
        missing: [],
        entries: [
          { id: "r#a", unit: "c001", file: "r", key: "a", type: "misc", status: "added", lines: [1, 3], cited: [], problems: [], fields: [{ name: "title", old: null, new: "acm # x", resolved: "ACM x" }, { name: "note", old: "n", new: null }] },
          { id: "r#b", unit: "c001", file: "r", key: "b", type: "misc", status: "removed", lines: [4, 5], cited: [], problems: [], fields: [] },
        ],
      }),
    ).toEqual([{ id: "r#a", type: "misc", fields: { title: "ACM x" } }]);
  });
});

describe("Confirmations", () => {
  it("hold for an entry's looked-up fields, wherever the entry is, until they change or are taken back", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "latex-review-confirm-")),
      file = path.join(dir, "latex-review", "references-confirmed.json");
    try {
      const book = entry({ author: "Donald E. Knuth", title: "The TeXbook", year: "1984" }, "refs.bib#knuth");
      new Confirmations(file).set(book, true, 5000);
      const later = new Confirmations(file);
      expect(later.of([book, { ...book, id: "other.bib#tb" }])).toEqual({ "refs.bib#knuth": 5, "other.bib#tb": 5 });
      expect(later.of([{ ...book, fields: { ...book.fields, year: "1986" } }])).toEqual({});
      later.set(book, false);
      expect(new Confirmations(file).of([book])).toEqual({});
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
