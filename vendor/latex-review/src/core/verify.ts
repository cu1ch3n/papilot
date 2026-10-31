import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  CheckDifference,
  CheckRecord,
  ReferenceCheck,
  ReferenceChecks,
  References,
} from "../types.ts";

// Checks bibliography entries against published records: a DOI through
// doi.org, an arXiv identifier through arXiv, and otherwise the title in
// Crossref, then DBLP, then arXiv. Only the entry's title, authors, year and
// identifiers leave the computer. A record agrees when its title, authors and
// year match; finding none is "unverified", not proof that the work does not
// exist, since theses, reports and many books are in none of these sources.

export interface CheckInput {
  id: string;
  type: string;
  fields: Record<string, string>;
}
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
interface Candidate {
  record: CheckRecord;
  families: string[];
  preprint: boolean;
  /** Crossref's type of the work, such as journal-article or book. */
  kind?: string;
}
type Lookup<T> = T | "unavailable";

const AGENT = "latex-review bibliography check (+https://github.com/cu1ch3n/papilot)";
// Milliseconds between two requests to a host. arXiv asks for one request
// every three seconds; DBLP for restraint.
const PACE: Record<string, number> = {
  "doi.org": 200,
  "api.crossref.org": 250,
  "dblp.org": 1000,
  "export.arxiv.org": 3000,
};

// --- Text -----------------------------------------------------------------

const LETTERS: Record<string, string> = {
  ss: "ss", o: "o", O: "O", aa: "a", AA: "A", ae: "ae", AE: "AE",
  oe: "oe", OE: "OE", l: "l", L: "L", i: "i", j: "j",
};
const GREEK: Record<string, string> = Object.fromEntries(
  "alpha α beta β gamma γ delta δ epsilon ε varepsilon ε zeta ζ eta η theta θ vartheta θ iota ι kappa κ lambda λ mu μ nu ν xi ξ pi π rho ρ sigma σ tau τ upsilon υ phi φ varphi φ chi χ psi ψ omega ω Gamma Γ Delta Δ Theta Θ Lambda Λ Xi Ξ Pi Π Sigma Σ Phi Φ Psi Ψ Omega Ω"
    .split(" ")
    .flatMap((word, i, all) => (i % 2 ? [] : [[word, all[i + 1]]])),
);
/** LaTeX as plain text: accents to letters, Greek letters to characters,
 * other commands dropped, braces gone. HTML tags, which Crossref puts in
 * titles, go too. */
