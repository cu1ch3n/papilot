import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DATA, ENGINE } from './paths.ts';
import { mergeInProgress, workingTree } from './manuscript.ts';
import { ignorePattern } from '../commit.ts';
import { checker, confirmations, engine as referenceEngine } from './references.ts';

// The manuscript's uncommitted changes as a PDF comparison: the last commit
// against the working tree, rendered by the review engine like a task's round
// and shown in its viewer. Each change can be staged or unstaged in the real
// index, or reverted on disk; a revert can be undone. A commit then takes what
// is staged, so one set of edits can become several commits.

type Op = ['equal' | 'replace' | 'insert' | 'delete', number, number, number, number];
export interface Unit { id: string; file: string; status: 'added' | 'deleted' | 'modified'; kind: string; whole_file: boolean; ops: Op[]; old_start: number; old_end: number; new_start: number; new_end: number; old_text: string; new_text: string; truncated: boolean }
type Decision = 'pending' | 'accepted' | 'rejected' | 'commented';
export type ChangeAction = 'stage' | 'unstage' | 'revert';
interface Round { number: number; before: string; after: string; units: Unit[]; folder: string; warnings: string[]; decisions: Record<string, Decision> }
interface Job { key: string; phase: 'build' | 'render'; status: 'running' | 'failed'; created: number; error?: string; details?: string[]; log?: string }
interface Snapshot { before: string | null; after: string }
interface Entry { mode: string; sha: string }
interface Revert { id: string; files: { path: string; disk: Buffer | null; written: Buffer | null; index: Entry | null; indexAfter: Entry | null }[]; signatures: string[] }
interface Comparison { rounds: Round[]; job: Job | null; next: number; undo: Revert | null; reverted: Set<string>; snapshot?: { at: number; value: Promise<Snapshot> }; current?: { key: string; units: Unit[] } }

const conflict = (message: string) => Object.assign(new Error(message), { statusCode: 409 });

async function engine() {
  const load = (file: string) => import(pathToFileURL(path.join(ENGINE, file)).href);
  const [{ Builder, BuildError }, { Repo }, { loadProject, isFigure }, { diffUnits, revertUnits, withUnits, splitLines, textOf }, { opcodes }, { render, more }] = await Promise.all(
    ['src/core/build.ts', 'src/core/git.ts', 'src/core/config.ts', 'src/core/changes.ts', 'src/core/diff.ts', 'src/core/publish.ts'].map(load));
  return { Builder, BuildError, Repo, loadProject, isFigure, diffUnits, revertUnits, withUnits, splitLines, textOf, opcodes, render, more } as {
    Builder: any; BuildError: any; Repo: any; loadProject: (root: string) => any; isFigure: (project: any, file: string) => boolean;
    diffUnits: (repo: any, before: string, after: string, isFigure: (file: string) => boolean) => Unit[];
    revertUnits: (old: Buffer | null, next: Buffer | null, units: Unit[]) => Buffer | null;
    withUnits: (repo: any, before: string, after: string, units: Unit[]) => string;
    splitLines: (text: string) => string[]; textOf: (data: Buffer | null) => string | null;
    opcodes: (a: string[], b: string[]) => Op[];
    render: (output: string, request: unknown, variant?: (units: Unit[]) => Promise<unknown>) => Promise<void>;
    more: (output: string, unit: string) => Promise<unknown[]>;
  };
}

// A change is the same change in a later comparison when it replaces the same
// committed lines with the same text; reverting another change leaves both.
export const signature = (unit: Unit) => createHash('sha256').update(JSON.stringify([unit.file, unit.status, unit.old_start, unit.old_end, unit.old_text, unit.new_text])).digest('hex').slice(0, 24);

// Where a change sits in the committed file and in the working file, as line ranges.
const headRange = (unit: Unit): [number, number] => [unit.ops[0][1], unit.ops[unit.ops.length - 1][2]];
const workRange = (unit: Unit): [number, number] => [unit.ops[0][3], unit.ops[unit.ops.length - 1][4]];
// Two line ranges meet when they overlap, or when one is empty and sits inside or at the edge of the other.
const meets = ([a, b]: [number, number], [c, d]: [number, number]) => a === b || c === d ? a <= d && c <= b : a < d && c < b;

