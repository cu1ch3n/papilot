import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { ENGINE } from './paths.ts';
import type { Annotation, BuildProblem, GitFile, GitStatus, ManuscriptBuild, ManuscriptProblems } from '../shared.ts';
import { notesInstructions } from '../notes.ts';
import { ignorePattern } from '../commit.ts';
import { AnnotationPages, placeAnnotation } from './annotation-placement.ts';
import { collectProblems, countProblems, locateProblems, sortProblems, type StoredProblem } from './build-problems.ts';

type Rect = [number, number, number, number];

const exec = promisify(execFile);
async function git(root: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  return (await exec('git', args, { cwd: root, timeout: 30_000, env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 })).stdout;
}

// Porcelain v2 keeps paths with spaces intact under -z and reports branch,
// upstream and ahead/behind counts without a second command.
export function parseStatus(output: string, numstat: string): Omit<GitStatus, 'head'> {
  const lines = new Map<string, [number, number]>();
  const stats = numstat.split('\0');
  for (let i = 0; i < stats.length; i++) {
    const [added, deleted, file] = stats[i].split('\t');
    if (!added) continue;
    // A rename lists an empty path followed by the old and new paths.
    const target = file || (i += 2, stats[i]);
    if (target && added !== '-') lines.set(target, [Number(added), Number(deleted)]);
  }
  const status: Omit<GitStatus, 'head'> = { branch: null, upstream: null, ahead: 0, behind: 0, files: [] };
  const fields = output.split('\0');
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (field.startsWith('# branch.head ')) status.branch = field.slice(14) === '(detached)' ? null : field.slice(14);
    else if (field.startsWith('# branch.upstream ')) status.upstream = field.slice(18);
    else if (field.startsWith('# branch.ab ')) { const [ahead, behind] = field.slice(12).split(' '); status.ahead = Number(ahead); status.behind = -Number(behind); }
    else if (field.startsWith('? ')) status.files.push({ path: field.slice(2), status: '?', staged: false, unstaged: true });
    else if (/^[12u] /.test(field)) {
      const parts = field.split(' '), xy = parts[1], kind = field[0];
      const file = parts.slice(kind === '1' ? 8 : kind === '2' ? 9 : 10).join(' ');
      // A rename or copy is followed by its original path.
      const from = kind === '2' ? fields[++i] : undefined;
      const code = kind === 'u' ? 'U' : xy[1] !== '.' ? xy[1] : xy[0];
      // X is the index against HEAD, Y the working tree against the index.
      status.files.push({ path: file, status: code, staged: xy[0] !== '.', unstaged: xy[1] !== '.', lines: lines.get(file), ...(from ? { from } : {}) });
    }
  }
  return status;
}

export async function gitStatus(root: string): Promise<GitStatus> {
  const [status, numstat, head, remotes] = await Promise.all([
    git(root, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'], { GIT_OPTIONAL_LOCKS: '0' }),
    git(root, ['diff', '--numstat', '-z', 'HEAD']).catch(() => ''),
    git(root, ['log', '-1', '--format=%h%x00%s%x00%ct']).catch(() => ''),
    git(root, ['remote']).catch(() => ''),
  ]);
  const [hash, subject, time] = head.trim().split('\0');
  const parsed = parseStatus(status, numstat), dir = gitDir(root);
  // A merge in progress names the files whose conflict markers remain.
  const merging = dir && fs.existsSync(path.join(dir, 'MERGE_HEAD'))
    ? { message: readText(path.join(dir, 'MERGE_MSG')).split('\n')[0] || 'Merge', conflicts: parsed.files.filter(file => file.status === 'U' && conflictMarkers(root, file.path)).map(file => file.path) }
    : null;
  return { ...parsed, head: hash ? { hash, subject, date: Number(time) * 1000 } : null, remote: Boolean(remotes.trim()), merging };
}
const readText = (file: string) => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };
// The repository's Git directory: .git, or where a .git file points.
function gitDir(root: string) {
  try {
    const dot = path.join(root, '.git');
    return fs.statSync(dot).isFile() ? path.resolve(root, readText(dot).replace(/^gitdir:\s*/, '').trim()) : dot;
  } catch { return null; }
}
export function mergeInProgress(root: string) {
  const dir = gitDir(root);
  return Boolean(dir && fs.existsSync(path.join(dir, 'MERGE_HEAD')));
}
export const conflictMarkers = (root: string, file: string) => /^(?:<{7}|>{7})(?: |$)/m.test(readText(path.join(root, file)));