export function plain(text: string) {
  return text
    .replace(/<\/?(?:i|b|em|strong|sub|sup|scp|tt|span|mml:[a-z]+)\b[^>]*>/gi, "")
    .replace(/\\([A-Za-z]+)(?![A-Za-z])/g, (match, name) => GREEK[name] ?? match)
    .replace(/\\\\|\\[ ,;:!]/g, " ")
    .replace(
      /\\[`'^"~=.]\s*(?:\{\s*\\?([A-Za-z])\s*\}|\\?([A-Za-z]))/g,
      (_, braced, bare) => braced ?? bare,
    )
    // Accents named by a letter, such as \c{c} or \v s, unlike \rm.
    .replace(
      /\\[uvHtcdbkr](?:\s*\{\s*\\?([A-Za-z])\s*\}|\s+\\?([A-Za-z]))/g,
      (_, braced, bare) => braced ?? bare,
    )
    .replace(/\\(ss|aa|AA|ae|AE|oe|OE|o|O|l|L|i|j)(?![A-Za-z])\s*/g, (_, c) => LETTERS[c])
    .replace(/\\([&%$#_{}])/g, "$1")
    .replace(/\\(LaTeX|TeX)(?![A-Za-z])/g, "$1")
    .replace(/\\[A-Za-z]+\*?\s*/g, "")
    .replace(/[{}$]/g, "")
    .replace(/~/g, " ")
    .replace(/-{2,3}/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}
const fold = (text: string) =>
  text.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase();
/** Letters and digits only, for comparing titles and names. */
export const compact = (text: string) =>
  fold(plain(text)).replace(/[^\p{L}\p{N}]+/gu, "");
function similarity(a: string, b: string) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++)
      row[j] = Math.min(
        previous[j] + 1,
        row[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    previous = row;
  }
  return 1 - previous[b.length] / Math.max(a.length, b.length);
}
/** 1 for the same title; 0.9 when one adds only a subtitle after a colon,
 * full stop or dash. Words added without one make another title. */
export function titleScore(a: string, b: string) {
  const x = compact(a),
    y = compact(b);
  if (x && x === y) return 1;
  const main = (title: string) => compact(plain(title).split(/\s*(?:[:.?!]|\s[-–—])\s+/)[0]),
    subtitle =
      (x.length >= 15 && main(b) === x && y !== x) || (y.length >= 15 && main(a) === y && x !== y)
        ? 0.9
        : 0;
  return Math.max(similarity(x.slice(0, 400), y.slice(0, 400)), subtitle);
}

// --- Names ----------------------------------------------------------------

// Split at top-level " and ", as BibTeX does.
function splitNames(value: string) {
  const names: string[] = [];
  let depth = 0,
    start = 0;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "{") depth++;
    else if (value[i] === "}") depth--;
    else if (depth === 0 && /\s/.test(value[i])) {
      const match = /^\s+and\s+/i.exec(value.slice(i));
      if (match) {
        names.push(value.slice(start, i));
        i += match[0].length - 1;
        start = i + 1;
      }
    }
  }
  names.push(value.slice(start));
  return names.map((n) => n.trim()).filter(Boolean);
}
function topLevel(name: string, separator: RegExp) {
  const parts: string[] = [];
  let depth = 0,
    current = "";
  for (const c of name) {
    if (c === "{") depth++;
    if (c === "}") depth--;
    if (depth === 0 && separator.test(c)) {
      parts.push(current);
      current = "";
    } else current += c;
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}
/** A BibTeX author list as names and family names; `others` marks a list
 * cut short with "and others". */
export function bibAuthors(value: string) {
  const names: string[] = [],
    families: string[] = [];
  let others = false;
  for (const name of splitNames(value)) {
    if (name.toLowerCase() === "others") {
      others = true;
      continue;
    }
    let family: string;
    if (/^\{[^{}]*\}$/.test(name)) family = name;
    else {
      const comma = topLevel(name, /,/);
      if (comma.length > 1) family = comma[0];
      else {
        const words = topLevel(name, /\s/),
          von = words.findIndex((w, i) => i > 0 && i < words.length - 1 && /^[a-z]/.test(w));
        family = words.slice(von > 0 ? von : words.length - 1).join(" ");
      }
    }
    names.push(plain(comma(name)));
    families.push(compact(family));
  }
  return { names, families, others };
}
// "Knuth, Donald E." as "Donald E. Knuth" for display.
function comma(name: string) {
  const parts = topLevel(name, /,/);
  return parts.length === 2 ? `${parts[1]} ${parts[0]}` : name;
}
const recordFamily = (name: string) =>
  compact(name.replace(/\s+\d{4}$/, "").trim().split(/\s+/).at(-1) ?? "");
const sameFamily = (a: string, b: string) =>
  a === b || (Math.min(a.length, b.length) >= 3 && (a.endsWith(b) || b.endsWith(a)));

// --- Identifiers ----------------------------------------------------------

export function doiOf(fields: Record<string, string>) {
  const clean = (value: string) =>
    value
      .replace(/\\_/g, "_")
      .replace(/^\s*(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i, "")
      .replace(/[\s.,;]+$/, "")
      .trim();
  if (fields.doi) {
    const doi = clean(fields.doi);
    if (/^10\.\d{4,9}\/\S+$/.test(doi)) return doi;
  }
  const inUrl = /doi\.org\/(10\.\d{4,9}\/[^\s}]+)/i.exec(fields.url ?? "");
  return inUrl ? clean(inUrl[1]) : null;
}
const ARXIV = /(\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?/;
export function arxivOf(fields: Record<string, string>) {
  const kind = (fields.archiveprefix ?? fields.eprinttype ?? "").toLowerCase();
  if (fields.eprint && (kind === "arxiv" || !kind)) {
    const match = new RegExp(`^\\s*(?:arxiv:)?${ARXIV.source}\\s*$`, "i").exec(fields.eprint);
    if (match) return match[1];
  }
  if (fields.arxiv) {
    const match = ARXIV.exec(fields.arxiv);
    if (match) return match[1];
  }
  const url = /arxiv\.org\/(?:abs|pdf)\/([^\s}?#]+)/i.exec(fields.url ?? "");
  if (url) {
    const match = ARXIV.exec(url[1]);
    if (match) return match[1];
  }
  for (const name of ["journal", "note", "howpublished", "booktitle", "publisher"]) {
    const match = new RegExp(`arXiv:\\s*${ARXIV.source}`, "i").exec(fields[name] ?? "");
    if (match) return match[1];
  }
  const doi = /^10\.48550\/arxiv\.(.+)$/i.exec(doiOf(fields) ?? "");
  return doi ? (ARXIV.exec(doi[1])?.[1] ?? null) : null;
}
const yearOf = (fields: Record<string, string>) => {
  const match = /\b(\d{4})\b/.exec(fields.year ?? fields.date ?? "");
  return match ? Number(match[1]) : null;
};

// --- HTTP -----------------------------------------------------------------

interface Answer {
  status: number;
  type: string;
  body: string;
}
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** One request at a time to each host, paced, with a short retry, and a
 * host that keeps failing set aside for a few minutes. */
export class Http {
  private queues = new Map<string, Promise<unknown>>();
  private last = new Map<string, number>();
  private down = new Map<string, number>();
  constructor(
    private fetcher: Fetch = fetch,
    private pace: Record<string, number> = PACE,
    private now: () => number = Date.now,
    private sleep: (ms: number) => Promise<unknown> = delay,
  ) {}
  get(url: string, accept: string): Promise<Lookup<Answer>> {
    const host = new URL(url).hostname,
      run = (this.queues.get(host) ?? Promise.resolve()).then(() =>
        this.request(host, url, accept),
      );
    this.queues.set(host, run.catch(() => {}));
    return run;
  }
  private async request(host: string, url: string, accept: string): Promise<Lookup<Answer>> {
    if ((this.down.get(host) ?? 0) > this.now()) return "unavailable";
    for (let attempt = 0; attempt < 3; attempt++) {
      const wait = (this.last.get(host) ?? 0) + (this.pace[host] ?? 500) - this.now();
      if (wait > 0) await this.sleep(wait);
      this.last.set(host, this.now());
      try {
        const response = await this.fetcher(url, {
          headers: { Accept: accept, "User-Agent": AGENT },
          redirect: "follow",
          signal: AbortSignal.timeout(15000),
        });
        const type = response.headers.get("content-type") ?? "",
          body = await response.text();
        // A page asking to prove the client is not a bot is not an answer.
        if (response.status === 202 || (accept.includes("json") && response.ok && !type.includes("json"))) {
          this.down.set(host, this.now() + 10 * 60000);
          return "unavailable";
        }
        if (response.status === 429 || response.status >= 500) {
          const after = Number(response.headers.get("retry-after"));
          if (attempt < 2) {
            await this.sleep(Math.min(Number.isFinite(after) && after > 0 ? after * 1000 : 1500 * (attempt + 1), 10000));
            continue;
          }
          this.down.set(host, this.now() + 5 * 60000);
          return "unavailable";
        }
        return { status: response.status, type, body };
      } catch {
        if (attempt < 2) {
          await this.sleep(1000 * (attempt + 1));
          continue;
        }
        this.down.set(host, this.now() + 2 * 60000);
        return "unavailable";
      }
    }
    return "unavailable";
  }
}

// --- Sources --------------------------------------------------------------

const first = (value: unknown) =>
  (Array.isArray(value) ? value[0] : value) as string | undefined;
function cslCandidate(item: any, source: CheckRecord["source"]): Candidate | null {
  const title = first(item?.title);
  if (!title) return null;
  const people = (Array.isArray(item.author) ? item.author : []) as any[],
    authors = people.map((a) => a.literal ?? a.name ?? [a.given, a.family].filter(Boolean).join(" ")).filter(Boolean),
    families = people.map((a) => compact(a.family ?? a.literal ?? a.name ?? "")).filter(Boolean),
    year = (item.issued ?? item.published ?? item["published-print"] ?? item["published-online"])?.["date-parts"]?.[0]?.[0],
    doi = typeof item.DOI === "string" ? item.DOI : null,
    venue = first(item["container-title"]) || (typeof item.publisher === "string" ? item.publisher : null) || null;
  return {
    record: {
      source,
      title: plain(String(title)),
      authors,
      year: Number.isInteger(year) ? year : null,
      venue,
      doi,
      url: doi ? `https://doi.org/${doi}` : (item.URL ?? ""),
    },
    families,
    preprint: item.type === "posted-content" || /arxiv/i.test(String(item.publisher ?? "")),
    kind: typeof item.type === "string" ? item.type : undefined,
  };
}
async function byDoi(http: Http, doi: string): Promise<Lookup<Candidate | null>> {
  const url = "https://doi.org/" + doi.split("/").map(encodeURIComponent).join("/"),
    answer = await http.get(url, "application/vnd.citationstyles.csl+json");
  if (answer === "unavailable") return answer;
  if (answer.status === 404) return null;
  if (answer.status !== 200) return "unavailable";
  try {
    return cslCandidate(JSON.parse(answer.body), "doi") ?? "unavailable";
  } catch {
    return "unavailable";
  }
}
// Crossref ranks the right record first far more often when the query
// carries the authors' names as well as the title.
async function searchCrossref(http: Http, title: string, names: string[]): Promise<Lookup<Candidate[]>> {
  const query = new URLSearchParams({
      "query.bibliographic": [title, ...names.slice(0, 4)].join(" "),
      rows: "10",
      select: "DOI,title,author,issued,container-title,type,publisher",
    }),
    answer = await http.get(`https://api.crossref.org/works?${query}`, "application/json");
  if (answer === "unavailable" || answer.status !== 200) return "unavailable";
  try {
    const items: any[] = JSON.parse(answer.body)?.message?.items ?? [];
    return items.map((item) => cslCandidate(item, "crossref")).filter((c): c is Candidate => c !== null);
  } catch {
    return "unavailable";
  }
}
async function searchDblp(http: Http, title: string): Promise<Lookup<Candidate[]>> {
  const query = new URLSearchParams({ q: title, format: "json", h: "5" }),
    answer = await http.get(`https://dblp.org/search/publ/api?${query}`, "application/json");
  if (answer === "unavailable" || answer.status !== 200) return "unavailable";
  try {
    const hits: any[] = JSON.parse(answer.body)?.result?.hits?.hit ?? [];
    return hits.flatMap((hit): Candidate[] => {
      const info = hit.info ?? {},
        people = info.authors?.author,
        list = (Array.isArray(people) ? people : people ? [people] : []).map((a: any) =>
          String(a.text ?? a).replace(/\s+\d{4}$/, ""),
        );
      if (!info.title) return [];
      return [{
        record: {
          source: "dblp",
          title: String(info.title).replace(/\.$/, ""),
          authors: list,
          year: Number(info.year) || null,
          venue: first(info.venue) ?? null,
          doi: info.doi ?? null,
          url: info.url ?? info.ee ?? "",
        },
        families: list.map(recordFamily),
        preprint: /corr/i.test(String(info.venue ?? "")),
      }];
    });
  } catch {
    return "unavailable";
  }
}
const decode = (text: string) =>
  text
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
function atomCandidates(xml: string): Candidate[] {
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].flatMap(([, entry]): Candidate[] => {
    const tag = (name: string) =>
        decode(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(entry)?.[1] ?? "").replace(/\s+/g, " ").trim(),
      id = ARXIV.exec(tag("id"))?.[1],
      title = tag("title");
    if (!id || !title) return [];
    const authors = [...entry.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/g)].map((m) => decode(m[1]).trim());
    return [{
      record: {
        source: "arxiv",
        title,
        authors,
        year: Number(/^(\d{4})/.exec(tag("published"))?.[1]) || null,
        venue: tag("arxiv:journal_ref") || "arXiv",
        doi: tag("arxiv:doi") || null,
        url: `https://arxiv.org/abs/${id}`,
      },
      families: authors.map(recordFamily),
      preprint: true,
    }];
  });
}
async function byArxiv(http: Http, id: string): Promise<Lookup<Candidate | null>> {
  const answer = await http.get(
    `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`,
    "application/atom+xml",
  );
  if (answer === "unavailable" || answer.status !== 200) return "unavailable";
  return atomCandidates(answer.body)[0] ?? null;
}
async function searchArxiv(http: Http, title: string): Promise<Lookup<Candidate[]>> {
  const words = fold(title).replace(/[^\p{L}\p{N}\s-]+/gu, " ").replace(/\s+/g, " ").trim(),
    answer = await http.get(
      `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(`ti:"${words}"`)}&max_results=5`,
      "application/atom+xml",
    );
  if (answer === "unavailable" || answer.status !== 200) return "unavailable";
  return atomCandidates(answer.body);
}

