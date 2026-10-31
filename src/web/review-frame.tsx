import taskCommitStyles from './task-commit.css?inline';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { NoteSummary, Task } from '../shared.ts';
import { ReviewNotes } from './review-notes.tsx';
import themeStyles from './theme.css?inline';
import { language, t, useLanguage } from './i18n.ts';
import { useNoteResults } from './note-results.tsx';
import { ReviewNoteConnections } from './review-note-connections.tsx';
import { SHORTCUT_EVENT, useShortcuts } from './shortcuts.ts';
import { installReviewScroll } from './review-scroll.ts';

// The viewer reads the interface language from its address.
export const reviewUrl = (task: Pick<Task, 'projectId' | 'name'>, round?: number, change?: number) => `/review/${task.projectId}/?task=${task.name}${round ? `&round=${round}${change === undefined ? '&history=1' : `&change=${change}`}` : ''}${language() === 'en' ? '' : `&lang=${language()}`}`;
// The same viewer shows a paper's uncommitted changes against its last commit.
export const changesUrl = (projectId: string) => `/review/${projectId}/?changes=1${language() === 'en' ? '' : `&lang=${language()}`}`;

// The embedded viewer shares our origin. Keep its decision controls, but remove
// navigation and the task title that the workspace already provides. Its bar
// becomes the review toolbar; Papilot's PDF tools sit in the reserved space
// on the right, and anything it leads with on the left.
function compactReviewFrame(doc: Document, reserve: number, lead: number, changes: boolean) {
  if (!doc || doc.getElementById('papilot-embed-style')) return;
  doc.documentElement.style.setProperty('--papilot-tools', `${reserve}px`);
  doc.documentElement.style.setProperty('--papilot-lead', `${lead}px`);
  const style = doc.createElement('style'); style.id = 'papilot-embed-style';
  style.textContent = themeStyles + `
    :root{--sans:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI","PingFang SC","Noto Sans SC",system-ui,sans-serif;--comment:var(--accent);--accept:var(--green);--reject:var(--red);--frame:var(--canvas);--bar:var(--bg);--muted:var(--text-3);--ink:var(--text);--head:var(--bg-subtle);font-size:14px}
    .banner{border-radius:10px}
    .source,.source-code,.composer textarea,.composer button,.unit-actions button,.toast,.change-map-tooltip,.review-mode,.review-mode select,.review-complete,.change.standalone{background:var(--bg);color:var(--text)}
    .banner{background:var(--accent-soft);border-color:var(--accent-line)}.banner .details{background:var(--bg-subtle)}
    .source-title{color:var(--text-2)}
    .source-code del{background:var(--red-soft);color:var(--red)}
    .source-code ins{background:var(--green-soft);color:var(--green)}
    .remark{background:var(--accent-soft)}.histories,.caption{background:var(--bg-subtle);color:var(--text-2)}
    /* Bibliography entries and their checks follow the theme. */
    :root{--ok-soft:var(--green-soft);--bad-soft:var(--red-soft);--warn:var(--amber-text);--warn-soft:var(--amber-soft);--warn-line:var(--amber-line)}
    .references,.reference-entry{background:var(--bg);color:var(--text)}
    .reference-fields th,.reference-status,.reference-lines,.reference-cited,.reference-side,.reference-resolved{color:var(--text-3)}
    .toast.error{background:var(--red-soft);color:var(--red)}
    /* Papilot's commit step at the end of the completion card. */
    .review-complete{align-items:center}
    .review-complete-actions{flex-wrap:wrap;justify-content:flex-end;max-width:100%}
    .review-complete-actions .commit-state{font-size:13px;color:var(--text-3)}
    .review-complete-actions .commit-button{display:inline-flex;align-items:center;height:28px;padding:0 12px;border:1px solid var(--line-strong);border-radius:7px;background:var(--bg);color:var(--text);font:500 13px var(--sans);cursor:pointer;box-shadow:0 1px 2px rgb(0 0 0/.06)}
    .review-complete-actions .commit-button:hover{background:var(--bg-subtle);border-color:var(--line-hover)}
    .review-complete-actions .commit-button:focus-visible{outline:none;box-shadow:var(--ring)}
    .review-complete-actions .commit-button{height:auto;min-height:30px;padding:5px 12px;white-space:nowrap}
    .review-complete-actions .commit-button:disabled{opacity:.5;cursor:default}
    :root[data-papilot-phone] .review-complete-actions{justify-content:flex-start;margin-left:0}
    :root[data-papilot-phone] .review-complete-actions .commit-state{flex-basis:100%}
    :root[data-papilot-phone] .review-complete-actions .commit-button{min-height:40px}
    /* Page images follow the theme like the manuscript's PDF. They are
       transparent: the sheet is the paper, and the before/after rows tint it. */
    .pdf-strip{color-scheme:light}.pdf-strip img{filter:var(--pdf-filter)}.sheet{background:var(--pdf-page)}
    :root[data-theme="dark"]{--before:#432c30;--after:#28392d}
    .bar{display:flex;align-items:center;height:var(--papilot-bar-height,44px);min-height:var(--papilot-bar-height,44px);padding:0 max(14px,calc(var(--papilot-tools,0px) + 4px)) 0 calc(var(--papilot-lead,0px) + 14px);gap:12px;flex-wrap:nowrap;overflow:hidden}
    .bar .overview-link,.bar .identity h1,.bar .identity span{display:none}
    .bar .identity{flex:1;min-width:0;flex-direction:row;gap:6px}
    .bar .identity span{font-size:13px;font-weight:600;color:var(--text-2);overflow:hidden;text-overflow:ellipsis}
    .bar .meter{display:flex;order:initial;width:auto;font-size:13px}
    .bar .bar-end{margin-left:0;gap:6px;flex-wrap:wrap;justify-content:flex-end;min-width:0}
    .bar .ghost{font-size:13px;font-weight:500;height:28px;padding:0 10px;border-radius:7px}
    .bar .ghost:hover{text-decoration:none;background:var(--bg-hover)}
    .bar .accept-all,.bar .reject-all{display:inline-flex;align-items:center;gap:6px;border-color:var(--line-strong);background:var(--bg);color:var(--ink);box-shadow:0 1px 2px rgb(0 0 0/.06)}
    .bar .accept-all:hover,.bar .reject-all:hover{background:var(--bg-subtle);border-color:var(--line-hover)}
    .bar .ghost.round{display:none}
    .bar .status{font-size:13px}
    .sheet{border-radius:4px;box-shadow:0 1px 2px rgb(0 0 0/.06),0 8px 24px rgb(0 0 0/.08)}
    .change-head{font-size:13px;background:var(--bg-subtle)}.link{font-size:13px}
    /* The current change: a thin accent outline and a warm header, like a selected
       row in the workspace, rather than a blue frame on a blue-grey header. */
    .change.current{box-shadow:0 0 0 1px var(--accent-line),0 0 0 4px rgb(37 99 235/.07)}
    .change.current .change-head{background:var(--bg-muted);color:var(--ink)}
    .change-head .link{display:inline-flex;align-items:center;height:28px;padding:0 8px;border-radius:7px;color:var(--text-2);font-weight:500}
    .change-head .link:hover{background:var(--bg-hover);color:var(--ink);text-decoration:none}
    .change-head .link.active{background:var(--accent-soft);color:var(--accent);text-decoration:none}
    /* Decision buttons are plain text actions like the rest of the header
       (Copy reference, LaTeX, Undo): a coloured icon says what each does, and
       hovering tints it green, red or blue. On phones the bar is a solid
       toolbar at the bottom. */
    :root{--icon-copy:url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linejoin='round'><rect x='8' y='8' width='12' height='12' rx='2'/><path d='M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2'/></svg>");--icon-check:url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2.6' stroke-linecap='round' stroke-linejoin='round'><path d='M20 6 9 17l-5-5'/></svg>");--icon-cross:url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2.6' stroke-linecap='round'><path d='M18 6 6 18M6 6l12 12'/></svg>");--icon-comment:url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2.2' stroke-linejoin='round'><path d='M20 15a2 2 0 0 1-2 2H8l-4 4V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z'/></svg>")}
    .change-head .actions .accept::before,.change-head .actions .reject::before,.change-head .actions .comment::before,.bar .accept-all::before,.bar .reject-all::before{content:"";flex:none;width:13px;height:13px;background:currentColor;-webkit-mask:var(--icon) center/contain no-repeat;mask:var(--icon) center/contain no-repeat}
    .change-head .actions .accept,.bar .accept-all{--icon:var(--icon-check)}.change-head .actions .reject,.bar .reject-all{--icon:var(--icon-cross)}.change-head .actions .comment{--icon:var(--icon-comment)}
    .change-head .actions .accept::before,.bar .accept-all::before{background:var(--accept)}.change-head .actions .reject::before,.bar .reject-all::before{background:var(--reject)}.change-head .actions .comment::before{background:var(--accent)}
    .change-head .actions{gap:3px;padding:4px;background:var(--bg);border:1px solid var(--line-strong);border-radius:12px;box-shadow:0 1px 2px rgb(0 0 0/.06),0 4px 12px rgb(0 0 0/.06)}
    .change-head .actions button{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:28px;padding:0 11px;border:1px solid transparent;border-radius:7px;font-size:13px;font-weight:500;line-height:1;transition:background-color .15s,border-color .15s}
    .change-head .actions .nav{width:28px;padding:0;font-size:19px;font-weight:400;color:var(--text-2)}
    .change-head .actions .nav:hover:not(:disabled){background:var(--bg-hover)}
    .change-head .actions .nav:disabled{color:var(--text-3);opacity:1}
    .change-head .position{min-width:38px;font-size:12.5px;color:var(--text-2);font-variant-numeric:tabular-nums}
    .change-head .actions .accept,.change-head .actions .reject,.change-head .actions .comment,.change-head .actions .skip{background:transparent;color:var(--ink)}
    .change-head .actions .accept:hover:not(:disabled){background:var(--green-soft);color:var(--accept)}
    .change-head .actions .reject:hover:not(:disabled){background:var(--red-soft);color:var(--reject)}
    .change-head .actions .comment:hover:not(:disabled){background:var(--accent-soft);color:var(--accent)}
    .change-head .actions .skip:hover{background:var(--bg-hover)}
    .change-head .actions button:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
    .change-head .complete{display:inline-flex;align-items:center;gap:6px;padding:0 8px;font-size:13px;font-weight:500;color:var(--accept)}
    .change-head .complete::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
    .change-head .actions .undo{margin-left:3px;padding:0 9px;font-weight:400;color:var(--text-2)}
    .change-head .actions .undo:hover:not(:disabled){background:var(--bg-hover)}
    .change-head .actions .undo:disabled{color:var(--text-3);opacity:1}
    .change-head .actions .accept:disabled,.change-head .actions .reject:disabled,.change-head .actions .comment:disabled{opacity:.4}
    /* Uncommitted changes: Stage is the check, Unstage a minus and Revert an
       arrow back. The last revert is undone from the bar. */
    :root{--icon-minus:url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2.6' stroke-linecap='round'><path d='M5 12h14'/></svg>");--icon-revert:url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round'><path d='M9 14 4 9l5-5'/><path d='M4 9h10.5a5.5 5.5 0 0 1 0 11H11'/></svg>")}
    .change-head .actions .unstage::before{content:"";flex:none;width:13px;height:13px;background:var(--text-2);-webkit-mask:var(--icon-minus) center/contain no-repeat;mask:var(--icon-minus) center/contain no-repeat}
    [data-mode=changes] .change-head .actions .reject{--icon:var(--icon-revert)}
    .change-head .actions .unstage{background:transparent;color:var(--ink)}
    .change-head .actions .unstage:hover:not(:disabled){background:var(--bg-hover)}
    .change-head .actions .unstage:disabled{opacity:.4}
    .unit-actions .unstage{color:var(--text-2)}
    .bar .ghost.undo{flex-shrink:0;white-space:nowrap}
    /* A narrow desktop pane keeps the actions with its change. Wrapping
       the header preserves its tools without switching to a phone dock. */
    .change-head{flex-wrap:wrap;align-items:center;gap:4px 6px;padding:5px 8px 5px 12px;min-height:40px}
    .change-head .dock,.change-head .actions{display:contents}
    .change-head .actions>.nav:first-child{order:1}.change-head .change-number{order:2}.change-head .actions>.nav:not(:first-child){order:3}
    .change-head .change-where{order:4;flex:1 1 100px;min-width:0;margin-left:4px}
    .change-head .change-kind,.change-head .badge{order:5}
    .change-head .actions>*{order:6}
    .change-head .link{order:7}
    :root:not([data-papilot-phone]) .change-head .position,:root:not([data-papilot-phone]) .change-head .complete{display:none}
    .change-head .actions .undo:disabled{display:none}
    .change-head .actions .nav{width:28px;height:28px;font-size:18px}
    .change-head .copy-reference{width:28px;padding:0;justify-content:center;font-size:0}
    .change-head .copy-reference::before{content:"";width:15px;height:15px;background:currentColor;-webkit-mask:var(--icon-copy) center/contain no-repeat;mask:var(--icon-copy) center/contain no-repeat}
    @media(max-width:680px){
      :root:not([data-papilot-phone]){
        .change-head .dock{display:flex;order:8;flex:1 0 100%;margin:0}
        .change-head .actions{display:flex;width:100%;flex-wrap:wrap;gap:3px;padding:0;border:0;border-radius:0;background:none;box-shadow:none}
        .change-head .position{display:inline;order:2;min-width:30px}
        .change-head .actions>.nav:not(:first-child){margin-right:auto}
        .change-head .actions button{padding:0 6px;font-size:12.5px}
        .change-head .actions .nav{padding:0;font-size:18px}
      }
    }
    #paper{--paper-top:14px;padding-top:14px}
    .review-body>#paper{padding-right:34px;overscroll-behavior:contain}
    .change-map{top:10px;bottom:10px;right:8px;width:14px;border:0;border-radius:0;background:none;box-shadow:none}
    .change-map::before{content:"";position:absolute;top:0;bottom:0;left:50%;width:2px;margin-left:-1px;border-radius:2px;background:var(--line)}
    .change-map-viewport{left:50%;right:auto;width:4px;margin-left:-2px;border:0;border-radius:999px;background:var(--scroll-thumb);transition:width .15s,margin .15s,background-color .15s}
    .change-map:hover .change-map-viewport,.change-map-viewport:active{width:6px;margin-left:-3px;background:var(--scroll-hover)}
    .change-map-mark{--mark:var(--text-3);left:50%;width:4px;min-height:3px;margin-left:-2px;border-radius:999px;transition:width .15s,margin .15s}
    .change-map-mark[aria-current]{outline:0;width:6px;margin-left:-3px;box-shadow:0 0 0 2px var(--frame)}
    .change-map:hover .change-map-mark{width:6px;margin-left:-3px}
    .change-map .change-map-mark:hover{outline:0;width:8px;margin-left:-4px;box-shadow:0 0 0 2px var(--frame)}
    .change-map-mark:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
    ::-webkit-scrollbar{width:10px;height:10px}::-webkit-scrollbar-track,::-webkit-scrollbar-corner{background:transparent}
    ::-webkit-scrollbar-thumb{background-color:var(--scroll-thumb);border:3px solid transparent;border-radius:999px;background-clip:padding-box}
    ::-webkit-scrollbar-thumb:hover{background-color:var(--scroll-active);border-width:2px}
    @supports not selector(::-webkit-scrollbar){*{scrollbar-width:thin;scrollbar-color:var(--scroll-hover) transparent}}
    .part-title{font-size:15px;margin:6px 0 10px}
    .side .pdf-strip,.context .pdf-strip{max-width:none}
    /* Only the host window, never an iframe's width, selects the phone
       layout. Navigation and position stay alongside the decisions. */
    :root[data-papilot-phone]{
      .bar{gap:8px}.bar .ghost:not(.history){min-height:36px;font-size:12px}
      .review-body>#paper{padding-left:8px;padding-right:24px;padding-bottom:132px}
      .change-map{right:4px;width:12px}
      .side.before::after,.side.after::after{content:none}
      .change-head{padding:4px 6px 4px 10px;gap:6px}
      .change-head .link{min-height:36px;padding:0 6px}
      .change-head .dock{display:flex;position:fixed;z-index:6;left:8px;right:8px;bottom:8px;margin:0}
      .change-head .actions{display:flex;width:100%;flex-wrap:wrap;justify-content:center;gap:4px;padding:5px;border-radius:12px;border-color:var(--line-strong);box-shadow:0 2px 4px rgb(0 0 0/.05),0 6px 20px rgb(0 0 0/.12)}
      .change-head .actions>*{order:initial!important}
      .change-head .actions button{flex:1 1 auto;min-width:0;height:44px;gap:5px;padding:0 6px;border-radius:8px;font-size:13px}
      .change-head .actions .nav{flex:0 0 32px;width:32px;min-width:32px;height:44px;padding:0}
      .change-head .position{min-width:30px;font-size:11.5px}
      .change-head .actions .undo{flex:0 0 auto;margin-left:0;padding:0 6px;font-size:13px}
      @media(max-width:360px){
        .change-head .actions:has(.nav){display:grid;grid-template-columns:repeat(3,minmax(0,1fr))}
        .change-head .actions .nav{width:100%;min-width:0;grid-row:1}
        .change-head .actions>.nav:first-child{grid-column:1}
        .change-head .actions>.nav:not(:first-child){grid-column:3}
        .change-head .position{grid-row:1;grid-column:2;justify-self:center}
        .change-head .actions button:not(.nav){grid-row:2}
      }
      .composer{left:0!important;right:0!important;width:auto!important;max-width:none;top:var(--papilot-review-bar-height,48px);bottom:auto;transform:none;max-height:calc(100% - var(--papilot-review-bar-height,48px) - var(--keyboard,0px));overflow:auto;border-width:0 0 1px;border-radius:0 0 16px 16px}
      #root:has(>.composer) .change-head .dock{display:none}
      .composer textarea{font-size:16px;min-height:76px;max-height:min(140px,30vh);resize:none}.composer button{min-height:44px}
      .composer-row{justify-content:flex-end;gap:8px}.composer-row .muted{display:none}
      .side .pdf-strip,.context .pdf-strip{width:calc(100% * var(--pdf-crop-scale,1));margin-left:calc(-100% * var(--pdf-crop-scale,1) * var(--pdf-crop-shift,0))}
      .side,.context{overflow-x:clip}
    }
    /* History shares the PDF tools' size. Shortcut settings live in Papilot. */
    .bar .ghost.history{display:inline-flex;align-items:center;justify-content:center;width:var(--papilot-button-size,30px);height:var(--papilot-button-size,30px);min-height:0;padding:0;font-size:0}
    .bar .history::before{content:"";width:16px;height:16px;background:currentColor;-webkit-mask:var(--icon-history) center/contain no-repeat;mask:var(--icon-history) center/contain no-repeat}
    /* Reserve the outer tools' row when there is too little room. Keep
       progress, batch counts and history; shorten only the batch labels. */
    .bar{container:review-bar/inline-size;height:auto;gap:8px}
    .bar .accept-all,.bar .reject-all{flex-shrink:0;white-space:nowrap}
    .bar .batch-count{margin-left:0;background:var(--bg-muted);color:var(--text-2)}
    :root[data-papilot-toolbar-stacked] .bar{padding:calc(var(--papilot-bar-height,44px) + 4px) 8px 4px;min-height:calc(var(--papilot-bar-height,44px) + 44px)}
    :root[data-papilot-toolbar-stacked] .bar .identity{display:none}
    :root[data-papilot-toolbar-stacked] .bar .bar-end{margin-left:auto}
    @container review-bar (max-width:340px){.bar .batch-label{display:none}.bar .accept-all,.bar .reject-all{padding:0 8px}.bar .bar-end{gap:4px}}
    :root{--icon-history:url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M3 12a9 9 0 1 0 2.6-6.4L3 8'/><path d='M3 3v5h5M12 7v5l3 2'/></svg>")}
  `;
  doc.documentElement.dataset.theme = window.document.documentElement.dataset.theme;
  style.textContent += taskCommitStyles;
  doc.head.append(style);
}

