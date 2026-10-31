import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/server/store.ts';
import { Workspace, accountUsage, acceptedFiles, agentModel, lightModel } from '../src/server/workspace.ts';
import { findSkill } from '../src/server/skills.ts';
import { reviewInstructions } from '../src/conversation.ts';
import { RpcResponseError, type Codex } from '../src/server/codex.ts';
import type { ReviewClient } from '../src/server/review.ts';
import type { PendingReview, Run, Task } from '../src/shared.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const feedback = { cursor: 7, feedback: [{ body: 'Preserve the boundary condition.' }] };
const summary = { state: 'reviewing', round: 1, counts: { pending: 1 } };

class FakeCodex extends EventEmitter {
  ready = false;
  calls: { method: string; params: any }[] = [];
  replies: { id: string | number; result: unknown }[] = [];
  rejections: { id: string | number; message: string }[] = [];
  handler = async (method: string, _params: any): Promise<any> => method === 'turn/start' ? { turn: { id: 'turn-new' } } : { thread: { id: 'thread' } };
  async request(method: string, params: any) { this.calls.push({ method, params }); return this.handler(method, params); }
  respond(id: string | number, result: unknown) { this.replies.push({ id, result }); }
  reject(id: string | number, message: string) { this.rejections.push({ id, message }); }
  close() { this.ready = false; }
}

function fixture(reviewHandler?: (method: string, route: string, body?: unknown) => Promise<any>, options: { file?: string; reviewUrl?: string; claude?: FakeCodex } = {}) {
  const store = new Store(options.file || ':memory:');
  const codex = new FakeCodex();
  const calls: { method: string; route: string; body?: unknown }[] = [];
  const invoke = async (method: string, route: string, body?: unknown) => {
    calls.push({ method, route, body });
    if (reviewHandler) return reviewHandler(method, route, body);
    if (route.includes('/feedback')) return feedback;
    if (route.includes('/jobs/')) return { status: 'done' };
    if (route.endsWith('/publish')) return { job: 'job' };
    return summary;
  };
  const review: ReviewClient = { url: options.reviewUrl || 'http://unused', token: 'test', get: route => invoke('GET', route), post: (route, body) => invoke('POST', route, body) };
  const workspace = new Workspace(store, codex as unknown as Codex, 2, async () => review, options.claude ? { claude: options.claude as unknown as Codex } : {});
  const task: Task = { id: 'task-id', projectId: 'paper', name: 'p-task', title: 'Task', instructions: 'Edit the introduction.', worktree: '/unused', threadId: 'thread', turnId: null, model: null, status: 'reviewing', createdAt: 1, updatedAt: 1, feedbackCursor: 0, error: null, review: null };
  store.saveProject({ id: task.projectId, name: 'Paper', path: '/unused', createdAt: 1 });
  store.saveTask(task);
  (workspace as any).loaded.add('thread');
  workspace.runtime.authenticated = true;
  return { store, codex, workspace, task, calls, close() { workspace.close(); store.close(); } };
}

function uncertainRun(f: ReturnType<typeof fixture>, active = true) {
  const run: Run = { id: 'pending-run', taskId: f.task.id, requestKey: 'pending-request', prompt: 'An uncertain revision.', feedbackCursor: 7, status: 'uncertain', createdAt: 1, finishedAt: null };
  f.store.saveRun(run);
  f.store.updateTask(f.task.id, { status: 'uncertain', turnId: null, pendingRunId: run.id, error: 'Check task status.' });
  if (active) (f.workspace as any).active.set(f.task.id, run);
  return run;
}

function identifiedTurn(run: Run, status = 'inProgress') {
  return { id: 'turn-confirmed', status, items: [{ type: 'userMessage', clientId: run.id }] };
}

const pendingReview: PendingReview = { route: '/api/tasks/p-task/decide', body: { id: 'decision-123', action: 'accept', round: 1, changes: ['change-1'] }, previousStatus: 'reviewing' };
const pageState = { csrf: 'test', task: 'p-task', title: 'Task', closed: false, state: 'reviewing', latest: 1, round: 1, revision: 'revision', decisions: { 'change-1': 'accepted' }, comments: {}, undo: null, job: null };