// The index's lines with one change's working-tree lines staged: every
// difference between the index and the working file inside the change.
export function stageLines(index: string[], work: string[], range: [number, number], opcodes: (a: string[], b: string[]) => Op[]) {
  const result = [...index];
  for (const [tag, i, j, x, y] of opcodes(index, work).reverse()) if (tag !== 'equal' && meets([x, y], range)) result.splice(i, j - i, ...work.slice(x, y));
  return result;
}
// The index's lines with one change unstaged: the committed lines back in its place.
export function unstageLines(head: string[], index: string[], range: [number, number], opcodes: (a: string[], b: string[]) => Op[]) {
  const result = [...index];
  for (const [tag, i, j, x, y] of opcodes(head, index).reverse()) if (tag !== 'equal' && meets([i, j], range)) result.splice(x, y - x, ...head.slice(i, j));
  return result;
}
// A change is staged when the index already has the working tree's text there.
export const stagedLines = (index: string[], work: string[], range: [number, number], opcodes: (a: string[], b: string[]) => Op[]) =>
  !opcodes(index, work).some(([tag, , , x, y]) => tag !== 'equal' && meets([x, y], range));

// A path's index entry, if it has one.
function indexEntry(repo: any, file: string): Entry | null {
  const [mode, sha] = repo.text(['ls-files', '-s', '-z', '--', file]).split(/\s+/);
  return sha ? { mode, sha } : null;
}
const same = (a: Buffer | null, b: Buffer | null) => a === null || b === null ? a === b : a.equals(b);
const readBytes = (file: string) => { try { return fs.readFileSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; } };

export class Changes {
  private comparisons = new Map<string, Comparison>();
  get busyForUpdate() { return [...this.comparisons.values()].some(comparison => comparison.job?.status === 'running'); }
  busyForProject(id: string) { return this.comparisons.get(id)?.job?.status === 'running'; }
  forgetProject(id: string) { this.comparisons.delete(id); }
  constructor(private dir = path.join(DATA, 'changes')) { fs.rmSync(dir, { recursive: true, force: true }); }

  private comparison(projectId: string) {
    let comparison = this.comparisons.get(projectId);
    if (!comparison) this.comparisons.set(projectId, comparison = { rounds: [], job: null, next: 1, undo: null, reverted: new Set() });
    return comparison;
  }

  // The last commit's tree and the working tree, read at most once a second.
  private snapshot(projectId: string, root: string, fresh = false): Promise<Snapshot> {
    const comparison = this.comparison(projectId);
    if (!fresh && comparison.snapshot && Date.now() - comparison.snapshot.at < 1000) return comparison.snapshot.value;
    const value = (async () => {
      const { Repo } = await engine(), repo = new Repo(root);
      return { before: repo.hasHead() ? repo.treeId('HEAD') : null, after: await workingTree(root) };
    })();
    comparison.snapshot = { at: Date.now(), value };
    value.catch(() => { if (comparison.snapshot?.value === value) comparison.snapshot = undefined; });
    return value;
  }

  // The changes between the two trees, leaving out untracked build output,
  // which the Git panel offers to ignore.
  private async units(projectId: string, root: string, snapshot: Snapshot) {
    const comparison = this.comparison(projectId), key = `${snapshot.before}:${snapshot.after}`;
    if (comparison.current?.key === key) return comparison.current.units;
    const { Repo, loadProject, isFigure, diffUnits } = await engine(), project = loadProject(root);
    const units = diffUnits(new Repo(root), snapshot.before!, snapshot.after, file => isFigure(project, file)).filter(unit => !(unit.status === 'added' && ignorePattern(unit.file)));
    comparison.current = { key, units };
    return units;
  }

  // Which of the current changes are staged, read from the index.
  private async staged(root: string, snapshot: Snapshot, units: Unit[]) {
    const { Repo, splitLines, textOf, opcodes } = await engine(), repo = new Repo(root);
    const files = [...new Set(units.map(unit => unit.file))];
    const work = repo.blobs(snapshot.after, files), index = repo.blobs('', files);
    const staged = new Set<string>();
    for (const unit of units) {
      const ready = unit.whole_file ? same(index[unit.file], work[unit.file])
        : index[unit.file] !== null && stagedLines(splitLines(textOf(index[unit.file]) ?? ''), splitLines(textOf(work[unit.file]) ?? ''), workRange(unit), opcodes);
      if (ready) staged.add(unit.id);
    }
    return staged;
  }