// Paths from the browser are matched against the changed files, and Git reads
// them literally, so a name cannot act as a pathspec pattern.
const literal = { GIT_LITERAL_PATHSPECS: '1' };
const DIFF_LIMIT = 400_000;

// One changed file's diff against HEAD; an untracked file shows as all new.
export async function gitDiff(root: string, file: string) {
  const entry = (await gitStatus(root)).files.find(item => item.path === file);
  if (!entry) throw Object.assign(new Error('That file has no uncommitted changes.'), { statusCode: 404 });
  const diff = await fileDiff(root, entry);
  return { path: file, diff: diff.slice(0, DIFF_LIMIT), truncated: diff.length > DIFF_LIMIT };
}
// A file's diff against HEAD, or with staged, what its index holds.
function fileDiff(root: string, entry: GitFile, staged = false) {
  const names = ['--', ...(entry.from ? [entry.from] : []), entry.path];
  if (staged) return git(root, ['diff', '--cached', '--no-color', '--find-renames', ...names], literal);
  return entry.status === '?'
    // `git diff --no-index` exits with 1 when the files differ.
    ? exec('git', ['diff', '--no-index', '--no-color', '--', '/dev/null', entry.path], { cwd: root, maxBuffer: 64 * 1024 * 1024 }).then(r => r.stdout, (e: { stdout?: string }) => e.stdout || '')
    : git(root, ['diff', '--no-color', '--find-renames', 'HEAD', ...names], literal);
}

// What a commit message is written from: the chosen files' diffs, or what is
// staged in them, each shortened so that a large change still fits, and the
// repository's recent commit subjects, whose style and language the message follows.
export async function commitChanges(root: string, paths: string[], staged = false) {
  const files = (await gitStatus(root)).files.filter(item => paths.includes(item.path) && (!staged || item.staged));
  if (!files.length) throw new Error(staged ? 'Stage at least one change.' : 'Select at least one changed file.');
  let patch = '';
  for (const [index, file] of files.entries()) {
    if (patch.length > 40_000) { patch += `\n[${files.length - index} more changed files are not shown.]\n`; break; }
    const diff = await fileDiff(root, file, staged);
    patch += diff.length > 8_000 ? `${diff.slice(0, 8_000)}\n[The rest of this file's diff is not shown.]\n` : diff;
  }
  const recent = (await git(root, ['log', '-8', '--format=%s']).catch(() => '')).split('\n').filter(Boolean);
  return { files, patch, recent };
}

// Adds the patterns for the chosen untracked build files to the repository's
// .gitignore, one per kind of file and each only once, so they leave the list
// of changes. The .gitignore is then a change to commit like any other.
export async function gitIgnore(root: string, paths: string[]) {
  const patterns = [...new Set((await gitStatus(root)).files.filter(item => item.status === '?' && paths.includes(item.path)).map(item => ignorePattern(item.path)).filter((pattern): pattern is string => Boolean(pattern)))];
  if (!patterns.length) throw new Error('None of the chosen files is build output that can be ignored.');
  const file = path.join(root, '.gitignore');
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const present = new Set(current.split(/\r?\n/).map(line => line.trim()));
  const missing = patterns.filter(pattern => !present.has(pattern) && !present.has('/' + pattern));
  if (missing.length) fs.writeFileSync(file, `${current}${current && !current.endsWith('\n') ? '\n' : ''}${current.trim() ? '\n' : ''}# Build output\n${missing.join('\n')}\n`);
  return gitStatus(root);
}

// Stage or unstage whole files, as the Git panel's checkboxes do. A rename
// moves with both of its paths.
export async function gitStage(root: string, paths: string[], stage: boolean) {
  const status = await gitStatus(root), files = status.files.filter(item => paths.includes(item.path));
  if (status.merging) throw new Error('Finish or abort the merge before staging other changes.');
  if (!files.length) throw new Error('Select at least one changed file.');
  const names = [...new Set(files.flatMap(item => item.from ? [item.from, item.path] : [item.path]))];
  if (stage) await gitAction(root, ['add', '-A', '--', ...names]);
  else await gitAction(root, status.head ? ['reset', '-q', 'HEAD', '--', ...names] : ['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', ...names]);
  return gitStatus(root);
}

