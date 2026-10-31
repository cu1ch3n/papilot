import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { applyUnits, revertUnits } from "./changes.ts";
import { now, readBytes, readJson, same, writeOrDelete } from "./files.ts";
import { cleanPath, merge3 } from "./git.ts";
import type { App } from "../server.ts";
import type {
  Action,
  ActionDetail,
  ActionKind,
  Decision,
  Feedback,
  FeedbackItem,
  History,
  Message,
  MessageData,
  PageState,
  RenderedRound,
  Round,
  RoundDetail,
  Summary,
  Task,
  Unit,
  Write,
} from "../types.ts";
const DECIDED: Record<ActionKind, Decision> = {
  accept: "accepted",
  reject: "rejected",
  comment: "commented",
};
const LIVE = new Set(["applying", "applied", "undoing"]);
export class Conflict extends Error {}
const snippet = (text: string) => {
  text = text.replace(/\n+$/, "");
  return text.length <= 400 ? text : text.slice(0, 400) + " …";
};
export function safePath(root: string, file: string) {
  cleanPath(file);
  const target = path.resolve(root, file),
    realRoot = fs.realpathSync(root);
  let current = target;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) throw new Error("Invalid path: " + file);
    current = parent;
  }
  const resolved = fs.realpathSync(current);
  if (
    (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) ||
    (resolved !== realRoot && !resolved.startsWith(realRoot + path.sep))
  )
    throw new Error("Refusing to write outside the working tree: " + file);
  return target;
}
export class Review {
  constructor(public app: App) {}
  latestRound(name: string) {
    return this.app.store.one<Round>(
      "SELECT * FROM rounds WHERE task=? ORDER BY number DESC LIMIT 1",
      name,
    );
  }
  round(name: string, number: number) {
    const found = this.app.store.one<Round>(
      "SELECT * FROM rounds WHERE task=? AND number=?",
      name,
      number,
    );
    if (!found)
      throw new Error(
        `Round ${number} of ${JSON.stringify(name)} does not exist.`,
      );
    return found;
  }
  actions(name: string, number: number) {
    return this.app.store.all<Action>(
      "SELECT * FROM actions WHERE task=? AND round=? ORDER BY seq",
      name,
      number,
    );
  }
  decisions(name: string, round: Round): Record<string, Decision> {
    const result: Record<string, Decision> = Object.fromEntries(
      round.units.map((u) => [u.id, "pending"]),
    );
    for (const action of this.actions(name, round.number))
      if (LIVE.has(action.status))
        for (const change of action.changes)
          result[change] = DECIDED[action.kind];
    return result;
  }
  comments(name: string, number: number) {
    return Object.fromEntries(
      this.actions(name, number)
        .filter((a) => a.kind === "comment" && LIVE.has(a.status))
        .flatMap((a) => a.changes.map((c) => [c, a.body])),
    );
  }
  counts(
    name: string,
    round = this.latestRound(name),
  ): Record<Decision, number> {
    const values = round ? Object.values(this.decisions(name, round)) : [];
    return {
      accepted: values.filter((v) => v === "accepted").length,
      rejected: values.filter((v) => v === "rejected").length,
      commented: values.filter((v) => v === "commented").length,
      pending: values.filter((v) => v === "pending").length,
    };
  }
  lastChange(name: string) {
    return this.app.store.one<{ id: number | null }>(
      "SELECT MAX(id) AS id FROM messages WHERE task=? AND kind IN ('accept','reject','undo')",
      name,
    )!.id;
  }
  undoEntry(name: string) {
    const latest = this.latestRound(name),
      action = this.app.store.one<Action>(
        "SELECT * FROM actions WHERE task=? AND status='applied' ORDER BY seq DESC LIMIT 1",
        name,
      );
    const delivered = this.app.delivery.get(name);
    return action && latest && action.round === latest.number && (!delivered || action.seq > delivered.seq) ? action : null;
  }
  summary(name: string): Summary {
    const task = this.app.tasks.get(name),
      latest = this.latestRound(name),
      job = this.app.publisher.current(name),
      counts = this.counts(name, latest),
      number = latest?.number ?? null;
    const notes =
      latest &&
      this.app.store.one(
        "SELECT id FROM messages WHERE task=? AND kind='note' AND created>? LIMIT 1",
        name,
        latest.created,
      );
    const notReverted =
      latest &&
      this.actions(name, latest.number).some(
        (a) =>
          a.kind === "reject" &&
          LIVE.has(a.status) &&
          a.detail.not_reverted?.length,
      );
    let state: Summary["state"], next: string;
    if (job && ["queued", "running"].includes(job.status)) {
      state = "building";
      next = "A round is being built. Run `publish` again to wait for it.";
    } else if (
      job?.status === "failed" &&
      (!latest || job.created > latest.created)
    ) {
      state = "build_failed";
      next =
        job.result.next ||
        "Fix the problem in the worktree, then publish again.";
    } else if (!latest) {
      state = "editing";
      next = "Edit files in the worktree, then run `publish`.";
    } else if (counts.pending) {
      state = "reviewing";
      next = `The user is reviewing round ${number} (${counts.pending} changes left). Keep this turn open with \`feedback --wait\`, then continue automatically.`;
    } else if (counts.commented || notes || notReverted) {
      state = "revise";
      next =
        "Revise the commented changes in the worktree, then `publish`. Rejected changes were already reverted in your worktree" +
        (notReverted ? " except where noted." : ".");
    } else {
      state = "done";
      next =
        "Every change is decided. Report completion and leave the review open for inspection and undo. Run `finish` only when the user asks to clean up the review.";
    }
    return {
      task: name,
      title: task.title,
      state,
      round: number,
      counts,
      next,
    };
  }
  pageState(name: string, number?: number): PageState {
    const task = this.app.tasks.get(name, false),
      latest = this.latestRound(name);
    number ||= latest?.number;
    const round = number ? this.round(name, number) : null,
      undo =
        round && latest && number === latest.number
          ? this.undoEntry(name)
          : null,
      job = this.app.publisher.current(name);
    this.app.viewers.set(name, now());
    return {
      csrf: this.app.csrf,
      task: name,
      title: task.title,
      closed: Boolean(task.closed),
      state: task.closed ? null : this.summary(name).state,
      latest: latest?.number ?? null,
      history: this.app.store.all<{ number: number; created: number }>(
        "SELECT number,created FROM rounds WHERE task=? ORDER BY number DESC",
        name,
      ),
      round: number ?? null,
      revision: round?.after ?? null,
      decisions: round ? this.decisions(name, round) : {},
      comments: round ? this.comments(name, round.number) : {},
      undo: undo
        ? { id: undo.id, kind: undo.kind, changes: undo.changes }
        : null,
      job: job
        ? {
            id: job.id,
            status: job.status,
            phase: job.phase,
            created: job.created,
            ahead: job.status === "queued" ? this.app.publisher.ahead(job) : 0,
            ...job.result,
          }
        : null,
    };
  }
  roundDetail(name: string, number: number): RoundDetail {
    const round = this.round(name, number),
      render = readJson<RenderedRound>(
        path.join(
          this.app.state,
          "rounds",
          name,
          String(number).padStart(3, "0"),
          "round.json",
        ),
        { units: {}, sections: [], loose: [] },
      ),
      history = this.history(name, round);
    // Earlier releases stored a single after strip as an object. Keep those rounds readable.
    for (const block of [
      ...render.sections
        .flatMap((s) => s.blocks)
        .filter((b) => b.kind === "change"),
      ...render.loose,
    ]) {
      if (!Array.isArray(block.after))
        block.after = block.after ? [block.after] : [];
      block.kind = "change";
    }
    return {
      task: name,
      round: number,
      before: round.before,
      after: round.after,
      units: round.units.map((u) => ({
        ...u,
        ...render.units[u.id],
        ...(history[u.id] ? { history: history[u.id] } : {}),
      })),
      sections: render.sections,
      loose: render.loose,
      warnings: round.summary.warnings ?? [],
      files: `/files/${name}/${number}/`,
      ...(render.references ? { references: render.references } : {}),
    };
  }
  history(name: string, round: Round): Record<string, History[]> {
    if (round.number === 1) return {};
    const previous = this.round(name, round.number - 1),
      comments = this.comments(name, previous.number),
      result: Record<string, History[]> = {};
    for (const unit of round.units)
      for (const old of previous.units)
        if (
          comments[old.id] &&
          old.file === unit.file &&
          ((old.old_text && old.old_text === unit.old_text) ||
            Math.max(old.old_start, unit.old_start) <=
              Math.min(old.old_end, unit.old_end))
        )
          (result[unit.id] ??= []).push({
            round: previous.number,
            change: old.id,
            comment: comments[old.id],
            new_text: old.new_text,
          });
    return result;
  }
  feedback(name: string, after = 0): Feedback {
    this.app.tasks.get(name);
    const rows = this.app.store.all<Message>(
        "SELECT * FROM messages WHERE task=? AND id>? ORDER BY id",
        name,
        after,
      ),
      undone = new Set(
        this.app.store
          .all<{ id: string }>(
            "SELECT id FROM actions WHERE task=? AND status='undone'",
            name,
          )
          .map((a) => a.id),
      ),
      items: FeedbackItem[] = [];
    for (const message of rows) {
      if (
        (message.kind === "undo" && (message.data.message ?? 0) > after) ||
        (message.kind !== "undo" &&
          message.action &&
          undone.has(message.action))
      )
        continue;
      const item: FeedbackItem = {
        id: message.id,
        kind: message.kind,
        round: message.round,
      };
      if (message.body) item.text = message.body;
      const changes = message.data.changes ?? [];
      if (changes.length && message.round) {
        const units = new Map(
          this.round(name, message.round).units.map((u) => [u.id, u]),
        );
        item.changes = ["comment", "reject"].includes(message.kind)
          ? changes
              .filter((c) => units.has(c))
              .map((c) => {
                const u = units.get(c)!;
                return {
                  id: c,
                  file: u.file,
                  lines: [u.new_start, u.new_end] as [number, number],
                  old: snippet(u.old_text),
                  new: snippet(u.new_text),
                };
              })
          : changes;
      }
      if (message.data.not_reverted?.length)
        item.not_reverted = message.data.not_reverted;
      if (message.data.undid) item.undid = message.data.undid;
      items.push(item);
    }
    const summary = this.summary(name);
    if (items.some((i) => i.kind === "note"))
      summary.next =
        "Read and act on the user's message in `feedback` first, even while changes are pending or a round is building. Then follow the task state.";
    const job = this.app.publisher.current(name);
    return {
      ...summary,
      feedback: items,
      cursor: rows.at(-1)?.id ?? after,
      ...(job?.status === "failed" ? { build_error: job.result } : {}),
      warnings: this.latestRound(name)?.summary.warnings ?? [],
    };
  }
  decide(
    name: string,
    data: {
      action: ActionKind;
      id?: string;
      changes: string[];
      round: number;
      body?: string;
    },
  ) {
    const task = this.app.tasks.get(name),
      kind = data.action;
    this.app.delivery.assertReady(name);
    if (!Object.hasOwn(DECIDED, kind))
      throw new Error("The action must be accept, reject or comment.");
    const identity = data.id || randomUUID();
    if (!/^[A-Za-z0-9-]{1,80}$/.test(identity))
      throw new Error("Invalid action id.");
    const previous = this.app.store.one<Action>(
        "SELECT * FROM actions WHERE id=?",
        identity,
      ),
      chosen = data.changes;
    if (previous) {
      if (
        previous.task !== name ||
        previous.round !== data.round ||
        previous.kind !== kind ||
        (kind === "comment" && previous.body !== (data.body || "").trim()) ||
        JSON.stringify(previous.changes) !== JSON.stringify(chosen)
      )
        throw new Error(
          "This action id was already used for another decision.",
        );
      if (previous.status !== "applied")
        throw new Error("That decision was undone or failed. Make it again.");
      return this.pageState(name);
    }
    const latest = this.latestRound(name);
    if (!latest || data.round !== latest.number)
      throw new Error("A newer round is available. Reload the page.");
    const decisions = this.decisions(name, latest);
    if (
      !Array.isArray(chosen) ||
      !chosen.length ||
      new Set(chosen).size !== chosen.length ||
      chosen.some((c) => decisions[c] !== "pending")
    )
      throw new Error("These changes were already decided. Reload the page.");
    const body = (data.body || "").trim();
    if (kind === "comment" && !body) throw new Error("Write a comment first.");
    if (body.length > 20000)
      throw new Error("Comments are limited to 20,000 characters.");
    const selected = chosen.map((c) => latest.units.find((u) => u.id === c)!);
    if (kind === "accept") this.accept(task, latest, identity, selected);
    else if (kind === "reject") this.reject(task, latest, identity, selected);
    else
      this.app.store.transaction(() => {
        this.record(
          identity,
          task,
          latest,
          kind,
          chosen,
          body,
          {},
          [],
          "applied",
          false,
        );
        this.message(name, latest.number, "comment", identity, body, {
          changes: chosen,
        });
      });
    return this.pageState(name);
  }
  byFile(units: Unit[]) {
    const groups: Record<string, Unit[]> = {};
    for (const unit of units) (groups[unit.file] ??= []).push(unit);
    return groups;
  }
  accept(task: Task, round: Round, identity: string, units: Unit[]) {
    const app = this.app,
      writes: [string, Buffer | null, Buffer | null][] = [],
      accepted: Record<string, Buffer | null> = {},
      conflicts: string[] = [],
      groups = this.byFile(units),
      files = Object.keys(groups),
      before = app.repo.blobs(round.before, files),
      after = app.repo.blobs(round.after, files),
      records = app.repo.blobs(task.accepted, files);
    for (const [file, group] of Object.entries(groups)) {
      const proposed = applyUnits(before[file], after[file], group),
        target = task.deferred ? "" : safePath(app.root, file),
        current = task.deferred ? records[file] : readBytes(target),
        [merged, conflict] = merge3(current, before[file], proposed),
        [recorded, recordedConflict] = merge3(
          records[file],
          before[file],
          proposed,
        );
      if (conflict || recordedConflict) conflicts.push(file);
      else if (!task.deferred && !same(merged, current)) writes.push([target, current, merged]);
      accepted[file] = recorded;
    }
    if (conflicts.length)
      throw new Conflict(
        `${units.map((u) => u.id).join(", ")} can't be applied: ${conflicts.join(", ")} changed in your manuscript since this round was published. Nothing was written. Comment on the change to have the agent redo it.`,
      );
    const afterCommit = app.repo.commitWith(
      task.accepted,
      accepted,
      "latex-review: accept " + units.map((u) => u.id).join(", "),
    );
    this.record(
      identity,
      task,
      round,
      "accept",
      units.map((u) => u.id),
      "",
      { accepted_before: task.accepted, accepted_after: afterCommit },
      writes,
    );
    this.carryOut(identity, "apply");
  }
  reject(task: Task, round: Round, identity: string, units: Unit[]) {
    const writes: [string, Buffer | null, Buffer | null][] = [],
      kept: string[] = [],
      groups = this.byFile(units),
      files = Object.keys(groups),
      before = this.app.repo.blobs(round.before, files),
      after = this.app.repo.blobs(round.after, files);
    for (const [file, group] of Object.entries(groups)) {
      const reverted = revertUnits(before[file], after[file], group),
        target = safePath(task.worktree, file),
        current = readBytes(target),
        [merged, conflict] = merge3(current, after[file], reverted);
      if (conflict) kept.push(file);
      else if (!same(merged, current)) writes.push([target, current, merged]);
    }
    this.record(
      identity,
      task,
      round,
      "reject",
      units.map((u) => u.id),
      "",
      { not_reverted: kept },
      writes,
    );
    this.carryOut(identity, "apply");
  }
  record(
    identity: string,
    task: Task,
    round: Round,
    kind: ActionKind,
    changes: string[],
    body: string,
    detail: ActionDetail,
    writes: [string, Buffer | null, Buffer | null][],
    status: Action["status"] = "applying",
    transaction = true,
  ) {
    const work = () => {
      this.app.store.execute(
        "INSERT INTO actions(id,task,round,kind,changes,body,status,detail,created) VALUES(?,?,?,?,?,?,?,?,?)",
        identity,
        task.name,
        round.number,
        kind,
        JSON.stringify(changes),
        body,
        status,
        JSON.stringify(detail),
        now(),
      );
      for (const [file, expected, target] of writes)
        this.app.store.execute(
          "INSERT INTO writes(action,phase,path,expected,target) VALUES(?,?,?,?,?)",
          identity,
          "apply",
          file,
          expected,
          target,
        );
    };
    if (transaction) this.app.store.transaction(work);
    else work();
  }
  perform(identity: string, phase: Write["phase"]) {
    const rows = this.app.store.all<Write>(
        "SELECT * FROM writes WHERE action=? AND phase=?",
        identity,
        phase,
      ),
      current = new Map(rows.map((r) => [r.path, readBytes(r.path)])),
      stale = rows.filter(
        (r) =>
          !same(current.get(r.path)!, r.expected) &&
          !same(current.get(r.path)!, r.target),
      );
    if (stale.length)
      throw new Conflict(
        "These files changed while the decision was being applied: " +
          stale.map((r) => r.path).join(", "),
      );
    for (const row of rows)
      if (!same(current.get(row.path)!, row.target))
        writeOrDelete(row.path, row.target);
  }
  carryOut(identity: string, phase: Write["phase"]) {
    try {
      this.perform(identity, phase);
    } catch (error) {
      for (const row of this.app.store.all<Write>(
        "SELECT * FROM writes WHERE action=? AND phase=?",
        identity,
        phase,
      ))
        if (
          same(readBytes(row.path), row.target) &&
          !same(row.target, row.expected)
        )
          writeOrDelete(row.path, row.expected);
      this.app.store.transaction(() => {
        this.app.store.execute(
          "DELETE FROM writes WHERE action=? AND phase=?",
          identity,
          phase,
        );
        this.app.store.execute(
          "UPDATE actions SET status=? WHERE id=?",
          phase === "apply" ? "failed" : "applied",
          identity,
        );
      });
      throw error;
    }
    this.complete(identity);
  }
  complete(identity: string) {
    const app = this.app,
      action = app.store.one<Action>(
        "SELECT * FROM actions WHERE id=?",
        identity,
      )!;
    if (!["applying", "undoing"].includes(action.status)) return;
    const applying = action.status === "applying",
      accepted = applying
        ? action.detail.accepted_after
        : action.detail.accepted_before;
    app.store.transaction(() => {
      if (action.kind === "accept")
        app.store.execute(
          "UPDATE tasks SET accepted=? WHERE name=?",
          accepted!,
          action.task,
        );
      app.store.execute(
        "UPDATE actions SET status=? WHERE id=?",
        applying ? "applied" : "undone",
        identity,
      );
      if (applying)
        this.message(action.task, action.round, action.kind, identity, "", {
          changes: action.changes,
          ...(action.detail.not_reverted?.length
            ? { not_reverted: action.detail.not_reverted }
            : {}),
        });
      else {
        const original = app.store.one<{ id: number }>(
          "SELECT id FROM messages WHERE action=? AND kind!='undo' ORDER BY id LIMIT 1",
          identity,
        );
        this.message(action.task, action.round, "undo", identity, "", {
          changes: action.changes,
          undid: action.kind,
          message: original?.id ?? 0,
        });
      }
    });
    if (action.kind === "accept")
      app.repo.updateRef(
        `refs/latex-review/${action.task}/accepted`,
        accepted!,
      );
  }
  message(
    name: string,
    number: number | null,
    kind: Message["kind"],
    action: string | null,
    body: string,
    data: MessageData,
  ) {
    this.app.store.execute(
      "INSERT INTO messages(task,round,kind,action,body,data,created) VALUES(?,?,?,?,?,?,?)",
      name,
      number,
      kind,
      action,
      body,
      JSON.stringify(data),
      now(),
    );
  }
  note(name: string, body: string) {
    body = (body || "").trim();
    if (!body || body.length > 20000)
      throw new Error("Write a message (at most 20,000 characters).");
    this.app.tasks.get(name);
    this.message(
      name,
      this.latestRound(name)?.number ?? null,
      "note",
      null,
      body,
      {},
    );
    return this.pageState(name);
  }
  undo(name: string, identity: string) {
    this.app.delivery.assertReady(name);
    const app = this.app,
      task = app.tasks.get(name),
      action = this.undoEntry(name);
    if (!action || action.id !== identity)
      throw new Error("Nothing to undo here any more. Reload the page.");
    if (
      action.kind === "accept" &&
      task.accepted !== action.detail.accepted_after
    )
      throw new Conflict(
        "The accepted text changed in an unexpected way; nothing was undone.",
      );
    const restores: [string, Buffer | null, Buffer | null][] = [],
      conflicts: string[] = [];
    for (const write of app.store.all<Write>(
      "SELECT * FROM writes WHERE action=? AND phase='apply'",
      identity,
    )) {
      const current = readBytes(write.path),
        [restored, conflict] = merge3(current, write.target, write.expected);
      if (conflict) conflicts.push(write.path);
      else if (!same(restored, current))
        restores.push([write.path, current, restored]);
    }
    if (conflicts.length)
      throw new Conflict(
        `Can't undo: ${conflicts.map((p) => path.relative(app.root, p)).join(", ")} changed since the decision. Nothing was undone.`,
      );
    app.store.transaction(() => {
      app.store.execute(
        "UPDATE actions SET status='undoing' WHERE id=?",
        identity,
      );
      for (const [file, expected, target] of restores)
        app.store.execute(
          "INSERT INTO writes(action,phase,path,expected,target) VALUES(?,'undo',?,?,?)",
          identity,
          file,
          expected,
          target,
        );
    });
    this.carryOut(identity, "undo");
    return { ...this.pageState(name), restored: action.changes };
  }
  recover() {
    for (const action of this.app.store.all<Action>(
      "SELECT * FROM actions WHERE status IN ('applying','undoing') ORDER BY seq",
    )) {
      try {
        this.carryOut(
          action.id,
          action.status === "applying" ? "apply" : "undo",
        );
      } catch {
        /* Journal state records a recoverable conflict; leave later actions available. */
      }
    }
  }
}
