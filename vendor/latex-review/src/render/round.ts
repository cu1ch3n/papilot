import fs from "node:fs";
import path from "node:path";
import { readJson, writeJson } from "../core/files.ts";
import { within } from "../core/git.ts";
import { deepestNode } from "../core/outline.ts";
import { referenceChanges } from "../core/bib.ts";
import { changesOf, placesOf, renderPlace } from "./effects.ts";
import { Build } from "./locate.ts";
import { renderSection, snap, Strips } from "./inline.ts";
import { pixelDifference, textChanges } from "./pdfdiff.ts";
import type {
  Card,
  ChangeBlock,
  Pair,
  Place,
  PlaceView,
  RenderedRound,
  RenderRequest,
  Strip,
  Unit,
} from "../types.ts";
export function typesetWords(text: string) {
  // TeX comments consume the end-of-line too. Keeping that newline would
  // turn a standalone comment into a paragraph break, or split foo%\nbar.
  const uncommented = (text.match(/[^\n]*\n|[^\n]+$/g) ?? [])
    .map((line) => {
      line = line.replace(/^[ \t]+/, "");
      for (let i = 0; i < line.length; i++) {
        if (line[i] === "\\") {
          i++;
          continue;
        }
        if (line[i] === "%") return line.slice(0, i);
      }
      return line;
    })
    .join("");
  return uncommented
    .split(/\n[ \t]*\n/)
    .filter((p) => p.trim())
    .map((p) => p.trim().replace(/\s+/g, " "));
}
export function classify(
  old: Build,
  next: Build,
  unit: Unit,
  body: Set<string>,
  figureFiles: (file: string) => boolean,
): Pick<Card, "pairs" | "comparison" | "own"> {
  const name = unit.file;
  // A changed line may be inside a whitespace-sensitive environment without
  // including its \begin in the hunk. Inspect the owning file before using
  // the source-only no-op shortcut; the PDF is the authority for these files.
  const whitespaceSensitive =
    /\\(?:verb\b|lstinline\b|mintinline\b|begin\{(?:verbatim\*?|Verbatim|lstlisting|minted)\})/.test(
      (old.read(name) ?? "") + (next.read(name) ?? ""),
    );
  // A .bib file is not typeset where it is written, and % in a URL is not
  // a comment there: its edits are compared in the PDF.
  if (
    unit.kind !== "binary" &&
    !name.endsWith(".bib") &&
    !whitespaceSensitive &&
    !unit.truncated &&
    unit.status === "modified" &&
    JSON.stringify(typesetWords(unit.old_text)) ===
      JSON.stringify(typesetWords(unit.new_text))
  )
    return { pairs: [], comparison: "identical" };
  const located =
      name.endsWith(".tex") && unit.kind !== "binary" && body.has(name),
    whole = unit.whole_file || figureFiles(name),
    left =
      located && unit.status !== "added"
        ? old.locator.locate(name, unit.old_start, unit.old_end, whole)
        : [],
    right =
      located && unit.status !== "deleted"
        ? next.locator.locate(name, unit.new_start, unit.new_end, whole)
        : [],
    analysis = textChanges(old.document, next.document, left, right),
    pairs: Pair[] = [];
  let pixels = 0;
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const a = left[i] ?? null,
      b = right[i] ?? null;
    pairs.push({
      old: a,
      new: b,
      before_marks: analysis.old_marks[i] ?? [],
      after_marks: analysis.new_marks[i] ?? [],
    });
    if (!analysis.text_changed)
      pixels += pixelDifference(
        a ? old.document.page(a.page).raster(a.clip) : null,
        b ? next.document.page(b.page).raster(b.clip) : null,
      );
  }
  const own = {
      old:
        left.length && !whole
          ? old.locator.boxes(name, unit.old_start, unit.old_end)
          : [],
      new:
        right.length && !whole
          ? next.locator.boxes(name, unit.new_start, unit.new_end)
          : [],
    },
    moved = left.some(
      (a, i) =>
        right[i] &&
        (a.page !== right[i].page ||
          a.label !== right[i].label ||
          a.clip.some((v, j) => Math.abs(v - right[i].clip[j]) > 1)),
    );
  return {
    pairs,
    comparison: !pairs.length
      ? "unmapped"
      : analysis.text_changed
        ? "text"
        : pixels
          ? "layout"
          : moved
            ? "position"
            : "identical",
    own,
  };
}
function looseBlock(
  card: Card,
  strips: Strips,
  old: Build,
  next: Build,
): ChangeBlock {
  const before: Strip[] = [],
    after: Strip[] = [];
  for (const pair of card.pairs)
    for (const [side, build, images, marks] of [
      ["old", old, before, pair.before_marks],
      ["new", next, after, pair.after_marks],
    ] as const) {
      const position = pair[side];
      if (position) {
        const image = strips.write(
          build.document,
          position.page,
          ...snap(
            build.document,
            position.page,
            position.clip[1],
            position.clip[3],
          ),
          marks,
          side,
        );
        if (image) images.push(image);
      }
    }
  return {
    kind: "change",
    units: [card.id],
    identical: card.comparison === "identical",
    before,
    after,
  };
}
// Places rendered with the round; the rest render when asked for.
export const SHOWN = 3;
// Renders the round. With more than one edit, when some edit prints nothing
// of its own or some change lies outside every edit's crops, it returns null
// after writing attribute.json: the caller compiles variants to find the
// edits behind each change and passes them back as `causes`.
export function renderRound(
  request: RenderRequest,
  out: string,
): RenderedRound | null {
  fs.mkdirSync(out, { recursive: true });
  const figureFiles = (name: string) => within(name, request.figures),
    old = new Build(request.old, request.main, request.source_dir),
    next = new Build(request.new, request.main, request.source_dir);
  try {
    const body = new Set(
        [old, next].flatMap((b) => b.outline.flatMap((n) => n.files)),
      ),
      cards: Card[] = [],
      result: RenderedRound = { units: {}, sections: [], loose: [] };
    for (const [index, unit] of request.units.entries()) {
      // The pass after variant builds reuses the first pass's cards rather
      // than asking SyncTeX again.
      const card: Card = request.cards?.[index] ?? {
          id: unit.id,
          file: unit.file,
          ...classify(old, next, unit, body, figureFiles),
        },
        node = card.pairs.length
          ? unit.status === "deleted"
            ? deepestNode(old.outline, unit.file, unit.old_start, unit.old_end)
            : deepestNode(next.outline, unit.file, unit.new_start, unit.new_end)
          : null;
      card.context_node = node?.id ?? null;
      cards.push(card);
      result.units[unit.id] = {
        visual: card.comparison,
        pages: [
          ...new Set(card.pairs.map((p) => (p.new ?? p.old)!.label)),
        ].sort(),
        section: node ? `${node.number} ${node.title}`.trim() : null,
      };
    }
    const changes = changesOf(old, next, cards),
      // An edit that prints nothing of its own, such as a macro definition,
      // changes the PDF only away from its lines. An edit of comments or
      // line breaks alone has no crop and changes nothing.
      silent = cards.filter(
        (c) =>
          c.comparison === "unmapped" ||
          (c.comparison === "identical" && c.pairs.length > 0),
      );
    if (
      request.units.length > 1 &&
      !request.causes &&
      (silent.length > 0 || changes.some((c) => !c.within.length))
    ) {
      writeJson(path.join(out, "attribute.json"), {
        changes,
        silent: silent.map((c) => c.id),
        cards,
      });
      return null;
    }
    const causes =
        request.units.length === 1
          ? changes.map(() => [request.units[0].id])
          : (request.causes ?? changes.map(() => [])),
      places = placesOf(
        old,
        next,
        changes.map((c) => c.effect),
        causes,
        changes.map((c) => c.within),
      ),
      strips = new Strips(out);
    for (const [id, list] of Object.entries(places))
      result.units[id].effects = {
        total: list.length,
        shown: list
          .slice(0, SHOWN)
          .map((place) => renderPlace(place, strips, old, next)),
      };
    if (Object.values(places).some((list) => list.length > SHOWN))
      writeJson(path.join(out, "places.json"), {
        main: request.main,
        source_dir: request.source_dir,
        old: request.old,
        new: request.new,
        units: places,
      });
    const placed = new Set<number>();
    for (const node of next.outline.filter((n) =>
      cards.some((c) => c.context_node === n.id),
    )) {
      const members = cards.flatMap((c, i): [number, Card][] =>
        c.context_node === node.id ? [[i, c]] : [],
      );
      let rendered: ReturnType<typeof renderSection>;
      try {
        rendered = renderSection(old, next, node, members, strips, figureFiles);
      } catch (error) {
        if (
          !(error as Error).message.includes("PDF outline") &&
          !(error as Error).message.includes("outside this PDF")
        )
          throw error;
        continue;
      }
      const [blocks, unlocated] = rendered;
      if (!blocks.some((b) => b.kind === "change")) continue;
      result.sections.push({
        node: node.id,
        number: node.number,
        title: node.title,
        blocks,
      });
      members.forEach(([i]) => {
        if (!unlocated.includes(i)) placed.add(i);
      });
    }
    cards.forEach((card, index) => {
      if (!placed.has(index))
        result.loose.push(looseBlock(card, strips, old, next));
    });
    try {
      const references = referenceChanges(request.units, old, next);
      if (references) result.references = references;
    } catch (error) {
      // The PDF review stands without the bibliography's entry view.
      console.error("Could not read the bibliography changes:", error);
    }
    fs.writeFileSync(path.join(out, "round.json"), JSON.stringify(result));
    return result;
  } finally {
    old.close();
    next.close();
  }
}
// The places of an edit past the first SHOWN, rendered into the round's
// folder on the first request and kept there.
export function renderMore(out: string, unit: string): PlaceView[] {
  const file = path.join(out, `places-${unit}.json`);
  if (fs.existsSync(file)) return readJson<PlaceView[]>(file, []);
  const saved = readJson<{
    main: string;
    source_dir: string;
    old: RenderRequest["old"];
    new: RenderRequest["new"];
    units: Record<string, Place[]>;
  } | null>(path.join(out, "places.json"), null);
  const list = saved?.units[unit]?.slice(SHOWN) ?? [];
  if (!saved || !list.length) {
    writeJson(file, []);
    return [];
  }
  const old = new Build(saved.old, saved.main, saved.source_dir),
    next = new Build(saved.new, saved.main, saved.source_dir);
  try {
    const strips = new Strips(out),
      views = list.map((place) => renderPlace(place, strips, old, next));
    writeJson(file, views);
    return views;
  } finally {
    old.close();
    next.close();
  }
}