// Commit what is staged, or with paths, exactly those files as they are on
// disk; changes staged for other files then stay staged and out of the commit.
export async function gitCommit(root: string, message: string, paths: string[] | null) {
  const status = await gitStatus(root);
  if (status.merging) throw new Error('Finish or abort the merge before committing other changes.');
  if (!paths) {
    if (!status.files.some(item => item.staged)) throw new Error('Stage at least one change to commit.');
    await gitAction(root, ['commit', '-m', message]);
    return (await git(root, ['rev-parse', '--short', 'HEAD'])).trim();
  }
  const files = status.files.filter(item => paths.includes(item.path));
  if (!files.length) throw new Error('Select at least one changed file to commit.');
  if (files.some(item => item.status === 'U')) throw new Error('Resolve the merge conflicts in the selected files before committing.');
  // A rename is already staged, so only its new path is added; the commit
  // names the old path too, so the removal is part of it.
  await gitAction(root, ['add', '-A', '--', ...files.map(item => item.path)]);
  await gitAction(root, ['commit', '--only', '-m', message, '--', ...new Set(files.flatMap(item => item.from ? [item.from, item.path] : [item.path]))]);
  return (await git(root, ['rev-parse', '--short', 'HEAD'])).trim();
}

// Fetch, fast-forward pull and push use the host's Git credentials. Nothing
// may prompt, so a missing credential fails instead of hanging.
export async function gitRemote(root: string, action: 'fetch' | 'pull' | 'merge' | 'push') {
  const status = await gitStatus(root);
  if (!status.remote) throw new Error('This repository has no remote.');
  if (status.merging && action !== 'fetch') throw new Error('Finish or abort the merge first.');
  if (action === 'fetch') await gitAction(root, ['fetch', '--prune'], 120_000);
  else if (action === 'pull' || action === 'merge') {
    if (!status.upstream) throw new Error('This branch does not track a remote branch yet.');
    // Pull only fast-forwards. Merge also joins a branch that has diverged
    // from its upstream; conflicts leave the merge in progress to resolve.
    if (action === 'pull') await gitAction(root, ['pull', '--ff-only'], 120_000);
    else await gitAction(root, ['pull', '--no-rebase', '--ff', '--no-edit'], 120_000).catch(error => { if (!mergeInProgress(root)) throw error; });
  } else if (status.upstream) await gitAction(root, ['push'], 120_000);
  else {
    if (!status.branch) throw new Error('Check out a branch before pushing.');
    const remotes = (await git(root, ['remote'])).split('\n').filter(Boolean);
    await gitAction(root, ['push', '-u', remotes.includes('origin') ? 'origin' : remotes[0], status.branch], 120_000);
  }
}

// A merge in progress ends with its commit once no conflict markers remain,
// or is abandoned, restoring the files as they were before it.
export async function gitFinishMerge(root: string) {
  const status = await gitStatus(root);
  if (!status.merging) throw new Error('No merge is in progress.');
  if (status.merging.conflicts.length) throw new Error(`Resolve the conflicts in ${status.merging.conflicts.join(', ')} first.`);
  const resolved = status.files.filter(item => item.status === 'U').map(item => item.path);
  if (resolved.length) await gitAction(root, ['add', '-A', '--', ...resolved]);
  await gitAction(root, ['commit', '--no-edit']);
  return (await git(root, ['rev-parse', '--short', 'HEAD'])).trim();
}
export async function gitAbortMerge(root: string) {
  if (!mergeInProgress(root)) throw new Error('No merge is in progress.');
  await gitAction(root, ['merge', '--abort']);
}
// What an agent needs to resolve a merge's conflicts: the files with markers
// and the commits on each side.
export async function mergeConflicts(root: string) {
  const status = await gitStatus(root);
  if (!status.merging) throw new Error('No merge is in progress.');
  const subjects = async (range: string) => (await git(root, ['log', '-12', '--format=%s', range]).catch(() => '')).split('\n').filter(Boolean);
  return { files: status.merging.conflicts, branch: status.branch || 'HEAD', upstream: status.upstream || 'the remote branch', ours: await subjects('MERGE_HEAD..HEAD'), theirs: await subjects('HEAD..MERGE_HEAD') };
}

