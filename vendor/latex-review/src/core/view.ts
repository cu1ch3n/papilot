import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Builder, BuildError } from "./build.ts";
import { cleanPath, within } from "./git.ts";
import { run } from "./process.ts";
import { mupdf } from "../render/pdf.ts";
import type { App } from "../server.ts";
import type { BuildInfo } from "../types.ts";
// A task's agent looks at its typeset pages: the task worktree as it is now,
// or the accepted text, compiled like a review round (only the chapters the
// edits and the asked-for places need, when the paper allows partial builds,
// so a later publication of the same text reuses the build) and drawn as PNG
// files the agent opens with its own image viewer. Places are source lines
// or printed page numbers.
export interface ViewRequest {
  locations?: string[];
  pages?: string[];
  accepted?: boolean;
}
export interface ViewedPage {
  /** The page's position in the PDF that was built, from 1. */
  index: number;
  /** The page number printed on it. */
  label: string;
  /** What asked for this page. */
  shows: string[];
  /** The drawn page. */
  file: string;
}
export interface ViewResult {
  pages: ViewedPage[];
  /** Requests no page answered, with the reason. */
  missing: string[];
  targets: string[];
  error?: string;
  details?: string[];
}
// Pages drawn per request, and how far from an asked-for line SyncTeX may
// look for one that printed something (blank lines and comments print nothing).
const PAGES = 4,
  NEARBY = 10,
  SCALE = 1.5,
  // Drawn pages are kept this long, for an agent that opens them later in its turn.
  KEEP = 6 * 3600 * 1000;
// A new folder for one view's pages, after removing the task's old ones.
function folder(app: App, name: string) {
  const views = path.join(app.project.state, "views", name);
  for (const entry of fs.existsSync(views) ? fs.readdirSync(views) : []) {
    const old = path.join(views, entry);
    if (Date.now() - fs.statSync(old).mtimeMs > KEEP)
      fs.rmSync(old, { recursive: true, force: true });
  }
  const created = path.join(views, `${Date.now()}-${randomBytes(3).toString("hex")}`);
  fs.mkdirSync(created, { recursive: true });
  return created;
}
interface Location {
  asked: string;
  file: string;
  line: number;
}
function location(app: App, worktree: string, value: string): Location {
  const match = /^(.*?):(\d+)$/.exec(value.trim());
  if (!match) throw new Error(`Give a location as file:line, such as main.tex:12: ${value}`);
  let file = match[1];
  if (path.isAbsolute(file)) file = path.relative(worktree, file);
  file = cleanPath(file);
  if (!within(file, [app.project.source_dir]))
    throw new Error(`${file} is outside the paper's source folder ${app.project.source_dir}.`);
  return { asked: value.trim(), file, line: Number(match[2]) };
}
// The pages SyncTeX gives for a source line, or for the nearest line that
// printed something.
function pagesOf(pdf: string, file: string, line: number) {
  for (let distance = 0; distance <= NEARBY; distance++)
    for (const candidate of distance ? [line - distance, line + distance] : [line]) {
      if (candidate < 1) continue;
      const output = run(
        "synctex",
        ["view", "-i", `${candidate}:0:${file}`, "-o", pdf],
        { check: false, timeout: 20000 },
      ).stdout.toString();
      const pages = [
        ...new Set(
          [...output.matchAll(/^Page:(\d+)$/gm)].map((m) => Number(m[1])),
        ),
      ];
      if (pages.length) return pages;
    }
  return [];
}
export async function view(
  app: App,
  name: string,
  request: ViewRequest,
): Promise<ViewResult> {
  const task = app.tasks.get(name),
    project = app.project;
  if (!fs.existsSync(task.worktree))
    throw new Error(`The task worktree ${task.worktree} no longer exists.`);
  const locations = (request.locations ?? []).map((l) =>
      location(app, task.worktree, l),
    ),
    labels = (request.pages ?? []).map((p) => p.trim()).filter(Boolean);
  if (!locations.length && !labels.length)
    throw new Error("Ask for at least one source location or page number.");
  const after = app.tasks.snapshot(task),
    before = task.accepted,
    builder = new Builder(project, app.repo),
    targets = builder.plan(before, after, [
      ...new Set([
        ...app.repo.changedFiles(before, after),
        ...locations.map((l) => l.file),
      ]),
    ]);
  let build: BuildInfo;
  try {
    const seed = targets[0] !== "full" ? await builder.build(task.base) : null;
    build = await builder.build(request.accepted ? before : after, targets, seed);
  } catch (error) {
    if (!(error instanceof BuildError)) throw error;
    return {
      pages: [],
      missing: [],
      targets,
      error: request.accepted
        ? "The accepted text could not be compiled."
        : "The paper in the task worktree could not be compiled.",
      details: error.details,
    };
  }
  const pdf = build.pdf,
    document = mupdf.Document.openDocument(fs.readFileSync(pdf), "application/pdf");
  try {
    const wanted = new Map<number, string[]>(),
      missing: string[] = [],
      ask = (index: number, asked: string) =>
        wanted.set(index, [...(wanted.get(index) ?? []), asked]);
    for (const l of locations) {
      // The build compiles an export of the source folder.
      const file = path.join(
          build.root,
          path.posix.relative(project.source_dir || ".", l.file),
        ),
        found = fs.existsSync(file) ? pagesOf(pdf, file, l.line) : [];
      if (found.length) found.forEach((page) => ask(page, l.asked));
      else missing.push(`${l.asked}: SyncTeX places no typeset text at or near this line.`);
    }
    if (labels.length) {
      const printed = Array.from({ length: document.countPages() }, (_, i) => {
        const page = document.loadPage(i),
          label = page.getLabel() || String(i + 1);
        page.destroy();
        return label;
      });
      for (const label of labels) {
        const index = printed.findIndex(
          (p) => p.toLowerCase() === label.toLowerCase(),
        );
        if (index >= 0) ask(index + 1, label);
        else
          missing.push(
            targets[0] === "full"
              ? `Page ${label}: no page has this printed number.`
              : `Page ${label}: not in the chapters compiled for this view (${targets.join(", ")}). Ask for a source line on that page instead.`,
          );
      }
    }
    const indices = [...wanted.keys()].sort((a, b) => a - b);
    if (indices.length > PAGES)
      missing.push(
        `Only the first ${PAGES} pages are shown; ask again for pages ${indices.slice(PAGES).join(", ")} of this build.`,
      );
    const out = indices.length ? folder(app, name) : "";
    const pages = indices.slice(0, PAGES).map((index) => {
      const page = document.loadPage(index - 1),
        pixmap = page.toPixmap(
          [SCALE, 0, 0, SCALE, 0, 0],
          mupdf.ColorSpace.DeviceRGB,
          false,
          true,
        ),
        label = page.getLabel() || String(index),
        file = path.join(out, `page-${/^[\w-]{1,16}$/u.test(label) ? label : index}-${index}.png`);
      fs.writeFileSync(file, pixmap.asPNG());
      pixmap.destroy();
      page.destroy();
      return { index, label, shows: wanted.get(index)!, file };
    });
    return { pages, missing, targets };
  } finally {
    document.destroy();
  }
}
