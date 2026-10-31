import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { BuildProblem, BuildProblemCounts } from '../shared.ts';

const exec = promisify(execFile);

// A problem as read from the log: `input` is the file as TeX named it, relative
// to the directory TeX ran in. It never leaves the server.
export interface LogProblem extends Omit<BuildProblem, 'file' | 'page' | 'rect'> { input?: string }
export interface StoredProblem extends BuildProblem { source?: string }

// Overfull lines narrower than this are invisible in print.
export const OVERFULL_MIN_PT = 1;
// Locating runs SyncTeX once or twice per problem; a paper with more problems
// lists the rest without a page.
const LOCATE_LIMIT = 300;
const WRAP = 79;

// TeX breaks every log line at 79 characters (bytes in pdfTeX), even inside
// file names and words. Rejoin the pieces before reading anything else.
export function unwrapLog(text: string) {
  const out: string[] = [];
  let current = '', joining = false;
  for (const line of text.split(/\r?\n/)) {
    current = joining ? current + line : line;
    joining = line.length === WRAP || Buffer.byteLength(line) === WRAP;
    if (!joining) out.push(current);
  }
  if (joining) out.push(current);
  return out;
}

const looksLikeFile = (name: string) => /^(?:\.{1,2}\/|\/|[A-Za-z]:[\\/])/.test(name) || /\.[A-Za-z][\w-]*$/.test(name);
const IGNORED = [
  /^There (?:were|was) (?:undefined|multiply)/, /^Rerun to get/, /Label\(s\) may have changed/, /^Please (?:\(re\))?run/i,
  /^Writing or overwriting file/, /^File [`'][^']+' already exists on the system/, /^Unused global option/,
];

// TeX reports which file it is reading with "(name" and ")" around everything
// that file prints. Only a "(" followed by a file that exists opens a file, so
// parentheses in messages and wrapped text keep the stack balanced but never
// change the current file.
export function parseLatexLog(text: string, isFile: (name: string) => boolean = () => true): LogProblem[] {
  const lines = unwrapLog(text), stack: (string | null)[] = [], found: LogProblem[] = [], seen = new Set<string>();
  const current = () => { for (let i = stack.length - 1; i >= 0; i--) if (stack[i]) return stack[i]!; return undefined; };
  const add = (problem: LogProblem) => {
    const id = JSON.stringify([problem.kind, problem.key, problem.input, problem.line, problem.end, problem.message]);
    if (!seen.has(id)) { seen.add(id); found.push(problem); }
  };
  const scan = (line: string) => {
    for (let j = 0; j < line.length; j++) {
      if (line[j] === ')') { stack.pop(); continue; }
      if (line[j] !== '(') continue;
      const match = /^"([^"]+)"|^([^\s()[\]{}<>"]+)/.exec(line.slice(j + 1)), name = match?.[1] ?? match?.[2];
      if (name && looksLikeFile(name) && isFile(name)) { stack.push(name); j += match![0].length; } else stack.push(null);
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // file:line: message (from -file-line-error) or "! message".
    const located = /^(.+?):(\d+): (.*)$/.exec(line);
    const errorFile = located && (located[1] === current() || (looksLikeFile(located[1]) && isFile(located[1]))) ? located : null;
    if (errorFile || line.startsWith('! ')) {
      let message = errorFile ? errorFile[3] : line.slice(2), last = line, end = i + 1;
      for (; end < lines.length && end < i + 20; end++) {
        const next = lines[end];
        if (!next.trim() || next.startsWith('! ') || /^(?:See |Type |l\.\d+ |\s*\.\.\.|\s*<)/.test(next) || /^(.+?):(\d+): /.test(next)) break;
        message += (last.length >= WRAP ? '' : ' ') + next; last = next;
      }
      let context = -1;
      for (let k = end; k < Math.min(lines.length, end + 12); k++) if (/^l\.\d+ /.test(lines[k])) { context = k; break; }
      message = message.replace(/\s+/g, ' ').trim();
      if (!/==> Fatal error occurred|^Emergency stop/.test(message)) {
        const missing = /File [`']([^']+)' not found/.exec(message);
        add({
          kind: missing ? 'missing-file' : 'error', severity: 'error', message, key: missing?.[1],
          input: errorFile ? errorFile[1] : current(), line: errorFile ? Number(errorFile[2]) : context >= 0 ? Number(/^l\.(\d+)/.exec(lines[context])![1]) : undefined,
        });
      }
      // Help text and the source context are TeX's commentary, not file events.
      i = context >= 0 ? context + 1 : end - 1;
      continue;
    }
    const warning = /^(LaTeX|Package|Class|Module)(?: (\S+))? Warning: (.*)$|^(pdfTeX) warning(?: \([^)]*\))?: (.*)$/i.exec(line);
    if (warning) {
      const owner = warning[1] === 'LaTeX' ? warning[2] || '' : warning[2] || '', isLatex = warning[1] === 'LaTeX';
      let message = warning[3] ?? warning[5], end = i + 1;
      // Continuation lines start with "(package)" or, for LaTeX, an indent.
      for (; end < lines.length; end++) {
        const next = lines[end], prefix = owner ? `(${owner})` : '';
        if (prefix && next.startsWith(prefix)) message += ' ' + next.slice(prefix.length).trim();
        else if (isLatex && !owner && /^\s{4,}\S/.test(next)) message += ' ' + next.trim();
        else break;
      }
      i = end - 1;
      message = message.replace(/\s+/g, ' ').trim();
      if (owner === 'Font' || IGNORED.some(pattern => pattern.test(message))) continue;
      const inputLine = /on input line (\d+)/.exec(message), at = inputLine ? Number(inputLine[1]) : undefined;
      const reference = /^Reference [`']([^']+)' on page \S+ undefined/.exec(message);
      const citation = /Citation [`']([^']+)'(?: on page \S+)? undefined/.exec(message);
      const label = /^Label [`']([^']+)' multiply defined/.exec(message);
      if (reference) add({ kind: 'reference', severity: 'warning', message, key: reference[1], input: current(), line: at });
      else if (citation) add({ kind: 'citation', severity: 'warning', message, key: citation[1], input: current(), line: at });
      // cleveref repeats every label as `name@cref`; the user's label is reported already.
      else if (label) { if (!label[1].includes('@')) add({ kind: 'label', severity: 'warning', message, key: label[1] }); }
      else add({ kind: 'other', severity: 'minor', message: `${warning[2] && !isLatex ? warning[2] + ': ' : ''}${message}`, input: current(), line: at });
      continue;
    }
    const box = /^(Overfull|Underfull) \\([hv])box \((?:badness \d+|([\d.]+)pt too (?:wide|high))\)(?: (?:in paragraph|in alignment|detected) at lines? (\d+)(?:--(\d+))?)?/.exec(line);
    if (box) {
      const amount = Number(box[3]);
      if (box[1] === 'Overfull' && amount >= OVERFULL_MIN_PT && box[4]) {
        const start = Number(box[4]), stop = box[5] ? Number(box[5]) : start;
        add({ kind: 'overfull', severity: 'minor', message: line.trim(), amount: Math.round(amount * 10) / 10, input: current(), line: start, end: stop > start ? stop : undefined });
      }
      // The box's contents follow until a blank line; their text has stray parentheses.
      while (i + 1 < lines.length && lines[i + 1].trim()) i++;
      continue;
    }
    const glyph = /^Missing character: There is no (.+?) in font (.+?)!/.exec(line);
    if (glyph) { add({ kind: 'glyph', severity: 'warning', message: line.trim(), key: glyph[1], input: current() }); continue; }
    scan(line);
  }
  // A remark repeated for many objects, such as pdfTeX's duplicate link
  // targets for every equation, is listed once with how often it occurred.
  const remarks = new Map<string, LogProblem>();
  return found.filter(problem => {
    if (problem.kind !== 'other') return true;
    const shape = problem.message.replace(/\{[^{}]*\}/g, '{}').replace(/[`'][^`']*'/g, "''").replace(/\d+/g, '#');
    const first = remarks.get(shape);
    if (!first) { remarks.set(shape, problem); return true; }
    first.count = (first.count || 1) + 1;
    return false;
  });
}