// Git's own message, without the usage noise, becomes the error the user sees.
async function gitAction(root: string, args: string[], timeout = 60_000) {
  try { return (await exec('git', args, { cwd: root, timeout, env: { ...process.env, ...literal, GIT_TERMINAL_PROMPT: '0' }, maxBuffer: 64 * 1024 * 1024 })).stdout; }
  catch (error) {
    const e = error as { stderr?: string; stdout?: string; killed?: boolean; message: string };
    const detail = (e.stderr || e.stdout || '').split('\n').map(line => line.trim()).filter(line => line && !/^(hint|To |From ):?/.test(line)).slice(-4).join(' ');
    throw new Error(e.killed ? `git ${args[0]} timed out.` : detail || e.message);
  }
}

// The preview shows the manuscript as it is on disk, including accepted but
// uncommitted review changes. A temporary index records it as a Git tree
// without touching the real index, branches or files.
export async function workingTree(root: string) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-index-')), env = { GIT_INDEX_FILE: path.join(folder, 'index') };
  try {
    await git(root, ['read-tree', 'HEAD'], env);
    await git(root, ['add', '-A'], env);
    return (await git(root, ['write-tree'], env)).trim();
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
}

async function engine() {
  const [{ Builder }, { Repo }, { loadProject }, { mupdf, PdfDocument, containsCenter, walkText }] = await Promise.all([
    import(pathToFileURL(path.join(ENGINE, 'src/core/build.ts')).href),
    import(pathToFileURL(path.join(ENGINE, 'src/core/git.ts')).href),
    import(pathToFileURL(path.join(ENGINE, 'src/core/config.ts')).href),
    import(pathToFileURL(path.join(ENGINE, 'src/render/pdf.ts')).href),
  ]);
  return { Builder, Repo, loadProject, mupdf, PdfDocument, containsCenter, walkText };
}

// `synctex edit` maps a PDF position (big points from the top-left corner) to
// the source file and line that produced it.
export function parseSynctex(output: string) {
  const input = /^Input:(.*)$/m.exec(output)?.[1], line = Number(/^Line:(\d+)$/m.exec(output)?.[1]);
  return input && line > 0 ? { input: path.normalize(input), line } : null;
}

// One task for every pending note, quoting the marked text and its source so
// the agent can find each place without guessing.
export function annotationTask(notes: Annotation[]) {
  const first = notes[0].comment.split('\n').find(line => line.trim())?.trim() || 'Address a PDF note';
  const title = notes.length === 1 ? (first.length > 80 ? first.slice(0, 79).replace(/\s+\S*$/, '') + '…' : first) : `Address ${notes.length} PDF notes`;
  return { title, instructions: notesInstructions(notes) };
}

// The LaTeX the marked region came from, read from the exact tree that was
// compiled. Long ranges keep their first lines.
// Where one end of a selection sits in its printed line: the line's letters and
// the index of the marked letter among them.
export interface Anchor { line: string; at: number }
const letters = (text: string) => text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

// The printed line around a marked character, for settleLines.
export function anchor(chars: { text: string }[], index: number, end: boolean): Anchor | null {
  const line = letters(chars.map(c => c.text).join(''));
  if (!line) return null;
  const at = end ? letters(chars.slice(0, index + 1).map(c => c.text).join('')).length - 1 : letters(chars.slice(0, index).map(c => c.text).join('')).length;
  return { line, at: Math.min(Math.max(at, 0), line.length - 1) };
}

// SyncTeX records spaces and boxes rather than characters, so a word that
// starts a printed line is often credited to the source line before it, whose
// line break made the space. Settle each end of the selection by finding its
// printed line among the source lines around SyncTeX's answer; text that does
// not match, such as formulas, keeps SyncTeX's lines.
export function settleLines(source: string[], [start, end]: [number, number], first: Anchor | null, last: Anchor | null): [number, number] {
  const low = Math.max(1, start - 4), high = Math.min(source.length, end + 4);
  let text = '';
  const owner: number[] = [];
  for (let number = low; number <= high; number++) {
    const plain = letters(source[number - 1].replace(/(^|[^\\])%.*$/, '$1').replace(/\\[a-zA-Z@]+\*?/g, ' '));
    text += plain; owner.push(...Array<number>(plain.length).fill(number));
  }
  const distance = (line: number) => Math.max(0, start - line, line - end);
  const locate = (mark: Anchor | null) => {
    if (!mark) return null;
    // The whole printed line pins the place best; shorter context around the
    // mark still matches when part of the line does not appear in the source.
    for (const reach of [Infinity, 24, 10]) {
      const from = Math.max(0, mark.at - reach), needle = mark.line.slice(from, mark.at + reach + 1);
      let best: number | null = null;
      for (let index = text.indexOf(needle); index >= 0; index = text.indexOf(needle, index + 1)) {
        const line = owner[index + mark.at - from];
        if (best === null || distance(line) < distance(best)) best = line;
      }
      if (best !== null) return best;
    }
    return null;
  };
  const from = locate(first) ?? start, to = locate(last) ?? end;
  return from <= to ? [from, to] : [start, end];
}

