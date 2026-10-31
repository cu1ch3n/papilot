import { Repo, within } from "./git.ts";
import { groups, opcodes } from "./diff.ts";
import { entrySpans } from "./bib.ts";
import type { Scope, Unit, Op } from "../types.ts";
export const EXCERPT = 6000;
export function textOf(data: Buffer | null): string | null {
  if (data === null) return "";
  if (data.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return null;
  }
}
export const splitLines = (text: string) =>
  text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
export function diffUnits(
  repo: Repo,
  before: string,
  after: string,
  isFigure: (p: string) => boolean = () => false,
): Unit[] {
  const files = repo.changedFiles(before, after),
    oldBlobs = repo.blobs(before, files),
    newBlobs = repo.blobs(after, files),
    units: Unit[] = [];
  for (const file of files) {
    const old = oldBlobs[file],
      next = newBlobs[file],
      a = textOf(old),
      b = textOf(next);
    const status =
        old === null ? "added" : next === null ? "deleted" : "modified",
      binary = a === null || b === null;
    const left = binary ? [] : splitLines(a!),
      right = binary ? [] : splitLines(b!);
    let hunks = binary ? [] : groups(opcodes(left, right));
    if (!binary && file.endsWith(".bib"))
      hunks = byEntry(hunks, entrySpans(a!), entrySpans(b!));
    const whole =
      binary || status !== "modified" || isFigure(file) || !hunks.length;
    if (whole) hunks = [[["replace", 0, left.length, 0, right.length]]];
    for (const edits of hunks) {
      const [, i, , x] = edits[0],
        [, , j, , y] = edits.at(-1)!;
      const oldText = left.slice(i, j).join(""),
        newText = right.slice(x, y).join("");
      units.push({
        id: `c${String(units.length + 1).padStart(3, "0")}`,
        file,
        status,
        kind: binary ? "binary" : isFigure(file) ? "figure" : "text",
        whole_file: whole,
        ops: whole ? [] : edits,
        old_start: i + 1,
        old_end: Math.max(i + 1, j),
        new_start: x + 1,
        new_end: Math.max(x + 1, y),
        old_text: binary ? "" : oldText.slice(0, EXCERPT),
        new_text: binary ? "" : newText.slice(0, EXCERPT),
        truncated: oldText.length > EXCERPT || newText.length > EXCERPT,
      });
    }
  }
  return units;
}
// A bibliography entry is decided whole: hunks that touch the same entry,
// before or after, or the same key on either side, become one change, so
// accepting part of an entry cannot mix its old and new fields.
export function byEntry(
  hunks: Op[][],
  before: { key: string; span: [number, number] }[],
  after: { key: string; span: [number, number] }[],
) {
  // An empty range touches an entry it falls strictly inside.
  const touches = ([a, b]: [number, number], [s, e]: [number, number]) =>
    a === b ? s < a && a < e : a < e && s < b;
  const root = hunks.map((_, i) => i),
    find = (i: number): number => (root[i] === i ? i : (root[i] = find(root[i]))),
    owner = new Map<string, number>();
  hunks.forEach((hunk, i) => {
    const old: [number, number] = [hunk[0][1], hunk.at(-1)![2]],
      next: [number, number] = [hunk[0][3], hunk.at(-1)![4]],
      keys = [
        ...before.filter((e) => touches(old, e.span)).map((e) => e.key),
        ...after.filter((e) => touches(next, e.span)).map((e) => e.key),
      ];
    for (const key of keys) {
      const j = owner.get(key);
      if (j === undefined) owner.set(key, i);
      else root[find(i)] = find(j);
    }
  });
  const merged = new Map<number, Op[]>();
  hunks.forEach((hunk, i) => {
    const r = find(i);
    merged.set(r, [...(merged.get(r) ?? []), ...hunk]);
  });
  return [...merged.values()].map((ops) =>
    ops.sort((p, q) => p[1] - q[1] || p[3] - q[3]),
  );
}
function edits(units: Unit[], index: 1 | 3): Op[] {
  return units.flatMap((u) => u.ops).sort((a, b) => b[index] - a[index]);
}
export function applyUnits(
  old: Buffer | null,
  next: Buffer | null,
  units: Unit[],
) {
  if (units.some((u) => u.whole_file)) return next;
  const a = splitLines(old!.toString()),
    b = splitLines(next!.toString());
  for (const [, i, j, x, y] of edits(units, 1))
    a.splice(i, j - i, ...b.slice(x, y));
  return Buffer.from(a.join(""));
}
// The tree of `before`, a commit or a tree, with only these units of
// `after` applied.
export function withUnits(
  repo: Repo,
  before: string,
  after: string,
  units: Unit[],
) {
  const files = [...new Set(units.map((u) => u.file))],
    old = repo.blobs(before, files),
    next = repo.blobs(after, files);
  return repo.treeWith(
    before,
    Object.fromEntries(
      files.map((f) => [
        f,
        applyUnits(
          old[f],
          next[f],
          units.filter((u) => u.file === f),
        ),
      ]),
    ),
  );
}
export function revertUnits(
  old: Buffer | null,
  next: Buffer | null,
  units: Unit[],
) {
  if (units.some((u) => u.whole_file)) return old;
  const a = splitLines(old!.toString()),
    b = splitLines(next!.toString());
  for (const [, i, j, x, y] of edits(units, 3))
    b.splice(x, y - x, ...a.slice(i, j));
  return Buffer.from(b.join(""));
}
export function scopeViolations(
  repo: Repo,
  base: string,
  revision: string,
  scope: Scope,
) {
  const files = repo.changedFiles(base, revision);
  if (scope.ranges === null)
    return files.filter((f) => !within(f, scope.paths));
  const old = repo.blobs(base, files),
    next = repo.blobs(revision, files),
    violations: string[] = [];
  for (const file of files) {
    const a = textOf(old[file]),
      b = textOf(next[file]),
      allowed = scope.ranges[file];
    if (!allowed || old[file] === null || a === null || b === null) {
      violations.push(file);
      continue;
    }
    for (const [tag, i, j] of opcodes(splitLines(a), splitLines(b))) {
      if (tag === "equal") continue;
      const permitted =
        i === j
          ? allowed.some(([s, e]) => s - 1 <= i && i <= e)
          : Array.from({ length: j - i }, (_, k) => i + k + 1).every((n) =>
              allowed.some(([s, e]) => s <= n && n <= e),
            );
      if (!permitted) {
        violations.push(`${file}:${i + 1}`);
        break;
      }
    }
  }
  return violations;
}
