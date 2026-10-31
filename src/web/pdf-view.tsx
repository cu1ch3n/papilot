import type { NoteGroup } from '../note-groups.ts';
import { GroupPicker, GroupAction, groupName, groupStyle } from './note-groups.tsx';
import { forwardRef, Fragment, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { EventBus, FindState, LinkTarget, PDFFindController, PDFLinkService, PDFViewer } from 'pdfjs-dist/web/pdf_viewer.mjs';
import viewerStyles from 'pdfjs-dist/web/pdf_viewer.css?inline';
import worker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { Annotation } from '../shared.ts';
import { ChipSelect } from './chip-select.tsx';
import { sendsMessage } from './composer.ts';
import { Icon } from './icons.tsx';
import { browserStorage } from './storage.ts';
import { mergeLines } from './note-geometry.ts';
import { touchSelection } from './touch-select.ts';
import { t } from './i18n.ts';

pdfjs.GlobalWorkerOptions.workerSrc = worker;

// The pdf.js stylesheet also styles pdf.js's own app (.sidebar, .dialog) and
// sets a dark color scheme on :root; keep all of it inside the viewer.
const styles = document.createElement('style');
styles.textContent = `@scope (.pdf-view) {${viewerStyles.replaceAll(':root', ':scope').replace(/color-scheme:\s*light dark;?/g, '')}}`;
document.head.append(styles);

export type Rect = [number, number, number, number];
export interface OutlineItem { title: string; level: number; dest: unknown; page: number; top: number | null }
export interface PdfHandle { goTo: (item: OutlineItem) => void; goToNote: (note: Annotation) => void; showPlace: (page: number, rect: Rect) => void; focus: () => void; fitWidth: () => void }
// A touch selection also has its ends: the edge of its first and last word, with that line's top and bottom.
interface Selection { page: number; rects: Rect[]; quote: string; handles?: { from: [number, number, number]; to: [number, number, number] } }

const touch = () => window.matchMedia('(pointer: coarse)').matches;
const unit = (value: number) => Math.min(1, Math.max(0, value));
const percent = ([x0, y0, x1, y1]: Rect): React.CSSProperties => ({ left: `${x0 * 100}%`, top: `${y0 * 100}%`, width: `${(x1 - x0) * 100}%`, height: `${(y1 - y0) * 100}%` });
const bounds = (rects: Rect[]): Rect => [Math.min(...rects.map(r => r[0])), Math.min(...rects.map(r => r[1])), Math.max(...rects.map(r => r[2])), Math.max(...rects.map(r => r[3]))];
const zooms = () => [{ value: 'page-width', label: t('Fit width') }, { value: 'page-fit', label: t('Fit page') }, ...[0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4].map(scale => ({ value: String(scale), label: `${scale * 100}%` }))];

// A note covers whole words: a drag that starts or ends inside a word takes
// all of it, so the quote is readable and the highlight matches it. Only a
// boundary that cuts through a word widens; one already beside a word (the
// browser often ends a drag at the start of the next word) stays. Returns the
// widened range and the word pieces it added at each end.
function wholeWords(selected: Range) {
  const range = selected.cloneRange(), letter = /[\p{L}\p{N}]/u, start = range.startContainer, end = range.endContainer;
  let before = '', after = '';
  if (start.nodeType === Node.TEXT_NODE) {
    const text = start.textContent || ''; let at = range.startOffset;
    if (letter.test(text[at] || '')) while (at > 0 && letter.test(text[at - 1])) at--;
    before = text.slice(at, range.startOffset); range.setStart(start, at);
  }
  if (end.nodeType === Node.TEXT_NODE) {
    const text = end.textContent || ''; let at = range.endOffset;
    if (at > 0 && letter.test(text[at - 1])) while (at < text.length && letter.test(text[at])) at++;
    after = text.slice(range.endOffset, at); range.setEnd(end, at);
  }
  return { range, before, after };
}

// pdf.js lays each line of text out as one run in a stand-in font, which
// drifts from the printed words mid-line, so a drag selects other words than
// the ones under the pointer. The server reads each word's printed place from
// the PDF; selection and search use one run per word from it, placed on the
// word's baseline, and fall back to pdf.js's own text if that is unavailable.
type Words = { words: [string, number, number, number, number, number][] };
function exactText(document: PDFDocumentProxy, source: string) {
  const getPage = document.getPage.bind(document), pages = new Map<number, Promise<PDFPageProxy>>();
  document.getPage = (number: number) => {
    if (!pages.has(number)) pages.set(number, getPage(number).then(page => {
      if (page.rotate % 360 !== 0) return page;
      const own = page.getTextContent.bind(page);
      let exact: Promise<ReturnType<typeof textContent> | null> | null = null;
      const content = () => exact ??= fetch(`${source}&page=${number - 1}`).then(response => response.ok ? response.json() : null).then((data: Words | null) => data ? textContent(data, page.view) : null, () => null);
      page.getTextContent = (async (params?: Parameters<PDFPageProxy['getTextContent']>[0]) => (await content()) || own(params)) as PDFPageProxy['getTextContent'];
      page.streamTextContent = ((params?: Parameters<PDFPageProxy['getTextContent']>[0]) => new ReadableStream({ async start(controller) { controller.enqueue((await content()) || await own(params)); controller.close(); } })) as PDFPageProxy['streamTextContent'];
      return page;
    }));
    return pages.get(number)!;
  };
}
// A word followed by another on its line carries the space and reaches the
// next word's start, so a drag can begin in the gap between words.
function textContent({ words }: Words, view: number[]) {
  const items = words.map(([str, left, baseline, size, width, eol], index) => {
    const next = words[index + 1], joined = !eol && next && next[1] > left;
    return { str: joined ? str + ' ' : str, dir: 'ltr', width: joined ? next[1] - left : width, height: size, transform: [size, 0, 0, size, view[0] + left, view[3] - baseline], fontName: 'exact', hasEOL: Boolean(eol) };
  });
  return { items, styles: { exact: { fontFamily: 'serif', ascent: 0.8, descent: -0.2, vertical: false } }, lang: null };
}

// Number tags sit in the page margin level with the first marked line, on the
// side nearer the mark, so they never cover text; tags on one line step outwards.
function tagSpots(firsts: Rect[]) {
  const placed: { side: 'left' | 'right'; top: number }[] = [];
  return firsts.map(rect => {
    const side: 'left' | 'right' = (rect[0] + rect[2]) / 2 > 0.5 ? 'right' : 'left', top = (rect[1] + rect[3]) / 2;
    const slot = placed.filter(spot => spot.side === side && Math.abs(spot.top - top) < 0.015).length;
    placed.push({ side, top });
    return { [side]: 8 + slot * 24, top: `${top * 100}%` } as React.CSSProperties;
  });
}

// PDF bookmarks (hyperref writes them) with the page and height each one opens.
async function readOutline(document: PDFDocumentProxy) {
  const items: OutlineItem[] = [];
  async function walk(nodes: Awaited<ReturnType<PDFDocumentProxy['getOutline']>> | undefined, level: number) {
    for (const node of nodes || []) {
      const dest = typeof node.dest === 'string' ? await document.getDestination(node.dest).catch(() => null) : node.dest;
      let page = 0, top: number | null = null;
      if (Array.isArray(dest) && dest[0] !== undefined && dest[0] !== null) {
        page = typeof dest[0] === 'number' ? dest[0] + 1 : await document.getPageIndex(dest[0]).then(index => index + 1, () => 0);
        const kind = (dest[1] as { name?: string } | undefined)?.name;
        top = kind === 'XYZ' && typeof dest[3] === 'number' ? dest[3] : (kind === 'FitH' || kind === 'FitBH') && typeof dest[2] === 'number' ? dest[2] : null;
      }
      if (page) items.push({ title: node.title.trim(), level, dest: node.dest, page, top });
      await walk(node.items, level + 1);
    }
  }
  await walk(await document.getOutline(), 0);
  return items;
}

export function NoteEditor({ rect, onSave, onCancel }: { rect: Rect; onSave: (comment: string) => Promise<void>; onCancel: () => void }) {
  const [text, setText] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function save() {
    if (!text.trim() || busy) return;
    setBusy(true); setError('');
    try { await onSave(text.trim()); } catch (e) { setError(e instanceof Error ? e.message : String(e)); setBusy(false); }
  }
  // Open below the marked text, or above it when it ends near the bottom of the page.
  const below = rect[3] < 0.75;
  return <form className="note-editor" style={{ left: `min(${rect[0] * 100}%, calc(100% - min(340px, 100%)))`, ...(below ? { top: `calc(${rect[3] * 100}% + 8px)` } : { bottom: `calc(${(1 - rect[1]) * 100}% + 8px)` }) }} onPointerDown={e => e.stopPropagation()} onSubmit={e => { e.preventDefault(); void save(); }}>
    <textarea autoFocus aria-label={t('Note for the agent')} placeholder={t('What should change here?')} rows={3} value={text} readOnly={busy} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel(); } else if (sendsMessage(e.nativeEvent, touch())) { e.preventDefault(); void save(); } }}/>
    {error && <p className="inline-error" role="alert">{error}</p>}
    <div className="button-row"><button type="button" className="button secondary compact" disabled={busy} onClick={onCancel}>{t('Cancel')}</button><button className="button primary compact" disabled={busy || !text.trim()}>{busy ? t('Adding…') : t('Add note')}</button></div>
  </form>;
}

