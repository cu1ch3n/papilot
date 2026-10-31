import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Fixture } from "./helpers.ts";
import {
  bibliographyReport,
  citations,
  documentFiles,
  entryChanges,
  parseBib,
  referenceChanges,
  uncomment,
  type Document,
} from "../../src/core/bib.ts";
import { applyUnits, diffUnits } from "../../src/core/changes.ts";
import { buildOutline } from "../../src/core/outline.ts";
import type { Unit } from "../../src/types.ts";

const BIB = String.raw`% A comment line, ignored like any text outside entries.
@string{ acm = "ACM" }

@article{knuth1981,
  author  = {Donald E. Knuth and Michael F. Plass},
  title   = {Breaking paragraphs
             into lines},
  journal = {Software: Practice and Experience},
  year    = 1981,
  month   = nov,
}

@inproceedings{ellis1989,
  author    = "C. A. Ellis and S. J. Gibbs",
  title     = "Concurrency control in {Groupware} systems",
  booktitle = acm # " SIGMOD",
  year      = {1989}
}
`;

describe("BibTeX entries", () => {
  it("reads entries with their lines, values as written and macros expanded", () => {
    const [knuth, ellis] = parseBib(BIB);
    expect(knuth).toMatchObject({ key: "knuth1981", type: "article", lines: [4, 11] });
    expect(knuth.fields.map((f) => [f.name, f.value])).toEqual([
      ["author", "Donald E. Knuth and Michael F. Plass"],
      ["title", "Breaking paragraphs into lines"],
      ["journal", "Software: Practice and Experience"],
      ["year", "1981"],
      ["month", "nov"],
    ]);
    expect(knuth.fields.at(-1)!.resolved).toBe("November");
    expect(ellis).toMatchObject({ key: "ellis1989", type: "inproceedings", lines: [13, 18] });
    expect(ellis.fields[1].value).toBe("Concurrency control in {Groupware} systems");
    expect(ellis.fields[2]).toMatchObject({ value: 'acm # " SIGMOD"', resolved: "ACM SIGMOD" });
  });
  it("keeps reading after an entry it cannot read, and says why", () => {
    const entries = parseBib(
      "@article{broken,\n  title = {Unclosed,\n  year = 2020\n\n@book{fine, title={Fine}}\n",
    );
    expect(entries.map((e) => e.key)).toEqual(["broken", "fine"]);
    expect(entries[0].error).toBeTruthy();
    expect(entries[0].lines).toEqual([1, 4]);
    expect(entries[1]).toMatchObject({ lines: [5, 5], fields: [{ name: "title", value: "Fine" }] });
    expect(parseBib("@misc{a, title = {A} year = 2020}")[0].error).toMatch(/comma/);
  });
  it("ignores @comment and @preamble, and parenthesised entries work", () => {
    const entries = parseBib(
      "@comment{ @article{hidden, title={No}} }\n@preamble{ {\\newcommand{\\x}{y}} }\n@misc(paren, title = {P})\n",
    );
    expect(entries.map((e) => e.key)).toEqual(["paren"]);
  });
  it("pairs entries by key and lists every field of a changed one", () => {
    const next = BIB.replace("year    = 1981", "year    = 1982")
      .replace("@inproceedings{ellis1989", "@inproceedings{ellis89")
      .concat("\n@misc{new2024,\n  title = {A new one},\n  note = {x}\n}\n");
    const changes = entryChanges(BIB, next);
    expect(changes.map((c) => [c.status, c.key, c.oldKey])).toEqual([
      ["modified", "knuth1981", undefined],
      ["modified", "ellis89", "ellis1989"],
      ["added", "new2024", undefined],
    ]);
    expect(changes[0].fields.find((f) => f.name === "year")).toEqual({ name: "year", old: "1981", new: "1982" });
    expect(changes[0].fields.find((f) => f.name === "title")).toEqual({
      name: "title",
      old: "Breaking paragraphs into lines",
      new: "Breaking paragraphs into lines",
    });
    expect(changes[1].fields.every((f) => f.old === f.new)).toBe(true);
    expect(changes[2].fields.map((f) => f.old)).toEqual([null, null]);
    expect(entryChanges(next, BIB).find((c) => c.key === "new2024")?.status).toBe("removed");
    // Reformatting an entry changes none of its values.
    expect(entryChanges(BIB, BIB.replace("year    = 1981,", "year = 1981,"))).toEqual([]);
  });
});