export function sourceExcerpt(file: string, [start, end]: [number, number], limit = 20) {
  if (!fs.existsSync(file)) return undefined;
  const lines = fs.readFileSync(file, 'utf8').split('\n').slice(start - 1, end).map(line => line.trimEnd());
  return (lines.length > limit ? [...lines.slice(0, limit), '…'] : lines).join('\n');
}

// Every word on a page with its exact place, for the PDF view's selection
// layer: [text, left, baseline, font size, width, ends a line], in points from
// the page's top left. pdf.js lays a whole line out in a stand-in font and
// drifts from the printed words mid-line; per-word runs cannot drift.
export async function pdfWords(pdf: string, page: number) {
  const { PdfDocument, walkText } = await engine();
  const document = new PdfDocument(pdf);
  try {
    if (!Number.isInteger(page) || page < 0 || page >= document.length) throw Object.assign(new Error('That page is not part of the manuscript.'), { statusCode: 400 });
    const raw = document.raw.loadPage(page), [x0, y0, x1, y1] = raw.getBounds();
    const words: { text: string; left: number; right: number; baseline: number; size: number; eol: boolean }[] = [];
    let word: (typeof words)[number] | null = null;
    const text = raw.toStructuredText('preserve-whitespace');
    walkText(text, {
      beginLine: () => { word = null; },
      onChar: (c: string, origin: [number, number], _font: unknown, size: number, quad: number[]) => {
        if (/\s/u.test(c)) { word = null; return; }
        const left = Math.min(quad[0], quad[2], quad[4], quad[6]) - x0, right = Math.max(quad[0], quad[2], quad[4], quad[6]) - x0;
        if (!word) { word = { text: '', left, right, baseline: origin[1] - y0, size, eol: false }; words.push(word); }
        word.text += c; word.right = Math.max(word.right, right);
      },
      endLine: () => { if (words.length) words[words.length - 1].eol = true; },
    });
    text.destroy(); raw.destroy();
    const round = (value: number) => Math.round(value * 100) / 100;
    return { width: round(x1 - x0), height: round(y1 - y0), words: words.map(w => [w.text, round(w.left), round(w.baseline), round(w.size), round(w.right - w.left), w.eol ? 1 : 0] as [string, number, number, number, number, number]) };
  } finally { document.close(); }
}

// `problems` come from the last finished build. They are placed on the PDF
// named `problemsKey`; a failed build has no PDF of its own to place them on.
interface Build {
  tree: string; status: ManuscriptBuild['status']; key?: string; pdf?: string; root?: string; sourceDir?: string; pages?: [number, number][]; builtAt?: number; error?: string;
  problems?: StoredProblem[]; problemsKey?: string; log?: string; logFolder?: string;
}

// The TeX log, without the build folder's absolute path.
function readLog(file: string, folder?: string) {
  let text = fs.readFileSync(file, 'utf8');
  if (folder) text = text.split(folder).join('…');
  return text.split(os.homedir()).join('~');
}

export class Manuscripts extends EventEmitter {
  private builds = new Map<string, Build>();
  private oldPdfs = new Map<string, string | null>();
  private placements = new Map<string, (Pick<Annotation, 'key' | 'page' | 'rect' | 'rects' | 'source'>) | null>();
  // Placed problems per problem list; a rebuild in progress shares its predecessor's list.
  private located = new WeakMap<StoredProblem[], Promise<BuildProblem[]>>();
  get busyForUpdate() { return [...this.builds.values()].some(build => build.status === 'building'); }
  busyForProject(id: string) { return this.builds.get(id)?.status === 'building'; }
  forgetProject(id: string) { this.builds.delete(id); }

  async state(projectId: string, root: string, rebuild = false): Promise<{ git: GitStatus; build: ManuscriptBuild }> {
    const [status, tree] = await Promise.all([gitStatus(root), workingTree(root)]);
    let build = this.builds.get(projectId);
    if (!build || (build.status !== 'building' && (build.tree !== tree || rebuild))) build = this.start(projectId, root, tree, build, rebuild);
    const { status: state, key, pages, builtAt, error } = build;
    return { git: status, build: { status: state, key, pages, builtAt, error, current: build.tree === tree && state === 'ready', problems: build.problems && countProblems(build.problems) } };
  }