// --- Comparison -----------------------------------------------------------

interface Entry {
  type: string;
  title: string;
  authors: ReturnType<typeof bibAuthors>;
  year: number | null;
  doi: string | null;
}
function readEntry(type: string, fields: Record<string, string>): Entry {
  return {
    type: type.toLowerCase(),
    title: plain(fields.title ?? ""),
    authors: bibAuthors(fields.author ?? fields.editor ?? ""),
    year: yearOf(fields),
    doi: doiOf(fields),
  };
}
const yearAgrees = (entry: Entry, c: Candidate) =>
  entry.year === null ||
  c.record.year === null ||
  entry.year === c.record.year ||
  (c.preprint && entry.year > c.record.year && entry.year - c.record.year <= 2);
function authorsAgree(entry: Entry, c: Candidate) {
  const bib = entry.authors.families,
    record = c.families;
  if (!bib.length || !record.length) return { first: true, all: true, order: true };
  const found = bib.filter((f) => record.some((r) => sameFamily(f, r))),
    counted = entry.authors.others ? bib.length <= record.length : bib.length === record.length;
  return {
    first: sameFamily(bib[0], record[0]),
    all: found.length === bib.length && counted,
    order: bib.every((f, i) => record[i] !== undefined && sameFamily(f, record[i])),
  };
}
function differences(entry: Entry, c: Candidate): CheckDifference[] {
  const result: CheckDifference[] = [],
    title = titleScore(entry.title, c.record.title);
  if (entry.title && title < 1)
    result.push({ field: "title", bib: entry.title, record: c.record.title, ...(title >= 0.9 ? { minor: true } : {}) });
  const authors = authorsAgree(entry, c);
  if (!authors.all || !authors.first || !authors.order)
    result.push({
      field: "author",
      bib: [...entry.authors.names, ...(entry.authors.others ? ["others"] : [])].join("; "),
      record: c.record.authors.join("; "),
      ...(authors.all && authors.first ? { minor: true } : {}),
    });
  if (entry.year !== null && c.record.year !== null && entry.year !== c.record.year)
    result.push({ field: "year", bib: String(entry.year), record: String(c.record.year), ...(yearAgrees(entry, c) ? { minor: true } : {}) });
  if (entry.doi && c.record.doi && entry.doi.toLowerCase() !== c.record.doi.toLowerCase() && c.record.source !== "arxiv")
    result.push({ field: "doi", bib: entry.doi, record: c.record.doi });
  return result;
}
function judge(entry: Entry, c: Candidate) {
  const found = differences(entry, c);
  return {
    status: found.some((d) => !d.minor) ? ("mismatch" as const) : ("verified" as const),
    record: c.record,
    differences: found,
  };
}
// A journal article with a book's title is a review of the book.
const BOOKS = new Set(["book", "booklet", "manual", "collection", "mvbook", "proceedings", "reference"]);
const review = (entry: Entry, c: Candidate) =>
  BOOKS.has(entry.type) && (c.kind === "journal-article" || c.kind === "book-review");
