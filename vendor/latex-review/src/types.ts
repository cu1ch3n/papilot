export type Span = [number, number];
export type Rect = [number, number, number, number];
export type SourceBox = [
  page: number,
  top: number,
  bottom: number,
  left?: number,
  right?: number,
];
export type Ranges = Record<string, Span[]>;
export type Op = [
  "equal" | "replace" | "insert" | "delete",
  number,
  number,
  number,
  number,
];
export interface Heading {
  id: string;
  title: string;
  number: string;
  kind: string;
  level: number;
  file: string;
  line: number;
  parent: string | null;
  labels: string[];
  ranges: Ranges;
  files: string[];
}
export interface SectionRef {
  id: string;
  number: string;
  title: string;
}
export interface Scope {
  paths: string[];
  ranges: Ranges | null;
  sections: SectionRef[];
}
export interface Task {
  deferred?: number;
  name: string;
  title: string;
  worktree: string;
  base: string;
  accepted: string;
  scope: Scope;
  created: number;
  closed: number | null;
}
export interface Delivery {
  mode: "workspace" | "branch";
  accepted: string;
  seq: number;
  branch?: string;
  commit?: string;
  parent?: string;
  previous?: string;
  done: boolean;
  writes: { file: string; before: string | null; after: string | null }[];
}
export interface Unit {
  id: string;
  file: string;
  status: "added" | "deleted" | "modified";
  kind: "text" | "figure" | "binary";
  whole_file: boolean;
  ops: Op[];
  old_start: number;
  old_end: number;
  new_start: number;
  new_end: number;
  old_text: string;
  new_text: string;
  truncated: boolean;
}
export interface Round {
  task: string;
  number: number;
  before: string;
  after: string;
  units: Unit[];
  summary: {
    warnings: string[];
    targets: string[];
    builds: string[];
    renderer?: string;
  };
  created: number;
}
export type ActionKind = "accept" | "reject" | "comment";
export type Decision = "accepted" | "rejected" | "commented" | "pending";
export interface ActionDetail {
  accepted_before?: string;
  accepted_after?: string;
  not_reverted?: string[];
}
export interface Action {
  seq: number;
  id: string;
  task: string;
  round: number;
  kind: ActionKind;
  changes: string[];
  body: string;
  status: "applying" | "applied" | "undoing" | "undone" | "failed";
  detail: ActionDetail;
  created: number;
}
export interface Write {
  action: string;
  phase: "apply" | "undo";
  path: string;
  expected: Buffer | null;
  target: Buffer | null;
}
export interface MessageData {
  changes?: string[];
  not_reverted?: string[];
  undid?: string;
  message?: number;
}
export interface Message {
  id: number;
  task: string;
  round: number | null;
  kind: ActionKind | "undo" | "note";
  action: string | null;
  body: string;
  data: MessageData;
  created: number;
}
export interface JobResult {
  outcome?: "published" | "unchanged" | "empty";
  round?: number | null;
  changes?: number;
  kinds?: Record<string, number>;
  warnings?: string[];
  error?: string;
  details?: string[];
  next?: string;
  log?: string;
}
export interface Job {
  id: string;
  task: string;
  status: "queued" | "running" | "done" | "failed";
  phase: string;
  result: JobResult;
  created: number;
  finished?: number;
}
export interface BuildInfo {
  key: string;
  tree: string;
  targets: string[];
  root: string;
  cwd: string;
  pdf: string;
  seconds: number;
  warnings: string[];
}
export interface Position {
  page: number;
  clip: Rect;
  label: string;
}
export interface Mark {
  kind: "removed" | "added" | "moved";
  rect: Rect;
}
export interface Pair {
  old: Position | null;
  new: Position | null;
  before_marks: Mark[];
  after_marks: Mark[];
}
export type Visual = "unmapped" | "text" | "layout" | "position" | "identical";
export interface Card {
  id: string;
  file: string;
  pairs: Pair[];
  comparison: Visual;
  own?: { old: SourceBox[]; new: SourceBox[] };
  context_node?: string | null;
}
export interface TextGlyph {
  text: string;
  rect: Rect;
}
export interface TextLine {
  text: string;
  chars: TextGlyph[];
}
export interface Strip {
  src: string;
  clean: string;
  width: number;
  height: number;
  page: number;
  label: string;
  text?: TextLine[];
}
export interface ChangeBlock {
  kind: "change";
  units: string[];
  identical: boolean;
  reflow?: boolean;
  before: Strip[];
  after: Strip[];
}
export type Block =
  ChangeBlock | { kind: "context"; image: Strip } | { kind: "gap" };