  // Keep the previous pages visible while a newer working tree compiles.
  private start(projectId: string, root: string, tree: string, previous?: Build, force = false) {
    if (previous?.key && previous.pdf) this.oldPdfs.set(`${root}:${previous.key}`, previous.pdf);
    const build: Build = { tree, status: 'building', key: previous?.key, pdf: previous?.pdf, root: previous?.root, sourceDir: previous?.sourceDir, pages: previous?.pages, builtAt: previous?.builtAt, problems: previous?.problems, problemsKey: previous?.problemsKey, log: previous?.log, logFolder: previous?.logFolder };
    this.builds.set(projectId, build);
    void (async () => {
      let project: { source_dir?: string; doc_dir?: string; state: string } | undefined;
      try {
        const { Builder, Repo, loadProject, mupdf } = await engine();
        project = loadProject(root);
        const result = await new Builder(project, new Repo(root)).build(tree, ['full'], null, { force });
        const document = mupdf.Document.openDocument(fs.readFileSync(result.pdf), 'application/pdf');
        const pages: [number, number][] = [];
        for (let i = 0; i < document.countPages(); i++) { const [x0, y0, x1, y1] = document.loadPage(i).getBounds(); pages.push([Math.round(x1 - x0), Math.round(y1 - y0)]); }
        document.destroy?.();
        const key = createHash('sha256').update(result.key + result.pdf).digest('hex').slice(0, 16);
        if (this.builds.get(projectId) !== build) return;
        const log = String(result.pdf).replace(/\.pdf$/, '.log');
        let problems: StoredProblem[] = [];
        try { problems = collectProblems(fs.readFileSync(log, 'utf8'), { cwd: result.cwd, root: result.root, sourceDir: project!.source_dir || '' }); } catch { /* A build without a readable log reports no problems. */ }
        Object.assign(build, { status: 'ready', key, pdf: result.pdf, root: result.root, sourceDir: project!.source_dir || '', pages, builtAt: Date.now(), error: undefined, problems, problemsKey: key, log: fs.existsSync(log) ? log : undefined, logFolder: path.dirname(result.root) });
      } catch (error) {
        if (this.builds.get(projectId) !== build) return;
        const detail = error as { message?: string; details?: string[]; log?: string };
        const message = [detail.message, ...(detail.details || [])].filter(Boolean).join('\n') || 'The manuscript could not be compiled.';
        // The engine keeps latexmk's transcript and the TeX log of a failed
        // build; its sources are gone, so files resolve in the working tree.
        let problems: StoredProblem[] = [];
        if (detail.log && project) try {
          const kept = fs.readFileSync(detail.log, 'utf8'), marker = '\n\n--- TeX log ---\n', at = kept.indexOf(marker);
          // TeX stopped in its first pass, before references resolve, so only
          // the errors of a failed run mean anything.
          if (at >= 0) problems = collectProblems(kept.slice(at + marker.length), { cwd: path.join(root, project.doc_dir || '.'), root: path.join(root, project.source_dir || '.'), sourceDir: project.source_dir || '' })
            .filter(problem => problem.severity === 'error').map(({ source: _source, ...problem }) => problem);
        } catch { /* Fall back to the compiler's own message below. */ }
        if (!problems.length) problems.push({ kind: 'error', severity: 'error', message: detail.message || message });
        // The previous PDF stays on screen, and so do its warnings and places.
        const shown = build.problemsKey && build.problemsKey === build.key ? (build.problems || []).filter(problem => problem.severity !== 'error') : [];
        const logFolder = detail.log && project ? path.join(project.state, 'cache/builds', path.basename(detail.log, '.log')) : undefined;
        Object.assign(build, { status: 'failed', error: message, problems: [...problems, ...shown], problemsKey: shown.length ? build.problemsKey : undefined, log: detail.log && fs.existsSync(detail.log) ? detail.log : undefined, logFolder });
      }
      this.emit('change', projectId);
    })();
    return build;
  }