// How well a search result fits the entry, and whether it agrees.
function fit(entry: Entry, c: Candidate) {
  const title = titleScore(entry.title, c.record.title),
    authors = authorsAgree(entry, c),
    year = yearAgrees(entry, c);
  return {
    title,
    agrees: title >= 0.9 && authors.first && year,
    value: title * 3 + (authors.first ? 1 : 0) + (authors.all ? 0.5 : 0) + (year ? 0.5 : 0),
  };
}

export async function checkEntry(input: CheckInput, http: Http, now = Date.now): Promise<ReferenceCheck> {
  const entry = readEntry(input.type, input.fields),
    arxiv = arxivOf(input.fields),
    unavailable = new Set<string>(),
    result = (check: Omit<ReferenceCheck, "unavailable" | "checked" | "differences"> & { differences?: CheckDifference[] }): ReferenceCheck => ({
      differences: [],
      ...check,
      unavailable: [...unavailable],
      checked: Math.floor(now() / 1000),
    });
  if (!entry.doi && !arxiv && !compact(entry.title))
    return result({ status: "skipped", via: null, reason: "nothing-to-check" });
  let doiLost = false,
    arxivLost = false,
    answered = false;
  // An identifier that names no record is itself a finding, also when the
  // work turns up by its title.
  const settle = (c: Candidate, via: ReferenceCheck["via"], agrees = true) => {
    let found = judge(entry, c).differences;
    if (doiLost)
      found = [{ field: "doi", bib: entry.doi!, record: c.record.doi ?? "" }, ...found.filter((d) => d.field !== "doi")];
    if (arxivLost)
      found = [{ field: "arxiv", bib: arxiv!, record: c.record.source === "arxiv" ? (ARXIV.exec(c.record.url)?.[1] ?? "") : "" }, ...found];
    return result({
      status: !agrees || found.some((d) => !d.minor) ? "mismatch" : "verified",
      via,
      record: c.record,
      differences: found,
    });
  };
  if (entry.doi && !/^10\.48550\//.test(entry.doi)) {
    const found = await byDoi(http, entry.doi);
    if (found === "unavailable") unavailable.add("doi.org");
    else if (found) return settle(found, "doi");
    else answered = doiLost = true;
  }
  if (arxiv) {
    const found = await byArxiv(http, arxiv);
    if (found === "unavailable") unavailable.add("arXiv");
    else if (found) return settle(found, "arxiv");
    else answered = arxivLost = true;
  }
  const reason = doiLost ? "doi-not-found" : arxivLost ? "arxiv-not-found" : "no-match";
  if (compact(entry.title)) {
    let best: { c: Candidate; fit: ReturnType<typeof fit> } | null = null;
    const searches: [string, () => Promise<Lookup<Candidate[]>>][] = [
      ["Crossref", () => searchCrossref(http, entry.title, entry.authors.names)],
      ["DBLP", () => searchDblp(http, entry.title)],
      ["arXiv", () => searchArxiv(http, entry.title)],
    ];
    for (const [name, search] of searches) {
      const found = await search();
      if (found === "unavailable") {
        unavailable.add(name);
        continue;
      }
      answered = true;
      for (const c of found) {
        if (review(entry, c)) continue;
        const f = fit(entry, c);
        // A result that agrees beats a closer one that does not.
        if (
          f.title >= 0.6 &&
          (!best || (f.agrees === best.fit.agrees ? f.value > best.fit.value : f.agrees))
        )
          best = { c, fit: f };
      }
      if (best?.fit.agrees) break;
    }
    // The same title with other authors or another year is the work with
    // wrong details; a similar title, or one with a subtitle added, is only
    // the closest record.
    if (best && (best.fit.agrees || best.fit.title >= 0.95)) return settle(best.c, "title", best.fit.agrees);
    if (best)
      return result({ status: "unverified", via: "title", reason, record: best.c.record, differences: judge(entry, best.c).differences });
  }
  return result({
    status: answered ? "unverified" : "failed",
    via: entry.doi ? "doi" : arxiv ? "arxiv" : "title",
    reason,
  });
}

