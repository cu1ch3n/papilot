import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BibliographyEntry, BibliographyReport, ReferenceCheck } from '../shared.ts';
import { Icon } from './icons.tsx';
import { language, t, tn } from './i18n.ts';
import { browserStorage } from './storage.ts';
import './references-panel.css';

// The References panel checks the paper's whole bibliography as it is on
// disk: citations without an entry, keys used twice, the same work under two
// keys, entries nobody cites, and, when asked, what Crossref, DBLP and arXiv
// know of each entry. An entry no source knows can be marked as checked by
// hand, which the reviews of later changes honour. Problems go to an agent
// as a new task that finds out what happened; the author decides the edits.

type Load = <T>(route: string, body?: unknown) => Promise<T>;
const online = () => browserStorage.getItem('latex-review:references') !== 'off';
const SOURCE: Record<string, string> = { doi: 'doi.org', crossref: 'Crossref', dblp: 'DBLP', arxiv: 'arXiv' };
const fieldName = (field: string) => ({ title: t('Title'), author: t('Authors'), year: t('Year'), doi: 'DOI', arxiv: 'arXiv' } as Record<string, string>)[field] || field;
const gap = () => (language() === 'zh-CN' ? '' : ' ');
const where = (place: { file: string; line: number; section?: string | null }) => `${place.section ? place.section + ' · ' : ''}${place.file}:${place.line}`;
const value = (entry: BibliographyEntry, name: string) => { const field = entry.fields.find(f => f.name === name); return field ? field.resolved ?? field.value : ''; };
// Titles and names as they read, without TeX's braces.
const readable = (text: string) => text.replace(/\\[a-zA-Z]+\s*/g, '').replace(/[{}$]/g, '').replace(/\s+/g, ' ').trim();

/** The panel's data: read when the PDF is rebuilt, and checked online only
 * when the author asks. */
export function useBibliography(projectId: string, version: string, load: Load, enabled = true) {
  const [report, setReport] = useState<BibliographyReport | null>(null), [error, setError] = useState('');
  const [checking, setChecking] = useState(false), retry = useRef(false), [round, setRound] = useState(0);
  useEffect(() => { setReport(null); setError(''); setChecking(false); }, [projectId]);
  // Back from the editor, the files may have changed.
  useEffect(() => {
    if (!enabled) return;
    const again = () => setRound(n => n + 1);
    window.addEventListener('focus', again);
    return () => window.removeEventListener('focus', again);
  }, [enabled]);
  useEffect(() => {
    if (!projectId || !enabled) return;
    let live = true, timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const again = retry.current; retry.current = false;
      try {
        const next = await load<BibliographyReport>(`/projects/${projectId}/references${checking && online() ? `?check=1${again ? '&retry=1' : ''}` : ''}`);
        if (!live) return;
        setReport(next); setError('');
        if (checking && next.pending) timer = setTimeout(() => void poll(), 1500);
        else if (checking) setChecking(false);
      } catch (e) { if (live) { setError(e instanceof Error ? e.message : String(e)); setChecking(false); } }
    };
    void poll();
    return () => { live = false; clearTimeout(timer); };
  }, [projectId, version, checking, round, load, enabled]);
  return {
    report, error, checking,
    check(again = false) { retry.current = again; setChecking(true); setRound(n => n + 1); },
    async confirm(id: string, on: boolean) {
      try { setReport(await load<BibliographyReport>(`/projects/${projectId}/references/confirm`, { id, confirmed: on })); }
      catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    },
  };
}
export type Bibliography = ReturnType<typeof useBibliography>;

