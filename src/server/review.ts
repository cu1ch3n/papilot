import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { ENGINE } from './paths.ts';
import type { Task } from '../shared.ts';

export interface ReviewClient { url: string; token: string; get<T = any>(route: string): Promise<T>; post<T = any>(route: string, body?: unknown): Promise<T> }
let modulePromise: Promise<{ connect: (root: string) => Promise<ReviewClient> }> | null = null;
export function reviewClient(root: string): Promise<ReviewClient> {
  modulePromise ??= import(pathToFileURL(path.join(ENGINE, 'src/client.ts')).href);
  return modulePromise!.then(module => module.connect(root));
}
export const taskRoute = (name: string) => `/api/tasks/${encodeURIComponent(name)}`;

export function confirmedReviewResponse(status: number, value: unknown, task: string): boolean {
  if (!value || typeof value !== 'object') return false;
  const result = value as Record<string, unknown>;
  if (status === 400 || status === 409) return typeof result.error === 'string';
  return status >= 200 && status < 300 && result.task === task && typeof result.csrf === 'string' && typeof result.closed === 'boolean'
    && result.decisions !== null && typeof result.decisions === 'object' && !Array.isArray(result.decisions);
}

/** Add current workspace availability to viewer state; standalone engine state stays unchanged. */
export function annotateReviewState(value: unknown, tasks: readonly Task[]): unknown {
  if (!value || typeof value !== 'object' || typeof (value as any).task !== 'string'
    || !confirmedReviewResponse(200, value, (value as any).task)) return value;
  const state = value as Record<string, unknown>;
  const task = tasks.find(task => task.name === state.task);
  let decisionLock: string | null = null;
  let commentLock: string | null = null;
  if (!task) decisionLock = commentLock = 'This task is no longer available in Papilot. Return to the workspace.';
  else if (state.closed) decisionLock = commentLock = 'This review is finished. Accepted changes are in your manuscript.';
  else if (task.status === 'deleting') decisionLock = commentLock = 'This task is being deleted. Review actions and comments are unavailable.';
  else if (task.status === 'uncertain') decisionLock = 'Select Check status in Papilot before accepting, rejecting, or undoing changes. You can still add comments.';
  else if (task.status === 'building') decisionLock = 'Wait for the PDF build before accepting, rejecting, or undoing changes. You can still add comments.';
  else if (['running', 'waiting_input', 'queued'].includes(task.status)) decisionLock = 'Pause this task in Papilot before accepting, rejecting, or undoing changes. You can still add comments.';
  else if (task.pendingReview) decisionLock = 'Wait for the current review action before accepting, rejecting, or undoing changes. You can still add comments.';
  else if (task.delivery?.pending) decisionLock = 'Retry the pending delivery before changing review decisions.';
  // Changes the task has committed are in the manuscript too.
  return { ...state, decisionLock, commentLock, ...(task ? { workspace: { status: task.status, unsent: task.review?.unsent ?? 0, comments: task.review?.comments ?? 0, accepted: task.review?.files?.length || (task.committed || task.delivery?.pending ? 1 : 0), ...(task.deferred ? { deferred: true, destination: task.delivery?.pending ? undefined : task.delivery?.mode } : {}) } } : {}) };
}

export function allowedReviewRoute(route: string, method: string): boolean {
  if (route.includes('..') || route.includes('\\')) return false;
  if (method === 'GET') return route === '/' || /^\/(assets|fonts)\/[\w./-]+$/.test(route) || /^\/files\/[a-z0-9-]+\/\d+\/[\w.-]+\.(svg|png)$/.test(route) || /^\/api\/tasks(?:\/[a-z0-9-]+(?:\/(?:state|rounds\/\d+(?:\/effects\/c\d+|\/references)?))?)?$/.test(route);
  return method === 'POST' && /^\/api\/tasks\/[a-z0-9-]+\/(decide|undo|note|rounds\/\d+\/references\/confirm)$/.test(route);
}
export function rewriteReviewJson(value: any, prefix: string): any {
  if (Array.isArray(value)) return value.map(v => rewriteReviewJson(v, prefix));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === 'url' && typeof v === 'string' && /^http:\/\/(127\.0\.0\.1|localhost):\d+\//.test(v) ? prefix + new URL(v).pathname + new URL(v).search : rewriteReviewJson(v, prefix)]));
  return typeof value === 'string' && value.startsWith('/files/') ? prefix + value : value;
}
export function rewriteReviewHtml(html: string, prefix: string): string {
  const script = `<script>(()=>{const prefix=${JSON.stringify(prefix)};if(!crypto.randomUUID)crypto.randomUUID=()=>Array.from(crypto.getRandomValues(new Uint8Array(20)),b=>b.toString(16).padStart(2,'0')).join('');const original=window.fetch;window.fetch=(input,init)=>{if(typeof input==='string'&&input.startsWith('/api/'))input=prefix+input;const response=original.call(window,input,init);if(typeof input==='string'&&/\\/rounds\\/\\d+$/.test(input))response.then(r=>{if(r.ok)r.clone().json().then(value=>{if(Number.isSafeInteger(value.round)){document.documentElement.dataset.papilotRound=String(value.round);window.dispatchEvent(new Event('papilot:round'));}}).catch(()=>{});}).catch(()=>{});return response};})();</script>`;
  return html.replace(/(src|href)="\/(?!\/)/g, `$1="${prefix}/`).replace('<head>', '<head>' + script);
}