export function countProblems(problems: { severity: BuildProblem['severity'] }[]): BuildProblemCounts {
  const counts = { errors: 0, warnings: 0, minor: 0 };
  for (const problem of problems) counts[problem.severity === 'error' ? 'errors' : problem.severity === 'warning' ? 'warnings' : 'minor']++;
  return counts;
}

const stripComments = (line: string) => line.replace(/(^|[^\\])%.*$/, '$1');
function texFiles(folder: string, skip: string) {
  const files: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (!entry.name.startsWith('.') && entry.name !== 'node_modules' && full !== skip) walk(full); }
      else if (entry.name.endsWith('.tex')) files.push(full);
    }
  };
  walk(folder);
  return files;
}

// Where every problem is in the manuscript. TeX names files relative to the
// directory it ran in; the paper shows them relative to its repository, like
// note sources. A label defined twice is listed at each definition.
export function collectProblems(log: string, { cwd, root, sourceDir }: { cwd: string; root: string; sourceDir: string }): StoredProblem[] {
  const resolve = (name: string) => path.resolve(cwd, name);
  const parsed = parseLatexLog(log, name => { try { return fs.statSync(resolve(name)).isFile(); } catch { return false; } });
  const display = (absolute: string) => {
    const relative = path.relative(root, absolute);
    return relative.startsWith('..') || path.isAbsolute(relative) ? undefined : path.posix.join(sourceDir || '', relative.split(path.sep).join('/'));
  };
  let sources: { file: string; lines: string[] }[] | null = null;
  const output: StoredProblem[] = [];
  for (const { input, ...problem } of parsed) {
    if (problem.kind === 'label' && problem.key) {
      sources ??= texFiles(root, path.join(cwd, 'build')).map(file => ({ file, lines: fs.readFileSync(file, 'utf8').split('\n') }));
      const needle = `\\label{${problem.key}}`, places: StoredProblem[] = [];
      for (const { file, lines } of sources) lines.forEach((text, index) => {
        if (stripComments(text).includes(needle)) places.push({ ...problem, file: display(file), line: index + 1, source: file });
      });
      output.push(...(places.length ? places : [problem]));
      continue;
    }
    const absolute = input ? resolve(input) : undefined, file = absolute ? display(absolute) : undefined;
    output.push(file ? { ...problem, file, source: absolute } : { ...problem, line: undefined, end: undefined });
  }
  return output;
}

