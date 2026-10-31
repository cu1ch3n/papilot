import { Fragment, useEffect, useRef, useState } from "react";
import type {
  CheckDifference,
  ReferenceCheck,
  ReferenceChecks,
  ReferenceCitation,
  ReferenceEntry,
  ReferenceProblem,
  References,
  RoundDetail,
} from "../types.ts";
import { language, t, tn } from "./i18n.ts";

// Bibliography changes are shown whole, entry by entry, with what an online
// check found. An entry that is not verified is accepted only after the
// author confirms it, and batch acceptance leaves it for the author.

/** The host can turn online checks off; a page that cannot read the
 * setting checks online. */
export const REFERENCE_STORAGE = "latex-review:references";
export function onlineChecks() {
  try {
    return localStorage.getItem(REFERENCE_STORAGE) !== "off";
  } catch {
    return true;
  }
}

const SOURCE: Record<string, string> = {
  doi: "doi.org",
  crossref: "Crossref",
  dblp: "DBLP",
  arxiv: "arXiv",
};
const FIELD: Record<CheckDifference["field"], string> = {
  title: "Title",
  author: "Authors",
  year: "Year",
  doi: "DOI",
  arxiv: "arXiv",
};
const ENTRY_STATUS: Record<ReferenceEntry["status"], string> = {
  added: "New entry",
  modified: "Changed entry",
  removed: "Removed entry",
};
const CHECK: Record<string, string> = {
  verified: "Verified",
  mismatch: "Differs from the record",
  unverified: "Not verified",
  failed: "Could not check",
  skipped: "Nothing to check",
  checking: "Checking…",
  off: "Not checked online",
  confirmed: "Checked by you",
};
const PROBLEM: Record<ReferenceProblem, string> = {
  "still-cited": "The paper still cites this key, and no entry defines it now.",
  "duplicate-key": "Another entry in the bibliography has the same key.",
  unreadable: "BibTeX cannot read this entry.",
  "not-in-bibliography": "The paper does not use this .bib file, so the entry will not appear.",
};