interface Item { id: string; key: string; label: string; entry?: BibliographyEntry; problems: string[]; soft: boolean; fix: string }
// Every problem of the bibliography, entry by entry, most pressing first.
function items(report: BibliographyReport): Item[] {
  const list: Item[] = [], byId = new Map(report.entries.map(entry => [entry.id, entry]));
  // One item for each key cited without an entry, with every place.
  for (const key of [...new Set(report.missing.map(cite => cite.key))]) {
    const places = report.missing.filter(cite => cite.key === key).map(cite => `${cite.file}:${cite.line}`).join('; ');
    list.push({ id: `missing:${key}`, key, label: `\\cite{${key}}`, problems: [t('No entry has this key.') + gap() + places], soft: false,
      fix: t('{cite} ({places}) has no entry with this key.', { cite: `\\cite{${key}}`, places }) });
  }
  for (const entry of report.entries) {
    const check = report.checks[entry.id], mine = entry.id in report.confirmed, problems: string[] = [], fixes: string[] = [];
    if (entry.error) { problems.push(t('BibTeX cannot read it: {error}', { error: entry.error })); fixes.push(t('BibTeX cannot read it ({error}).', { error: entry.error })); }
    if (report.duplicates.some(ids => ids.includes(entry.id))) { problems.push(t('Another entry has the same key.')); fixes.push(t('another entry has the same key.')); }
    for (const group of report.similar.filter(g => g.ids.includes(entry.id))) {
      const others = group.ids.filter(id => id !== entry.id).map(id => byId.get(id)?.key).join(', ');
      problems.push(group.by === 'doi' ? t('Same DOI as {keys}.', { keys: others }) : t('Same title as {keys}.', { keys: others }));
      fixes.push(group.by === 'doi' ? t('the same work as {keys} (same DOI).', { keys: others }) : t('possibly the same work as {keys} (same title).', { keys: others }));
    }
    if (check && !mine && check.status === 'mismatch') {
      const major = check.differences.filter(d => !d.minor);
      problems.push(major.map(d => t('{field}: {bib} here, {record} in {source}', { field: fieldName(d.field), bib: d.bib, record: d.record || '—', source: SOURCE[check.record?.source || ''] || '' })).join('; '));
      fixes.push(t('{differences} (record: {url}).', { differences: major.map(d => t('{field} is {bib} but {source} has {record}', { field: fieldName(d.field), bib: d.bib, record: d.record || t('nothing'), source: SOURCE[check.record?.source || ''] || '' })).join('; '), url: check.record?.url || '' }));
    }
    if (check && !mine && check.status === 'unverified') { problems.push(t('No record in Crossref, DBLP or arXiv matches it.')); fixes.push(t('no record in Crossref, DBLP or arXiv matches it.')); }
    const soft = !problems.length && !report.all_cited && !entry.cited.length;
    if (soft) { problems.push(t('Not cited in the paper.')); fixes.push(t('it is not cited.')); }
    if (problems.length) list.push({ id: entry.id, key: entry.key, label: entry.key, entry, problems, soft,
      fix: t('{key} ({place}): {problems}', { key: entry.key, place: `${entry.file}:${entry.lines[0]}`, problems: fixes.join(gap()) }) });
  }
  return list;
}
function state(entry: BibliographyEntry, report: BibliographyReport, checking: boolean) {
  const check = report.checks[entry.id];
  if (entry.id in report.confirmed && check?.status !== 'verified') return 'confirmed';
  return check?.status || (checking ? 'checking' : 'unchecked');
}
const stateLabel = (status: string) => ({ verified: t('Verified'), mismatch: t('Differs'), unverified: t('Not found'), failed: t('Could not check'), skipped: t('Nothing to check'), confirmed: t('Checked by you'), checking: t('Checking…'), unchecked: t('Not checked') } as Record<string, string>)[status] || status;

/** How many problems the tab shows: those an author should act on. */
export const problemCount = (report: BibliographyReport | null) => report ? items(report).filter(item => !item.soft).length : 0;