async function reviewServer(handler: (request: IncomingMessage, response: ServerResponse, body: any) => void | Promise<void>) {
  const calls: { route: string; body: any; token: string | string[] | undefined }[] = [];
  const server = createServer(async (request, response) => {
    try {
      let text = '';
      for await (const chunk of request) text += chunk;
      const body = text ? JSON.parse(text) : undefined;
      calls.push({ route: request.url!, body, token: request.headers['x-review-token'] });
      await handler(request, response, body);
    } catch { response.destroy(); }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('The review fixture did not bind an HTTP port.');
  return { calls, url: `http://127.0.0.1:${address.port}`, async close() { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}

test('enqueue preserves a newer building status after feedback loading yields', async () => {
  const gate = deferred<typeof feedback>();
  const f = fixture(async () => gate.promise);
  try {
    const pending = f.workspace.enqueue(f.task.id, 'Revise the wording.', 'request');
    await tick();
    f.store.updateTask(f.task.id, { status: 'building' });
    gate.resolve(feedback);
    const run = await pending;
    assert.equal(f.store.task(f.task.id).status, 'building');
    assert.equal(f.store.runByKey(run.requestKey)?.status, 'queued');
  } finally { f.close(); }
});

test('concurrent retries with one request key persist only one run and message', async () => {
  const gate = deferred<typeof feedback>();
  const f = fixture(async () => gate.promise);
  try {
    const first = f.workspace.enqueue(f.task.id, 'Revise once.', 'same-request');
    const retry = f.workspace.enqueue(f.task.id, 'Revise once.', 'same-request');
    gate.resolve(feedback);
    const [a, b] = await Promise.all([first, retry]);
    assert.equal(a.id, b.id);
    assert.equal(f.store.runs().length, 1);
    assert.equal(f.store.items(f.task.id).length, 1);
  } finally { f.close(); }
});

test('parallel distinct messages cannot both occupy the one queued slot', async () => {
  const gate = deferred<typeof feedback>();
  const f = fixture(async () => gate.promise);
  try {
    const first = f.workspace.enqueue(f.task.id, 'First instruction.', 'first');
    const second = f.workspace.enqueue(f.task.id, 'Second instruction.', 'second');
    const results = Promise.allSettled([first, second]);
    gate.resolve(feedback);
    const settled = await results;
    assert.equal(settled.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(settled.filter(result => result.status === 'rejected').length, 1);
    assert.equal(f.store.runs().length, 1);
    assert.equal(f.store.items(f.task.id).length, 1);
  } finally { f.close(); }
});

test('a review write reserves the worktree until it finishes', async () => {
  const gate = deferred<void>();
  const f = fixture();
  try {
    f.codex.ready = true;
    const writing = f.workspace.reviewWrite(f.task.id, true, () => gate.promise);
    await f.workspace.enqueue(f.task.id, 'Next revision.', 'next', false);
    await tick();
    assert.equal(f.codex.calls.length, 0);
    assert.throws(() => f.workspace.publish(f.task.id));
    await assert.rejects(f.workspace.reviewWrite(f.task.id, true, async () => {}));
    gate.resolve();
    await writing;
    await tick();
    assert.equal(f.codex.calls.filter(call => call.method === 'turn/start').length, 1);
    assert.equal(f.store.task(f.task.id).status, 'running');
  } finally { gate.resolve(); f.close(); }
});

test('publication reserves the worktree and rejects duplicate builds and review writes', async () => {
  const gate = deferred<{ status: string }>();
  const f = fixture(async (_method, route) => route.includes('/jobs/') ? gate.promise : route.endsWith('/publish') ? { job: 'job' } : summary);
  try {
    f.codex.ready = true;
    const building = f.workspace.publish(f.task.id);
    assert.throws(() => f.workspace.publish(f.task.id));
    await assert.rejects(f.workspace.reviewWrite(f.task.id, true, async () => {}));
    await f.workspace.enqueue(f.task.id, 'Next revision.', 'next', false);
    await tick();
    assert.equal(f.codex.calls.length, 0);
    assert.equal(f.store.task(f.task.id).status, 'building');
    gate.resolve({ status: 'done' });
    await building;
    await tick();
    assert.equal(f.codex.calls.filter(call => call.method === 'turn/start').length, 1);
  } finally { gate.resolve({ status: 'done' }); f.close(); }
});

test('publication records each completed run result once and treats no new edits as no result', async () => {
  let round = 2, outcome = 'published';
  const f = fixture(async (_method, route) => route.includes('/jobs/') ? { status: 'done', outcome, round } : route.endsWith('/publish') ? { job: 'job' } : { ...summary, round });
  try {
    const run: Run = { id: 'finished-notes', taskId: f.task.id, requestKey: 'notes', prompt: 'Revise the notes.', status: 'completed', createdAt: 1, finishedAt: 2, reviewRound: 0 };
    f.store.saveRun(run);
    f.store.saveRun({ ...run, id: 'legacy-notes', requestKey: 'legacy', reviewRound: undefined });
    await f.workspace.publish(f.task.id);
    assert.equal(f.store.runByKey('notes')?.reviewRound, 2);
    assert.equal(f.store.runByKey('legacy')?.reviewRound, undefined, 'a new build cannot claim historical requests');
    round = 3;
    await f.workspace.publish(f.task.id);
    assert.equal(f.store.runByKey('notes')?.reviewRound, 2, 'later proposals cannot replace the original result');
    f.store.saveRun({ ...run, id: 'ignored-notes', requestKey: 'ignored' });
    outcome = 'unchanged';
    await f.workspace.publish(f.task.id);
    assert.equal(f.store.runByKey('ignored')?.reviewRound, null, 'an ignored request must not point at an older proposal');
  } finally { f.close(); }
});

test('comments remain available during an active turn while file decisions are blocked', async () => {
  const f = fixture();
  try {
    f.store.updateTask(f.task.id, { status: 'running', turnId: 'turn-new' });
    (f.workspace as any).active.set(f.task.id, { id: 'run' });
    assert.equal(await f.workspace.reviewWrite(f.task.id, false, async () => 'comment saved'), 'comment saved');
    await assert.rejects(f.workspace.reviewWrite(f.task.id, true, async () => {}));
    assert.throws(() => f.workspace.publish(f.task.id));
  } finally { f.close(); }
});

test('canceling queued feedback leaves it available for the next submission', async () => {
  const f = fixture();
  try {
    await f.workspace.enqueue(f.task.id, 'Apply the review comments.', 'first');
    assert.equal(f.store.task(f.task.id).feedbackCursor, 0);
    await f.workspace.interrupt(f.task.id);
    assert.equal(f.store.runByKey('first')?.status, 'interrupted');
    const retry = await f.workspace.enqueue(f.task.id, 'Apply the review comments.', 'retry');
    assert.match(retry.prompt, /Preserve the boundary condition/);
    assert.equal(f.store.task(f.task.id).feedbackCursor, 0);
    const afters = f.calls.filter(call => call.route.includes('/feedback')).map(call => new URL(call.route, 'http://unused').searchParams.get('after'));
    assert.ok(afters.length >= 2 && afters.every(after => after === '0'), afters.join());
  } finally { f.close(); }
});

test('unsent review feedback includes decisions and excludes feedback already queued for Codex', async () => {
  const items = [{ id: 3, kind: 'comment' }, { id: 5, kind: 'reject' }, { id: 7, kind: 'comment' }];
  const f = fixture(async (_method, route) => {
    if (!route.includes('/feedback')) return summary;
    const after = Number(new URL(route, 'http://unused').searchParams.get('after'));
    const feedback = items.filter(item => item.id > after);
    return { cursor: feedback.at(-1)?.id ?? after, feedback };
  });
  try {
    await f.workspace.refresh(f.task.id);
    assert.equal(f.store.task(f.task.id).review?.unsent, 3);
    await f.workspace.enqueue(f.task.id, 'Address the comments.', 'send');
    await f.workspace.refresh(f.task.id);
    assert.equal(f.store.task(f.task.id).review?.unsent, 0);
    await f.workspace.interrupt(f.task.id);
    await f.workspace.refresh(f.task.id);
    assert.equal(f.store.task(f.task.id).review?.unsent, 3, 'Pausing a queued message returns its decisions and comments to the unsent count');
  } finally { f.close(); }
});

test('accept-only, reject-only and undo feedback can be sent without comments', async () => {
  for (const kind of ['accept', 'reject', 'undo', 'note']) {
    const items = [{ id: 7, kind, round: 1, changes: ['change-1'] }];
    const f = fixture(async (_method, route) => {
      if (!route.includes('/feedback')) return { state: 'done', round: 1, counts: { pending: 0, accepted: kind === 'accept' ? 1 : 0, rejected: kind === 'reject' ? 1 : 0, commented: 0 } };
      const after = Number(new URL(route, 'http://unused').searchParams.get('after'));
      return { cursor: Math.max(after, 7), feedback: items.filter(item => item.id > after) };
    });
    try {
      await f.workspace.refresh(f.task.id);
      assert.equal(f.store.task(f.task.id).review?.unsent, 1, kind);
      const run = await f.workspace.enqueue(f.task.id, 'Continue from the review decisions.', 'send-decisions');
      assert.match(run.prompt, new RegExp(`"kind": "${kind}"`));
      assert.equal(run.feedbackCursor, 7);
      assert.equal((await f.workspace.enqueue(f.task.id, 'Continue from the review decisions.', 'send-decisions')).id, run.id);
      await f.workspace.refresh(f.task.id);
      assert.equal(f.store.task(f.task.id).review?.unsent, 0, kind);
      await f.workspace.interrupt(f.task.id);
      f.store.updateTask(f.task.id, { feedbackCursor: 7 });
      await f.workspace.refresh(f.task.id);
      assert.equal(f.store.task(f.task.id).review?.unsent, 0, 'Delivered feedback stays hidden');
    } finally { f.close(); }
  }
});

test('renaming a task changes only its title and is blocked during deletion', () => {
  const f = fixture();
  try {
    const renamed = f.workspace.renameTask(f.task.id, 'Clarify the abstract');
    assert.equal(renamed.title, 'Clarify the abstract');
    assert.equal(f.store.task(f.task.id).instructions, f.task.instructions);
    f.store.updateTask(f.task.id, { status: 'deleting' });
    assert.throws(() => f.workspace.renameTask(f.task.id, 'Another title'), /being deleted/);
  } finally { f.close(); }
});

test('archiving survives a restart, retains task history and review, and restores idempotently', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-archive-'));
  const file = path.join(dir, 'state.db'), f = fixture(undefined, { file });
  try {
    f.store.updateTask(f.task.id, { review: summary, committed: { hash: 'abc', accepted: 'text', at: 1 } });
    f.store.saveItem({ id: 'message', taskId: f.task.id, type: 'user', text: 'Keep this conversation.', createdAt: 1 });
    const before = f.store.task(f.task.id), items = f.store.items(f.task.id);
    const archived = f.workspace.archiveTask(f.task.id, true);
    assert.ok(archived.archivedAt);
    assert.deepEqual({ ...archived, archivedAt: undefined, updatedAt: before.updatedAt }, { ...before, archivedAt: undefined });
    assert.deepEqual(f.workspace.archiveTask(f.task.id, true), archived);
    await f.workspace.refresh(f.task.id);
    assert.equal(f.store.task(f.task.id).archivedAt, archived.archivedAt, 'review updates preserve the archive');
    const reopened = new Store(file);
    try {
      reopened.recover();
      assert.equal(reopened.task(f.task.id).archivedAt, archived.archivedAt);
      assert.deepEqual(reopened.items(f.task.id), items);
      assert.deepEqual(reopened.task(f.task.id).committed, before.committed);
    } finally { reopened.close(); }
    const restored = f.workspace.archiveTask(f.task.id, false);
    assert.equal(restored.archivedAt, null);
    assert.deepEqual(f.workspace.archiveTask(f.task.id, false), restored);
    assert.deepEqual(f.store.items(f.task.id), items);
    assert.equal(f.calls.some(call => call.method === 'POST'), false, 'archiving never writes to the review engine');
    f.store.updateTask(f.task.id, { status: 'running' });
    assert.equal(f.workspace.archiveTask(f.task.id, true).status, 'running', 'archiving does not interrupt a running task');
    f.store.updateTask(f.task.id, { status: 'deleting' });
    assert.throws(() => f.workspace.archiveTask(f.task.id, false), /being deleted/);
  } finally { f.close(); fs.rmSync(dir, { recursive: true }); }
});

test('leaving archives only a task that is still finished, and writing to it restores it', async () => {
  const f = fixture();
  try {
    const finished = { state: 'done', round: 1, counts: { accepted: 1 }, unsent: 1, comments: 0, files: [] };
    f.store.updateTask(f.task.id, { review: { ...finished, state: 'revise', counts: { commented: 1 }, comments: 1 } });
    assert.equal(f.workspace.archiveTask(f.task.id, true, true).archivedAt, undefined, 'a comment still waits for the agent');
    f.store.updateTask(f.task.id, { review: finished });
    assert.ok(f.workspace.archiveTask(f.task.id, true, true).archivedAt);
    await f.workspace.enqueue(f.task.id, 'One more pass on the abstract.', 'follow-up');
    assert.equal(f.store.task(f.task.id).archivedAt, null, 'a follow-up brings the task back');
    assert.equal(f.store.task(f.task.id).status, 'queued');
    assert.equal(f.workspace.archiveTask(f.task.id, true, true).archivedAt, null, 'new work keeps it listed');
    assert.ok(f.workspace.archiveTask(f.task.id, true).archivedAt, 'the author can still archive it by hand');
  } finally { f.close(); }
});

test('finished tasks from before auto-archiving are archived once', () => {
  const f = fixture();
  try {
    const finished = { state: 'done', round: 1, counts: { accepted: 1 }, unsent: 1, comments: 0, files: [] };
    f.store.updateTask(f.task.id, { review: finished });
    f.store.saveTask({ ...f.task, id: 'open-task', name: 'p-open', review: { ...finished, state: 'reviewing', counts: { pending: 2 } } });
    f.store.saveTask({ ...f.task, id: 'kept-task', name: 'p-kept', review: finished, archivedAt: 5 });
    let runs = 0;
    const sweep = () => { runs++; f.workspace.archiveFinished(); };
    f.store.migrate('archive-finished-tasks', sweep);
    assert.ok(f.store.task(f.task.id).archivedAt);
    assert.equal(f.store.task('open-task').archivedAt, undefined);
    assert.equal(f.store.task('kept-task').archivedAt, 5, 'an earlier archive keeps its time');
    f.workspace.archiveTask(f.task.id, false);
    f.store.migrate('archive-finished-tasks', sweep);
    assert.equal(runs, 1);
    assert.equal(f.store.task(f.task.id).archivedAt, null, 'a restored task is not archived again');
  } finally { f.close(); }
});

test('renaming a paper changes only its display name', () => {
  const f = fixture();
  try {
    const renamed = f.workspace.renameProject(f.task.projectId, 'Small Steps');
    assert.equal(renamed.name, 'Small Steps');
    assert.deepEqual(f.store.project(f.task.projectId), { id: f.task.projectId, name: 'Small Steps', path: '/unused', createdAt: 1 });
    assert.throws(() => f.workspace.renameProject('missing', 'Other'), /not found/);
  } finally { f.close(); }
});

test('feedback is marked delivered only after turn start is acknowledged', async () => {
  const ack = deferred<{ turn: { id: string } }>();
  const f = fixture();
  try {
    f.codex.handler = async () => ack.promise;
    f.codex.ready = true;
    await f.workspace.enqueue(f.task.id, 'Apply the review comments.', 'request');
    await tick();
    assert.equal(f.store.task(f.task.id).feedbackCursor, 0);
    ack.resolve({ turn: { id: 'turn-new' } });
    await tick();
    assert.equal(f.store.task(f.task.id).feedbackCursor, 7);
  } finally { ack.resolve({ turn: { id: 'turn-new' } }); f.close(); }
});

test('old completion and failure callbacks cannot finalize a newer active run', async () => {
  const f = fixture();
  try {
    const run: Run = { id: 'new-run', taskId: f.task.id, requestKey: 'new-request', prompt: 'New instruction.', status: 'running', createdAt: 1, finishedAt: null };
    f.store.saveRun(run);
    f.store.updateTask(f.task.id, { status: 'running', turnId: 'turn-new' });
    (f.workspace as any).active.set(f.task.id, run);
    await (f.workspace as any).notification({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn-old', status: 'completed' } } });
    (f.workspace as any).failRun({ ...run, id: 'old-run' }, new Error('Late failure'));
    assert.equal(f.store.task(f.task.id).status, 'running');
    assert.equal(f.store.task(f.task.id).turnId, 'turn-new');
    assert.equal(f.store.runByKey('new-request')?.status, 'running');
    assert.equal((f.workspace as any).active.get(f.task.id)?.id, run.id);
    assert.equal(f.calls.length, 0);
  } finally { f.close(); }
});

test('a fast completion before the turn/start response is applied to its owning run', async () => {
  const ack = deferred<{ turn: { id: string } }>();
  const f = fixture();
  try {
    f.codex.handler = async () => ack.promise;
    f.codex.ready = true;
    await f.workspace.enqueue(f.task.id, 'Small revision.', 'request', false);
    await tick();
    await (f.workspace as any).notification({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn-fast', status: 'completed' } } });
    assert.equal(f.store.runByKey('request')?.status, 'running');
    ack.resolve({ turn: { id: 'turn-fast' } });
    await tick();
    assert.equal(f.store.runByKey('request')?.status, 'completed');
    assert.equal(f.store.task(f.task.id).status, 'reviewing');
    assert.equal(f.calls.filter(call => call.route.endsWith('/publish')).length, 1);
    assert.equal((f.workspace as any).active.has(f.task.id), false);
  } finally { ack.resolve({ turn: { id: 'turn-fast' } }); f.close(); }
});

test('pause invalidates a message still loading feedback before it reaches the queue', async () => {
  const gate = deferred<typeof feedback>();
  const f = fixture(async () => gate.promise);
  try {
    const pending = f.workspace.enqueue(f.task.id, 'Delayed instruction.', 'request');
    const rejected = assert.rejects(pending);
    await tick();
    await f.workspace.interrupt(f.task.id);
    gate.resolve(feedback);
    await rejected;
    assert.equal(f.store.task(f.task.id).status, 'interrupted');
    assert.equal(f.store.runs().length, 0);
    assert.equal(f.store.items(f.task.id).length, 0);
  } finally { gate.resolve(feedback); f.close(); }
});

test('an uncertain turn/start outcome retains its worktree reservation', async () => {
  const f = fixture();
  try {
    f.codex.handler = async () => { throw new Error('Codex request timed out: turn/start'); };
    f.codex.ready = true;
    const run = await f.workspace.enqueue(f.task.id, 'Possibly started instruction.', 'request', false);
    await tick();
    assert.equal(f.store.task(f.task.id).status, 'uncertain');
    assert.equal(f.store.runByKey('request')?.status, 'uncertain');
    assert.equal((f.store.task(f.task.id) as any).pendingRunId, run.id);
    await assert.rejects(f.workspace.reviewWrite(f.task.id, true, async () => {}));
    assert.throws(() => f.workspace.publish(f.task.id));
    await assert.rejects(f.workspace.enqueue(f.task.id, 'A later instruction.', 'next', false));
    await tick();
    assert.equal(f.codex.calls.filter(call => call.method === 'turn/start').length, 1);
  } finally { f.close(); }
});

test('an explicit turn/start rejection safely releases its reservation', async () => {
  const f = fixture();
  try {
    f.codex.handler = async () => { throw new RpcResponseError('Model is unavailable.'); };
    f.codex.ready = true;
    await f.workspace.enqueue(f.task.id, 'Rejected revision.', 'request', false);
    await tick();
    assert.equal(f.store.task(f.task.id).status, 'failed');
    assert.equal(f.store.task(f.task.id).pendingRunId, null);
    assert.equal(f.store.runByKey('request')?.status, 'failed');
    assert.equal((f.workspace as any).active.has(f.task.id), false);
    assert.equal(await f.workspace.reviewWrite(f.task.id, true, async () => 'allowed'), 'allowed');
  } finally { f.close(); }
});

test('reconcile restores a persisted active turn by its message identity and replays its input request', async () => {
  const f = fixture();
  try {
    const run = uncertainRun(f, false);
    const request = { id: 23, method: 'item/tool/requestUserInput', params: { threadId: 'thread', turnId: 'turn-confirmed', questions: [{ id: 'scope', question: 'Which section?' }] } };
    (f.workspace as any).earlyRequests.set(f.task.id, [request]);
    f.codex.handler = async () => ({ thread: { status: { type: 'active' }, turns: [identifiedTurn(run)] } });
    const task = await f.workspace.reconcile(f.task.id);
    assert.equal(task.status, 'waiting_input');
    assert.equal(task.turnId, 'turn-confirmed');
    assert.equal(task.pendingRunId, null);
    assert.equal(task.feedbackCursor, 7);
    assert.equal(f.store.runByKey(run.requestKey)?.status, 'running');
    assert.equal((f.workspace as any).active.get(f.task.id)?.id, run.id);
    assert.equal(f.workspace.requests.size, 1);
    assert.equal(f.codex.calls[0].method, 'thread/read');
    assert.equal(f.codex.calls[0].params.includeTurns, true);
    await assert.rejects(f.workspace.reviewWrite(f.task.id, true, async () => {}));
  } finally { f.close(); }
});

test('reconcile finalizes an identified completed turn and builds its review once', async () => {
  const f = fixture();
  try {
    const run = uncertainRun(f);
    f.codex.handler = async () => ({ thread: { status: { type: 'idle' }, turns: [identifiedTurn(run, 'completed')] } });
    await Promise.all([f.workspace.reconcile(f.task.id), f.workspace.reconcile(f.task.id)]);
    assert.equal(f.store.task(f.task.id).status, 'reviewing');
    assert.equal(f.store.task(f.task.id).turnId, null);
    assert.equal(f.store.task(f.task.id).pendingRunId, null);
    assert.equal(f.store.runByKey(run.requestKey)?.status, 'completed');
    assert.equal(f.calls.filter(call => call.route.endsWith('/publish')).length, 1);
    assert.equal((f.workspace as any).active.has(f.task.id), false);
  } finally { f.close(); }
});

test('reconcile cannot adopt an unrelated turn or unlock a missing pending turn', async () => {
  const f = fixture();
  try {
    const run = uncertainRun(f, false);
    f.codex.handler = async () => ({ thread: { status: { type: 'idle' }, turns: [identifiedTurn({ ...run, id: 'unrelated-run' }, 'completed')] } });
    await assert.rejects(f.workspace.reconcile(f.task.id), /not confirmed/);
    assert.equal(f.store.task(f.task.id).status, 'uncertain');
    assert.equal(f.store.task(f.task.id).pendingRunId, run.id);
    assert.equal(f.store.task(f.task.id).feedbackCursor, 0);
    assert.equal(f.store.runByKey(run.requestKey)?.status, 'uncertain');
    await assert.rejects(f.workspace.reviewWrite(f.task.id, true, async () => {}));
    assert.throws(() => f.workspace.publish(f.task.id));
    assert.equal(f.calls.length, 0);
  } finally { f.close(); }
});

test('reconcile recognizes a persisted known turn even when its user item is absent', async () => {
  const f = fixture();
  try {
    const run = uncertainRun(f, false);
    f.store.updateTask(f.task.id, { turnId: 'known-turn' });
    f.codex.handler = async () => ({ thread: { status: { type: 'notLoaded' }, turns: [{ id: 'known-turn', status: 'inProgress', items: [] }] } });
    await f.workspace.reconcile(f.task.id);
    assert.equal(f.store.task(f.task.id).status, 'interrupted');
    assert.equal(f.store.runByKey(run.requestKey)?.status, 'interrupted');
    assert.equal((f.workspace as any).active.has(f.task.id), false);
    assert.equal(f.calls.length, 0);
  } finally { f.close(); }
});

test('reconcile preserves a completion received while reading an older in-progress snapshot', async () => {
  const read = deferred<any>();
  const f = fixture();
  try {
    const run = uncertainRun(f);
    f.codex.handler = async () => read.promise;
    const checking = f.workspace.reconcile(f.task.id);
    await (f.workspace as any).notification({ method: 'turn/completed', params: { threadId: 'thread', turn: identifiedTurn(run, 'completed') } });
    read.resolve({ thread: { status: { type: 'active' }, turns: [identifiedTurn(run)] } });
    await checking;
    assert.equal(f.store.runByKey(run.requestKey)?.status, 'completed');
    assert.equal(f.store.task(f.task.id).status, 'reviewing');
    assert.equal(f.calls.filter(call => call.route.endsWith('/publish')).length, 1);
  } finally { read.resolve({ thread: { turns: [] } }); f.close(); }
});

test('a stale request resolution cannot replace uncertain status with running', async () => {
  const f = fixture();
  try {
    uncertainRun(f);
    await (f.workspace as any).notification({ method: 'serverRequest/resolved', params: { threadId: 'thread', requestId: 999 } });
    assert.equal(f.store.task(f.task.id).status, 'uncertain');
    assert.equal(f.store.task(f.task.id).turnId, null);
    await assert.rejects(f.workspace.enqueue(f.task.id, 'Do not restart yet.', 'next', false));
  } finally { f.close(); }
});

test('an input request resolved before turn/start acknowledgement is not replayed', async () => {
  const ack = deferred<{ turn: { id: string } }>();
  const f = fixture();
  try {
    f.codex.handler = async () => ack.promise;
    f.codex.ready = true;
    await f.workspace.enqueue(f.task.id, 'Small revision.', 'request', false);
    await tick();
    (f.workspace as any).serverRequest({ id: 31, method: 'item/tool/requestUserInput', params: { threadId: 'thread', turnId: 'turn-new', questions: [{ id: 'scope', question: 'Which section?' }] } });
    await (f.workspace as any).notification({ method: 'serverRequest/resolved', params: { threadId: 'thread', requestId: 31 } });
    ack.resolve({ turn: { id: 'turn-new' } });
    await tick();
    assert.equal(f.workspace.requests.size, 0);
    assert.equal(f.store.task(f.task.id).status, 'running');
  } finally { ack.resolve({ turn: { id: 'turn-new' } }); f.close(); }
});

test('an ambiguous review write keeps queued edits reserved until the decision is confirmed', async () => {
  const gate = deferred<void>();
  const f = fixture();
  try {
    f.codex.ready = true;
    const writing = f.workspace.reviewWrite(f.task.id, true, async () => { await gate.promise; throw new Error('Review response was lost.'); }, pendingReview);
    const rejected = assert.rejects(writing, /lost/);
    assert.deepEqual(f.store.task(f.task.id).pendingReview, pendingReview);
    const run = await f.workspace.enqueue(f.task.id, 'Next revision.', 'next', false);
    gate.resolve();
    await rejected;
    await tick();
    assert.equal(f.store.task(f.task.id).status, 'uncertain');
    assert.deepEqual(f.store.task(f.task.id).pendingReview, pendingReview);
    assert.equal(f.store.runByKey(run.requestKey)?.status, 'queued');
    assert.equal(f.codex.calls.length, 0);
    await assert.rejects(f.workspace.enqueue(f.task.id, 'Another revision.', 'later', false));
    await assert.rejects(f.workspace.reviewWrite(f.task.id, true, async () => {}));
    assert.throws(() => f.workspace.publish(f.task.id));
    assert.equal(await f.workspace.reviewWrite(f.task.id, false, async () => 'comment saved'), 'comment saved');
  } finally { gate.resolve(); f.close(); }
});

test('restart recovery preserves the exact pending review and prevents a persisted queue from starting', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-review-recovery-'));
  const file = path.join(folder, 'state.sqlite');
  const f = fixture(undefined, { file });
  let restarted: Store | undefined;
  let workspace: Workspace | undefined;
  try {
    const queued = await f.workspace.enqueue(f.task.id, 'Waiting revision.', 'queued', false);
    f.store.updateTask(f.task.id, { pendingReview });
    f.close();
    restarted = new Store(file);
    restarted.recover();
    const codex = new FakeCodex();
    codex.ready = true;
    workspace = new Workspace(restarted, codex as unknown as Codex);
    workspace.runtime.authenticated = true;
    await (workspace as any).drain();
    assert.equal(restarted.task(f.task.id).status, 'uncertain');
    assert.deepEqual(restarted.task(f.task.id).pendingReview, pendingReview);
    assert.equal(restarted.runByKey(queued.requestKey)?.status, 'queued');
    assert.equal(codex.calls.length, 0);
    await assert.rejects(workspace.reviewWrite(f.task.id, true, async () => {}));
    assert.throws(() => workspace!.publish(f.task.id));
  } finally { workspace?.close(); restarted?.close(); fs.rmSync(folder, { recursive: true, force: true }); }
});

test('checking a lost review response replays its original identity exactly once and resumes queued work', async () => {
  const applied = new Set<string>();
  let mutations = 0;
  const server = await reviewServer((request, response, body) => {
    const fresh = !applied.has(body.id);
    if (fresh) { applied.add(body.id); mutations++; request.socket.destroy(); return; }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(pageState));
  });
  const f = fixture(undefined, { reviewUrl: server.url });
  try {
    const writing = f.workspace.reviewWrite(f.task.id, true, async () => {
      const response = await fetch(server.url + pendingReview.route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Review-Token': 'test' }, body: JSON.stringify(pendingReview.body) });
      return response.json();
    }, pendingReview);
    const rejected = assert.rejects(writing);
    await f.workspace.enqueue(f.task.id, 'Waiting revision.', 'queued', false);
    await rejected;
    assert.equal(f.store.task(f.task.id).status, 'uncertain');
    const task = await f.workspace.reconcile(f.task.id);
    assert.equal(task.pendingReview, null);
    assert.equal(task.status, 'queued');
    assert.equal(mutations, 1);
    assert.deepEqual(server.calls.map(call => ({ route: call.route, body: call.body, token: call.token })), Array(2).fill({ route: pendingReview.route, body: pendingReview.body, token: 'test' }));
    f.codex.ready = true;
    await (f.workspace as any).drain();
    await tick();
    assert.equal(f.store.task(f.task.id).status, 'running');
    assert.equal(f.codex.calls.filter(call => call.method === 'turn/start').length, 1);
  } finally { f.close(); await server.close(); }
});

test('concurrent review status checks cannot replay the decision twice', async () => {
  const received = deferred<void>(), release = deferred<void>();
  const server = await reviewServer(async (_request, response) => {
    received.resolve();
    await release.promise;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(pageState));
  });
  const f = fixture(undefined, { reviewUrl: server.url });
  try {
    f.store.updateTask(f.task.id, { status: 'uncertain', pendingReview });
    const checking = f.workspace.reconcile(f.task.id);
    await received.promise;
    await assert.rejects(f.workspace.reconcile(f.task.id), /still being checked/);
    await assert.rejects(f.workspace.reviewWrite(f.task.id, true, async () => {}));
    release.resolve();
    await checking;
    assert.equal(server.calls.length, 1);
    assert.equal(f.store.task(f.task.id).status, 'reviewing');
  } finally { release.resolve(); f.close(); await server.close(); }
});

test('an already-applied undo is checked using the same action ID without undoing another action', async () => {
  const pendingUndo: PendingReview = { route: '/api/tasks/p-task/undo', body: { id: 'already-undone-action' }, previousStatus: 'interrupted' };
  let otherUndone = false;
  const server = await reviewServer((_request, response, body) => {
    if (body.id === 'other-action') otherUndone = true;
    response.writeHead(400, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: 'Nothing to undo here any more. Reload the page.' }));
  });
  const f = fixture(undefined, { reviewUrl: server.url });
  try {
    f.store.updateTask(f.task.id, { status: 'uncertain', pendingReview: pendingUndo });
    const task = await f.workspace.reconcile(f.task.id);
    assert.deepEqual(server.calls[0].body, pendingUndo.body);
    assert.equal(otherUndone, false);
    assert.equal(task.status, 'interrupted');
    assert.equal(task.pendingReview, null);
    assert.match(task.error!, /Nothing to undo/);
    assert.equal(await f.workspace.reviewWrite(f.task.id, true, async () => 'allowed'), 'allowed');
  } finally { f.close(); await server.close(); }
});

test('review status checks retain uncertainty for transport, authentication, and malformed responses', async t => {
  const cases = [
    { name: 'disconnected transport', status: 0, body: '' },
    { name: 'unauthenticated response', status: 401, body: JSON.stringify({ error: 'Sign in.' }) },
    { name: 'forbidden response', status: 403, body: JSON.stringify({ error: 'Expired token.' }) },
    { name: 'server failure', status: 500, body: JSON.stringify({ error: 'Internal error.' }) },
    { name: 'invalid JSON', status: 200, body: '<html>Unavailable</html>' },
    { name: 'unrecognized success', status: 200, body: '{}' },
    { name: 'wrong task success', status: 200, body: JSON.stringify({ ...pageState, task: 'another-task' }) },
    { name: 'unrecognized business error', status: 400, body: JSON.stringify({ message: 'Unavailable.' }) },
  ];
  for (const entry of cases) await t.test(entry.name, async () => {
    const server = await reviewServer((request, response) => {
      if (!entry.status) { request.socket.destroy(); return; }
      response.writeHead(entry.status, { 'Content-Type': 'application/json' });
      response.end(entry.body);
    });
    const f = fixture(undefined, { reviewUrl: server.url });
    try {
      f.store.updateTask(f.task.id, { status: 'uncertain', pendingReview });
      await assert.rejects(f.workspace.reconcile(f.task.id));
      assert.equal(f.store.task(f.task.id).status, 'uncertain');
      assert.deepEqual(f.store.task(f.task.id).pendingReview, pendingReview);
      await assert.rejects(f.workspace.enqueue(f.task.id, 'Do not start yet.', 'next', false));
      await assert.rejects(f.workspace.reviewWrite(f.task.id, true, async () => {}));
      assert.throws(() => f.workspace.publish(f.task.id));
    } finally { f.close(); await server.close(); }
  });
});

const finishResponse = { task: 'p-task', finished: true, changed_files: [], discarded: {} };
const deletionReview = async (_method: string, route: string) => route.endsWith('/state') ? pageState : finishResponse;

test('deletion rejects active, queued, building, uncertain, and reserved tasks without engine writes', async t => {
  for (const status of ['running', 'waiting_input', 'queued', 'building', 'uncertain'] as const) await t.test(status, async () => {
    const f = fixture(deletionReview);
    try {
      f.store.updateTask(f.task.id, { status });
      await assert.rejects(f.workspace.deleteTask(f.task.id), /Pause the task/);
      assert.equal(f.store.task(f.task.id).status, status);
      assert.equal(f.calls.length, 0);
    } finally { f.close(); }
  });
  for (const reservation of ['active', 'publishing', 'reviewWrites', 'pendingReview', 'queued-run', 'preparing']) await t.test(reservation, async () => {
    const f = fixture(deletionReview);
    try {
      if (reservation === 'active') (f.workspace as any).active.set(f.task.id, { id: 'run' });
      else if (reservation === 'pendingReview') f.store.updateTask(f.task.id, { pendingReview });
      else if (reservation === 'queued-run') {
        await f.workspace.enqueue(f.task.id, 'Queued instruction.', 'queued', false);
        f.store.updateTask(f.task.id, { status: 'reviewing' });
      } else (f.workspace as any)[reservation].add(f.task.id);
      await assert.rejects(f.workspace.deleteTask(f.task.id));
      assert.equal(f.calls.length, 0);
    } finally { f.close(); }
  });
});

test('deletion waits for every pending comment and then removes only the selected task', async () => {
  const first = deferred<void>(), second = deferred<void>();
  const f = fixture(deletionReview);
  try {
    const other: Task = { ...f.task, id: 'other-task', name: 'p-other', threadId: 'other-thread' };
    f.store.saveTask(other);
    const run: Run = { id: 'old-run', taskId: f.task.id, requestKey: 'old-request', prompt: 'Earlier work.', status: 'completed', createdAt: 1, finishedAt: 2 };
    f.store.saveRun(run);
    f.store.saveRun({ ...run, id: 'other-run', taskId: other.id, requestKey: 'other-request' });
    f.store.saveItem({ id: 'old-item', taskId: f.task.id, type: 'assistant', text: 'Earlier answer.', createdAt: 1 });
    f.store.saveItem({ id: 'other-item', taskId: other.id, type: 'assistant', text: 'Keep this answer.', createdAt: 1 });
    (f.workspace as any).liveItems.set('late-item', { id: 'late-item', taskId: f.task.id, type: 'assistant', text: 'A late delta.', createdAt: 2 });
    const a = f.workspace.reviewWrite(f.task.id, false, () => first.promise);
    const b = f.workspace.reviewWrite(f.task.id, false, () => second.promise);
    await assert.rejects(f.workspace.deleteTask(f.task.id));
    first.resolve(); await a;
    await assert.rejects(f.workspace.deleteTask(f.task.id));
    second.resolve(); await b;
    assert.deepEqual(await f.workspace.deleteTask(f.task.id), { ok: true });
    (f.workspace as any).flush();
    assert.deepEqual(f.store.tasks().map(task => task.id), [other.id]);
    assert.deepEqual(f.store.runs().map(run => run.id), ['other-run']);
    assert.deepEqual(f.store.items(f.task.id), []);
    assert.equal(f.store.items(other.id)[0].text, 'Keep this answer.');
    assert.equal(f.store.projects().length, 1);
    assert.equal(f.store.taskDeleted(f.task.id), true);
    assert.deepEqual(f.calls.filter(call => call.method === 'POST'), [{ method: 'POST', route: '/api/tasks/p-task/finish', body: { force: true } }]);
    const callCount = f.calls.length;
    assert.deepEqual(await f.workspace.deleteTask(f.task.id), { ok: true });
    assert.equal(f.calls.length, callCount);
  } finally { first.resolve(); second.resolve(); f.close(); }
});

test('in-flight deletion blocks all task mutations and a duplicate deletion request', async () => {
  const gate = deferred<typeof finishResponse>();
  const f = fixture(async (_method, route) => route.endsWith('/state') ? pageState : gate.promise);
  try {
    const deleting = f.workspace.deleteTask(f.task.id);
    assert.equal(f.store.task(f.task.id).status, 'deleting');
    await assert.rejects(f.workspace.enqueue(f.task.id, 'Not allowed.', 'new', false));
    await assert.rejects(f.workspace.reviewWrite(f.task.id, true, async () => {}));
    await assert.rejects(f.workspace.reviewWrite(f.task.id, false, async () => {}));
    await assert.rejects(f.workspace.interrupt(f.task.id));
    await assert.rejects(f.workspace.reconcile(f.task.id));
    assert.throws(() => f.workspace.publish(f.task.id));
    await assert.rejects(f.workspace.deleteTask(f.task.id), /already in progress/);
    await (f.workspace as any).notification({ method: 'item/agentMessage/delta', params: { threadId: 'thread', turnId: 'old-turn', itemId: 'late', delta: 'Ignore this stale output.' } });
    gate.resolve(finishResponse);
    await deleting;
    (f.workspace as any).flush();
    assert.equal(f.store.tasks().length, 0);
    assert.equal(f.store.items(f.task.id).length, 0);
  } finally { gate.resolve(finishResponse); f.close(); }
});

test('feedback that finishes after deletion cannot recreate runs or history', async () => {
  const gate = deferred<typeof feedback>();
  const f = fixture(async (method, route) => route.includes('/feedback') ? gate.promise : deletionReview(method, route));
  try {
    const queued = f.workspace.enqueue(f.task.id, 'Delayed instructions.', 'delayed');
    const rejected = assert.rejects(queued, /Task not found/);
    await tick();
    await f.workspace.deleteTask(f.task.id);
    gate.resolve(feedback);
    await rejected;
    assert.equal(f.store.tasks().length, 0);
    assert.equal(f.store.runs().length, 0);
    assert.equal(f.store.items(f.task.id).length, 0);
  } finally { gate.resolve(feedback); f.close(); }
});

test('lost finish responses stay reserved across restart and retry confirms closed identity', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-delete-recovery-'));
  const file = path.join(folder, 'state.sqlite');
  let closed = false, finishCalls = 0;
  const f = fixture(async (_method, route) => {
    if (route.endsWith('/state')) return { ...pageState, closed };
    finishCalls++; closed = true;
    throw new Error('The finish response was lost.');
  }, { file });
  let reopened: Store | undefined, workspace: Workspace | undefined;
  try {
    await assert.rejects(f.workspace.deleteTask(f.task.id), /lost/);
    assert.equal(f.store.task(f.task.id).status, 'deleting');
    f.close();
    reopened = new Store(file); reopened.recover();
    assert.equal(reopened.task(f.task.id).status, 'deleting');
    assert.match(reopened.task(f.task.id).error!, /restarted during deletion/);
    const review: ReviewClient = { url: 'http://unused', token: 'test', get: async <T>() => ({ ...pageState, closed }) as T, post: async () => { finishCalls++; throw new Error('A closed task must not be finished again.'); } };
    workspace = new Workspace(reopened, new FakeCodex() as unknown as Codex, 2, async () => review);
    await assert.rejects(workspace.enqueue(f.task.id, 'Do not resume.', 'next', false));
    await workspace.deleteTask(f.task.id);
    assert.equal(reopened.tasks().length, 0);
    assert.equal(finishCalls, 1);
    assert.equal(reopened.taskDeleted(f.task.id), true);
  } finally { workspace?.close(); reopened?.close(); fs.rmSync(folder, { recursive: true, force: true }); }
});

test('unconfirmed deletion never treats a malformed or foreign engine response as completion', async t => {
  for (const entry of [
    { name: 'missing state identity', state: { closed: true } },
    { name: 'foreign closed state', state: { ...pageState, task: 'another-task', closed: true } },
    { name: 'invalid closed flag', state: { ...pageState, closed: 'true' } },
    { name: 'missing finish identity', state: pageState, finish: { finished: true } },
    { name: 'foreign finish identity', state: pageState, finish: { task: 'another-task', finished: true } },
    { name: 'explicit engine refusal', state: pageState, error: new Error('A round is still being built.') },
  ]) await t.test(entry.name, async () => {
    const f = fixture(async (_method, route) => {
      if (route.endsWith('/state')) return entry.state;
      if (entry.error) throw entry.error;
      return entry.finish;
    });
    try {
      await assert.rejects(f.workspace.deleteTask(f.task.id));
      assert.equal(f.store.task(f.task.id).status, 'deleting');
      assert.equal(f.store.taskDeleted(f.task.id), false);
      await assert.rejects(f.workspace.reviewWrite(f.task.id, true, async () => {}));
    } finally { f.close(); }
  });
});

test('deleted task IDs cannot be recreated by a delayed create retry', async () => {
  const f = fixture(deletionReview);
  try {
    const id = 'deleted-task-000001';
    f.store.saveTask({ ...f.task, id });
    await f.workspace.deleteTask(id);
    const count = f.calls.length;
    await assert.rejects(f.workspace.createTask({ id, projectId: f.task.projectId, title: 'Stale create request', instructions: 'Do not recreate.' }), /was deleted/);
    assert.equal(f.calls.length, count);
    assert.deepEqual(f.store.tasks().map(task => task.id), [f.task.id]);
  } finally { f.close(); }
});

test('real engine deletion removes one temporary worktree while preserving accepted text and another task', async () => {
  const { Fixture, METHOD, fakeRound } = await import(new URL('../vendor/latex-review/tests/ts/helpers.ts', import.meta.url).href);
  const { createServer: createReviewServer } = await import(new URL('../vendor/latex-review/src/server.ts', import.meta.url).href);
  const disk = new Fixture();
  const app = disk.app();
  const engine = createReviewServer(app);
  let f: ReturnType<typeof fixture> | undefined;
  try {
    const target = app.tasks.create('p-task', 'Remove this task', [], ['paper']);
    const other = app.tasks.create('p-other', 'Keep this task', [], ['paper']);
    disk.edit(target, METHOD, 'Method sentence 2.', 'Accepted manuscript sentence.');
    disk.edit(target, METHOD, 'Detail sentence 15.', 'Unaccepted draft sentence.');
    const round = fakeRound(app, target.name);
    app.review.decide(target.name, { id: 'accept-before-delete', action: 'accept', round: round.number, changes: [round.units[0].id] });
    const manuscript = disk.read(METHOD);
    assert.match(manuscript, /Accepted manuscript sentence/);
    assert.doesNotMatch(manuscript, /Unaccepted draft sentence/);
    const head = app.repo.rev('HEAD');
    const index = fs.readFileSync(path.join(disk.root, '.git/index'));
    const artifacts = path.join(app.state, 'rounds', target.name, '001');
    fs.mkdirSync(artifacts, { recursive: true }); fs.writeFileSync(path.join(artifacts, 'fixture.svg'), '<svg/>');
    app.url = await engine.listen({ port: 0, host: '127.0.0.1' });
    f = fixture(async (method, route, body) => {
      const response = await fetch(app.url + route, { method, headers: { 'Content-Type': 'application/json', 'X-Review-Token': app.csrf }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error);
      return value;
    });
    f.store.saveProject({ id: f.task.projectId, name: 'Temporary paper', path: disk.root, createdAt: 1 });
    f.store.updateTask(f.task.id, { worktree: target.worktree });
    await f.workspace.deleteTask(f.task.id);
    assert.equal(fs.existsSync(target.worktree), false);
    assert.equal(fs.existsSync(artifacts), false);
    assert.equal(fs.existsSync(other.worktree), true);
    assert.equal(app.tasks.get(other.name).closed, null);
    assert.equal(app.repo.text(['for-each-ref', `refs/latex-review/${target.name}/`]), '');
    assert.notEqual(app.repo.text(['for-each-ref', `refs/latex-review/${other.name}/`]), '');
    assert.equal(disk.read(METHOD), manuscript);
    assert.equal(app.repo.rev('HEAD'), head);
    assert.deepEqual(fs.readFileSync(path.join(disk.root, '.git/index')), index);
    const closedState = await fetch(app.url + '/api/tasks/p-task/state').then(response => response.json());
    assert.equal(closedState.task, target.name);
    assert.equal(closedState.closed, true);
    assert.equal(f.store.tasks().length, 0);
  } finally { f?.close(); await engine.close(); await disk.close(); }
});

test('Codex models list their reasoning efforts, and a task runs every turn at its effort', async () => {
  assert.deepEqual(agentModel({ model: 'gpt-x', displayName: 'GPT X', isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Fast' }, { reasoningEffort: 'xhigh', description: 'Deep' }, { description: 'malformed' }] }),
    { id: 'gpt-x', name: 'GPT X', isDefault: true, efforts: ['low', 'xhigh'], defaultEffort: 'medium' });
  assert.deepEqual(agentModel({ id: 'plain' }), { id: 'plain', name: 'plain', isDefault: false, efforts: [], defaultEffort: null });
  const f = fixture();
  try {
    f.codex.ready = true;
    f.store.updateTask(f.task.id, { effort: 'xhigh' });
    await f.workspace.enqueue(f.task.id, 'Next revision.', 'next', false);
    await tick();
    const turn = f.codex.calls.find(call => call.method === 'turn/start');
    assert.equal(turn?.params.effort, 'xhigh');
  } finally { f.close(); }
  const plain = fixture();
  try {
    plain.codex.ready = true;
    await plain.workspace.enqueue(plain.task.id, 'Next revision.', 'next', false);
    await tick();
    assert.equal('effort' in plain.codex.calls.find(call => call.method === 'turn/start')!.params, false);
  } finally { plain.close(); }
});

test('account usage keeps the limit windows, plan and credits Codex reports', () => {
  const window = { usedPercent: 83, windowDurationMins: 10080, resetsAt: 1_793_600_296 };
  assert.deepEqual(accountUsage({ ordinaryUsageAllowed: true, rateLimits: { planType: 'pro', primary: window, secondary: null, credits: { hasCredits: true, unlimited: false, balance: '12418.76' }, rateLimitReachedType: null } }),
    { plan: 'pro', windows: [{ usedPercent: 83, minutes: 10080, resetsAt: 1_793_600_296_000 }], credits: { unlimited: false, balance: 12418.76 }, reached: false });
  assert.equal(accountUsage({ ordinaryUsageAllowed: false, rateLimits: { primary: { usedPercent: 140, windowDurationMins: 300, resetsAt: null } } })!.reached, true);
  assert.equal(accountUsage({ ordinaryUsageAllowed: false, rateLimits: { primary: { usedPercent: 140, windowDurationMins: 300, resetsAt: null } } })!.windows[0].usedPercent, 100);
  assert.equal(accountUsage({ rateLimits: { primary: null, secondary: null, credits: { hasCredits: false, unlimited: false, balance: null } } }), null);
  assert.equal(accountUsage(undefined), null);
});

test('Fast mode uses the catalog tier and preserves older catalogs without inventing support', () => {
  assert.deepEqual(agentModel({ id: 'fast', serviceTiers: [{ id: 'priority', name: 'Fast', description: '2x speed' }] }).fastMode, { serviceTier: 'priority', description: '2x speed' });
  assert.deepEqual(agentModel({ id: 'older', additionalSpeedTiers: ['fast'] }).fastMode, { serviceTier: 'priority', description: '' });
  assert.equal(agentModel({ id: 'standard', serviceTiers: [], additionalSpeedTiers: ['fast'] }).fastMode, undefined);
  assert.equal(agentModel({ id: 'plain' }).fastMode, undefined);
});

test('tasks persist the chosen service tier, and reject unsupported Fast mode before creating a worktree', async () => {
  const f = fixture(async (_method, route) => route === '/api/tasks' ? { worktree: '/unused' } : summary);
  try {
    f.workspace.runtime.models = [agentModel({ id: 'model', isDefault: true, serviceTiers: [{ id: 'priority', name: 'Fast' }] })];
    const input = { id: 'fast-task-test-01', projectId: 'paper', title: 'Revise', instructions: 'Revise.', serviceTier: 'priority' };
    const created = await f.workspace.createTask(input);
    assert.equal(f.store.task(created.id).serviceTier, 'priority');
    const retry = await f.workspace.createTask({ ...input, serviceTier: 'default' });
    assert.equal(retry.serviceTier, 'priority', 'a retry cannot change an existing task');
    const before = f.calls.length;
    await assert.rejects(f.workspace.createTask({ ...input, id: 'fast-task-test-02', model: 'unsupported' }), /Fast mode is not available/);
    await assert.rejects(f.workspace.createTask({ ...input, id: 'fast-task-test-03', agent: 'claude' }), /only available for Codex/);
    await assert.rejects(f.workspace.createTask({ ...input, id: 'fast-task-test-04', serviceTier: 'unknown' }), /Fast mode is not available/);
    assert.equal(f.calls.length, before);
    const standard = await f.workspace.createTask({ ...input, id: 'fast-task-test-05', serviceTier: 'default' });
    assert.equal(standard.serviceTier, 'default');
  } finally { f.close(); }
});

test('Codex receives the saved Fast or explicit standard tier without changing reasoning', async () => {
  for (const serviceTier of ['priority', 'default', undefined]) {
    const f = fixture();
    try {
      f.codex.ready = true;
      f.store.updateTask(f.task.id, { effort: 'xhigh', serviceTier });
      await f.workspace.enqueue(f.task.id, 'Next revision.', 'next', false);
      await tick();
      const turn = f.codex.calls.find(call => call.method === 'turn/start')!;
      assert.equal(turn.params.effort, 'xhigh');
      assert.equal(turn.params.serviceTier, serviceTier);
      if (serviceTier === undefined) assert.equal('serviceTier' in turn.params, false, 'older tasks retain their host configuration');
    } finally { f.close(); }
  }
});

test('a question without an "Other" choice only accepts one of its options', async () => {
  const claude = new FakeCodex();
  const f = fixture(undefined, { claude });
  try {
    f.codex.ready = true; claude.ready = true;
    f.workspace.runtimes.claude.authenticated = true;
    f.store.updateTask(f.task.id, { agent: 'claude', threadId: 'claude-thread' });
    (f.workspace as any).loaded.add('claude-thread');
    await f.workspace.enqueue(f.task.id, 'Tighten the abstract.', 'choice-run', false);
    await tick();
    claude.emit('request', { id: 'choice-1', method: 'item/tool/requestUserInput', params: { threadId: 'claude-thread', turnId: 'turn-new', questions: [{ id: 'choice', question: 'Which section?', isOther: false, options: [{ label: 'Introduction' }, { label: 'Model' }] }] } });
    const [request] = f.workspace.snapshot().requests;
    assert.throws(() => f.workspace.answer(request.id, { answers: { choice: 'Both, model first' } }), /Choose one of the offered answers/);
    assert.deepEqual(claude.replies, []);
    assert.equal(f.workspace.snapshot().requests.length, 1);
    f.workspace.answer(request.id, { answers: { choice: 'Model' } });
    assert.deepEqual(claude.replies, [{ id: 'choice-1', result: { answers: { choice: { answers: ['Model'] } } } }]);
  } finally { f.close(); }
});

test('a task runs on its own agent: turns, approvals and pausing go to that agent only', async () => {
  const claude = new FakeCodex();
  const f = fixture(undefined, { claude });
  try {
    f.codex.ready = true; claude.ready = true;
    f.workspace.runtimes.claude.authenticated = true;
    f.store.updateTask(f.task.id, { agent: 'claude', threadId: 'claude-thread' });
    (f.workspace as any).loaded.add('claude-thread');
    await f.workspace.enqueue(f.task.id, 'Tighten the abstract.', 'claude-run', false);
    await tick();
    assert.equal(f.codex.calls.length, 0);
    assert.deepEqual(claude.calls.map(call => call.method), ['turn/start']);
    assert.equal(claude.calls[0].params.threadId, 'claude-thread');
    // An approval from Claude is answered through Claude, never Codex.
    claude.emit('request', { id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { threadId: 'claude-thread', turnId: 'turn-new', command: 'make' } });
    const [request] = f.workspace.snapshot().requests;
    assert.equal(request.taskId, f.task.id);
    f.workspace.answer(request.id, { decision: 'accept' });
    assert.deepEqual(claude.replies, [{ id: 'approval-1', result: { decision: 'accept' } }]);
    assert.deepEqual(f.codex.replies, []);
    // A request for this task that arrives from another agent is refused.
    f.codex.emit('request', { id: 'stray', method: 'item/commandExecution/requestApproval', params: { threadId: 'claude-thread', turnId: 'turn-new' } });
    assert.deepEqual(f.codex.rejections.map(r => r.id), ['stray']);
    await f.workspace.interrupt(f.task.id);
    assert.deepEqual(claude.calls.at(-1), { method: 'turn/interrupt', params: { threadId: 'claude-thread', turnId: 'turn-new' } });
    // Claude's turn completion is handled like Codex's.
    claude.emit('notification', { method: 'turn/completed', params: { threadId: 'claude-thread', turn: { id: 'turn-new', status: 'interrupted' } } });
    await tick();
    assert.equal(f.store.task(f.task.id).status, 'interrupted');
  } finally { f.close(); }
});

test('Antigravity is told to edit with its file tools, since it cannot run commands', () => {
  const f = fixture();
  try {
    const codex = (f.workspace as any).instructions(f.task) as string;
    const antigravity = (f.workspace as any).instructions({ ...f.task, agent: 'antigravity' }) as string;
    assert.match(codex, /You may run tools in the task worktree/);
    assert.match(antigravity, /^You are Antigravity running inside Papilot/);
    assert.match(antigravity, /Shell commands are not available to you here.*file tools only/);
    assert.doesNotMatch(antigravity, /You may run tools/);
  } finally { f.close(); }
});

test('a skill runs as its instructions while the chat keeps the author\'s words', async () => {
  const f = fixture();
  try {
    const run = await f.workspace.enqueue(f.task.id, 'Only the abstract.', 'skill-run', false, { skill: findSkill('/unused', 'proofread') });
    assert.match(run.prompt, /^Use the "Proofread" skill below/);
    assert.match(run.prompt, /<skill name="Proofread">[\s\S]*typos[\s\S]*<\/skill>\n\nRequest: Only the abstract\.$/);
    const item = f.store.items(f.task.id).find(entry => entry.id === run.id)!;
    assert.equal(item.text, 'Only the abstract.');
    assert.deepEqual(item.meta, { skill: { id: 'proofread', name: 'Proofread' } });
  } finally { f.close(); }
});

test('a failed task keeps its notes, and concurrent submissions cannot send the same note twice', async () => {
  const gate = deferred<any>();
  let fail = true;
  const f = fixture(async () => { if (fail) throw new Error('Review service unavailable'); return gate.promise; });
  try {
    const note = { id: 'draft-note', projectId: f.task.projectId, key: 'pdf', page: 0, rect: [0, 0, 1, 1] as [number, number, number, number], quote: 'A sentence.', comment: 'Clarify.', source: null, createdAt: 1 };
    f.store.saveAnnotation(note);
    const input = { id: 'notes-retry-task-01', projectId: f.task.projectId, title: 'Clarify', instructions: '', annotations: [note.id] };
    await assert.rejects(f.workspace.createTask(input), /Review service unavailable/);
    assert.equal(f.store.annotations(note.projectId)[0].taskId, undefined);
    fail = false;
    const creating = f.workspace.createTask(input);
    await assert.rejects(f.workspace.createTask({ ...input, id: 'notes-other-task-01' }), /already being sent/);
    gate.resolve({ worktree: '/unused/notes-task' });
    const created = await creating;
    assert.equal(created.id, input.id);
    assert.equal(f.store.annotations(note.projectId)[0].taskId, input.id);
    assert.equal(f.store.items(input.id).length, 1);
    assert.equal((await f.workspace.createTask(input)).id, input.id);
    await assert.rejects(f.workspace.createTask({ ...input, id: 'notes-other-task-01' }), /no longer available/);
  } finally { f.close(); }
});

test('sent review feedback shows as decisions and comments, not as the prompt', async () => {
  const f = fixture(async (_method, route) => route.includes('/feedback') ? { cursor: 9, feedback: [
    { id: 8, kind: 'accept', round: 2, changes: ['a', 'b'] },
    { id: 9, kind: 'comment', round: 2, text: 'Clarify the bound.', changes: [{ id: 'c', file: 'main.tex', lines: [4, 6], old: '', new: '' }] },
  ] } : summary);
  try {
    const run = await f.workspace.enqueue(f.task.id, '', 'feedback-run', true, { feedback: true });
    assert.ok(run.prompt.startsWith(reviewInstructions));
    assert.match(run.prompt, /Clarify the bound/);
    const item = f.store.items(f.task.id).find(entry => entry.id === run.id)!;
    assert.equal(item.text, '');
    assert.deepEqual(item.meta, { sendsFeedback: true, feedback: { round: 2, accepted: 2, rejected: 0, undone: 0, comments: [{ where: 'main.tex:4', text: 'Clarify the bound.' }] } });
    await f.workspace.interrupt(f.task.id);
    const typed = await f.workspace.enqueue(f.task.id, 'Also shorten it.', 'typed-run', false);
    assert.equal(f.store.items(f.task.id).find(entry => entry.id === typed.id)!.meta, undefined);
  } finally { f.close(); }
});

test('accepting puts a change in the manuscript without a commit, and the review knows the files it touched', async () => {
  const { Fixture, METHOD, fakeRound } = await import(new URL('../vendor/latex-review/tests/ts/helpers.ts', import.meta.url).href);
  const disk = new Fixture();
  const app = disk.app();
  const f = fixture();
  try {
    const target = app.tasks.create('p-task', 'Accept into the manuscript', [], ['paper']);
    disk.edit(target, METHOD, 'Method sentence 2.', 'Accepted manuscript sentence.');
    f.store.saveProject({ id: f.task.projectId, name: 'Temporary paper', path: disk.root, createdAt: 1 });
    assert.doesNotMatch((f.workspace as any).instructions(f.store.task(f.task.id)), /commit message/i);
    assert.deepEqual(await acceptedFiles(disk.root, target.name), []);
    const head = app.repo.text(['rev-parse', 'HEAD']);
    const round = fakeRound(app, target.name);
    app.review.decide(target.name, { id: 'accept', action: 'accept', round: round.number, changes: [round.units[0].id] });
    assert.match(fs.readFileSync(path.join(disk.root, METHOD), 'utf8'), /Accepted manuscript sentence\./);
    assert.equal(app.repo.text(['rev-parse', 'HEAD']), head);
    await f.workspace.refresh(f.task.id);
    assert.deepEqual(f.store.task(f.task.id).review?.files, [METHOD]);
  } finally { f.close(); await disk.close(); }
});

test('feedback alone cannot be sent when there is none, so the chat never shows an empty card', async () => {
  const f = fixture(async (_method, route) => route.includes('/feedback') ? { cursor: 3, feedback: [] } : summary);
  try {
    await assert.rejects(f.workspace.enqueue(f.task.id, '', 'empty-feedback', true, { feedback: true }), /no new review feedback/);
    assert.equal(f.store.runs().length, 0);
  } finally { f.close(); }
});

test('a commit message goes to the small model each agent offers, when it offers one', () => {
  const model = (id: string, name = id) => ({ id, name, isDefault: false, efforts: [], defaultEffort: null });
  assert.equal(lightModel([model('gpt-6.1-sol'), model('gpt-6-luna'), model('gpt-5.6-luna')])?.id, 'gpt-6-luna');
  assert.equal(lightModel([model('opus', 'Opus 5.5'), model('sonnet', 'Sonnet 5.5'), model('haiku', 'Haiku 5.5')])?.id, 'haiku');
  assert.equal(lightModel([model('gemini-4-argon', 'Gemini 4 Argon'), model('gemini-3.8-flash', 'Gemini 3.8 Flash')])?.id, 'gemini-3.8-flash');
  assert.equal(lightModel([model('gemini-4-argon', 'Gemini 4 Argon'), model('custom', 'Custom')]), undefined);
});

test('an agent writes a commit message from the chosen changes, in a read-only turn it does not keep', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-message-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  const f = fixture();
  try {
    git('init', '-q', '-b', 'main');
    for (const [key, value] of [['user.name', 'Test'], ['user.email', 'test@localhost'], ['commit.gpgsign', 'false']]) git('config', key, value);
    fs.writeFileSync(path.join(root, 'main.tex'), 'Original opening.\n'); fs.writeFileSync(path.join(root, 'notes.md'), 'Notes.\n');
    git('add', '.'); git('commit', '-qm', 'Draft the introduction');
    fs.writeFileSync(path.join(root, 'main.tex'), 'Tighter opening.\n'); fs.writeFileSync(path.join(root, 'notes.md'), 'Not chosen.\n');
    f.store.saveProject({ id: f.task.projectId, name: 'Paper', path: root, createdAt: 1 });
    f.store.updateTask(f.task.id, { title: 'Tighten the opening', review: { state: 'done', round: 1, counts: {}, files: ['main.tex'] } });
    f.codex.ready = true;
    f.workspace.runtimes.codex.models = [
      { id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol', isDefault: true, efforts: ['low', 'high'], defaultEffort: 'high' },
      { id: 'gpt-6-luna', name: 'GPT-6-Luna', isDefault: false, efforts: ['low', 'medium'], defaultEffort: 'medium' },
    ];
    const replies = ['```\nTighten the opening sentence.\n```', 'Shorten the opening sentence'];
    f.codex.handler = async method => {
      if (method === 'thread/start') return { thread: { id: 'commit-thread' } };
      const text = replies.shift();
      setImmediate(() => {
        f.codex.emit('notification', { method: 'item/completed', params: { threadId: 'commit-thread', turnId: 'commit-turn', item: { id: 'reply', type: 'agentMessage', text } } });
        f.codex.emit('notification', { method: 'turn/completed', params: { threadId: 'commit-thread', turn: { id: 'commit-turn', status: 'completed' } } });
      });
      return { turn: { id: 'commit-turn' } };
    };
    assert.deepEqual(await f.workspace.commitMessage(f.task.projectId, ['main.tex'], { agent: 'claude' }), { message: 'Tighten the opening sentence', agent: 'codex' });
    const start = f.codex.calls.find(call => call.method === 'thread/start')!.params, turn = f.codex.calls.find(call => call.method === 'turn/start')!.params;
    assert.deepEqual([start.cwd, start.sandbox, start.approvalPolicy, start.ephemeral, start.model, turn.effort], [root, 'read-only', 'never', true, 'gpt-6-luna', 'low']);
    const prompt: string = turn.input[0].text;
    for (const part of ['- Draft the introduction', '- Tighten the opening', 'M main.tex', '+Tighter opening.']) assert.ok(prompt.includes(part), part);
    assert.ok(!prompt.includes('notes.md'), 'files that were not chosen stay out');
    // The reply belongs to no task, so no chat shows it.
    assert.deepEqual(f.store.items(f.task.id), []);
    // The same changes get the same message at once, unless a fresh one is asked for.
    const turns = () => f.codex.calls.filter(call => call.method === 'turn/start').length;
    assert.deepEqual(await f.workspace.commitMessage(f.task.projectId, ['main.tex']), { message: 'Tighten the opening sentence', agent: 'codex' });
    assert.equal(turns(), 1);
    assert.deepEqual(await f.workspace.commitMessage(f.task.projectId, ['main.tex'], { fresh: true }), { message: 'Shorten the opening sentence', agent: 'codex' });
    assert.equal(turns(), 2);
    assert.equal((await f.workspace.commitMessage(f.task.projectId, ['main.tex'])).message, 'Shorten the opening sentence');
    // Once the author has decided every change, the review's message is written ahead.
    fs.writeFileSync(path.join(root, 'main.tex'), 'An even tighter opening.\n');
    replies.push('Tighten the opening again');
    f.store.updateTask(f.task.id, { status: 'reviewing', review: { state: 'done', round: 1, counts: { pending: 1 }, files: ['main.tex'] } });
    await f.workspace.prepareCommitMessage(f.task.id);
    assert.equal(turns(), 2, 'a review with undecided changes waits');
    f.store.updateTask(f.task.id, { review: { state: 'done', round: 1, counts: { accepted: 1 }, files: ['main.tex'] } });
    await f.workspace.prepareCommitMessage(f.task.id);
    assert.equal(turns(), 3);
    assert.equal((await f.workspace.commitMessage(f.task.projectId, ['main.tex'], { agent: 'codex' })).message, 'Tighten the opening again');
    assert.equal(turns(), 3);
    f.codex.ready = false;
    await assert.rejects(f.workspace.commitMessage(f.task.projectId, ['main.tex']), /Sign in to an agent, such as Codex/);
  } finally { f.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('a build the agent broke goes back to it once, and its instructions name what the review covers', async () => {
  const jobs: Record<string, object> = {
    'job-1': { status: 'failed', error: 'Some edits are outside the task scope: docs/coverage.md', details: ['Allowed: main'], next: 'Undo edits outside the scope, then publish again.' },
    'job-2': { status: 'failed', error: 'Some edits are outside the task scope: docs/coverage.md', details: ['Allowed: main'] },
  };
  let published = 0;
  const f = fixture(async (_method, route) => {
    if (route.endsWith('/publish')) return { job: `job-${++published}` };
    if (route.startsWith('/api/jobs/')) return jobs[route.slice('/api/jobs/'.length)];
    if (route.includes('/feedback')) return feedback;
    return { ...summary, scope: { sections: [], files: ['main'] } };
  });
  try {
    f.store.updateTask(f.task.id, { threadId: null });
    f.codex.ready = true;
    await f.workspace.enqueue(f.task.id, 'Address the notes.', 'request', false);
    await tick(); await tick();
    const start = f.codex.calls.find(call => call.method === 'thread/start')!.params;
    assert.match(start.developerInstructions, /The review covers only main in this worktree, and an edit to any other file stops the PDF build/);
    const complete = () => (f.workspace as any).notification({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn-new', status: 'completed' } } });
    await complete();
    const fix = f.store.runByKey('build-fix-job-1')!;
    assert.ok(fix, 'the build error is queued for the agent');
    assert.ok(fix.prompt.includes('Some edits are outside the task scope: docs/coverage.md\nAllowed: main'));
    // The chat shows the error rather than the prompt, and the task carries on.
    const item = f.store.items(f.task.id).find(entry => entry.id === fix.id)!;
    assert.equal(item.text, '');
    assert.deepEqual(item.meta?.build, { error: 'Some edits are outside the task scope: docs/coverage.md', details: ['Allowed: main'] });
    assert.equal(f.store.task(f.task.id).error, null);
    await tick(); await tick();
    assert.equal(f.store.runByKey('build-fix-job-1')?.status, 'running');
    // The same failure after the fix turn stops for the author instead of looping.
    await complete();
    assert.equal(f.store.runByKey('build-fix-job-2'), undefined);
    assert.equal(f.store.task(f.task.id).status, 'failed');
    assert.match(f.store.task(f.task.id).error || '', /outside the task scope/);
  } finally { f.close(); }
});

test('Codex threads get the view_pdf tool, which Papilot answers with typeset pages', async () => {
  const views: unknown[] = [];
  const f = fixture(async (_method, route, body) => {
    if (route.endsWith('/view')) { views.push(body); return { pages: [{ index: 3, label: '1', shows: ['main.tex:12'], file: '/paper/.git/latex-review/views/p-task/1/page-1-3.png' }], missing: ['Page 99: no page has this printed number.'], targets: ['chapters/intro'] }; }
    if (route.includes('/feedback')) return feedback;
    return summary;
  });
  try {
    f.store.updateTask(f.task.id, { threadId: null });
    f.codex.ready = true;
    await f.workspace.enqueue(f.task.id, 'Fix the runt on page 1.', 'request', false);
    await tick(); await tick();
    const start = f.codex.calls.find(call => call.method === 'thread/start')!.params;
    assert.deepEqual(start.dynamicTools.map((tool: any) => tool.name), ['view_pdf']);
    assert.match(start.developerInstructions, /use the view_pdf tool and open the pages it draws with your image viewer/);
    assert.equal(f.store.task(f.task.id).viewPdf, true);
    // Papilot answers the call itself: the author is not asked.
    const call = (id: number, tool: string, args: object) => (f.workspace as any).serverRequest({ id, method: 'item/tool/call', params: { threadId: 'thread', turnId: 'turn-new', callId: `call-${id}`, tool, arguments: args } });
    call(41, 'view_pdf', { locations: ['main.tex:12'], pages: ['99', 7], accepted: 'yes' });
    for (let i = 0; i < 20 && !f.codex.replies.length; i++) await tick();
    assert.deepEqual(views, [{ locations: ['main.tex:12'], pages: ['99'] }]);
    const reply = f.codex.replies[0] as { id: number; result: { success: boolean; contentItems: any[] } };
    assert.equal(reply.id, 41);
    assert.equal(reply.result.success, true);
    // Only text comes back: the page files, which the agent opens with its image viewer.
    assert.deepEqual(reply.result.contentItems, [{ type: 'inputText', text: 'Your worktree was compiled (only chapters/intro, so page positions differ from the full PDF while printed page numbers match).\nPage 1 shows main.tex:12: /paper/.git/latex-review/views/p-task/1/page-1-3.png\nPage 99: no page has this printed number.\nOpen the page files you need with your image viewer (view_image).' }]);
    assert.equal(f.workspace.requests.size, 0);
    assert.equal(f.store.task(f.task.id).status, 'running');
    call(42, 'other_tool', {});
    for (let i = 0; i < 20 && f.codex.replies.length < 2; i++) await tick();
    assert.deepEqual(f.codex.replies[1], { id: 42, result: { success: false, contentItems: [{ type: 'inputText', text: 'Papilot has no tool named other_tool.' }] } });
    // The chat shows what the agent looked at.
    await (f.workspace as any).notification({ method: 'item/completed', params: { threadId: 'thread', turnId: 'turn-new', item: { id: 'look', type: 'dynamicToolCall', tool: 'view_pdf', arguments: { locations: ['main.tex:12'], pages: ['99'] }, status: 'completed', success: true } } });
    const item = f.store.items(f.task.id).find(entry => entry.id === `${f.task.id}:turn-new:look`)!;
    assert.deepEqual([item.type, item.text, item.status], ['pdf', 'main.tex:12, p. 99', 'completed']);
  } finally { f.close(); }
});

test('a Codex without the experimental tool API starts threads without view_pdf', async () => {
  const f = fixture();
  try {
    f.codex.handler = async (method, params) => {
      if (method === 'thread/start' && params.dynamicTools) throw new RpcResponseError('Invalid request: thread/start.dynamicTools requires experimentalApi capability');
      return method === 'turn/start' ? { turn: { id: 'turn-new' } } : { thread: { id: 'thread' } };
    };
    f.store.updateTask(f.task.id, { threadId: null });
    f.codex.ready = true;
    await f.workspace.enqueue(f.task.id, 'Tighten the abstract.', 'request', false);
    for (let i = 0; i < 10 && !f.codex.calls.some(call => call.method === 'turn/start'); i++) await tick();
    const starts = f.codex.calls.filter(call => call.method === 'thread/start').map(call => call.params);
    assert.equal(starts.length, 2);
    assert.equal(starts[1].dynamicTools, undefined);
    assert.doesNotMatch(starts[1].developerInstructions, /view_pdf/);
    assert.equal(f.store.task(f.task.id).viewPdf, false);
    assert.equal(f.store.task(f.task.id).status, 'running');
  } finally { f.close(); }
});

test('a build that fails for reasons outside the agent\'s edits is not sent back to it', async () => {
  const f = fixture(async (_method, route) => {
    if (route.endsWith('/publish')) return { job: 'job' };
    if (route.startsWith('/api/jobs/')) return { status: 'failed', error: 'The comparison baseline could not be compiled.', details: ['! Undefined control sequence.'] };
    if (route.includes('/feedback')) return feedback;
    return summary;
  });
  try {
    f.codex.ready = true;
    await f.workspace.enqueue(f.task.id, 'Address the notes.', 'request', false);
    await tick(); await tick();
    await (f.workspace as any).notification({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn-new', status: 'completed' } } });
    assert.equal(f.store.runs().length, 1);
    assert.equal(f.store.task(f.task.id).status, 'failed');
    assert.equal(f.store.task(f.task.id).error, 'The comparison baseline could not be compiled.\n! Undefined control sequence.');
  } finally { f.close(); }
});

test('an agent resolves a merge in the manuscript checkout, and review writes wait for the merge', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-resolve-'));
  const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  const remote = path.join(base, 'remote.git'), root = path.join(base, 'paper'), other = path.join(base, 'other');
  const clone = (target: string) => { run(base, 'clone', '-q', remote, target); for (const [key, value] of [['user.name', 'Test'], ['user.email', 'test@localhost'], ['commit.gpgsign', 'false']]) run(target, 'config', key, value); };
  const edit = (cwd: string, text: string, message: string) => { fs.writeFileSync(path.join(cwd, 'main.tex'), text); run(cwd, 'commit', '-qam', message); };
  const f = fixture();
  try {
    run(base, 'init', '-q', '--bare', '-b', 'main', remote); clone(root);
    fs.writeFileSync(path.join(root, 'main.tex'), 'Opening.\n'); run(root, 'add', '.'); run(root, 'commit', '-qm', 'Start'); run(root, 'push', '-q', '-u', 'origin', 'main');
    clone(other); edit(other, 'Their opening.\n', 'Reword the opening'); run(other, 'push', '-q');
    edit(root, 'My opening.\n', 'Rewrite the opening'); run(root, 'fetch', '-q');
    try { run(root, 'merge', '--no-edit', 'origin/main'); } catch { /* The conflict is the point. */ }
    f.store.saveProject({ id: f.task.projectId, name: 'Paper', path: root, createdAt: 1 });
    await assert.rejects(f.workspace.reviewWrite(f.task.id, true, async () => undefined), /Finish or abort the merge/);
    f.codex.ready = true;
    f.workspace.runtimes.codex.models = [{ id: 'deep', name: 'Deep', isDefault: true, efforts: ['low', 'high'], defaultEffort: 'high' }];
    f.codex.handler = async method => {
      if (method === 'thread/start') return { thread: { id: 'merge-thread' } };
      fs.writeFileSync(path.join(root, 'main.tex'), 'My opening, as reworded.\n');
      setImmediate(() => {
        f.codex.emit('notification', { method: 'item/completed', params: { threadId: 'merge-thread', item: { id: 'reply', type: 'agentMessage', text: 'Kept your rewrite and their wording.' } } });
        f.codex.emit('notification', { method: 'turn/completed', params: { threadId: 'merge-thread', turn: { id: 'merge-turn', status: 'completed' } } });
      });
      return { turn: { id: 'merge-turn' } };
    };
    const result = await f.workspace.resolveConflicts(f.task.projectId);
    assert.deepEqual([result.summary, result.remaining, result.agent, result.git.merging?.conflicts], ['Kept your rewrite and their wording.', [], 'codex', []]);
    const start = f.codex.calls.find(call => call.method === 'thread/start')!.params, turn = f.codex.calls.find(call => call.method === 'turn/start')!.params;
    assert.deepEqual([start.cwd, start.sandbox, start.approvalPolicy, start.ephemeral, turn.effort], [root, 'workspace-write', 'never', true, 'high']);
    for (const part of ['- main.tex', '- Rewrite the opening', '- Reword the opening', 'origin/main']) assert.ok(turn.input[0].text.includes(part), part);
    await assert.rejects(f.workspace.resolveConflicts(f.task.projectId), /No file has conflict markers left/);
  } finally { f.close(); fs.rmSync(base, { recursive: true, force: true }); }
});

test('deferred tasks deliver accepted changes through the review engine and generate a message from their isolated diff', async () => {
  const { Fixture, METHOD, fakeRound } = await import(new URL('../vendor/latex-review/tests/ts/helpers.ts', import.meta.url).href);
  const disk = new Fixture(), app = disk.app();
  const f = fixture(async (method, route, body: any) => {
    if (route.includes('/feedback')) return app.review.feedback('p-task');
    if (method === 'POST' && route.endsWith('/deliver')) return app.delivery.deliver('p-task', body.mode, body.message);
    return app.taskInfo('p-task');
  });
  try {
    const target = app.tasks.create('p-task', 'Isolated revision', [], ['paper'], true);
    disk.edit(target, METHOD, 'Method sentence 2.', 'Accepted isolated text.');
    const round = fakeRound(app, target.name);
    app.review.decide(target.name, { id: 'accept-isolated', action: 'accept', round: round.number, changes: round.units.map((unit: any) => unit.id) });
    f.store.saveProject({ id: f.task.projectId, name: 'Paper', path: disk.root, createdAt: 1 });
    await f.workspace.refresh(f.task.id);
    assert.equal(f.store.task(f.task.id).deferred, true);
    assert.deepEqual(f.store.task(f.task.id).review?.files, [METHOD]);
    f.codex.ready = true;
    (f.workspace as any).oneOff = async (_id: string, input: any) => {
      assert.match(input.prompt, /Accepted isolated text/);
      assert.match(input.prompt, /Diff:/);
      return 'Explain the method';
    };
    assert.equal((await f.workspace.commitMessage(f.task.projectId, [METHOD], { taskId: f.task.id })).message, 'Explain the method');
    await assert.rejects(f.workspace.commitTask(f.task.id, 'Commit', true), /kept locally/);
    f.store.updateTask(f.task.id, { status: 'running' });
    await assert.rejects(f.workspace.deliverTask(f.task.id, 'workspace'), /Wait for the task/);
    f.store.updateTask(f.task.id, { status: 'reviewing' });
    const gate = deferred<void>();
    const writing = f.workspace.reviewWrite(f.task.id, true, () => gate.promise);
    await assert.rejects(f.workspace.commitTask(f.task.id, 'Commit'), /current review action/);
    gate.resolve(); await writing;
    const result = await f.workspace.commitTask(f.task.id, 'Explain the method');
    assert.equal(f.store.task(f.task.id).delivery?.commit, result.commit);
    assert.deepEqual(f.store.task(f.task.id).review?.files, []);
    assert.doesNotMatch(disk.read(METHOD), /Accepted isolated text/);
    assert.deepEqual(result.git.files, []);
    assert.equal((await f.workspace.commitTask(f.task.id, 'Retry')).commit, result.commit);
  } finally { f.close(); await disk.close(); }
});

test('a task commits only what it accepted since its last commit, never during a review write, and can push', async () => {
  const { Fixture, METHOD, fakeRound } = await import(new URL('../vendor/latex-review/tests/ts/helpers.ts', import.meta.url).href);
  const disk = new Fixture();
  const app = disk.app();
  const f = fixture(undefined, { file: path.join(disk.base, 'state.db') });
  try {
    const target = app.tasks.create('p-task', 'Accept twice', [], ['paper']);
    disk.edit(target, METHOD, 'Method sentence 2.', 'First accepted sentence.');
    disk.edit(target, METHOD, 'Detail sentence 15.', 'Second accepted sentence.');
    disk.write('notes.txt', 'Not part of the task.');
    f.store.saveProject({ id: f.task.projectId, name: 'Temporary paper', path: disk.root, createdAt: 1 });
    await assert.rejects(f.workspace.commitTask(f.task.id, 'Nothing yet'), /no accepted changes/);
    const round = fakeRound(app, target.name);
    app.review.decide(target.name, { id: 'accept-first', action: 'accept', round: round.number, changes: [round.units[0].id] });
    assert.deepEqual(await acceptedFiles(disk.root, target.name), [METHOD]);
    const first = await f.workspace.commitTask(f.task.id, 'Accept the first sentence', true);
    assert.equal(app.repo.text(['log', '-1', '--format=%s']).trim(), 'Accept the first sentence');
    assert.equal(app.repo.text(['show', '--name-only', '--format=', 'HEAD']).trim(), METHOD);
    assert.deepEqual(first.git.files.map((file: { path: string }) => file.path), ['notes.txt']);
    assert.match(first.pushError ?? '', /no remote/);
    assert.equal(f.store.task(f.task.id).committed?.hash, first.commit);
    assert.notEqual(f.store.task(f.task.id).committed?.pushed, true, 'a failed push leaves a local commit');
    // Someone edits the same file by hand: it is not this task's to commit.
    fs.writeFileSync(path.join(disk.root, METHOD), fs.readFileSync(path.join(disk.root, METHOD), 'utf8') + '\nA hand edit.\n');
    await f.workspace.refresh(f.task.id);
    assert.deepEqual(f.store.task(f.task.id).review?.files, []);
    await assert.rejects(f.workspace.commitTask(f.task.id, 'Not mine'), /no accepted changes left/);
    // Accepting more makes the file this task's again.
    app.review.decide(target.name, { id: 'accept-second', action: 'accept', round: round.number, changes: [round.units[1].id] });
    await f.workspace.refresh(f.task.id);
    assert.deepEqual(f.store.task(f.task.id).review?.files, [METHOD]);
    // A review write in progress on the paper holds the commit back, and the reverse.
    const gate = deferred<void>();
    const write = f.workspace.reviewWrite(f.task.id, true, () => gate.promise);
    await assert.rejects(f.workspace.commitTask(f.task.id, 'Too early'), /review action/);
    gate.resolve(); await write;
    const committing = f.workspace.exclusiveCommit(f.task.projectId, () => new Promise(resolve => setTimeout(resolve, 20)));
    await assert.rejects(f.workspace.reviewWrite(f.task.id, true, async () => undefined), /commit is in progress/);
    await committing;
    const remote = path.join(disk.base, 'remote.git');
    app.repo.run(['init', '--bare', remote]);
    app.repo.run(['remote', 'add', 'origin', remote]);
    const second = await f.workspace.commitTask(f.task.id, 'Accept the second sentence', true);
    assert.equal(second.pushError, undefined);
    assert.equal(f.store.task(f.task.id).committed?.hash, second.commit);
    assert.equal(f.store.task(f.task.id).committed?.pushed, true);
    assert.equal(app.repo.text(['rev-parse', '@{upstream}']).trim(), app.repo.rev('HEAD'));
    const reopened = new Store(f.store.file);
    try { assert.deepEqual(reopened.task(f.task.id).committed, f.store.task(f.task.id).committed); }
    finally { reopened.close(); }
    disk.edit(target, METHOD, 'Method sentence 7.', 'A later accepted sentence.');
    const next = fakeRound(app, target.name);
    app.review.decide(target.name, { id: 'accept-next', action: 'accept', round: next.number, changes: next.units.map((unit: any) => unit.id) });
    const third = await f.workspace.commitTask(f.task.id, 'Keep the next revision local');
    assert.equal(third.pushError, undefined);
    assert.equal(f.store.task(f.task.id).committed?.hash, third.commit);
    assert.notEqual(f.store.task(f.task.id).committed?.pushed, true, 'a later local commit resets the previous push result');
    assert.equal(third.git.ahead, 1);
  } finally { f.close(); await disk.close(); }
});

test('agents that are not found on the host are neither started nor offered, and Reconnect looks again', async () => {
  const store = new Store(':memory:');
  class Detected extends FakeCodex {
    found = false; starts = 0;
    detect() { return this.found; }
    async start() { this.starts++; this.ready = true; }
    handler = async (method: string): Promise<any> => method === 'account/read' ? { account: { type: 'Local configuration' }, requiresOpenaiAuth: false } : method === 'model/list' ? { data: [] } : {};
  }
  const codex = new FakeCodex(); codex.handler = async (method: string) => method === 'account/read' ? { account: { email: 'me@example.com' }, requiresOpenaiAuth: false } : { data: [] };
  (codex as any).start = async () => { codex.ready = true; };
  const qwen = new Detected();
  const others = Object.fromEntries((['claude', 'cursor', 'antigravity', 'kimi', 'glm', 'deepseek', 'opencode'] as const).map(id => [id, Object.assign(new Detected(), { found: false })]));
  const workspace = new Workspace(store, codex as unknown as Codex, 2, async () => { throw new Error('unused'); }, { ...others, qwen } as any);
  try {
    await workspace.connect();
    assert.equal(qwen.starts, 0);
    assert.equal(workspace.runtimes.qwen.installed, false);
    assert.equal(workspace.runtimes.qwen.error, null);
    assert.equal(workspace.runtimes.codex.installed, true);
    qwen.found = true;
    await workspace.connect();
    assert.equal(qwen.starts, 1);
    assert.deepEqual([workspace.runtimes.qwen.installed, workspace.runtimes.qwen.connected, workspace.runtimes.qwen.authenticated], [true, true, true]);
    // A connected agent stays offered even if it can no longer be found.
    qwen.found = false;
    await workspace.connect();
    assert.equal(workspace.runtimes.qwen.installed, true);
  } finally { workspace.close(); store.close(); }
});