// --- Checker --------------------------------------------------------------

/** The added and modified entries of a round, as the check reads them. */
export function checkInputs(references?: References): CheckInput[] {
  return (references?.entries ?? [])
    .filter((e) => e.status !== "removed" && !e.error)
    .map((e) => ({
      id: e.id,
      type: e.type,
      fields: Object.fromEntries(
        e.fields.filter((f) => f.new !== null).map((f) => [f.name, f.resolved ?? f.new!]),
      ),
    }));
}
/** Entries of the whole bibliography, as the check reads them. */
export function entryInputs(entries: { id: string; type: string; fields: { name: string; value: string; resolved?: string }[]; error?: string }[]): CheckInput[] {
  return entries
    .filter((e) => !e.error)
    .map((e) => ({ id: e.id, type: e.type, fields: Object.fromEntries(e.fields.map((f) => [f.name, f.resolved ?? f.value])) }));
}
// Bump when the comparison changes, so that saved results are redone.
const VERSION = 1;
const LOOKED_UP = ["title", "author", "editor", "year", "date", "doi", "eprint", "archiveprefix", "eprinttype", "arxiv", "url", "journal", "note", "howpublished", "booktitle", "publisher"];
export const keyOf = (input: CheckInput) =>
  createHash("sha256")
    .update(JSON.stringify([VERSION, LOOKED_UP.map((n) => input.fields[n] ?? "")]))
    .digest("hex")
    .slice(0, 32);
