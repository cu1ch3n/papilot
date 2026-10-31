import { forwardRef, useEffect, useId, useImperativeHandle, useRef, useState } from 'react';
import type { BuildProblem, BuildProblemCounts, ManuscriptBuild, ManuscriptProblems } from '../shared.ts';
import { Icon } from './icons.tsx';
import { t, tn } from './i18n.ts';
import './build-problems.css';

export interface ProblemsHandle { open(): void }

// What a problem is, in the interface language. TeX's own wording is kept for
// errors and package remarks, which have no fixed shape.
export function problemTitle(problem: BuildProblem) {
  switch (problem.kind) {
    case 'reference': return t('Undefined reference');
    case 'citation': return t('Undefined citation');
    case 'label': return t('Label defined more than once');
    case 'missing-file': return t('Missing file');
    case 'glyph': return t('Missing character');
    case 'overfull': return t('Line too wide by {amount}pt', { amount: problem.amount ?? 0 });
    default: return problem.message;
  }
}
const hasKey = (problem: BuildProblem) => problem.key && ['reference', 'citation', 'label', 'missing-file', 'glyph'].includes(problem.kind);
export const problemPlace = (problem: BuildProblem) => problem.file ? `${problem.file}${problem.line ? `:${problem.line}${problem.end ? `–${problem.end}` : ''}` : ''}` : '';

// The list an agent receives: the agent reads English, like note locations.
const agentText = (problem: BuildProblem) => {
  const what = { reference: `Undefined reference \`${problem.key}\``, citation: `Undefined citation \`${problem.key}\``, label: `Label \`${problem.key}\` defined more than once`, 'missing-file': `Missing file \`${problem.key}\``, glyph: `Missing character ${problem.key}`, overfull: `Overfull line, ${problem.amount}pt too wide` }[problem.kind as string] || problem.message;
  const place = problemPlace(problem);
  return `- ${place ? place + ' — ' : ''}${what}`;
};
export function fixRequest(problems: BuildProblem[], limit = 40) {
  const chosen = problems.filter(problem => problem.kind !== 'other');
  const lines = chosen.slice(0, limit).map(agentText);
  if (chosen.length > limit) lines.push(`- …and ${chosen.length - limit} more in the build log`);
  return `${t('Fix these problems from the last compilation:')}\n${lines.join('\n')}`;
}