  // Old annotations keep their saved content. Only their proven PDF position
  // changes; ambiguous or missing content stays on the earlier version.
  async reanchor(projectId: string, root: string, notes: Annotation[]): Promise<Annotation[]> {
    const build = this.builds.get(projectId);
    if (!build?.pdf || !build.key || build.status !== 'ready' || !notes.some(note => note.key !== build.key)) return notes;
    const { PdfDocument, loadProject } = await engine();
    const current = new PdfDocument(build.pdf), target = new AnnotationPages(current);
    const old = new Map<string, { document: InstanceType<typeof PdfDocument>; pages: AnnotationPages }>();
    try {
      const output: Annotation[] = [];
      for (const note of notes) {
        if (note.key === build.key) { output.push(note); continue; }
        const cacheKey = JSON.stringify([projectId, build.key, note.key, note.page, note.rect, note.rects, note.quote]);
        if (!this.placements.has(cacheKey)) {
          let placement: Pick<Annotation, 'key' | 'page' | 'rect' | 'rects' | 'source'> | null = null;
          try {
            const lookup = `${root}:${note.key}`;
            if (!this.oldPdfs.has(lookup)) {
              const cache = path.join(loadProject(root).state, 'cache/builds');
              let found: string | null = null;
              for (const entry of fs.readdirSync(cache, { withFileTypes: true })) {
                if (!entry.isDirectory() || entry.name.endsWith('.lock')) continue;
                try {
                  const folder = path.join(cache, entry.name), saved = JSON.parse(fs.readFileSync(path.join(folder, 'result.json'), 'utf8'));
                  if (typeof saved.pdf !== 'string' || !path.resolve(saved.pdf).startsWith(path.resolve(folder) + path.sep)) continue;
                  if (createHash('sha256').update(saved.key + saved.pdf).digest('hex').slice(0, 16) === note.key && fs.existsSync(saved.pdf)) { found = saved.pdf; break; }
                } catch { /* An incomplete or pruned build cannot locate a note. */ }
              }
              this.oldPdfs.set(lookup, found);
            }
            const pdf = this.oldPdfs.get(lookup);
            if (pdf) {
              if (!old.has(pdf)) { const document = new PdfDocument(pdf); old.set(pdf, { document, pages: new AnnotationPages(document) }); }
              const match = placeAnnotation(note, old.get(pdf)!.pages, target);
              if (match) {
                const { source } = await this.locate(projectId, build.key, match.page, match.rect, match.rects, note.quote);
                placement = { ...match, key: build.key, source };
              }
            }
          } catch { /* Keep the annotation intact when its position cannot be verified. */ }
          this.placements.set(cacheKey, placement);
        }
        const placement = this.placements.get(cacheKey);
        output.push(placement ? { ...note, ...placement } : note);
      }
      if (this.placements.size > 2000) this.placements.clear();
      if (this.oldPdfs.size > 500) this.oldPdfs.clear();
      return this.builds.get(projectId)?.key === build.key ? output : notes;
    } finally { current.close(); for (const entry of old.values()) entry.document.close(); }
  }

  // Every problem of the last finished build, placed on its PDF when there is
  // one. Placing runs SyncTeX per problem, once per build.
  async problems(projectId: string): Promise<ManuscriptProblems> {
    const build = this.builds.get(projectId);
    if (!build?.problems) return { status: build?.status || 'building', problems: [], log: Boolean(build?.log) };
    const { problems, problemsKey: key, pdf } = build;
    if (!key || key !== build.key || !pdf) return { status: build.status, problems: sortProblems(problems.map(({ source: _source, ...problem }) => problem)), log: Boolean(build.log) };
    let placed = this.located.get(problems);
    if (!placed) {
      placed = (async () => {
        const { PdfDocument } = await engine();
        const document = new PdfDocument(pdf), pages = new Map<number, ReturnType<typeof document.page>>();
        try {
          return sortProblems(await locateProblems(problems, pdf, page => {
            if (!Number.isInteger(page) || page < 0 || page >= document.length) return null;
            if (!pages.has(page)) pages.set(page, document.page(page));
            return pages.get(page)!;
          }));
        } finally { for (const page of pages.values()) page.close(); document.close(); }
      })();
      placed.catch(() => this.located.delete(problems));
      this.located.set(problems, placed);
    }
    return { status: build.status, key, problems: await placed, log: Boolean(build.log) };
  }

  log(projectId: string) {
    const build = this.builds.get(projectId);
    if (!build?.log || !fs.existsSync(build.log)) throw Object.assign(new Error('There is no compilation log yet.'), { statusCode: 404 });
    return readLog(build.log, build.logFolder);
  }