// Phones read the text block rather than the page. Measure the text layer's
// shared left and right edges across all strips and crop the page margins
// (used only by the narrow-screen strip rule above).
function cropMargins(doc: Document) {
  let min = 1, max = 0;
  for (const strip of doc.querySelectorAll<HTMLElement>('.pdf-strip')) {
    const box = strip.getBoundingClientRect(); if (!box.width) continue;
    for (const line of strip.querySelectorAll('.pdf-text-line')) {
      const first = line.firstElementChild?.getBoundingClientRect(), last = line.lastElementChild?.getBoundingClientRect();
      if (!first?.width || !last?.width) continue;
      min = Math.min(min, (first.left - box.left) / box.width); max = Math.max(max, (last.right - box.left) / box.width);
    }
  }
  const root = doc.documentElement.style, span = max - min + 0.04;
  if (max <= min || span >= 0.95) { root.removeProperty('--pdf-crop-scale'); root.removeProperty('--pdf-crop-shift'); return; }
  root.setProperty('--pdf-crop-scale', (1 / span).toFixed(4)); root.setProperty('--pdf-crop-shift', Math.max(0, min - 0.02).toFixed(4));
}


// The iframe can finish loading an HTTP error or an empty document. Wait for the
// actual viewer, keep watching slow startup, and let the user retry safely.
// completion is the next step shown in the viewer's card once every change is decided.
// Without a task the frame shows the paper's uncommitted changes (changesOf),
// and the viewer's own waiting message shows while they are compared.
export function ReviewFrame({ task, changesOf, tools, lead, completion, onSendNotes, onDecided }: { task?: Task; changesOf?: string; tools?: ReactNode; lead?: ReactNode; completion?: ReactNode; onSendNotes?: (message: { text: string; requestKey: string; notes?: NoteSummary[] }) => Promise<void>; onDecided?: () => void }) {
  const shortcuts = useShortcuts();
  const noteLinks = useNoteResults(), linksRef = useRef(noteLinks); linksRef.current = noteLinks;
  // Current changes open in the usual review; only older results need history.
  const linkedRound = task ? noteLinks?.focus?.change.round : undefined;
  const linkedChange = linkedRound === task?.review?.round ? noteLinks?.focus?.change.stop : undefined;
  const focusSequence = task ? noteLinks?.focus?.sequence : undefined;
  const [document, setDocument] = useState<Document | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const toolbar = useRef<HTMLDivElement>(null), leading = useRef<HTMLDivElement>(null), hostBar = useRef<HTMLDivElement>(null);
  const [reserve, setReserve] = useState(0), [leadWidth, setLeadWidth] = useState(0);
  const decided = useRef(onDecided); decided.current = onDecided;
  const observer = useRef<MutationObserver | null>(null);
  const cropper = useRef<MutationObserver | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'slow' | 'error'>('loading');
  // A new language reloads the viewer in that language.
  const shown = useLanguage().language;
  useEffect(() => {
    if (document && frame.current) return installReviewScroll(frame.current, document);
  }, [document]);
  useEffect(() => {
    const view = document?.defaultView;
    if (!view) return;
    view.dispatchEvent(new CustomEvent(SHORTCUT_EVENT, { detail: shortcuts }));
  }, [document, shortcuts]);
  useEffect(() => {
    const view = document?.defaultView;
    if (!view) return;
    const open = (event: Event) => { event.preventDefault(); window.dispatchEvent(new Event('papilot:open-shortcuts')); };
    view.addEventListener('latex-review:help', open);
    return () => view.removeEventListener('latex-review:help', open);
  }, [document]);
  useEffect(() => {
    setPhase('loading');
    const timer = setTimeout(() => setPhase(value => value === 'loading' ? 'slow' : value), 15000);
    return () => { clearTimeout(timer); observer.current?.disconnect(); cropper.current?.disconnect(); };
  }, [attempt, shown, linkedRound, focusSequence]);
  useEffect(() => {
    const element = toolbar.current; if (!element) return;
    const observer = new ResizeObserver(() => setReserve(Math.ceil(element.offsetWidth)));
    observer.observe(element); return () => observer.disconnect();
  }, [Boolean(tools)]);
  useEffect(() => {
    const element = leading.current; if (!element) { setLeadWidth(0); return; }
    const observer = new ResizeObserver(() => setLeadWidth(Math.ceil(element.offsetWidth)));
    observer.observe(element); return () => observer.disconnect();
  }, [Boolean(lead)]);
  useEffect(() => {
    if (!document || !frame.current || !hostBar.current) return;
    const root = document.documentElement, bar = document.querySelector<HTMLElement>('.bar');
    const phone = window.matchMedia('(max-width: 520px)');
    const sync = () => {
      root.toggleAttribute('data-papilot-phone', phone.matches);
      root.style.setProperty('--papilot-tools', `${reserve}px`);
      root.style.setProperty('--papilot-lead', `${leadWidth}px`);
      root.style.setProperty('--papilot-bar-height', `${hostBar.current!.offsetHeight}px`);
      root.toggleAttribute('data-papilot-toolbar-stacked', frame.current!.clientWidth - reserve - leadWidth < 220);
      const button = toolbar.current?.querySelector<HTMLElement>('.icon-button');
      if (button) root.style.setProperty('--papilot-button-size', `${button.offsetWidth}px`);
      if (bar) root.style.setProperty('--papilot-review-bar-height', `${bar.offsetHeight}px`);
    };
    const observer = new ResizeObserver(sync);
    observer.observe(frame.current); observer.observe(hostBar.current);
    if (bar) observer.observe(bar);
    phone.addEventListener('change', sync); sync();
    return () => { observer.disconnect(); phone.removeEventListener('change', sync); };
  }, [reserve, leadWidth, document]);
  function loaded() {
    observer.current?.disconnect();
    try {
      const doc = frame.current?.contentDocument;
      if (!doc || (!doc.getElementById('root') && !doc.getElementById('paper'))) { setPhase('error'); return; }
      compactReviewFrame(doc, reserve, leadWidth, Boolean(changesOf));
      setDocument(doc);
      frame.current?.contentWindow?.addEventListener('latex-review:decided', () => { decided.current?.(); linksRef.current?.reload(); });
      // The viewer scrolls only its paper. Revealing or focusing something can
      // scroll its document or #root too, overflow hidden or not, which slides
      // the viewer's bar out from under our tools and the paper in; put them back.
      const root = doc.getElementById('root');
      doc.addEventListener('scroll', event => {
        const scrolled = event.target === doc ? doc.scrollingElement : event.target === root ? root : null;
        if (scrolled && (scrolled.scrollTop || scrolled.scrollLeft)) scrolled.scrollTo(0, 0);
      }, true);
      // Strips render after the viewer starts; re-measure the text edges when they change.
      let pending: ReturnType<typeof setTimeout> | undefined;
      cropper.current?.disconnect();
      cropper.current = new MutationObserver(() => { clearTimeout(pending); pending = setTimeout(() => cropMargins(doc), 150); });
      cropper.current.observe(doc.body, { childList: true, subtree: true });
      const inspect = () => {
        const paper = doc.getElementById('paper');
        if (!paper) return;
        if (paper.querySelector('[role="alert"]')) { setPhase('error'); return; }
        if (changesOf || !paper.querySelector('.waiting')) { setPhase('ready'); observer.current?.disconnect(); cropMargins(doc); }
      };
      observer.current = new MutationObserver(inspect);
      observer.current.observe(doc.body, { childList: true, subtree: true });
      inspect();
    } catch { setPhase('error'); }
  }
  useEffect(() => {
    if (!document) return;
    const root = window.document.documentElement;
    const sync = () => { document.documentElement.dataset.theme = root.dataset.theme; };
    sync();
    const themeObserver = new MutationObserver(sync);
    themeObserver.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    return () => themeObserver.disconnect();
  }, [document]);
  // The viewer's cards for writing stay above the keyboard. The workspace fits
  // itself above the keyboard, but not while the page is zoomed; the cards
  // then shorten by the part of the viewer the keyboard covers.
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!document || !viewport) return;
    const sync = () => {
      const box = frame.current?.getBoundingClientRect(); if (!box) return;
      document.documentElement.style.setProperty('--keyboard', `${Math.max(0, Math.round(box.bottom - viewport.offsetTop - viewport.height))}px`);
    };
    sync(); viewport.addEventListener('resize', sync); viewport.addEventListener('scroll', sync); window.addEventListener('resize', sync);
    return () => { viewport.removeEventListener('resize', sync); viewport.removeEventListener('scroll', sync); window.removeEventListener('resize', sync); };
  }, [document]);
  const ready = phase === 'ready';
  const [slot, setSlot] = useState<Element | null>(null);
  useEffect(() => {
    if (!document || !ready) { setSlot(null); return; }
    const find = () => setSlot(document.querySelector('.review-complete-actions'));
    find();
    const watch = new MutationObserver(find);
    watch.observe(document.body, { childList: true, subtree: true });
    return () => watch.disconnect();
  }, [document, ready]);
  return <div className={'review-viewport' + (ready ? '' : ' review-pending')} aria-busy={!ready}>
    <iframe ref={frame} key={`${attempt}:${shown}:${linkedRound || ''}:${focusSequence || ''}`} title={task ? t('{title} PDF change review', { title: task.title }) : t('Uncommitted changes in the PDF')} src={task ? reviewUrl(task, linkedRound, linkedChange) : changesUrl(changesOf!)} onLoad={loaded} onError={() => setPhase('error')} className="review-frame" aria-hidden={!ready} tabIndex={ready ? 0 : -1}/>
    {task && ready && <ReviewNoteConnections doc={document} round={linkedRound || task.review?.round || 0}/>}
    <div ref={hostBar} className="review-host-bar">
      {lead && <div ref={leading} className="review-lead">{lead}</div>}
      <div ref={toolbar} className="review-tools">{task && onSendNotes && <ReviewNotes doc={ready ? document : null} task={task} onSend={onSendNotes}/>}{tools}</div>
    </div>
    {slot && completion ? createPortal(completion, slot) : null}
    {!ready && <div className="review-loading"><p role={phase === 'error' ? 'alert' : 'status'}>{phase === 'error' ? t('The PDF review could not be loaded.') : phase === 'slow' ? t('The PDF review is taking longer than expected.') : t('Loading PDF review…')}</p>{phase !== 'loading' && <button className="button secondary" onClick={() => { setPhase('loading'); setAttempt(value => value + 1); }}>{t('Reload review')}</button>}</div>}
  </div>;
}