  // Compile both trees once the working tree or the last commit changes, and
  // render their comparison. The previous comparison stays readable meanwhile.
  private schedule(projectId: string, root: string, snapshot: Snapshot) {
    const comparison = this.comparison(projectId), latest = comparison.rounds.at(-1), key = `${snapshot.before}:${snapshot.after}`;
    if (!snapshot.before || (latest && `${latest.before}:${latest.after}` === key) || comparison.job?.status === 'running' || comparison.job?.key === key) return;
    const job: Job = { key, phase: 'build', status: 'running', created: Date.now() };
    comparison.job = job;
    void (async () => {
      const { Builder, BuildError, Repo, loadProject, withUnits, render } = await engine();
      const project = loadProject(root), repo = new Repo(root), number = comparison.next++;
      const units = await this.units(projectId, root, snapshot), folder = path.join(this.dir, projectId, String(number));
      let warnings: string[] = [];
      fs.rmSync(folder, { recursive: true, force: true }); fs.mkdirSync(folder, { recursive: true });
      if (units.length) {
        const builder = new Builder(project, repo);
        const build = async (tree: string, what: string) => {
          try { return await builder.build(tree, ['full']); }
          catch (error) { throw error instanceof BuildError ? Object.assign(new Error(what), { details: (error as any).details, log: (error as any).log }) : error; }
        };
        const old = await build(snapshot.before!, 'The last commit could not be compiled.'), next = await build(snapshot.after, 'The working tree could not be compiled.');
        job.phase = 'render';
        // The engine compiles the commit with some of the changes when it must
        // tell which of them changes the PDF elsewhere, such as a macro's uses.
        await render(folder, { main: project.main, source_dir: project.source_dir, figures: project.figures, old, new: next, units },
          (subset: Unit[]) => builder.build(withUnits(repo, snapshot.before!, snapshot.after, subset), ['full']));
        warnings = next.warnings.filter((warning: string) => !old.warnings.includes(warning));
      } else fs.writeFileSync(path.join(folder, 'round.json'), JSON.stringify({ units: {}, sections: [], loose: [] }));
      comparison.rounds.push({ number, before: snapshot.before!, after: snapshot.after, units, folder, warnings, decisions: {} });
      // The viewer may still show the round before; older ones go.
      for (const old of comparison.rounds.splice(0, Math.max(0, comparison.rounds.length - 3))) fs.rmSync(old.folder, { recursive: true, force: true });
      if (comparison.job === job) comparison.job = null;
    })().catch(error => {
      const detail = error as { message?: string; details?: string[]; log?: string };
      Object.assign(job, { status: 'failed', error: detail.message || 'The comparison could not be built.', details: detail.details || [], ...(detail.log ? { log: detail.log } : {}) });
    });
  }

  // What the viewer polls, in the review engine's page state shape: the
  // latest comparison, and for the round it shows, which changes are staged
  // (accepted), unstaged (pending), reverted (rejected) or edited since.
  async state(projectId: string, root: string, csrf: string, number?: number) {
    const comparison = this.comparison(projectId), snapshot = await this.snapshot(projectId, root);
    this.schedule(projectId, root, snapshot);
    const latest = comparison.rounds.at(-1) ?? null, round = comparison.rounds.find(item => item.number === number) ?? latest;
    let decisionLock: string | null = mergeInProgress(root) ? 'Finish or abort the merge in the Git panel before staging or reverting changes.' : null;
    if (round && snapshot.before && round.before === snapshot.before) {
      const units = await this.units(projectId, root, snapshot), staged = await this.staged(root, snapshot, units);
      const current = new Map(units.map(unit => [signature(unit), unit]));
      round.decisions = Object.fromEntries(round.units.map(unit => {
        const key = signature(unit), found = current.get(key);
        return [unit.id, found ? (staged.has(found.id) ? 'accepted' : 'pending') : comparison.reverted.has(key) ? 'rejected' : 'commented'];
      }));
    } else if (round) decisionLock ??= 'The last commit changed. The comparison is being updated.';
    const job = comparison.job, decisions = round?.decisions ?? {}, values = Object.values(decisions);
    const building = job?.status === 'running' && (!latest || job.key !== `${latest.before}:${latest.after}`);
    const undo = comparison.undo && round ? round.units.filter(unit => comparison.undo!.signatures.includes(signature(unit))).map(unit => unit.id) : [];
    return {
      csrf, task: 'changes', title: 'Uncommitted changes', closed: false, decisionLock, commentLock: null,
      state: !snapshot.before ? 'build_failed' : building || (!latest && job?.status !== 'failed') ? 'building' : job?.status === 'failed' ? 'build_failed' : values.includes('pending') ? 'reviewing' : 'done',
      latest: latest?.number ?? null, round: round?.number ?? null, revision: round?.after ?? null,
      decisions, comments: {},
      undo: comparison.undo ? { id: comparison.undo.id, kind: 'reject', changes: undo } : null,
      job: !snapshot.before ? { id: 'changes', status: 'failed', phase: 'build', created: 0, ahead: 0, error: 'This repository has no commits yet. Commit once to compare later changes in the PDF.' }
        : job ? { id: job.key, status: job.status === 'running' ? 'running' : 'failed', phase: job.phase, created: job.created, ahead: 0, ...(job.error ? { error: job.error, details: job.details, log: job.log } : {}) } : null,
    };
  }