  pdf(projectId: string, key: string) {
    const build = this.builds.get(projectId);
    if (!build?.pdf || build.key !== key) throw Object.assign(new Error('This manuscript preview is out of date. Refresh it and try again.'), { statusCode: 404 });
    return build.pdf;
  }

  // A note keeps the text under the marked region and its LaTeX source, so it
  // stays meaningful after the manuscript changes and the preview recompiles.
  // A text selection arrives as one rectangle per line plus the selected text;
  // a marked region arrives as one rectangle.
  // Word places for the PDF view's selection layer, cached per build and page.
  private wordCache = new Map<string, Awaited<ReturnType<typeof pdfWords>>>();
  async words(projectId: string, key: string, page: number) {
    const cacheKey = `${projectId}:${key}:${page}`, cached = this.wordCache.get(cacheKey);
    if (cached) return cached;
    const result = await pdfWords(this.pdf(projectId, key), page);
    if (this.wordCache.size > 200) this.wordCache.delete(this.wordCache.keys().next().value!);
    this.wordCache.set(cacheKey, result);
    return result;
  }

  async locate(projectId: string, key: string, page: number, rect: Rect, rects: Rect[] = [], selected = '') {
    const pdf = this.pdf(projectId, key), build = this.builds.get(projectId)!;
    const { PdfDocument, containsCenter } = await engine();
    const document = new PdfDocument(pdf);
    try {
      if (!Number.isInteger(page) || page < 0 || page >= document.length) throw Object.assign(new Error('That page is not part of the manuscript.'), { statusCode: 400 });
      const current = document.page(page), [x0, y0, x1, y1] = current.bounds, width = x1 - x0, height = y1 - y0;
      const toPage = (r: Rect) => [x0 + r[0] * width, y0 + r[1] * height, x0 + r[2] * width, y0 + r[3] * height];
      const clips = (rects.length ? rects : [rect]).map(toPage);
      const quote = (selected || clips.map(clip => current.text(clip)).join(' ')).replace(/\uFFFD/g, '').replace(/\s+/g, ' ').trim().slice(0, 600);
      // Ask SyncTeX about the first and last marked character of every line, so
      // the source range covers the whole selection rather than its first line.
      const points: [number, number][] = [], centre = (r: number[]): [number, number] => [(r[0] + r[2]) / 2, (r[1] + r[3]) / 2];
      let first: Anchor | null = null, last: Anchor | null = null;
      for (const line of current.lines as { chars: { text: string; rect: number[] }[] }[]) {
        const marked = line.chars.flatMap((c, index) => clips.some(clip => containsCenter(clip, c.rect)) ? [index] : []);
        if (!marked.length) continue;
        if (!first && !last) first = anchor(line.chars, marked[0], false);
        last = anchor(line.chars, marked[marked.length - 1], true);
        if (points.length >= 24) continue;
        points.push(centre(line.chars[marked[0]].rect));
        if (marked.length > 1) points.push(centre(line.chars[marked[marked.length - 1]].rect));
      }
      if (!points.length) points.push(...clips.slice(0, 12).map(centre));
      const hits = (await Promise.all(points.map(([x, y]) => exec('synctex', ['edit', '-o', `${page + 1}:${(x - x0).toFixed(1)}:${(y - y0).toFixed(1)}:${pdf}`]).then(r => parseSynctex(r.stdout), () => null)))).filter(hit => hit !== null);
      const files = new Map<string, { input: string; lines: number[] }>();
      for (const hit of hits) {
        const relative = path.relative(build.root || path.dirname(hit.input), hit.input);
        const file = path.posix.join(build.sourceDir || '', (relative.startsWith('..') ? path.basename(hit.input) : relative).split(path.sep).join('/'));
        files.set(file, { input: hit.input, lines: [...(files.get(file)?.lines || []), hit.line] });
      }
      const [file, found] = [...files].sort((a, b) => b[1].lines.length - a[1].lines.length)[0] || [];
      if (!file || !found) return { quote, source: null };
      const source = fs.existsSync(found.input) ? fs.readFileSync(found.input, 'utf8').split('\n') : [];
      const lines = settleLines(source, [Math.min(...found.lines), Math.max(...found.lines)], first, last);
      return { quote, source: { file, lines, excerpt: sourceExcerpt(found.input, lines) } };
    } finally { document.close(); }
  }

}