// Like Overleaf's log button: a quiet icon beside Recompile. Errors turn its
// count red, warnings leave it grey, and typesetting remarks are never counted.
// Nothing opens by itself; the list loads when someone asks for it.
export const ProblemsButton = forwardRef<ProblemsHandle, {
  counts?: BuildProblemCounts; status?: ManuscriptBuild['status']; pdfKey?: string; logUrl: string;
  load: () => Promise<ManuscriptProblems>; onJump: (problem: BuildProblem) => void; onFix?: (problems: BuildProblem[]) => void;
}>(function ProblemsButton({ counts, status, pdfKey, logUrl, load, onJump, onFix }, ref) {
  const id = useId(), trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false), [data, setData] = useState<ManuscriptProblems | null>(null), [error, setError] = useState('');
  const loadRef = useRef(load); loadRef.current = load;
  const errors = counts?.errors || 0, warnings = counts?.warnings || 0, shown = errors || warnings;
  const signature = JSON.stringify([counts, status, pdfKey]);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setError('');
    loadRef.current().then(result => { if (alive) setData(result); }, reason => { if (alive) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { alive = false; };
  }, [open, signature]);
  useEffect(() => {
    if (!open) return;
    const dismiss = () => panel.current?.hidePopover();
    window.addEventListener('resize', dismiss);
    return () => window.removeEventListener('resize', dismiss);
  }, [open]);
  function show() {
    const element = panel.current!, box = trigger.current!.getBoundingClientRect();
    element.showPopover();
    if (window.matchMedia('(max-width: 680px)').matches) { element.style.left = ''; element.style.top = ''; return; }
    element.style.left = `${Math.max(8, Math.min(box.right - element.offsetWidth, window.innerWidth - element.offsetWidth - 8))}px`;
    element.style.top = `${Math.max(8, Math.min(box.bottom + 6, window.innerHeight - element.offsetHeight - 8))}px`;
  }
  useImperativeHandle(ref, () => ({ open() { if (!panel.current?.matches(':popover-open')) show(); } }), []);
  const problems = data?.problems || [];
  const groups: [string, BuildProblem[]][] = [
    [t('Errors'), problems.filter(problem => problem.severity === 'error')],
    [t('Warnings'), problems.filter(problem => problem.severity === 'warning')],
  ];
  const minor = problems.filter(problem => problem.severity === 'minor');
  const fixable = problems.filter(problem => problem.kind !== 'other');
  const label = errors ? tn(errors, '{n} compilation error', '{n} compilation errors') : warnings ? tn(warnings, '{n} compilation warning', '{n} compilation warnings') : t('Compilation log');
  const row = (problem: BuildProblem, index: number) => {
    const where = problemPlace(problem), canJump = problem.page !== undefined && Boolean(problem.rect) && data?.key === pdfKey;
    const content = <>
      <span className="problem-title"><span>{problemTitle(problem)}</span>{hasKey(problem) && <code>{problem.key}</code>}{(problem.count || 0) > 1 && <span className="problem-repeat" title={t('Reported {n} times', { n: problem.count! })}>×{problem.count}</span>}</span>
      {(where || problem.page !== undefined) && <span className="problem-place">{where && <span className="problem-file" title={where}>{where}</span>}{problem.page !== undefined && <span className="problem-page">{t('p. {page}', { page: problem.page + 1 })}</span>}</span>}
    </>;
    return <li key={index} data-severity={problem.severity}>{canJump
      ? <button type="button" onClick={() => { panel.current?.hidePopover(); onJump(problem); }}>{content}</button>
      : <div className="problem-static">{content}</div>}</li>;
  };
  return <span className="menu-anchor problems-anchor">
    <button ref={trigger} type="button" className="icon-button problems-button" data-severity={errors ? 'error' : warnings ? 'warning' : undefined} aria-label={label} title={label} aria-haspopup="dialog" aria-expanded={open} aria-controls={id}
      onClick={() => { if (panel.current?.matches(':popover-open')) panel.current.hidePopover(); else show(); }}>
      <Icon name="log" size={17}/>{shown > 0 && <b className="problems-count" aria-hidden="true">{shown > 99 ? '99+' : shown}</b>}
    </button>
    <div ref={panel} id={id} popover="auto" role="dialog" aria-label={t('Compilation problems')} className="problems-panel"
      onToggle={event => setOpen((event.nativeEvent as ToggleEvent).newState === 'open')}
      onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); panel.current?.hidePopover(); trigger.current?.focus(); } }}>
      <header className="problems-header">
        <strong>{t('Compilation problems')}</strong>
        {status === 'building' && <span className="problems-status">{t('Recompiling; this list will update.')}</span>}
      </header>
      <div className="problems-body" aria-busy={!data && !error}>
        {error ? <p className="problems-empty" role="alert">{error}</p>
          : !data ? <p className="problems-empty">{t('Loading…')}</p>
          : !problems.length ? <p className="problems-empty">{data.status === 'building' ? t('The first build is still running.') : t('No problems in the last build.')}</p>
          : <>
            {groups.map(([title, list]) => list.length > 0 && <section key={title}>
              <h3>{title} <span>{list.length}</span></h3>
              <ul>{list.map(row)}</ul>
            </section>)}
            {minor.length > 0 && <details className="problems-minor" open={!groups.some(([, list]) => list.length)}>
              <summary>{t('Typesetting and other remarks')} <span>{minor.length}</span></summary>
              <ul>{minor.map(row)}</ul>
            </details>}
          </>}
      </div>
      {(data?.log || (onFix && fixable.length > 0)) && <footer className="problems-footer">
        {data?.log && <a href={logUrl} target="_blank" rel="noreferrer">{t('Raw log')}</a>}
        {onFix && fixable.length > 0 && <button type="button" className="button ghost compact" onClick={() => { panel.current?.hidePopover(); onFix(fixable); }}><Icon name="tool" size={14}/>{t('Fix with an agent…')}</button>}
      </footer>}
    </div>
  </span>;
});