export interface VisualUnit {
  visual: Visual;
  pages: string[];
  section: string | null;
  /** Where the PDF changes away from this edit's own lines: how many
   * places, and the first ones rendered. The rest render on request. */
  effects?: { total: number; shown: PlaceView[] };
}
/** A place where an edit changes the PDF away from its own lines, such as a
 * use of a redefined macro. `with` lists the other edits it also needs. */
export interface Place {
  page: string;
  section: string | null;
  pairs: Pair[];
  with?: string[];
}
export interface PlaceView {
  page: string;
  section: string | null;
  before: Strip[];
  after: Strip[];
  with?: string[];
}
export interface RenderedRound {
  units: Record<string, VisualUnit>;
  sections: { node: string; number: string; title: string; blocks: Block[] }[];
  loose: ChangeBlock[];
  references?: References;
}
/** One field of a changed bibliography entry, before and after; null
 * where the entry lacks it. `resolved` is the new value with @string
 * macros expanded, when that differs. */
export interface ReferenceField {
  name: string;
  old: string | null;
  new: string | null;
  resolved?: string;
}
export interface ReferenceCitation {
  file: string;
  line: number;
  section: string | null;
}
/** still-cited: a removed key that the document still cites.
 * not-in-bibliography: the document does not read this .bib file. */
export type ReferenceProblem =
  | "still-cited"
  | "duplicate-key"
  | "unreadable"
  | "not-in-bibliography";
/** A bibliography entry that a round adds, removes or modifies, shown whole
 * under the edit it belongs to. */
export interface ReferenceEntry {
  id: string;
  unit: string;
  file: string;
  key: string;
  old_key?: string;
  type: string;
  old_type?: string;
  status: "added" | "removed" | "modified";
  fields: ReferenceField[];
  lines: Span;
  /** Where the revised document cites the key. */
  cited: ReferenceCitation[];
  /** Where it still cites a renamed entry's old key. */
  old_cited?: ReferenceCitation[];
  problems: ReferenceProblem[];
  error?: string;
}
/** A key the revised document newly cites with no bibliography entry. */
export interface MissingCitation {
  key: string;
  file: string;
  line: number;
  unit: string | null;
  section: string | null;
}
export interface References {
  entries: ReferenceEntry[];
  missing: MissingCitation[];
}
/** A published record a bibliography entry was compared with. */
export interface CheckRecord {
  source: "doi" | "crossref" | "arxiv" | "dblp";
  title: string;
  authors: string[];
  year: number | null;
  venue: string | null;
  doi: string | null;
  url: string;
}
export interface CheckDifference {
  field: "title" | "author" | "year" | "doi" | "arxiv";
  bib: string;
  record: string;
  /** Shown, but not a reason to doubt the entry: punctuation in a title,
   * or a preprint's year before the published version's. */
  minor?: boolean;
}
/** verified: a record agrees. mismatch: a record of the same work differs,
 * or the DOI names another work. unverified: no record was found.
 * failed: a source could not be reached. skipped: nothing to look up. */