  detail(projectId: string, number: number) {
    const round = this.comparison(projectId).rounds.find(item => item.number === number);
    if (!round) throw Object.assign(new Error('This comparison is out of date. Refresh the page.'), { statusCode: 404 });
    const render = this.rendered(round);
    return {
      task: 'changes', round: round.number, before: round.before, after: round.after,
      units: round.units.map(unit => ({ ...unit, ...render.units[unit.id] })), sections: render.sections, loose: render.loose,
      warnings: round.warnings, files: `/review/${projectId}/changes/files/${round.number}/`,
      ...(render.references ? { references: render.references } : {}),
    };
  }
  private rendered(round: Round): { units: Record<string, object>; sections: unknown[]; loose: unknown[]; references?: unknown } {
    try { return JSON.parse(fs.readFileSync(path.join(round.folder, 'round.json'), 'utf8')); } catch { return { units: {}, sections: [], loose: [] }; } // An empty comparison has no render.
  }

  // Online checks of the bibliography entries the uncommitted changes add or
  // modify, as for a task's round; check asks for lookups to start.
  async references(projectId: string, root: string, number: number, check: boolean, retry: boolean) {
    const inputs = await this.entryInputs(projectId, number);
    return { ...(await checker()).lookup(inputs, check, retry), confirmed: (await confirmations(root)).of(inputs) };
  }
  // The author checked an entry by hand, or takes that back.
  async confirmReference(projectId: string, root: string, number: number, id: string, on: boolean) {
    const inputs = await this.entryInputs(projectId, number), input = inputs.find(item => item.id === id);
    if (!input) throw Object.assign(new Error('This entry is no longer among the changes. Refresh the page.'), { statusCode: 404 });
    (await confirmations(root)).set(input, on);
    return this.references(projectId, root, number, false, false);
  }
  private async entryInputs(projectId: string, number: number) {
    const round = this.comparison(projectId).rounds.find(item => item.number === number);
    if (!round) throw Object.assign(new Error('This comparison is out of date. Refresh the page.'), { statusCode: 404 });
    return (await referenceEngine()).checkInputs(this.rendered(round).references);
  }

  // The places a change alters away from its own lines, past those the
  // comparison rendered, rendered into its folder when first asked for.
  async effects(projectId: string, number: number, unit: string) {
    const round = this.comparison(projectId).rounds.find(item => item.number === number);
    if (!round || !/^c\d+$/.test(unit)) throw Object.assign(new Error('This comparison is out of date. Refresh the page.'), { statusCode: 404 });
    const { more } = await engine();
    return { places: await more(round.folder, unit) };
  }

  file(projectId: string, number: number, name: string) {
    const round = this.comparison(projectId).rounds.find(item => item.number === number);
    const file = round && /^[\w.-]+\.(svg|png)$/.test(name) ? path.join(round.folder, name) : '';
    if (!file || !fs.existsSync(file)) throw Object.assign(new Error('No such file.'), { statusCode: 404 });
    return file;
  }

  // The chosen changes of a round the viewer shows, found again among the
  // changes on disk now. Each must still be there exactly as shown.
  private async chosen(projectId: string, root: string, number: number, ids: string[]) {
    const comparison = this.comparison(projectId), round = comparison.rounds.find(item => item.number === number);
    if (!round) throw conflict('This comparison is out of date. Wait for it to update.');
    const snapshot = await this.snapshot(projectId, root, true);
    if (round.before !== snapshot.before) throw conflict('The last commit changed. Wait for the comparison to update.');
    if (mergeInProgress(root)) throw conflict('Finish or abort the merge in the Git panel before staging or reverting changes.');
    const current = new Map((await this.units(projectId, root, snapshot)).map(unit => [signature(unit), unit]));
    const units = ids.map(id => {
      const shown = round.units.find(unit => unit.id === id);
      const found = shown && current.get(signature(shown));
      if (!found) throw conflict(shown ? `${shown.file} changed since this comparison. Wait for it to update.` : 'Select a change from this comparison.');
      return found;
    });
    if (!units.length) throw new Error('Select at least one change.');
    return { comparison, snapshot, units };
  }