describe("Citations", () => {
  it("finds the keys of LaTeX, natbib and biblatex citations, without comments", () => {
    const text = String.raw`As \cite{a} and \citep[p.~3]{b, c} show.
% \cite{commented}
\textcite[see][12]{d}\nocite{*} 100\% \citet*{e}
\cites[1]{f}[2]{g} \Citep{h} \citestyle{plain} \footcite{i}`;
    expect(citations(text, "x.tex").map((c) => `${c.key}:${c.line}`)).toEqual([
      "a:1", "b:1", "c:1", "d:3", "*:3", "e:3", "f:4", "g:4", "h:4", "i:4",
    ]);
    expect(uncomment("a % b\nc \\% d % e")).toBe("a    \nc \\% d    ");
  });
  it("follows inputs from the main file and finds its bibliography", () => {
    const files: Record<string, string> = {
      "paper/main.tex": String.raw`\input{sections/a}\include{b}\import{parts/}{c}
% \input{ignored}
\bibliography{refs,more.bib}\addbibresource[label=x]{extra.bib}`,
      "paper/sections/a.tex": String.raw`\subimport{deep/}{d}`,
      "paper/sections/deep/d.tex": "",
      "paper/b.tex": "",
      "paper/parts/c.tex": "",
    };
    expect(documentFiles((f) => files[f] ?? null, "paper/main.tex")).toEqual({
      files: ["paper/main.tex", "paper/sections/a.tex", "paper/sections/deep/d.tex", "paper/b.tex", "paper/parts/c.tex"],
      bibs: ["paper/refs.bib", "paper/more.bib", "paper/extra.bib"],
    });
  });
});

const MAIN = String.raw`\documentclass{article}
\begin{document}
\section{Intro}
Text \cite{knuth1981}.
\section{Related}
See \cite{ellis1989}.
\bibliography{refs}
\end{document}
`;
function doc(files: Record<string, string>): Document {
  const read = (f: string) => files[f] ?? null;
  return { read, main: "paper/main.tex", outline: buildOutline(read, "paper/main.tex").nodes };
}
const unit = (over: Partial<Unit>): Unit => ({
  id: "c001", file: "paper/refs.bib", status: "modified", kind: "text", whole_file: false, ops: [],
  old_start: 1, old_end: 1, new_start: 1, new_end: 1, old_text: "", new_text: "", truncated: false, ...over,
});

describe("Bibliography changes of a round", () => {
  it("shows each entry under its edit, where it is cited, and what is wrong with it", () => {
    const next = BIB.replace("@inproceedings{ellis1989", "@inproceedings{ellis89")
      .concat("\n@misc{knuth1981,\n  title = {Twice}\n}\n");
    const result = referenceChanges(
      [
        unit({ id: "c001", old_start: 13, old_end: 13, new_start: 13, new_end: 13 }),
        unit({ id: "c002", old_start: 19, old_end: 19, new_start: 19, new_end: 22 }),
      ],
      doc({ "paper/main.tex": MAIN, "paper/refs.bib": BIB }),
      doc({ "paper/main.tex": MAIN.replace("Text \\cite{knuth1981}", "Text \\cite{knuth1981,missing}"), "paper/refs.bib": next }),
    )!;
    expect(result.entries.map((e) => [e.unit, e.key, e.status, e.problems])).toEqual([
      ["c001", "ellis89", "modified", ["still-cited"]],
      ["c002", "knuth1981", "added", ["duplicate-key"]],
    ]);
    expect(result.entries[0]).toMatchObject({
      id: "paper/refs.bib#ellis89",
      old_key: "ellis1989",
      cited: [],
      old_cited: [{ file: "paper/main.tex", line: 6, section: "2 Related" }],
    });
    expect(result.entries[1].cited).toEqual([{ file: "paper/main.tex", line: 4, section: "1 Intro" }]);
    expect(result.missing).toEqual([
      { key: "missing", file: "paper/main.tex", line: 4, unit: null, section: "1 Intro" },
    ]);
  });
  it("flags a .bib file the document does not read, and reports nothing without changes", () => {
    const result = referenceChanges(
      [unit({ file: "paper/other.bib", status: "added", whole_file: true })],
      doc({ "paper/main.tex": MAIN, "paper/refs.bib": BIB }),
      doc({ "paper/main.tex": MAIN, "paper/refs.bib": BIB, "paper/other.bib": "@misc{x, title={X}}" }),
    )!;
    expect(result.entries.map((e) => [e.key, e.status, e.problems])).toEqual([["x", "added", ["not-in-bibliography"]]]);
    expect(referenceChanges([], doc({ "paper/main.tex": MAIN }), doc({ "paper/main.tex": MAIN }))).toBeUndefined();
  });
});