export interface ReferenceCheck {
  status: "verified" | "mismatch" | "unverified" | "failed" | "skipped";
  record?: CheckRecord;
  differences: CheckDifference[];
  /** What the entry was looked up by. */
  via: "doi" | "arxiv" | "title" | null;
  reason?: "doi-not-found" | "arxiv-not-found" | "no-match" | "nothing-to-check";
  /** Sources that could not be reached for this check. */
  unavailable: string[];
  checked: number;
}
export interface ReferenceChecks {
  checks: Record<string, ReferenceCheck>;
  /** Entries still being looked up. */
  pending: number;
  /** Entries the author has checked by hand, with when (seconds). A
   * confirmation holds while the entry's looked-up fields stay the same. */
  confirmed?: Record<string, number>;
}
/** An entry of the paper's bibliography as it is now. */
export interface BibliographyEntry {
  id: string;
  file: string;
  key: string;
  type: string;
  fields: { name: string; value: string; resolved?: string }[];
  lines: Span;
  cited: ReferenceCitation[];
  error?: string;
}
/** The whole bibliography of a paper: its entries, where each is cited,
 * and what is wrong with them without looking anything up. */
export interface Bibliography {
  /** The .bib files the paper names, and those of them that do not exist. */
  bibs: string[];
  absent: string[];
  entries: BibliographyEntry[];
  /** Citations of keys no entry defines, each place. */
  missing: (ReferenceCitation & { key: string })[];
  /** Entries sharing a key. */
  duplicates: string[][];
  /** Entries under different keys with the same DOI or title. */
  similar: { ids: string[]; by: "doi" | "title" }[];
  /** \nocite{*} puts every entry in the bibliography. */
  all_cited: boolean;
}
export interface RenderRequest {
  main: string;
  source_dir: string;
  figures: string[];
  old: BuildInfo;
  new: BuildInfo;
  units: Unit[];
  /** The edits that cause each change of the whole documents, found by
   * compiling variants when the round has more than one edit. */
  causes?: string[][];
  /** The cards of the first pass, reused with `causes`. */
  cards?: Card[];
}
/** Words of the old and new PDF that changed, as ranges of each document's
 * words in reading order. */
export interface Effect {
  old: [number, number];
  new: [number, number];
}
export interface History {
  round: number;
  change: string;
  comment: string;
  new_text: string;
}
export interface RoundDetail extends Omit<RenderedRound, "units"> {
  task: string;
  round: number;
  before: string;
  after: string;
  units: (Unit & Partial<VisualUnit> & { history?: History[] })[];
  warnings: string[];
  files: string;
  references?: References;
}
export type TaskState =
  "editing" | "building" | "build_failed" | "reviewing" | "revise" | "done";
export interface Summary {
  task: string;
  title: string;
  state: TaskState;
  round: number | null;
  counts: Record<Decision, number>;
  next: string;
}
export interface PageState {
  csrf: string;
  task: string;
  title: string;
  closed: boolean;
  /** Optional host-provided reason that file decisions or comments are unavailable. */
  decisionLock?: string | null;
  commentLock?: string | null;
  /**
   * Host activity, undelivered feedback (all updates, and the comments among them),
   * and how many manuscript files this task's accepted changes touched.
   */
  workspace?: {
    deferred?: boolean;
    destination?: "workspace" | "branch";
    status: string;
    unsent: number;
    comments?: number;
    accepted?: number;
  };
  state: TaskState | null;
  latest: number | null;
  /** Publication times for browsing earlier changes without revision numbers. */
  history?: { number: number; created: number }[];
  round: number | null;
  revision: string | null;
  decisions: Record<string, Decision>;
  comments: Record<string, string>;
  undo: { id: string; kind: ActionKind; changes: string[] } | null;
  job:
    | (Pick<Job, "id" | "status" | "phase" | "created"> &
        JobResult & { ahead: number })
    | null;
}
export interface FeedbackItem {
  id: number;
  kind: Message["kind"];
  round: number | null;
  text?: string;
  changes?:
    | string[]
    | { id: string; file: string; lines: Span; old: string; new: string }[];
  not_reverted?: string[];
  undid?: string;
}
export interface Feedback extends Summary {
  feedback: FeedbackItem[];
  cursor: number;
  build_error?: JobResult;
  warnings?: string[];
}
export interface TaskInfo extends Summary {
  worktree: string;
  url: string;
  viewing: boolean;
  scope: { sections: string[]; files: string[] };
}