export interface CheckState {
  round: number;
  value: ReferenceChecks | null;
  error: boolean;
}
/** Asks for the checks of a round's entries until none is pending. */
export function useReferenceChecks(
  detail: RoundDetail | null,
  load: <T>(route: string, body?: unknown) => Promise<T>,
) {
  const [state, setState] = useState<CheckState | null>(null),
    retrying = useRef(false),
    [attempt, setAttempt] = useState(0),
    checked = Boolean(detail?.references?.entries.some((e) => e.status !== "removed" && !e.error));
  useEffect(() => {
    if (!detail || !checked) {
      setState(null);
      return;
    }
    let cancelled = false,
      timer: ReturnType<typeof setTimeout> | undefined;
    const round = detail.round;
    async function poll() {
      const online = onlineChecks(),
        retry = retrying.current;
      retrying.current = false;
      try {
        const value = await load<ReferenceChecks>(
          `/rounds/${round}/references${online ? `?check=1${retry ? "&retry=1" : ""}` : ""}`,
        );
        if (cancelled) return;
        setState({ round, value, error: false });
        if (online && value.pending) timer = setTimeout(poll, document.hidden ? 5000 : 1500);
      } catch {
        if (cancelled) return;
        setState((s) => ({ round, value: s?.round === round ? s.value : null, error: true }));
        timer = setTimeout(poll, 5000);
      }
    }
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [detail?.round, detail?.after, checked, attempt]);
  const current = state && detail && state.round === detail.round ? state : null;
  return {
    checks: current?.value?.checks ?? {},
    pending: current?.value?.pending ?? (checked && onlineChecks() ? 1 : 0),
    confirmed: current?.value?.confirmed ?? {},
    error: Boolean(current?.error),
    retry() {
      retrying.current = true;
      setAttempt((n) => n + 1);
    },
    async confirm(id: string, on: boolean) {
      if (!detail) return;
      const round = detail.round,
        value = await load<ReferenceChecks>(`/rounds/${round}/references/confirm`, { id, confirmed: on });
      setState((s) => (s?.round === round ? { round, value: { ...value, pending: Math.max(value.pending, s.value?.pending ?? 0) }, error: false } : s));
    },
  };
}

/** What the author should know before accepting an entry; empty when it is
 * verified and nothing is wrong with it. */
export function concerns(
  entry: ReferenceEntry,
  check: ReferenceCheck | undefined,
  pending: boolean,
  confirmed = false,
): string[] {
  const found = entry.problems.map((p) => t(PROBLEM[p]));
  if (entry.status === "removed" || entry.error || confirmed) return found;
  const state = checkState(check, pending);
  if (state !== "verified") found.push(t(CHECK[state]));
  return found;
}
function checkState(check: ReferenceCheck | undefined, pending: boolean) {
  if (check) return check.status;
  return pending && onlineChecks() ? "checking" : "off";
}
/** Each change's entries that need a look before acceptance, and the
 * citations it adds without an entry. */
export function risks(
  references: References | undefined,
  checks: Record<string, ReferenceCheck>,
  pending: number,
  confirmed: Record<string, number> = {},
) {
  const result = new Map<string, { label: string; reasons: string[] }[]>();
  for (const entry of references?.entries ?? []) {
    const reasons = concerns(entry, checks[entry.id], pending > 0, entry.id in confirmed);
    if (reasons.length)
      result.set(entry.unit, [...(result.get(entry.unit) ?? []), { label: entry.key, reasons }]);
  }
  for (const cite of references?.missing ?? [])
    if (cite.unit)
      result.set(cite.unit, [
        ...(result.get(cite.unit) ?? []),
        { label: `\\cite{${cite.key}}`, reasons: [t("No bibliography entry has this key.")] },
      ]);
  return result;
}

// Chinese sentences follow each other without a space.
const gap = () => (language() === "zh-CN" ? "" : " ");
function where(place: ReferenceCitation) {
  return `${place.section ? `${place.section} · ` : ""}${place.file}:${place.line}`;
}
function Cited({ entry }: { entry: ReferenceEntry }) {
  const places = entry.status === "removed" ? [] : entry.cited;
  if (entry.status === "removed") return null;
  return (
    <p className="reference-cited">
      {places.length
        ? tn(places.length, "Cited {n} time: {places}", "Cited {n} times: {places}", { places: places.map(where).join("; ") })
        : t("Not cited in the paper, so it does not appear in the PDF.")}
    </p>
  );
}
function Value({ old, next, status }: { old: string | null; next: string | null; status: ReferenceEntry["status"] }) {
  if (status !== "modified" || old === next) return <>{next ?? old}</>;
  return (
    <>
      {old !== null && <del>{old}</del>}
      {old !== null && next !== null && " "}
      {next !== null && <ins>{next}</ins>}
    </>
  );
}
function Verdict({ check, state, entry, onRetry, confirmed, onConfirm }: {
  check?: ReferenceCheck;
  state: string;
  entry: ReferenceEntry;
  onRetry: () => void;
  confirmed?: number;
  onConfirm?: (on: boolean) => void;
}) {
  if (entry.status === "removed" || entry.error) return null;
  const confirmation =
    onConfirm && (confirmed !== undefined || (state !== "verified" && state !== "checking")) ? (
      <p className="reference-confirmation">
        {confirmed !== undefined ? (
          <>
            {t("You checked this entry yourself.")}{" "}
            <button type="button" className="link" onClick={() => onConfirm(false)}>
              {t("Undo")}
            </button>
          </>
        ) : (
          <button type="button" className="reference-confirm" onClick={() => onConfirm(true)}>
            {t("I checked it myself")}
          </button>
        )}
      </p>
    ) : null;
  const source = check?.record ? SOURCE[check.record.source] : "",
    unreachable = check?.unavailable.length
      ? t("{sources} could not be reached.", { sources: check.unavailable.join(", ") })
      : "";
  const text =
    state === "checking"
      ? t("Looking this entry up in Crossref, DBLP and arXiv…")
      : state === "off"
        ? t("Online checks are off in Settings, so this entry was not looked up.")
        : state === "verified"
          ? check!.differences.length
            ? t("Matches the record in {source}, apart from the small differences below.", { source })
            : t("Matches the record in {source}.", { source })
          : state === "mismatch"
            ? t("{source} has this work with other details. Compare them below.", { source })
            : state === "unverified"
              ? check!.reason === "doi-not-found"
                ? t("The DOI is not registered, and no record matches the title.")
                : check!.reason === "arxiv-not-found"
                  ? t("No arXiv paper has this identifier, and no record matches the title.")
                  : t("No record in Crossref, DBLP or arXiv matches this entry. Theses, reports and many books are in none of them, so check it yourself.")
              : state === "failed"
                ? t("The sources could not be reached.")
                : t("The entry has no title, DOI or arXiv identifier to look up.");
  return (
    <div className="reference-verdict" data-check={state}>
      <p>
        {text}
        {unreachable && gap() + unreachable}
        {(state === "failed" || state === "unverified" || (check?.unavailable.length ?? 0) > 0) && (
          <>
            {" "}
            <button type="button" className="link" onClick={onRetry}>
              {t("Check again")}
            </button>
          </>
        )}
      </p>
      {check && check.differences.length > 0 && (
        <dl className="reference-differences">
          {check.differences.map((d, i) => (
            <Fragment key={i}>
              <dt>
                {t(FIELD[d.field])}
                {d.minor ? ` · ${t("small")}` : ""}
              </dt>
              <dd>
                <span className="reference-ours">
                  <span className="reference-side">{t("Entry")}</span>
                  {d.bib}
                </span>
                <span className="reference-theirs">
                  <span className="reference-side">{SOURCE[check.record?.source ?? ""] ?? t("Record")}</span>
                  {d.record || (d.field === "doi" ? t("(not registered)") : d.field === "arxiv" ? t("(no such paper)") : "—")}
                </span>
              </dd>
            </Fragment>
          ))}
        </dl>
      )}
      {check?.record && (
        <p className="reference-record">
          <span className="reference-side">
            {state === "unverified" ? t("Closest record") : t("Record")} · {source}
          </span>
          <a href={check.record.url} target="_blank" rel="noopener noreferrer">
            {check.record.title}
          </a>
          {[
            check.record.authors.join(", "),
            check.record.venue,
            check.record.year,
            check.record.doi ? `doi:${check.record.doi}` : null,
          ]
            .filter(Boolean)
            .map((part, i) => (
              <span key={i}> · {part}</span>
            ))}
        </p>
      )}
      {confirmation}
    </div>
  );
}

/** A change's bibliography entries, every field shown. */
export function ReferenceEntries({ entries, checks, pending, onRetry, confirmed = {}, onConfirm }: {
  entries: ReferenceEntry[];
  checks: Record<string, ReferenceCheck>;
  pending: boolean;
  onRetry: () => void;
  confirmed?: Record<string, number>;
  onConfirm?: (id: string, on: boolean) => void;
}) {
  return (
    <div className="references">
      {entries.map((entry) => {
        const check = checks[entry.id],
          state = entry.status === "removed" ? "removed" : entry.error ? "unreadable" : checkState(check, pending),
          mine = confirmed[entry.id],
          shown = mine !== undefined && state !== "verified" && state !== "removed" && state !== "unreadable" ? "confirmed" : state;
        return (
          <section className="reference-entry" key={entry.id} data-status={entry.status} data-check={shown}>
            <header className="reference-head">
              <code className="reference-key">
                @{entry.old_type ? <><del>{entry.old_type}</del><ins>{entry.type}</ins></> : entry.type}
                {"{"}
                {entry.old_key ? <><del>{entry.old_key}</del><ins>{entry.key}</ins></> : entry.key}
                {"}"}
              </code>
              <span className="reference-status">{t(ENTRY_STATUS[entry.status])}</span>
              {state !== "removed" && state !== "unreadable" && (
                <span className="reference-check" data-check={shown}>
                  {t(CHECK[shown])}
                </span>
              )}
              <span className="reference-lines">
                {entry.file}:{entry.lines[0]}–{entry.lines[1]}
              </span>
            </header>
            {entry.problems.map((p) => (
              <p className="reference-problem" key={p}>
                {t(PROBLEM[p])}
                {p === "unreadable" && entry.error ? gap() + entry.error : ""}
                {p === "still-cited" &&
                  gap() + [...(entry.status === "removed" ? entry.cited : []), ...(entry.old_cited ?? [])].map(where).join("; ")}
              </p>
            ))}
            <table className="reference-fields">
              <tbody>
                {entry.fields.map((field) => (
                  <tr
                    key={field.name}
                    data-change={
                      entry.status !== "modified" || field.old === field.new
                        ? undefined
                        : field.old === null
                          ? "added"
                          : field.new === null
                            ? "removed"
                            : "changed"
                    }
                  >
                    <th scope="row">{field.name}</th>
                    <td>
                      <Value old={field.old} next={field.new} status={entry.status} />
                      {field.resolved && <span className="reference-resolved"> = {field.resolved}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Cited entry={entry} />
            <Verdict
              check={check}
              state={state}
              entry={entry}
              onRetry={onRetry}
              confirmed={mine}
              onConfirm={onConfirm && ((on) => onConfirm(entry.id, on))}
            />
          </section>
        );
      })}
    </div>
  );
}

/** One line above the document: how many entries changed, how many need a
 * look, and the citations without an entry. */
export function ReferenceBanner({ references, checks, pending, confirmed = {}, changeOf, onSelect, onRetry }: {
  references: References;
  checks: Record<string, ReferenceCheck>;
  pending: number;
  confirmed?: Record<string, number>;
  changeOf: (unit: string | null) => number;
  onSelect: (index: number) => void;
  onRetry: () => void;
}) {
  const entries = references.entries,
    looked = entries.filter((e) => e.status !== "removed" && !e.error),
    mine = (e: ReferenceEntry) => e.id in confirmed && checks[e.id]?.status !== "verified",
    count = (status: string) => looked.filter((e) => checks[e.id]?.status === status && !mine(e)).length,
    flagged = entries
      .map((entry) => ({ entry, reasons: concerns(entry, checks[entry.id], pending > 0, entry.id in confirmed) }))
      .filter((item) => item.reasons.length),
    summary = [
      entries.length
        ? tn(entries.length, "{n} entry changed", "{n} entries changed")
        : tn(references.missing.length, "{n} citation without an entry", "{n} citations without an entry"),
      count("verified") && tn(count("verified"), "{n} verified", "{n} verified"),
      looked.filter(mine).length && tn(looked.filter(mine).length, "{n} checked by you", "{n} checked by you"),
      count("mismatch") && tn(count("mismatch"), "{n} differs from its record", "{n} differ from their records"),
      count("unverified") && tn(count("unverified"), "{n} not verified", "{n} not verified"),
      count("failed") && tn(count("failed"), "{n} could not be checked", "{n} could not be checked"),
      pending > 0 && onlineChecks() && t("checking {n}…", { n: pending }),
      !onlineChecks() && looked.length > 0 && t("online checks are off"),
    ].filter(Boolean);
  const link = (unit: string | null, label: string) => {
    const index = changeOf(unit);
    return index >= 0 ? (
      <button type="button" className="link" onClick={() => onSelect(index)}>
        {label}
      </button>
    ) : (
      <span>{label}</span>
    );
  };
  return (
    <div className="banner references-banner" role="status">
      <details open={flagged.length > 0 || references.missing.length > 0}>
        <summary>
          <strong>{t("Bibliography")}</strong> · {summary.join(" · ")}
        </summary>
        {(flagged.length > 0 || references.missing.length > 0) && (
          <ul className="references-flagged">
            {flagged.map(({ entry, reasons }) => (
              <li key={entry.id}>
                {link(entry.unit, entry.key)} — {reasons.join(gap())}
              </li>
            ))}
            {references.missing.map((cite, i) => (
              <li key={`missing-${i}`}>
                {link(cite.unit, `\\cite{${cite.key}}`)} — {t("No bibliography entry has this key.")}{" "}
                <span className="muted">{where(cite)}</span>
              </li>
            ))}
          </ul>
        )}
        {count("failed") > 0 && (
          <button type="button" className="link" onClick={onRetry}>
            {t("Check again")}
          </button>
        )}
      </details>
    </div>
  );
}

/** Asks before accepting entries that are not verified. */
export function ConfirmReferences({ items, staging, onCancel, onConfirm }: {
  items: { label: string; reasons: string[] }[];
  staging: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const confirm = useRef<HTMLButtonElement>(null);
  useEffect(() => confirm.current?.focus(), []);
  return (
    <div className="help-backdrop" onClick={onCancel}>
      <dialog open aria-labelledby="references-confirm-title" className="references-confirm" onClick={(e) => e.stopPropagation()}>
        <h2 id="references-confirm-title">
          {staging ? t("Stage bibliography entries that are not verified?") : t("Accept bibliography entries that are not verified?")}
        </h2>
        <ul>
          {items.map((item, i) => (
            <li key={i}>
              <code>{item.label}</code> — {item.reasons.join(gap())}
            </li>
          ))}
        </ul>
        <p className="muted">
          {t("An agent can write an entry for a work that does not exist, or with the wrong authors, year or DOI. Check each one before it goes into your paper.")}
        </p>
        <div className="references-confirm-actions">
          <button type="button" onClick={onCancel}>
            {t("Cancel")}
          </button>
          <button type="button" className="accept" ref={confirm} onClick={onConfirm}>
            {staging ? t("Stage anyway") : t("Accept anyway")}
          </button>
        </div>
      </dialog>
    </div>
  );
}