interface SyncBox { page: number; x: number; y: number; h: number; v: number; W: number; H: number }
// `synctex view` lists one record per box: the point it names (x, y) and the
// box itself, h from the left and v at its baseline, W wide and H tall.
export function parseSynctexView(output: string): SyncBox[] {
  const boxes: Partial<SyncBox>[] = [];
  for (const line of output.split('\n')) {
    const match = /^(Page|x|y|h|v|W|H):(-?[\d.]+)\s*$/.exec(line);
    if (!match) continue;
    if (match[1] === 'Page') boxes.push({ page: Number(match[2]) - 1 });
    else if (boxes.length) (boxes[boxes.length - 1] as Record<string, number>)[match[1]] = Number(match[2]);
  }
  return boxes.filter((box): box is SyncBox => ['page', 'x', 'y', 'h', 'v', 'W', 'H'].every(key => Number.isFinite((box as Record<string, number>)[key])));
}

interface PageText { width: number; height: number; bounds: number[]; search(needle: string): number[][] }
// Put each problem on the page SyncTeX names. A missing reference or citation
// is narrowed to its "??" or "?" in that line; everything else marks its lines.
export async function locateProblems(problems: StoredProblem[], pdf: string, openPage: (page: number) => PageText | null): Promise<BuildProblem[]> {
  const view = async (file: string, line: number) => {
    try { return parseSynctexView((await exec('synctex', ['view', '-i', `${line}:0:${file}`, '-o', pdf], { timeout: 10000 })).stdout); } catch { return []; }
  };
  // TeX warns about the missing references of one source line in reading
  // order, so the second warning for a line belongs to its second "??".
  const ordinal = new Map<StoredProblem, number>(), counted = new Map<string, number>();
  for (const problem of problems) {
    const id = JSON.stringify([problem.source, problem.line, problem.kind]), seen = counted.get(id) || 0;
    ordinal.set(problem, seen); counted.set(id, seen + 1);
  }
  const place = async (problem: StoredProblem): Promise<BuildProblem> => {
    const { source, ...shown } = problem;
    if (!source || !problem.line) return shown;
    const lines = problem.end && problem.end !== problem.line ? [problem.line, problem.end] : [problem.line];
    const boxes = (await Promise.all(lines.map(line => view(source, line)))).flat();
    if (!boxes.length) return shown;
    const page = boxes[0].page, text = openPage(page);
    if (!text) return shown;
    const [x0, y0] = text.bounds;
    const onPage = boxes.filter(box => box.page === page), tidy = onPage.filter(box => box.H > 0 && box.H < text.height * 0.4);
    let rect: number[] = tidy.length
      ? [Math.min(...tidy.map(b => b.h)), Math.min(...tidy.map(b => b.v - b.H)), Math.max(...tidy.map(b => b.h + b.W)), Math.max(...tidy.map(b => b.v))]
      : [onPage[0].x - 6, onPage[0].y - 10, onPage[0].x + 6, onPage[0].y + 2];
    rect = [rect[0] + x0, rect[1] + y0, rect[2] + x0, rect[3] + y0];
    if (problem.kind === 'reference' || problem.kind === 'citation') {
      // A citation prints "?" or its key; the "?" of a missing reference's "??" is not one.
      const pairs = text.search('??'), inside = (mark: number[], outer: number[]) => mark[0] >= outer[0] - 0.5 && mark[2] <= outer[2] + 0.5 && mark[1] >= outer[1] - 0.5 && mark[3] <= outer[3] + 0.5;
      const marks = (problem.kind === 'reference' ? pairs : [...text.search('?').filter(mark => !pairs.some(pair => inside(mark, pair))), ...(problem.key ? text.search(problem.key) : [])])
        .filter(mark => { const middle = (mark[1] + mark[3]) / 2; return onPage.some(box => middle >= box.v - box.H + y0 - 3 && middle <= box.v + y0 + 3); })
        .sort((a, b) => Math.abs(a[1] - b[1]) > 2 ? a[1] - b[1] : a[0] - b[0]);
      // SyncTeX's points sit on the nodes this source line printed, so a mark
      // that starts beside one came from this line, not from its neighbours.
      const gap = (mark: number[]) => Math.min(...onPage.map(box => Math.abs(mark[0] - (box.x + x0))));
      const own = marks.filter(mark => gap(mark) <= 6);
      let best: number[] | undefined = own[ordinal.get(problem) || 0];
      if (!best && marks.length) best = marks.reduce((a, b) => gap(b) < gap(a) ? b : a);
      if (best) rect = [best[0] - 2, best[1] - 1, best[2] + 2, best[3] + 1];
    }
    const unit = (value: number) => Math.min(1, Math.max(0, Math.round(value * 10000) / 10000));
    return { ...shown, page, rect: [unit((rect[0] - x0) / text.width), unit((rect[1] - y0) / text.height), unit((rect[2] - x0) / text.width), unit((rect[3] - y0) / text.height)] };
  };
  const output: BuildProblem[] = new Array(problems.length);
  let next = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    for (let index = next++; index < problems.length; index = next++) {
      if (index >= LOCATE_LIMIT) { const { source: _source, ...shown } = problems[index]; output[index] = shown; continue; }
      output[index] = await place(problems[index]);
    }
  }));
  return output;
}

// Errors first, then the paper's order: page, then position on the page.
export function sortProblems(problems: BuildProblem[]) {
  const rank = { error: 0, warning: 1, minor: 2 };
  return [...problems].sort((a, b) => rank[a.severity] - rank[b.severity]
    || (a.page ?? Infinity) - (b.page ?? Infinity) || (a.rect?.[1] ?? 0) - (b.rect?.[1] ?? 0)
    || (a.file || '').localeCompare(b.file || '') || (a.line ?? 0) - (b.line ?? 0));
}