// How long a result stands before the entry is looked up again, in seconds.
const KEEP: Record<ReferenceCheck["status"], number> = {
  verified: 30 * 86400,
  mismatch: 30 * 86400,
  skipped: 30 * 86400,
  unverified: 86400,
  failed: 120,
};

/** Checks entries in the background and keeps the results in a file, so
 * that a page can ask again until every entry has one. */
export class ReferenceChecker {
  private saved: Record<string, ReferenceCheck> | null = null;
  private failed = new Map<string, ReferenceCheck>();
  private running = new Map<string, Promise<void>>();
  private waiting: (() => void)[] = [];
  private active = 0;
  private now: () => number;
  private concurrency: number;
  private http: Http;
  constructor(
    private file: string | null,
    options: { fetch?: Fetch; pace?: Record<string, number>; now?: () => number; concurrency?: number } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.concurrency = options.concurrency ?? 3;
    this.http = new Http(options.fetch, options.pace, this.now);
  }
  private results() {
    if (!this.saved) {
      try {
        const data = JSON.parse(fs.readFileSync(this.file ?? "", "utf8"));
        this.saved = data?.version === VERSION && data.checks && typeof data.checks === "object" ? data.checks : {};
      } catch {
        this.saved = {};
      }
    }
    return this.saved!;
  }
  private save() {
    if (!this.file) return;
    const kept = Object.entries(this.results())
      .sort((a, b) => b[1].checked - a[1].checked)
      .slice(0, 3000);
    this.saved = Object.fromEntries(kept);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify({ version: VERSION, checks: this.saved }));
      fs.renameSync(temporary, this.file);
    } catch {
      /* The results stay in memory. */
    }
  }
  private fresh(check: ReferenceCheck) {
    return this.now() / 1000 - check.checked < KEEP[check.status];
  }
  /** The results known for these entries. With `start`, entries without a
   * fresh result are looked up; `retry` also redoes those that found nothing
   * or could not be checked. */
  lookup(inputs: CheckInput[], start = false, retry = false): ReferenceChecks {
    const checks: Record<string, ReferenceCheck> = {};
    let pending = 0;
    for (const input of inputs) {
      const key = keyOf(input),
        known = this.failed.get(key) ?? this.results()[key],
        redo = retry && known && (known.status === "failed" || known.status === "unverified");
      if (this.running.has(key)) {
        pending++;
        continue;
      }
      if (known && this.fresh(known) && !redo) {
        checks[input.id] = known;
        continue;
      }
      if (!start) {
        if (known) checks[input.id] = known;
        continue;
      }
      pending++;
      this.run(key, input);
    }
    return { checks, pending };
  }
  private run(key: string, input: CheckInput) {
    const task = (async () => {
      if (this.active >= this.concurrency) await new Promise<void>((r) => this.waiting.push(r));
      this.active++;
      try {
        const check = await checkEntry(input, this.http, this.now);
        if (check.status === "failed") this.failed.set(key, check);
        else {
          this.failed.delete(key);
          this.results()[key] = check;
          this.save();
        }
      } catch {
        this.failed.set(key, {
          status: "failed",
          via: null,
          differences: [],
          unavailable: [],
          checked: Math.floor(this.now() / 1000),
        });
      } finally {
        this.active--;
        this.waiting.shift()?.();
        this.running.delete(key);
      }
    })();
    this.running.set(key, task);
  }
  /** Settles when every lookup in progress has finished, for tests. */
  async idle() {
    while (this.running.size) await Promise.all(this.running.values());
  }
}

/** Entries the author has checked by hand, kept beside the repository's
 * review state so that the panel, the review of uncommitted changes and
 * every task's review share them. A confirmation is of the entry's looked-up
 * fields: editing them asks again. */
export class Confirmations {
  constructor(private file: string) {}
  private read(): Record<string, number> {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return data?.version === 1 && data.confirmed && typeof data.confirmed === "object" ? data.confirmed : {};
    } catch {
      return {};
    }
  }
  /** When each of these entries was confirmed, in seconds. */
  of(inputs: CheckInput[]) {
    const saved = this.read(),
      result: Record<string, number> = {};
    for (const input of inputs) {
      const at = saved[keyOf(input)];
      if (typeof at === "number") result[input.id] = at;
    }
    return result;
  }
  set(input: CheckInput, on: boolean, now = Date.now()) {
    const saved = this.read(),
      key = keyOf(input);
    if (on) saved[key] = Math.floor(now / 1000);
    else delete saved[key];
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, confirmed: saved }));
    fs.renameSync(temporary, this.file);
  }
}
