import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bibliography, confirmEntry } from '../src/server/references.ts';

// A paper with one entry cited twice, one never cited, a key used twice,
// and a citation of a key no entry defines. Nothing is looked up online.
function paper() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-references-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  fs.mkdirSync(path.join(root, 'sections'));
  fs.writeFileSync(path.join(root, 'main.tex'), String.raw`\documentclass{article}
\begin{document}
\section{Intro}
\input{sections/body}
\bibliography{refs}
\end{document}
`);
  fs.writeFileSync(path.join(root, 'sections/body.tex'), String.raw`See \cite{knuth} and \citep{knuth,ghost}.
`);
  fs.writeFileSync(path.join(root, 'refs.bib'), `@book{knuth,
  author = {Donald E. Knuth},
  title = {The {\\TeX}book},
  year = 1984
}
@misc{unused, title = {Never cited}}
@misc{unused, title = {Twice}}
`);
  return root;
}

test('the References panel reports the bibliography on disk and keeps confirmations in the repository', async () => {
  const root = paper();
  try {
    const report = await bibliography(root, false, false);
    assert.deepEqual(report.bibs, ['refs.bib']);
    assert.deepEqual(report.entries.map(entry => [entry.id, entry.cited.length]), [['refs.bib#knuth', 2], ['refs.bib#unused', 0], ['refs.bib#unused#2', 0]]);
    assert.deepEqual(report.entries[0].cited[0], { file: 'sections/body.tex', line: 1, section: '1 Intro' });
    assert.deepEqual(report.missing.map(cite => cite.key), ['ghost']);
    assert.deepEqual(report.duplicates, [['refs.bib#unused', 'refs.bib#unused#2']]);
    assert.equal(report.pending, 0);
    assert.deepEqual(report.confirmed, {});

    const confirmed = await confirmEntry(root, 'refs.bib#knuth', true);
    assert.ok(confirmed.confirmed['refs.bib#knuth'] > 0);
    const file = path.join(root, '.git/latex-review/references-confirmed.json');
    assert.ok(fs.existsSync(file));
    // Editing the entry's looked-up fields asks again.
    fs.writeFileSync(path.join(root, 'refs.bib'), fs.readFileSync(path.join(root, 'refs.bib'), 'utf8').replace('year = 1984', 'year = 1986'));
    assert.deepEqual((await bibliography(root, false, false)).confirmed, {});
    await assert.rejects(confirmEntry(root, 'refs.bib#nothing', true), /no longer in the bibliography/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
