import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DATA, ENGINE } from './paths.ts';
import type { BibliographyReport, ReferenceCheck } from '../shared.ts';

// The paper's bibliography as it is on disk: every entry, where it is cited,
// what is wrong with it without looking anything up, and, when asked, what
// Crossref, DBLP and arXiv know of it. The review engine does the reading
// and the checking; this is where Papilot asks it for a whole paper.

type Input = { id: string; type: string; fields: Record<string, string> };
interface Checker { lookup(inputs: Input[], start?: boolean, retry?: boolean): { checks: Record<string, ReferenceCheck>; pending: number } }
interface Confirmations { of(inputs: Input[]): Record<string, number>; set(input: Input, on: boolean): void }
interface Engine {
  bibliographyReport(doc: { read(file: string): string | null; main: string; outline: unknown[] }): Omit<BibliographyReport, 'checks' | 'pending' | 'confirmed'>;
  buildOutline(read: (file: string) => string | null, main: string): { nodes: unknown[] };
  loadProject(root: string): { main: string };
  checkInputs(references: unknown): Input[];
  entryInputs(entries: unknown[]): Input[];
  ReferenceChecker: new (file: string) => Checker;
  Confirmations: new (file: string) => Confirmations;
  Repo: new (root: string) => { gitDir(): string };
}
let loading: Promise<Engine> | undefined;
export function engine(): Promise<Engine> {
  const load = (file: string) => import(pathToFileURL(path.join(ENGINE, file)).href);
  loading ??= Promise.all(['src/core/bib.ts', 'src/core/outline.ts', 'src/core/config.ts', 'src/core/verify.ts', 'src/core/git.ts'].map(load))
    .then(modules => Object.assign({}, ...modules) as Engine);
  return loading;
}
// One checker for Papilot's process, so that the panel and the review of
// uncommitted changes share their results and their file.
let shared: Checker | undefined;
export async function checker(file = path.join(DATA, 'references.json')) {
  const { ReferenceChecker } = await engine();
  return shared ??= new ReferenceChecker(file);
}
// Confirmations live beside the review engine's state in the repository, so
// a task's review, the uncommitted changes and this panel agree.
export async function confirmations(root: string) {
  const { Confirmations, Repo } = await engine();
  return new Confirmations(path.join(new Repo(root).gitDir(), 'latex-review', 'references-confirmed.json'));
}

// A file of the paper, read only from inside its folder.
function reader(root: string) {
  const base = fs.realpathSync(root);
  return (file: string) => {
    const target = path.resolve(base, file);
    if (target !== base && !target.startsWith(base + path.sep)) return null;
    try { return fs.statSync(target).isFile() ? fs.readFileSync(target, 'utf8') : null; } catch { return null; }
  };
}
async function report(root: string) {
  const mods = await engine(), read = reader(root), { main } = mods.loadProject(root);
  const result = mods.bibliographyReport({ read, main, outline: mods.buildOutline(read, main).nodes });
  return { result, inputs: mods.entryInputs(result.entries) };
}

export async function bibliography(root: string, check: boolean, retry: boolean): Promise<BibliographyReport> {
  const { result, inputs } = await report(root);
  return { ...result, ...(await checker()).lookup(inputs, check, retry), confirmed: (await confirmations(root)).of(inputs) };
}
export async function confirmEntry(root: string, id: string, on: boolean) {
  const { inputs } = await report(root), input = inputs.find(item => item.id === id);
  if (!input) throw Object.assign(new Error('This entry is no longer in the bibliography. Refresh the panel.'), { statusCode: 404 });
  (await confirmations(root)).set(input, on);
  return bibliography(root, false, false);
}