describe("Bibliography hunks", () => {
  let f: Fixture;
  beforeEach(() => {
    f = new Fixture();
  });
  afterEach(async () => f.close());
  it("makes one change of hunks that touch the same entry, so an entry is decided whole", () => {
    const fields = Array.from({ length: 12 }, (_, i) => `  field${i} = {${i}},`).join("\n"),
      bib = `@article{long,\n${fields}\n  title = {Old}\n}\n\n@misc{other,\n  title = {Other}\n}\n`;
    f.write("paper/refs.bib", bib);
    f.repo.run(["add", "."]);
    f.repo.run(["commit", "-qm", "bib"]);
    const head = f.repo.rev("HEAD"),
      next = bib.replace("field0 = {0}", "field0 = {zero}").replace("title = {Old}", "title = {New}");
    f.write("paper/refs.bib", next);
    const after = f.repo.snapshot(["paper"]),
      units = diffUnits(f.repo, head, after);
    expect(units).toHaveLength(1);
    expect(units[0].ops.length).toBe(2);
    expect(applyUnits(f.repo.blob(head, "paper/refs.bib"), f.repo.blob(after, "paper/refs.bib"), units)?.toString()).toBe(next);
    // Distant edits of different entries stay separate.
    const apart = bib.replace("field0 = {0}", "field0 = {zero}").replace("title = {Other}", "title = {Another}");
    f.write("paper/refs.bib", apart);
    expect(diffUnits(f.repo, head, f.repo.snapshot(["paper"]))).toHaveLength(2);
  });
});

describe("The whole bibliography", () => {
  it("lists every entry with its citations, and what is wrong without looking anything up", () => {
    const bib = BIB + String.raw`
@misc{knuth1981,
  title = {Again}
}
@article{plass81,
  title = {Breaking paragraphs into lines},
  doi = {10.1002/spe.4380111102}
}
@book{other,
  title = {Something else},
  doi = {https://doi.org/10.1002/SPE.4380111102}
}
`;
    const report = bibliographyReport(doc({ "paper/main.tex": MAIN.replace("See \\cite{ellis1989}.", "See \\cite{ellis1989,ghost}."), "paper/refs.bib": bib }));
    expect(report.bibs).toEqual(["paper/refs.bib"]);
    expect(report.entries.map((e) => [e.id, e.cited.length])).toEqual([
      ["paper/refs.bib#knuth1981", 1],
      ["paper/refs.bib#ellis1989", 1],
      ["paper/refs.bib#knuth1981#2", 1],
      ["paper/refs.bib#plass81", 0],
      ["paper/refs.bib#other", 0],
    ]);
    expect(report.entries[1].cited).toEqual([{ file: "paper/main.tex", line: 6, section: "2 Related" }]);
    expect(report.missing).toEqual([{ key: "ghost", file: "paper/main.tex", line: 6, section: "2 Related" }]);
    expect(report.duplicates).toEqual([["paper/refs.bib#knuth1981", "paper/refs.bib#knuth1981#2"]]);
    expect(report.similar).toEqual([
      { ids: ["paper/refs.bib#plass81", "paper/refs.bib#other"], by: "doi" },
      { ids: ["paper/refs.bib#knuth1981", "paper/refs.bib#plass81"], by: "title" },
    ]);
    expect(report.all_cited).toBe(false);
  });
  it("names .bib files that do not exist", () => {
    const report = bibliographyReport(doc({ "paper/main.tex": MAIN }));
    expect(report).toMatchObject({ bibs: ["paper/refs.bib"], absent: ["paper/refs.bib"], entries: [] });
  });
});