export function ReferencesPanel({ data, onInvestigate }: { data: Bibliography; onInvestigate: (text: string) => void }) {
  const { report, error, checking } = data;
  const [filter, setFilter] = useState<'problems' | 'all'>('problems'), [open, setOpen] = useState('');
  // The author's own choices; by default every problem but an uncited entry goes to the agent.
  const [choices, setChoices] = useState<Record<string, boolean>>({});
  const all = useMemo(() => report ? items(report) : [], [report]);
  const included = (item: Item) => choices[item.id] ?? !item.soft;
  const toggle = useCallback((item: Item) => setChoices(current => ({ ...current, [item.id]: !(current[item.id] ?? !item.soft) })), []);
  if (error && !report) return <section className="references-panel"><p className="inline-error" role="alert">{error}</p></section>;
  if (!report) return <section className="references-panel"><p className="references-empty">{t('Reading the bibliography…')}</p></section>;
  if (!report.bibs.length) return <section className="references-panel"><p className="references-empty">{t('This paper names no .bib file with {bibliography} or {addbibresource}.', { bibliography: '\\bibliography', addbibresource: '\\addbibresource' })}</p></section>;
  const count = (status: string) => report.entries.filter(entry => state(entry, report, checking) === status).length;
  const unchecked = report.entries.filter(entry => !entry.error && !report.checks[entry.id]).length;
  const chosen = all.filter(included);
  const shown = filter === 'problems' ? null : report.entries;
  // The agent finds out what happened; the author decides what to change.
  const investigate = () => onInvestigate([t('Find out what happened with these bibliography problems and report back. Do not edit any file. For each, check whether the work exists and what its published record says (authors, title, year, venue, DOI), find where the entry or citation came from in the Git history of the .bib and .tex files, and say what you would suggest. Mark which findings you confirmed in a source and which are guesses.'), ...chosen.map(item => '- ' + item.fix)].join('\n'));
  return <div className="references-panel" aria-busy={checking}>
    <div className="references-summary">
      <p>
        <strong>{tn(report.entries.length, '{n} entry', '{n} entries')}</strong>
        {([['verified', t('{n} verified', { n: count('verified') })], ['confirmed', t('{n} checked by you', { n: count('confirmed') })], ['mismatch', t('{n} differ', { n: count('mismatch') })], ['unverified', t('{n} not found', { n: count('unverified') })], ['failed', t('{n} could not be checked', { n: count('failed') })]] as const).map(([status, label]) => count(status) > 0 && <span key={status} className={'references-stat s-' + status}>{label}</span>)}
        {report.absent.length > 0 && <span className="references-stat s-mismatch">{t('Missing: {files}', { files: report.absent.join(', ') })}</span>}
      </p>
      <div className="references-actions">
        {checking ? <span className="references-progress" role="status"><span className="spinner"/>{t('Checking {n}…', { n: report.pending || unchecked })}</span>
          : <button type="button" className="button secondary compact" disabled={!online()} title={online() ? t('Look the entries up in Crossref, DBLP and arXiv. Only their titles, authors, years and identifiers are sent.') : t('Online checks are off in Settings.')} onClick={() => data.check(unchecked === 0)}>
            <Icon name="refresh" size={14}/>{unchecked ? (unchecked === report.entries.length ? t('Check online') : tn(unchecked, 'Check {n} more online', 'Check {n} more online')) : t('Check again')}</button>}
      </div>
      {!online() && <p className="references-note">{t('Online checks are off in Settings, so only problems found in the files are shown.')}</p>}
      {error && <p className="inline-error" role="alert">{error}</p>}
    </div>
    <div className="references-filter" role="tablist" aria-label={t('Show')}>
      <button type="button" role="tab" aria-selected={filter === 'problems'} onClick={() => setFilter('problems')}>{t('Problems')}<span className="count">{all.filter(item => !item.soft).length}</span></button>
      <button type="button" role="tab" aria-selected={filter === 'all'} onClick={() => setFilter('all')}>{t('All entries')}<span className="count">{report.entries.length}</span></button>
    </div>
    {filter === 'problems' && (all.length ? <ul className="references-list">{all.map(item => <li key={item.id} className={'references-item' + (item.soft ? ' soft' : '')} data-open={open === item.id} data-state={item.entry ? state(item.entry, report, checking) : 'missing'}>
      <div className="references-row">
        <input type="checkbox" aria-label={t('Include {key} in the task', { key: item.label })} checked={included(item)} onChange={() => toggle(item)}/>
        <button type="button" className="references-head" aria-expanded={item.entry ? open === item.id : undefined} disabled={!item.entry} onClick={() => setOpen(open === item.id ? '' : item.id)}>
          <code>{item.label}</code>
          {item.entry && <span className={'references-state s-' + state(item.entry, report, checking)}>{stateLabel(state(item.entry, report, checking))}</span>}
          <span className="references-problems">{item.problems.join(gap())}</span>
        </button>
      </div>
      {item.entry && open === item.id && <EntryDetail entry={item.entry} check={report.checks[item.entry.id]} confirmed={item.entry.id in report.confirmed} onConfirm={on => void data.confirm(item.entry!.id, on)}/>}
    </li>)}</ul> : <p className="references-empty"><Icon name="check" size={15}/>{unchecked ? t('No problems in the files. Check online to compare the entries with their records.') : t('No problems found.')}</p>)}
    {shown && <ul className="references-list">{shown.map(entry => { const status = state(entry, report, checking); return <li key={entry.id} className="references-item" data-open={open === entry.id}>
      <button type="button" className="references-head" aria-expanded={open === entry.id} onClick={() => setOpen(open === entry.id ? '' : entry.id)}>
        <code>{entry.key}</code><span className={'references-state s-' + status}>{stateLabel(status)}</span>
        <span className="references-title">{readable(value(entry, 'title')) || entry.type}</span>
        <span className="references-meta">{[readable(value(entry, 'author')).split(/\s+and\s+/i)[0], value(entry, 'year')].filter(Boolean).join(' · ')}</span>
      </button>
      {open === entry.id && <EntryDetail entry={entry} check={report.checks[entry.id]} confirmed={entry.id in report.confirmed} onConfirm={on => void data.confirm(entry.id, on)}/>}
    </li>; })}</ul>}
    {filter === 'problems' && all.length > 0 && <div className="references-fix">
      <button type="button" className="button primary compact" disabled={!chosen.length} onClick={investigate}><Icon name="search" size={14}/>{tn(chosen.length, 'Ask an agent to look into {n} problem', 'Ask an agent to look into {n} problems')}</button>
      <span>{t('Opens a new task you can edit before sending. The agent reports what it finds and changes nothing.')}</span>
    </div>}
  </div>;
}

