import type { GroupInstructions, NoteGroup } from './note-groups.ts';
export type TaskStatus = 'idle' | 'queued' | 'running' | 'waiting_input' | 'building' | 'reviewing' | 'interrupted' | 'failed' | 'uncertain' | 'deleting';
export interface Project { id: string; name: string; path: string; createdAt: number }
export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_ATTACHMENT_TOTAL = 100 * 1024 * 1024;
export interface Attachment { id: string; projectId: string; name: string; size: number; mime: string }
export type UpdateChannel = 'stable' | 'dev';
export interface UpdateStatus {
  channel?: UpdateChannel;
  currentVersion: string; latestVersion: string | null;
  phase: 'idle' | 'checking' | 'available' | 'installing' | 'waiting' | 'restarting' | 'updated' | 'failed';
  checkedAt: number | null; error: string | null; canUpdate: boolean;
}
// unsent counts review updates the agent has not received; comments are the
// ones that ask for a revision. files are the manuscript files this task's
// accepted changes touched since its last commit, relative to the repository root.
export interface ReviewSummary { state: string; round: number | null; counts: Record<string, number>; unsent?: number; comments?: number; files?: string[]; next?: string; job?: { phase: string; status: string; error?: string; details?: string[] } | null }
export interface PendingReview { route: string; body: Record<string, unknown>; previousStatus: TaskStatus }
export interface Task {
  // New tasks keep acceptance isolated until the author chooses a destination.
  deferred?: boolean;
  delivery?: { mode: 'workspace' | 'branch'; accepted: string; branch?: string; commit?: string; pending?: boolean } | null;
  id: string; projectId: string; name: string; title: string; instructions: string;
  titleSource?: 'prompt' | 'generated' | 'manual'; titleRevision?: number; titleGeneration?: 'pending' | 'failed' | null;
  worktree: string; threadId: string | null; turnId: string | null; agent?: AgentId; model: string | null; effort?: string | null; serviceTier?: string;
  status: TaskStatus; createdAt: number; updatedAt: number; feedbackCursor: number;
  archivedAt?: number | null;
  error: string | null; review: ReviewSummary | null;
  pauseVersion?: number; pendingRunId?: string | null;
  pendingReview?: PendingReview | null;
  // The task's last commit from its review, and the accepted text it included.
  committed?: { hash: string; accepted: string; at: number; pushed?: boolean } | null;
}
// A task the author is through with, which Papilot archives once they leave
// it: every change of its last result is decided, no comment or rejection
// waits to go back to the agent, and what was accepted has left the task
// (applied or committed; older tasks accept straight into the working
// directory). An answer without manuscript changes is finished too.
export function taskFinished(task: Task) {
  const review = task.review;
  if (task.status !== 'reviewing' || !review || task.pendingReview || task.delivery?.pending || review.counts?.pending || review.state === 'build_failed') return false;
  const unsent = review.unsent ?? ['accepted', 'rejected', 'commented'].reduce((count, kind) => count + (review.counts?.[kind] || 0), 0);
  if ((review.comments ?? unsent) > 0 || (unsent > 0 && !review.counts?.accepted)) return false;
  if (review.round === null) return true;
  return review.state === 'done' && (!task.deferred || review.files?.length === 0);
}
// reviewRound is 0 while awaiting a result, null when no changes were produced,
// or the published round. Older runs omit it.
export interface Run { id: string; taskId: string; requestKey: string; prompt: string; attachments?: Attachment[]; feedbackCursor?: number; status: 'queued' | 'running' | 'completed' | 'failed' | 'interrupted' | 'uncertain'; createdAt: number; finishedAt: number | null; reviewRound?: number | null }
export interface TimelineItem { id: string; taskId: string; type: string; text: string; detail?: string; status?: string; createdAt: number; meta?: MessageMeta }
// A user message can run a skill or carry review feedback; the chat shows
// those as what they are rather than as the prompt the agent receives.
// Papilot itself sends the agent a build its own edits broke.
export interface NoteAnchor { sources: { file: string; lines: [number, number] }[]; round?: number }
export interface NoteSummary { group?: NoteGroup; where: string; quote: string; comment: string; id?: string; anchor?: NoteAnchor }
export interface NoteChange { round: number; stop: number; units: string[]; state: 'pending' | 'accepted' | 'rejected' | 'commented' | 'mixed'; match: 'source' | 'quote' }
export interface NoteResult { key: string; itemId: string; index: number; note: NoteSummary; round: number | null; state: 'waiting' | 'unmatched' | 'matched'; changes: NoteChange[] }
export interface MessageMeta { attachments?: Attachment[]; skill?: { id: string; name: string }; notes?: NoteSummary[]; groupInstructions?: GroupInstructions; feedback?: FeedbackSummary; sendsFeedback?: boolean; build?: BuildFailure; author?: Author }
// Who wrote a message or note; none means the owner.
export interface Author { id: string; name: string }
// A failed review build as the engine reports it; log is the compiler log's path.
export interface BuildFailure { error: string; details: string[]; log?: string }
export interface FeedbackSummary { round: number | null; accepted: number; rejected: number; undone: number; comments: { where: string; text: string }[]; buildError?: boolean }
export interface Skill { id: string; name: string; description: string; hint: string; source: 'builtin' | 'user' | 'paper' }
export interface PendingRequest { id: string; taskId: string; method: string; params: Record<string, any>; createdAt: number }
export type AgentId = 'codex' | 'claude' | 'antigravity' | 'kimi' | 'cursor' | 'opencode' | 'qwen' | 'glm' | 'deepseek';
// Every agent Papilot can drive, in menu order. Only the ones found on the host are offered.
export const AGENT_IDS: AgentId[] = ['codex', 'claude', 'cursor', 'antigravity', 'kimi', 'glm', 'deepseek', 'qwen', 'opencode'];
export const AGENT_NAMES: Record<AgentId, string> = { codex: 'Codex', claude: 'Claude', cursor: 'Cursor', antigravity: 'Antigravity', kimi: 'Kimi', glm: 'GLM', deepseek: 'DeepSeek', qwen: 'Qwen', opencode: 'OpenCode' };
export const isAgentId = (value: unknown): value is AgentId => AGENT_IDS.includes(value as AgentId);
export interface AgentModel { id: string; name: string; isDefault: boolean; efforts: string[]; defaultEffort: string | null; fastMode?: { serviceTier: string; description: string } }
// The account's included usage: rolling windows (minutes long, reset time in ms) and credits.
export interface UsageWindow { usedPercent: number; minutes: number | null; resetsAt: number | null }
export interface Usage { plan: string | null; windows: UsageWindow[]; credits: { unlimited: boolean; balance: number | null } | null; reached: boolean }
// installed is false when the agent was not found on the host (no CLI, SDK
// credentials or key); such agents are not offered. Older servers omit it.
export interface RuntimeStatus { connected: boolean; authenticated: boolean; account: string | null; error: string | null; models: AgentModel[]; usage?: Usage | null; installed?: boolean }
export interface DiagnosticCheck { id: string; ok: boolean; severity: 'error' | 'warn' | 'info'; detail: string; fix: string | null }
export interface DiagnosticReport {
  version: string; checkedAt: number; platform: string; arch: string; node: string;
  ok: boolean; checks: DiagnosticCheck[];
}
export interface Snapshot { projects: Project[]; tasks: Task[]; requests: PendingRequest[]; runtime: RuntimeStatus; runtimes?: Partial<Record<AgentId, RuntimeStatus>>; version: string; viewer?: Viewer }
// Who is looking: the owner on this host or Tailscale (local), or a person
// signed in with a passkey at the public URL (account). Older servers send none.
// owner names the owner, whose messages carry no author.
export interface Viewer { id: string; name: string; role: 'owner' | 'member'; listener: 'local' | 'account'; owner: string }
// A person the owner invited, as the People dialog shows them. joined means
// they have registered at least one passkey; projects are the shared papers.
export interface Person { id: string; name: string; role: 'owner' | 'member'; joined: boolean; projects: string[]; lastSeenAt: number | null; devices: Device[] }
// A passkey or a signed-in browser session, either of which the owner can revoke.
export interface Device { id: string; kind: 'passkey' | 'session'; label: string; createdAt: number; lastUsedAt: number | null }
export interface People { origin: string | null; people: Person[] }
// staged: the index has changes to this file; unstaged: the working tree has more.
export interface GitFile { path: string; status: string; staged: boolean; unstaged: boolean; lines?: [number, number]; from?: string }
// merging is a merge in progress, with the files whose conflict markers remain.
export interface GitStatus { branch: string | null; upstream: string | null; ahead: number; behind: number; files: GitFile[]; head: { hash: string; subject: string; date: number } | null; remote?: boolean; merging?: { message: string; conflicts: string[] } | null }
export interface GitDiff { path: string; diff: string; truncated: boolean }
export interface GitWorktree {
  path: string; branch: string | null; head: string | null; current: boolean; bare: boolean;
  locked?: string; prunable?: string; status: GitStatus | null; error?: string;
  taskId?: string;
}
export interface GitGraphCommit { hash: string; parents: string[]; subject: string; author: string; date: number; refs: string[] }
export interface GitOverview { worktrees: GitWorktree[]; commits: GitGraphCommit[]; truncated: boolean }
export interface ManuscriptBuild { status: 'building' | 'ready' | 'failed'; key?: string; pages?: [number, number][]; builtAt?: number; error?: string; current: boolean }
export interface Annotation { group?: NoteGroup; id: string; projectId: string; key: string; page: number; rect: [number, number, number, number]; rects?: [number, number, number, number][]; comment: string; quote: string; source: { file: string; lines: [number, number]; excerpt?: string } | null; createdAt: number; taskId?: string; author?: Author; deletedAt?: number }
export interface Manuscript { git: GitStatus; build: ManuscriptBuild; annotations: Annotation[] }
export interface PaperImport {
  id: string; path: string; name: string; copied: boolean; candidates: string[]; main: string; engine: string;
  phase: 'choose' | 'building' | 'failed' | 'ready' | 'repairing';
  error?: string; summary?: string; versioned?: boolean;
}
// The paper's bibliography as the References panel reads it: the review
// engine's report of every entry, with online checks and the entries the
// author checked by hand.
export interface ReferenceCitation { file: string; line: number; section: string | null }
export interface ReferenceRecord { source: 'doi' | 'crossref' | 'arxiv' | 'dblp'; title: string; authors: string[]; year: number | null; venue: string | null; doi: string | null; url: string }
export interface ReferenceCheck {
  status: 'verified' | 'mismatch' | 'unverified' | 'failed' | 'skipped';
  record?: ReferenceRecord; via: 'doi' | 'arxiv' | 'title' | null;
  differences: { field: 'title' | 'author' | 'year' | 'doi' | 'arxiv'; bib: string; record: string; minor?: boolean }[];
  reason?: 'doi-not-found' | 'arxiv-not-found' | 'no-match' | 'nothing-to-check'; unavailable: string[]; checked: number;
}
export interface BibliographyEntry { id: string; file: string; key: string; type: string; fields: { name: string; value: string; resolved?: string }[]; lines: [number, number]; cited: ReferenceCitation[]; error?: string }
export interface BibliographyReport {
  bibs: string[]; absent: string[]; entries: BibliographyEntry[];
  missing: (ReferenceCitation & { key: string })[]; duplicates: string[][]; similar: { ids: string[]; by: 'doi' | 'title' }[]; all_cited: boolean;
  checks: Record<string, ReferenceCheck>; pending: number; confirmed: Record<string, number>;
}