  // Stage or unstage writes the index only; revert writes the files too, and
  // keeps what it replaced for undo.
  async act(projectId: string, root: string, csrf: string, action: ChangeAction, number: number, ids: string[]) {
    const { comparison, snapshot, units } = await this.chosen(projectId, root, number, ids);
    const { Repo, splitLines, textOf, opcodes, revertUnits } = await engine(), repo = new Repo(root);
    const files = [...new Set(units.map(unit => unit.file))];
    const head = repo.blobs(snapshot.before, files), work = repo.blobs(snapshot.after, files), index = repo.blobs('', files);
    const lines = (data: Buffer | null) => splitLines(textOf(data) ?? '');
    const entry = (file: string) => indexEntry(repo, file);
    const writeIndex = (file: string, text: string[]) => {
      const mode = entry(file)?.mode || repo.mode(snapshot.before, file) || '100644';
      repo.run(['update-index', '--add', '--cacheinfo', `${mode},${repo.hashObject(Buffer.from(text.join('')))},${file}`]);
    };
    const unstage = (file: string, part: Unit[]) => {
      if (part.some(unit => unit.whole_file)) { repo.run(['reset', '-q', 'HEAD', '--', file]); return; }
      if (index[file] === null) return;
      let next = lines(index[file]);
      for (const unit of part) next = unstageLines(lines(head[file]), next, headRange(unit), opcodes);
      if (next.join('') !== lines(index[file]).join('')) writeIndex(file, next);
    };
    const revert: Revert = { id: randomUUID(), files: [], signatures: units.map(signature) };
    for (const file of files) {
      const part = units.filter(unit => unit.file === file), whole = part.some(unit => unit.whole_file);
      if (action === 'stage') {
        if (whole) repo.run(['add', '-A', '--', file]);
        else {
          let next = index[file] === null ? lines(head[file]) : lines(index[file]);
          for (const unit of part) next = stageLines(next, lines(work[file]), workRange(unit), opcodes);
          writeIndex(file, next);
        }
      } else if (action === 'unstage') unstage(file, part);
      else {
        const absolute = path.join(root, file), disk = readBytes(absolute), before = entry(file);
        if (!same(disk, work[file])) throw conflict(`${file} changed on disk since this comparison. Wait for it to update.`);
        const stat = fs.lstatSync(absolute, { throwIfNoEntry: false });
        if (stat && !stat.isFile()) throw new Error(`${file} is not a regular file, so it cannot be reverted here.`);
        if (head[file] === null) { repo.run(['rm', '--cached', '-q', '--ignore-unmatch', '--', file]); fs.rmSync(absolute, { force: true }); }
        else if (whole) repo.run(['checkout', 'HEAD', '--', file]);
        else { fs.writeFileSync(absolute, revertUnits(head[file], work[file], part)!); unstage(file, part); }
        revert.files.push({ path: file, disk, written: readBytes(absolute), index: before, indexAfter: entry(file) });
      }
    }
    if (action === 'revert') { comparison.undo = revert; revert.signatures.forEach(key => comparison.reverted.add(key)); }
    comparison.snapshot = undefined;
    return this.state(projectId, root, csrf, number);
  }

  // Undo puts back what the last revert replaced, unless a file changed since.
  async undo(projectId: string, root: string, csrf: string, id: string) {
    const comparison = this.comparison(projectId), revert = comparison.undo;
    if (!revert || revert.id !== id) throw conflict('There is no revert to undo.');
    const { Repo } = await engine(), repo = new Repo(root);
    for (const file of revert.files) if (!same(readBytes(path.join(root, file.path)), file.written)) throw conflict(`${file.path} changed after the revert, so it was not restored.`);
    for (const file of revert.files) {
      const absolute = path.join(root, file.path);
      if (file.disk === null) fs.rmSync(absolute, { force: true });
      else { fs.mkdirSync(path.dirname(absolute), { recursive: true }); fs.writeFileSync(absolute, file.disk); }
      const now = indexEntry(repo, file.path);
      if (now?.sha === file.indexAfter?.sha && now?.mode === file.indexAfter?.mode) {
        if (file.index) repo.run(['update-index', '--add', '--cacheinfo', `${file.index.mode},${file.index.sha},${file.path}`]);
        else if (now) repo.run(['update-index', '--force-remove', '--', file.path]);
      }
    }
    comparison.undo = null;
    revert.signatures.forEach(key => comparison.reverted.delete(key));
    comparison.snapshot = undefined;
    const latest = comparison.rounds.at(-1);
    return { ...(await this.state(projectId, root, csrf)), restored: latest ? latest.units.filter(unit => revert.signatures.includes(signature(unit))).map(unit => unit.id) : [] };
  }
}