function EntryDetail({ entry, check, confirmed, onConfirm }: { entry: BibliographyEntry; check?: ReferenceCheck; confirmed: boolean; onConfirm: (on: boolean) => void }) {
  return <div className="references-detail">
    <table><tbody>{entry.fields.map(field => <tr key={field.name}><th scope="row">{field.name}</th><td>{field.value}{field.resolved && <span className="references-resolved"> = {field.resolved}</span>}</td></tr>)}</tbody></table>
    <p className="references-where">{entry.file}:{entry.lines[0]}–{entry.lines[1]}{gap() || ' · '}{entry.cited.length ? tn(entry.cited.length, 'Cited {n} time: {places}', 'Cited {n} times: {places}', { places: entry.cited.map(where).join('; ') }) : t('Not cited in the paper.')}</p>
    {check?.record && <p className="references-record"><span>{check.status === 'unverified' ? t('Closest record') : t('Record')} · {SOURCE[check.record.source]}</span>
      <a href={check.record.url} target="_blank" rel="noopener noreferrer">{check.record.title}</a>{[check.record.authors.join(', '), check.record.venue, check.record.year, check.record.doi && `doi:${check.record.doi}`].filter(Boolean).map((part, i) => <span key={i}> · {part}</span>)}</p>}
    {check && check.differences.length > 0 && <dl className="references-differences">{check.differences.map((d, i) => <div key={i}><dt>{fieldName(d.field)}{d.minor ? ` · ${t('small')}` : ''}</dt><dd><span>{d.bib}</span><span>{SOURCE[check.record?.source || ''] || t('Record')}: {d.record || '—'}</span></dd></div>)}</dl>}
    {check?.unavailable.length ? <p className="references-note">{t('{sources} could not be reached.', { sources: check.unavailable.join(', ') })}</p> : null}
    {!entry.error && (confirmed
      ? <p className="references-confirmed">{t('You checked this entry yourself.')} <button type="button" className="button ghost compact" onClick={() => onConfirm(false)}>{t('Undo')}</button></p>
      : check?.status !== 'verified' && <button type="button" className="button ghost compact" onClick={() => onConfirm(true)}><Icon name="check" size={14}/>{t('I checked it myself')}</button>)}
  </div>;
}