// A pdf.js viewer that behaves like a local PDF reader: continuous pages,
// crisp zoom, selectable text, search, links and bookmarks. Notes live in a
// layer above each page; pdf.js clears unknown children when it redraws a
// page, so each layer is re-attached after rendering.
export const PdfView = forwardRef<PdfHandle, {
  group?: NoteGroup | null; onGroupChange?: (group: NoteGroup | null) => void; markingDisabled?: boolean;
  url: string; words?: string; notes: { note: Annotation; number: number }[]; active: string; region: boolean; setRegion: (on: boolean) => void;
  onCreate: (page: number, rect: Rect, rects: Rect[], quote: string, comment: string, group?: NoteGroup) => Promise<void>;
  onSelect: (note: Annotation) => void; outline: OutlineItem[]; section: number;
  onOutline: (items: OutlineItem[]) => void; onSection: (index: number) => void;
  lead?: ReactNode;
  tools?: ReactNode;
}>(function PdfView(props, ref) {
  const latest = useRef(props); latest.current = props;
  const container = useRef<HTMLDivElement>(null), inner = useRef<HTMLDivElement>(null), findInput = useRef<HTMLInputElement>(null);
  const tools = useRef<{ bus: EventBus; links: PDFLinkService; find: PDFFindController; viewer: PDFViewer } | null>(null);
  const loaded = useRef<PDFDocumentProxy | null>(null), restore = useRef<{ scale: string; top: number; left: number } | null>(null);
  const layerMap = useRef(new Map<number, HTMLElement>());
  const [layers, setLayers] = useState(new Map<number, HTMLElement>());
  const [pages, setPages] = useState(0), [page, setPage] = useState(1), [pageInput, setPageInput] = useState('1');
  const [zoom, setZoom] = useState({ value: 'page-width', scale: 1 });
  const [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [findOpen, setFindOpen] = useState(false), [query, setQuery] = useState(''), [matches, setMatches] = useState({ current: 0, total: 0 }), [notFound, setNotFound] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  // A place shown from elsewhere, such as a compilation problem, marked briefly.
  const [flash, setFlash] = useState<{ page: number; rect: Rect; id: number } | null>(null);
  const [editing, setEditing] = useState<{ page: number; rect: Rect; rects: Rect[]; quote: string } | null>(null), editingRef = useRef(editing); editingRef.current = editing;
  const picking = useRef<ReturnType<typeof touchSelection> | null>(null);
  const [draft, updateDraft] = useState<{ page: number; rect: Rect } | null>(null), draftRef = useRef(draft);
  const setDraft = (value: typeof draft) => { draftRef.current = value; updateDraft(value); };
  const origin = useRef<{ page: number; x: number; y: number; box: DOMRect } | null>(null);

  useImperativeHandle(ref, () => ({
    focus() { container.current?.focus({ preventScroll: true }); },
    fitWidth() { const viewer = tools.current?.viewer; if (viewer && viewer.currentScaleValue !== 'page-width') viewer.currentScaleValue = 'page-width'; },
    goTo(item) { latest.current.onSection(latest.current.outline.indexOf(item)); void tools.current?.links.goToDestination(item.dest as string | unknown[]); },
    goToNote(note) {
      const div = tools.current?.viewer.getPageView(note.page)?.div, box = container.current;
      if (!div || !box) return;
      box.scrollTo({ top: box.scrollTop + div.getBoundingClientRect().top - box.getBoundingClientRect().top + note.rect[1] * div.offsetHeight - 96, behavior: 'smooth' });
    },
    showPlace(page, rect) {
      const div = tools.current?.viewer.getPageView(page)?.div, box = container.current;
      if (!div || !box) return;
      const pageBox = div.getBoundingClientRect(), view = box.getBoundingClientRect();
      const top = box.scrollTop + pageBox.top - view.top + rect[1] * div.offsetHeight - box.clientHeight / 3;
      const middle = box.scrollLeft + pageBox.left - view.left + (rect[0] + rect[2]) / 2 * div.offsetWidth - box.clientWidth / 2;
      // A far jump lands at once, so the mark is still showing on arrival.
      box.scrollTo({ top, left: box.scrollWidth > box.clientWidth ? middle : box.scrollLeft, behavior: Math.abs(top - box.scrollTop) > box.clientHeight * 2 ? 'instant' : 'smooth' });
      setFlash({ page, rect, id: Date.now() });
    },
  }), []);
  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => setFlash(current => current?.id === flash.id ? null : current), 2400);
    return () => clearTimeout(timer);
  }, [flash]);

  useEffect(() => {
    const box = container.current!, bus = new EventBus();
    const links = new PDFLinkService({ eventBus: bus, externalLinkTarget: LinkTarget.BLANK, externalLinkRel: 'noopener noreferrer' });
    const find = new PDFFindController({ eventBus: bus, linkService: links });
    const viewer = new PDFViewer({ container: box, viewer: inner.current!, eventBus: bus, linkService: links, findController: find, removePageBorders: true, annotationMode: pdfjs.AnnotationMode.ENABLE });
    links.setViewer(viewer);
    tools.current = { bus, links, find, viewer };
    const attach = ({ pageNumber, source }: { pageNumber: number; source?: { div?: HTMLElement } }) => {
      const div = source?.div ?? viewer.getPageView(pageNumber - 1)?.div;
      if (!div) return;
      let layer = layerMap.current.get(pageNumber);
      if (!layer) { layer = document.createElement('div'); layer.className = 'note-layer'; layerMap.current.set(pageNumber, layer); setLayers(new Map(layerMap.current)); }
      if (layer.parentElement !== div) div.append(layer);
    };
    bus.on('pagerendered', attach); bus.on('textlayerrendered', attach); bus.on('annotationlayerrendered', attach);
    bus.on('pagesinit', () => {
      const keep = restore.current; restore.current = null;
      viewer.currentScaleValue = keep?.scale || browserStorage.getItem('papilot:pdf-zoom') || 'page-width';
      if (keep) { box.scrollTop = keep.top; box.scrollLeft = keep.left; }
    });
    bus.on('pagechanging', ({ pageNumber }: { pageNumber: number }) => { setPage(pageNumber); setPageInput(String(pageNumber)); });
    bus.on('scalechanging', ({ scale, presetValue }: { scale: number; presetValue?: string }) => {
      setZoom({ value: presetValue || String(scale), scale });
      if (presetValue) browserStorage.setItem('papilot:pdf-zoom', presetValue); else browserStorage.setItem('papilot:pdf-zoom', String(Math.round(scale * 100) / 100));
    });
    // Resizing a panel does not resize the window. Reapply fit presets to the
    // viewer's actual bounds, while preserving an explicitly chosen percentage.
    let resizeFrame = 0;
    const resize = new ResizeObserver(() => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        if (!viewer.pagesCount || !box.clientWidth || !box.clientHeight) return;
        const scale = viewer.currentScaleValue;
        if (scale === 'page-width' || scale === 'page-fit' || scale === 'page-height' || scale === 'auto') viewer.currentScaleValue = scale;
        viewer.update();
      });
    });
    resize.observe(box);
    // The current section is the last bookmark above a line 40% down the view
    // (PDF units grow upwards); at the end of the document it is the last one.
    bus.on('updateviewarea', ({ location }: { location?: { pageNumber: number; top: number; scale: number } }) => {
      if (!location) return;
      const items = latest.current.outline, reading = location.top - box.clientHeight * 0.4 / (viewer.currentScale * 96 / 72);
      let current = -1;
      items.forEach((item, index) => { if (item.page < location.pageNumber || (item.page === location.pageNumber && (item.top === null || item.top >= reading))) current = index; });
      if (box.scrollTop + box.clientHeight >= box.scrollHeight - 2 && items.length) current = items.length - 1;
      if (current !== latest.current.section) latest.current.onSection(current);
    });
    bus.on('updatefindmatchescount', ({ matchesCount }: { matchesCount: { current: number; total: number } }) => setMatches(matchesCount));
    bus.on('updatefindcontrolstate', ({ state, matchesCount }: { state: number; matchesCount?: { current: number; total: number } }) => { setNotFound(state === FindState.NOT_FOUND); if (matchesCount) setMatches(matchesCount); });
    // Trackpad pinches arrive as ctrl+wheel; touch pinches are handled here so
    // the page zooms instead of the whole workspace.
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault(); viewer.updateScale({ drawingDelay: 250, scaleFactor: Math.exp(-e.deltaY / 100), origin: [e.clientX, e.clientY] });
    };
    let pinch: number | null = null;
    const spread = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const touchStart = (e: TouchEvent) => { if (e.touches.length === 2) pinch = spread(e.touches); };
    const touchMove = (e: TouchEvent) => {
      if (pinch === null || e.touches.length !== 2) return;
      e.preventDefault();
      const distance = spread(e.touches);
      viewer.updateScale({ drawingDelay: 250, scaleFactor: distance / pinch, origin: [(e.touches[0].clientX + e.touches[1].clientX) / 2, (e.touches[0].clientY + e.touches[1].clientY) / 2] });
      pinch = distance;
    };
    const touchEnd = (e: TouchEvent) => { if (e.touches.length < 2) pinch = null; };
    box.addEventListener('wheel', wheel, { passive: false });
    box.addEventListener('touchstart', touchStart, { passive: true });
    box.addEventListener('touchmove', touchMove, { passive: false });
    box.addEventListener('touchend', touchEnd);
    // A text selection on one page offers "Add note" beside it.
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const select = () => {
      if (picking.current?.active()) return;
      const current = document.getSelection();
      if (!current || current.isCollapsed || !current.rangeCount) { setSelection(null); return; }
      const { range, before, after } = wholeWords(current.getRangeAt(0)), node = range.startContainer, element = node instanceof Element ? node : node.parentElement;
      const pageDiv = element?.closest<HTMLElement>('.page');
      if (!pageDiv || !box.contains(pageDiv)) { setSelection(null); return; }
      const frame = pageDiv.getBoundingClientRect();
      const rects = mergeLines(Array.from(range.getClientRects()).filter(r => r.width > 1 && r.height > 1 && r.top >= frame.top - 1 && r.bottom <= frame.bottom + 1)
        .map(r => [unit((r.left - frame.left) / frame.width), unit((r.top - frame.top) / frame.height), unit((r.right - frame.left) / frame.width), unit((r.bottom - frame.top) / frame.height)] as Rect));
      // The selection's own text keeps pdf.js's line breaks as spaces.
      const quote = (before + current.toString() + after).replace(/\s+/g, ' ').trim();
      const value = rects.length && quote ? { page: Number(pageDiv.dataset.pageNumber) - 1, rects, quote } : null;
      setSelection(value); return value;
    };
    const selectionChange = () => { clearTimeout(timer); timer = setTimeout(select, 120); };
    document.addEventListener('selectionchange', selectionChange);
    const finishGroup = (event: PointerEvent) => {
      if (!latest.current.group || latest.current.markingDisabled || editingRef.current || latest.current.region || event.pointerType === 'touch' || !box.contains(event.target as Node) || (event.target as Element).closest('button,input,select')) return;
      setTimeout(() => { if (disposed) return; const value = select(); if (value && latest.current.group) addToGroup(value); }, 0);
    };
    document.addEventListener('pointerup', finishGroup);
    // Keep marks transparent to pointer events so dragging still selects the
    // underlying text. A click/tap on a mark selects its note after the native
    // selection gesture has finished; drags, scrolling and long presses do not.
    const noteAt = (event: MouseEvent) => {
      if (latest.current.region || editingRef.current) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('button,a,input,textarea,select,[contenteditable],.select-handle,.note-editor')) return;
      const page = target?.closest<HTMLElement>('.page');
      if (!page || !box.contains(page)) return;
      const frame = page.getBoundingClientRect(), x = (event.clientX - frame.left) / frame.width, y = (event.clientY - frame.top) / frame.height;
      let hit: Annotation | undefined, area = Infinity;
      for (const { note } of latest.current.notes) {
        if (note.page !== Number(page.dataset.pageNumber) - 1) continue;
        for (const [left, top, right, bottom] of note.rects?.length ? note.rects : [note.rect]) {
          // Prefer the more specific mark when text and a larger region overlap.
          const size = (right - left) * (bottom - top);
          if (x >= left && x <= right && y >= top && y <= bottom && size <= area) { hit = note; area = size; }
        }
      }
      return hit;
    };
    let press: { id: string; x: number; y: number; time: number; touch: boolean } | null = null;
    const cancelPress = () => { press = null; };
    const pressNote = (event: PointerEvent) => {
      press = null;
      if (!event.isPrimary || event.button !== 0) return;
      const note = noteAt(event);
      if (note) press = { id: note.id, x: event.clientX, y: event.clientY, time: event.timeStamp, touch: event.pointerType !== 'mouse' };
    };
    const moveNote = (event: PointerEvent) => {
      if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > (press.touch ? 10 : 4)) cancelPress();
    };
    const releaseNote = (event: PointerEvent) => {
      const start = press; press = null;
      if (!start || event.defaultPrevented || event.button !== 0 || (start.touch && event.timeStamp - start.time >= 450)
        || document.getSelection()?.isCollapsed === false) return;
      const note = noteAt(event);
      if (note?.id !== start.id) return;
      // pdf.js can remove its blank-page hit target on mouseup, suppressing
      // click entirely. Touch taps first let touchend clear any old handles.
      if (start.touch) setTimeout(() => { if (!disposed && !picking.current?.active()) latest.current.onSelect(note); }, 0);
      else latest.current.onSelect(note);
    };
    box.addEventListener('pointerdown', pressNote); box.addEventListener('scroll', cancelPress);
    document.addEventListener('pointermove', moveNote); document.addEventListener('pointerup', releaseNote); document.addEventListener('pointercancel', cancelPress);
    // Touch screens select words with Papilot's own handles and menu (style.css
    // turns native selection off there). Each text run is one word.
    picking.current = touchSelection<HTMLElement>(box, {
      target: element => element.closest('.textLayer')?.closest<HTMLElement>('.page') ?? undefined,
      units: page => ({ units: Array.from(page.querySelectorAll<HTMLElement>('.textLayer span')).filter(span => !span.firstElementChild), line: (_, index) => index }),
      blocked: () => latest.current.region || Boolean(editingRef.current),
      menu: '.add-note',
      onSelect: ({ target: pageDiv, units, from, to }) => {
        const frame = pageDiv.getBoundingClientRect(), range = document.createRange(), last = units[to].firstChild;
        // A word followed by another carries the space; the selection stops before it.
        range.setStart(units[from], 0);
        if (last?.nodeType === Node.TEXT_NODE) range.setEnd(last, (last.textContent || '').trimEnd().length); else range.setEnd(units[to], units[to].childNodes.length);
        const rects = mergeLines(Array.from(range.getClientRects()).filter(r => r.width > 1 && r.height > 1)
          .map(r => [unit((r.left - frame.left) / frame.width), unit((r.top - frame.top) / frame.height), unit((r.right - frame.left) / frame.width), unit((r.bottom - frame.top) / frame.height)] as Rect));
        // Words that end a line carry no space, so the runs are joined with one.
        const quote = units.slice(from, to + 1).map(span => span.textContent).join(' ').replace(/\s+/g, ' ').trim();
        if (!rects.length || !quote) return;
        const [first, end] = [rects[0], rects[rects.length - 1]];
        setSelection({ page: Number(pageDiv.dataset.pageNumber) - 1, rects, quote, handles: { from: [first[0], first[1], first[3]], to: [end[2], end[1], end[3]] } });
      },
      onClear: () => setSelection(null),
    });
    return () => {
      disposed = true; clearTimeout(timer); picking.current?.stop(); picking.current = null;
      resize.disconnect(); cancelAnimationFrame(resizeFrame);
      document.removeEventListener('selectionchange', selectionChange); document.removeEventListener('pointerup', finishGroup);
      box.removeEventListener('pointerdown', pressNote); box.removeEventListener('scroll', cancelPress);
      document.removeEventListener('pointermove', moveNote); document.removeEventListener('pointerup', releaseNote); document.removeEventListener('pointercancel', cancelPress);
      box.removeEventListener('wheel', wheel); box.removeEventListener('touchstart', touchStart); box.removeEventListener('touchmove', touchMove); box.removeEventListener('touchend', touchEnd);
      viewer.cleanup(); void loaded.current?.loadingTask.destroy(); loaded.current = null; tools.current = null; layerMap.current.clear();
    };
  }, []);

  // A recompiled manuscript opens at the same place and zoom.
  useEffect(() => {
    const current = tools.current!, box = container.current!;
    let cancelled = false, settled = false;
    if (loaded.current) restore.current = { scale: current.viewer.currentScaleValue, top: box.scrollTop, left: box.scrollLeft };
    setLoading(!loaded.current); setError('');
    const task = pdfjs.getDocument({ url: props.url, enableXfa: false });
    task.promise.then(async document => {
      settled = true;
      if (cancelled) { void document.loadingTask.destroy(); return; }
      const previous = loaded.current;
      loaded.current = document; layerMap.current.clear(); setLayers(new Map()); setSelection(null); setEditing(null);
      if (latest.current.words) exactText(document, latest.current.words);
      current.viewer.setDocument(document); current.links.setDocument(document, null);
      setPages(document.numPages); setLoading(false);
      void previous?.loadingTask.destroy();
      const items = await readOutline(document).catch(() => []);
      if (!cancelled) latest.current.onOutline(items);
    }, failure => { settled = true; if (!cancelled) { setError(failure instanceof Error ? failure.message : String(failure)); setLoading(false); } });
    return () => { cancelled = true; if (!settled) void task.destroy(); };
  }, [props.url]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const viewer = tools.current?.viewer, mod = e.metaKey || e.ctrlKey;
      if (!viewer || e.defaultPrevented) return;
      if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); if (findInput.current) findInput.current.select(); else setFindOpen(true); }
      else if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); viewer.increaseScale(); }
      else if (mod && e.key === '-') { e.preventDefault(); viewer.decreaseScale(); }
      else if (mod && e.key === '0') { e.preventDefault(); viewer.currentScaleValue = 'page-width'; }
      else if (e.key === 'Escape' && latest.current.region) latest.current.setRegion(false);
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, []);

  useEffect(() => {
    const finish = (event: KeyboardEvent) => { if (event.key === 'Escape' && latest.current.group) latest.current.onGroupChange?.(null); };
    document.addEventListener('keydown', finish); return () => document.removeEventListener('keydown', finish);
  }, []);

  function search(again: boolean, previous = false, text = query) {
    tools.current?.bus.dispatch('find', { source: null, type: again ? 'again' : '', query: text, caseSensitive: false, entireWord: false, highlightAll: true, findPrevious: previous, matchDiacritics: false });
  }
  function closeFind() { setFindOpen(false); setQuery(''); setMatches({ current: 0, total: 0 }); setNotFound(false); tools.current?.bus.dispatch('findbarclose', { source: null }); }
  function goToPage() {
    const viewer = tools.current?.viewer, number = Number.parseInt(pageInput, 10);
    if (viewer && number >= 1 && number <= pages) viewer.currentPageNumber = number; else setPageInput(String(page));
  }
  function addToGroup(value: Selection, rect = bounds(value.rects)) {
    const group = latest.current.group;
    if (!group || latest.current.markingDisabled) return;
    const create = latest.current.onCreate;
    document.getSelection()?.removeAllRanges(); picking.current?.reset(); setSelection(null);
    void create(value.page, rect, value.rects, value.quote, '', group).catch(error => setError(error instanceof Error ? error.message : String(error)));
  }
  function startNote() {
    if (!selection) return;
    if (props.group) { addToGroup(selection); return; }
    setEditing({ page: selection.page, rect: bounds(selection.rects), rects: selection.rects, quote: selection.quote });
    document.getSelection()?.removeAllRanges(); picking.current?.reset(); setSelection(null);
  }
  async function save(comment: string) {
    if (!editing) return;
    await latest.current.onCreate(editing.page, editing.rect, editing.rects, editing.quote, comment);
    setEditing(null); latest.current.setRegion(false);
  }
  const section = props.outline[props.section];
  const presets = zooms(), zoomLabel = presets.find(option => option.value === zoom.value) ? zoom.value : String(Math.round(zoom.scale * 100) / 100);
  const zoomOptions = presets.some(option => option.value === zoomLabel) ? presets : [...presets, { value: zoomLabel, label: `${Math.round(zoom.scale * 100)}%` }];

  return <div className={'pdf-view' + (props.region ? ' marking' : '')}>
    <div className="pdf-toolbar" role="toolbar" aria-label={t('PDF controls')}>
      {props.lead}
      <div className="pdf-section" title={section?.title}>{section?.title && <span className="pdf-section-title">{section.title}</span>}</div>
      <div className="pdf-pager">
        <button type="button" className="icon-button" aria-label={t('Previous page')} disabled={page <= 1} onClick={() => tools.current?.viewer.previousPage()}><Icon name="chevronUp" size={16}/></button>
        <input aria-label={t('Page number')} inputMode="numeric" value={pageInput} onChange={e => setPageInput(e.target.value.replace(/\D/g, ''))} onFocus={e => e.currentTarget.select()} onBlur={() => setPageInput(String(page))} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); goToPage(); e.currentTarget.blur(); } }}/>
        <span className="pdf-pages">/ {pages || '–'}</span>
        <button type="button" className="icon-button" aria-label={t('Next page')} disabled={page >= pages} onClick={() => tools.current?.viewer.nextPage()}><Icon name="chevronDown" size={16}/></button>
      </div>
      <div className="pdf-zoom">
        <button type="button" className="icon-button" aria-label={t('Zoom out')} title={t('Zoom out (⌘−)')} onClick={() => tools.current?.viewer.decreaseScale()}><Icon name="minus" size={16}/></button>
        <ChipSelect className="zoom-chip" label={t('Zoom')} value={zoomLabel} options={zoomOptions} onChange={value => { if (tools.current) tools.current.viewer.currentScaleValue = value; }}/>
        <button type="button" className="icon-button" aria-label={t('Zoom in')} title={t('Zoom in (⌘+)')} onClick={() => tools.current?.viewer.increaseScale()}><Icon name="plus" size={16}/></button>
      </div>
      <button type="button" className={'icon-button' + (findOpen ? ' active' : '')} aria-label={t('Find in PDF')} aria-pressed={findOpen} title={t('Find (⌘F)')} onClick={() => { if (findOpen) closeFind(); else setFindOpen(true); }}><Icon name="search" size={16}/></button>
      <button type="button" className={'icon-button region-toggle' + (props.region ? ' active' : '')} aria-label={t('Mark region')} aria-pressed={props.region} title={t('Mark a figure or region')} onClick={() => props.setRegion(!props.region)}><Icon name="region" size={16}/></button>
      {props.onGroupChange && <GroupPicker value={props.group || null} onChange={props.onGroupChange} disabled={props.markingDisabled || Boolean(editing)}/>}
      {props.tools}
    </div>
    {findOpen && <div className="pdf-find">
      <Icon name="search" size={15}/>
      <input ref={findInput} autoFocus aria-label={t('Search the PDF')} placeholder={t('Find in PDF')} value={query} onChange={e => { setQuery(e.target.value); search(false, false, e.target.value); }} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); search(true, e.shiftKey); } else if (e.key === 'Escape') { e.preventDefault(); closeFind(); } }}/>
      <span className="pdf-find-count" aria-live="polite">{query ? notFound ? t('No matches') : matches.total ? t('{current} of {total}', { current: matches.current, total: matches.total }) : '' : ''}</span>
      <button type="button" className="icon-button" aria-label={t('Previous match')} disabled={!matches.total} onClick={() => search(true, true)}><Icon name="chevronUp" size={16}/></button>
      <button type="button" className="icon-button" aria-label={t('Next match')} disabled={!matches.total} onClick={() => search(true)}><Icon name="chevronDown" size={16}/></button>
      <button type="button" className="icon-button" aria-label={t('Close search')} onClick={closeFind}><Icon name="close" size={15}/></button>
    </div>}
    <div className="pdf-scroll-host">
      <div ref={container} className="pdf-container" tabIndex={0} aria-label={t('PDF pages')}>
        <div ref={inner} className="pdfViewer"/>
      </div>
      {(loading || error) && <div className="review-loading"><p role={error ? 'alert' : 'status'}>{error ? t('The PDF could not be opened: {error}', { error }) : t('Opening the PDF…')}</p></div>}
    </div>
    {[...layers].map(([number, layer]) => createPortal(<Fragment>
      {(() => {
        const notes = props.notes.filter(({ note }) => note.page === number - 1), spots = tagSpots(notes.map(({ note }) => (note.rects?.length ? note.rects : [note.rect])[0]));
        return notes.map(({ note, number: label }, index) => <Fragment key={note.id}>
          {(note.rects?.length ? note.rects : [note.rect]).map((rect, part) => <div key={part} className={(note.rects?.length ? 'note-mark' : 'note-box') + (props.active === note.id ? ' active' : '')} data-note={note.id} data-group={note.group} style={{ ...percent(rect), ...groupStyle(note.group) }}/>) }
          <button type="button" className={'note-tag' + (props.active === note.id ? ' active' : '')} data-note={note.id} data-group={note.group} style={{ ...spots[index], ...groupStyle(note.group) }} aria-label={t('Note {n}: {comment}', { n: label, comment: note.group ? groupName(note.group) : note.comment })} title={note.group ? t('Annotation groups') : note.comment} onClick={() => props.onSelect(note)}>{label}</button>
        </Fragment>);
      })()}
      {props.region && <div className="region-capture"
        onPointerDown={e => {
          if (editing || e.button > 0) return;
          e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId);
          const box = e.currentTarget.getBoundingClientRect(), x = unit((e.clientX - box.left) / box.width), y = unit((e.clientY - box.top) / box.height);
          origin.current = { page: number - 1, x, y, box }; setDraft({ page: number - 1, rect: [x, y, x, y] });
        }}
        onPointerMove={e => { const start = origin.current; if (!start) return; const x = unit((e.clientX - start.box.left) / start.box.width), y = unit((e.clientY - start.box.top) / start.box.height); setDraft({ page: start.page, rect: [Math.min(start.x, x), Math.min(start.y, y), Math.max(start.x, x), Math.max(start.y, y)] }); }}
        onPointerUp={() => {
          const current = draftRef.current; origin.current = null; setDraft(null);
          if (current && (current.rect[2] - current.rect[0] > 0.015 || current.rect[3] - current.rect[1] > 0.01)) {
            if (latest.current.group) addToGroup({ page: current.page, rects: [], quote: '' }, current.rect);
            else setEditing({ page: current.page, rect: current.rect, rects: [], quote: '' });
          }
        }}/>}
      {draft?.page === number - 1 && <div className="note-box draft" style={percent(draft.rect)}/>}
      {flash?.page === number - 1 && <div key={flash.id} className="problem-flash" style={percent(flash.rect)}/>}
      {selection?.handles && selection.page === number - 1 && !editing && <>
        {selection.rects.map((rect, index) => <div key={index} className="note-mark draft" style={percent(rect)}/>)}
        {(['from', 'to'] as const).map(end => { const [x, top, bottom] = selection.handles![end]; return <span key={end} className="select-handle" data-end={end} style={{ left: `${x * 100}%`, top: `${top * 100}%`, height: `${(bottom - top) * 100}%` }}/>; })}
      </>}
      {selection?.page === number - 1 && !editing && <button type="button" className={'add-note' + (selection.handles ? ' touch' : '')} aria-label={props.group ? t('Add to {group}', { group: groupName(props.group) }) : t('Add note')} style={{ left: `${selection.rects[selection.rects.length - 1][2] * 100}%`, top: `${selection.rects[selection.rects.length - 1][3] * 100}%` }} onPointerDown={e => e.preventDefault()} onMouseDown={e => e.preventDefault()} onClick={startNote}><Icon name="pencil" size={14}/><GroupAction group={props.group}/></button>}
      {editing?.page === number - 1 && <>
        {(editing.rects.length ? editing.rects : [editing.rect]).map((rect, index) => <div key={index} className={(editing.rects.length ? 'note-mark' : 'note-box') + ' draft'} style={percent(rect)}/>)}
        <NoteEditor rect={editing.rect} onCancel={() => { setEditing(null); }} onSave={save}/>
      </>}
    </Fragment>, layer, `layer-${number}`))}
  </div>;
});
