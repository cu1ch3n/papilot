import { isNoteGroup } from '../note-groups.ts';
import Fastify from 'fastify';
import compress from '@fastify/compress';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { registerFrontend } from './frontend.ts';
import type { Store } from './store.ts';
import type { Workspace } from './workspace.ts';
import { reviewClient, allowedReviewRoute, rewriteReviewHtml, rewriteReviewJson, confirmedReviewResponse, annotateReviewState } from './review.ts';
import { fullPaperPdf } from './pdf.ts';
import { type ChangeAction, Changes } from './changes.ts';
import { bibliography, confirmEntry } from './references.ts';
import { type Manuscripts, annotationTask, gitAbortMerge, gitCommit, gitDiff, gitFinishMerge, gitIgnore, gitRemote, gitStage, gitStatus } from './manuscript.ts';
import { gitOverview } from './git-overview.ts';
import { findSkill, listedSkill, loadSkills } from './skills.ts';
import { registerSkillRoutes } from './skill-routes.ts';
import { type Accounts, deviceLabel } from './accounts.ts';
import { type Listener, Limiter, SESSION_COOKIE, author, clientAddress, cookie, equals, guard, viewerInfo, visibleSnapshot } from './access.ts';
import { isAgentId, type AgentId, type NoteSummary } from '../shared.ts';
import { parseGroupInstructions } from '../note-groups.ts';
import { taskNoteResults } from './note-results.ts';
import type { Updates } from './updates.ts';
import { Diagnostics } from './diagnostics.ts';
import { attachmentIds } from './attachments.ts';
import { MAX_ATTACHMENT_BYTES } from '../shared.ts';
import { PaperImports } from './imports.ts';
import { DATA } from './paths.ts';

const importsByWorkspace = new WeakMap<Workspace, PaperImports>();

// Git writes to one repository run one at a time; each returns the new status.
// Both listeners share one queue, so the owner and a collaborator take turns.
export function gitQueue() {
  const queue = new Map<string, Promise<unknown>>();
  return function serialGit<T>(projectId: string, work: () => Promise<T>) {
    const run = (queue.get(projectId) || Promise.resolve()).catch(() => {}).then(work);
    queue.set(projectId, run);
    return run.finally(() => { if (queue.get(projectId) === run) queue.delete(projectId); });
  };
}

export interface AppOptions {
  listener: Listener; store: Store; workspace: Workspace; manuscripts: Manuscripts; accounts: Accounts; changes?: Changes;
  csrf: string; serialGit: ReturnType<typeof gitQueue>; dist: string | null; version: string;
  connectReview?: typeof reviewClient;
  updates?: Updates; updateInstance?: string;
  diagnostics?: Diagnostics;
}

// One Fastify instance per listener: the local one for this host and Tailscale,
// the account one for the public URL. Both serve the same workspace.
export async function buildApp(options: AppOptions) {
  const { listener, store, workspace, manuscripts, accounts, serialGit } = options, connectReview = options.connectReview || reviewClient;
  const changes = options.changes || new Changes(fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-changes-')));
  const diagnostics = options.diagnostics || new Diagnostics();
  let imports = importsByWorkspace.get(workspace);
  if (!imports) { imports = new PaperImports(manuscripts, DATA, root => Boolean(store.projectByPath(root))); importsByWorkspace.set(workspace, imports); }
  workspace.importsBusy = () => imports!.busy;
  // A public request must arrive in full within a minute; held-open bodies tie up nothing.
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024, ...(listener.kind === 'account' ? { requestTimeout: 60000 } : {}) });
  const { csrfFor } = guard(app, { listener, accounts, store, csrf: options.csrf, request: id => workspace.requests.get(id) });
  const updateRequests = new WeakMap<object, () => void>();
  app.addHook('onRequest', async (request, reply) => {
    if (!options.updates || !/^\/(api|review)\//.test(request.url) || /^\/api\/(?:updates(?:\/|$)|health(?:\?|$)|events(?:\?|$)|state(?:\?|$))/.test(request.url)) return;
    if (options.updates.restarting) return reply.code(503).header('Retry-After', '3').send({ error: 'Papilot is restarting after an update. Please wait a moment.' });
    const release = options.updates.enter(); updateRequests.set(request, release); reply.raw.once('close', release);
  });
  app.addHook('onResponse', async request => { updateRequests.get(request)?.(); });
  const projectRequests = new WeakMap<object, () => void>();
  app.addHook('preHandler', async request => {
    const access = request.routeOptions.config.access, params = request.params as Record<string, string>;
    if (!access || typeof access !== 'object') return;
    const id = 'project' in access ? (access.from === 'body' ? request.body as Record<string, string> : params)?.[access.project]
      : 'task' in access ? store.tasks().find(task => task.id === params[access.task])?.projectId
      : store.tasks().find(task => task.id === workspace.requests.get(params[access.request])?.taskId)?.projectId;
    if (id) projectRequests.set(request, workspace.enterProjectRequest(id));
  });
  app.addHook('onSend', async (request, _reply, payload) => { projectRequests.get(request)?.(); return payload; });
  app.addHook('onError', async request => { projectRequests.get(request)?.(); });
  await app.register(compress);
  app.setErrorHandler((error, _request, reply) => { reply.code((error as any).statusCode || 400).send({ error: (error as Error).message }); });
  const any = { config: { access: 'any' as const } }, owner = { config: { access: 'owner' as const } };
  registerSkillRoutes(app, store);
  const project = (param = 'id') => ({ config: { access: { project: param } } }), task = { config: { access: { task: 'id' } } };
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
  app.post<{ Params: { id: string } }>('/api/projects/:id/attachments', { ...project(), bodyLimit: MAX_ATTACHMENT_BYTES }, async request => {
    if (!Buffer.isBuffer(request.body)) throw new Error('Upload a file as binary data.');
    const header = request.headers['x-papilot-filename'];
    if (typeof header !== 'string') throw new Error('Choose a file with a valid name.');
    let name: string;
    try { name = decodeURIComponent(header); } catch { throw new Error('Choose a file with a valid name.'); }
    return workspace.attachments.upload(request.params.id, author(request.viewer)?.id || 'owner', name, request.body);
  });
  app.get<{ Params: { id: string; attachment: string } }>('/api/projects/:id/attachments/:attachment', project(), (request, reply) => {
    const file = workspace.attachments.get(request.params.id, request.params.attachment, author(request.viewer)?.id || 'owner');
    const disposition = file.mime.startsWith('image/') ? 'inline' : 'attachment';
    return reply.type(file.mime).header('Content-Disposition', `${disposition}; filename="attachment"; filename*=UTF-8''${encodeURIComponent(file.name).replace(/'/g, '%27')}`)
      .header('Content-Security-Policy', "default-src 'none'; sandbox").send(fs.createReadStream(workspace.attachments.path(file)));
  });
  app.post<{ Params: { id: string; attachment: string } }>('/api/projects/:id/attachments/:attachment/discard', project(), request => {
    workspace.attachments.discard(request.params.id, request.params.attachment, author(request.viewer)?.id || 'owner');
    return { ok: true };
  });
  async function manuscript(id: string, rebuild = false) {
    const root = store.project(id).path, state = await manuscripts.state(id, root, rebuild);
    const notes = store.annotations(id).filter(note => !note.taskId);
    const placed = await manuscripts.reanchor(id, root, notes).catch(() => notes);
    for (let index = 0; index < notes.length; index++) {
      const next = placed[index], previous = notes[index];
      if (next.key === previous.key || next.key !== state.build.key) continue;
      const current = store.annotation(id, previous.id);
      // A comment edit, deletion, or task submission may have happened while
      // PDF positions were being checked. Never restore or overwrite that work.
      if (current.deletedAt !== undefined || current.taskId || workspace.annotationSending(current.id) || current.key !== previous.key) continue;
      store.saveAnnotation({ ...current, key: next.key, page: next.page, rect: next.rect, rects: next.rects, source: next.source });
    }
    return { ...state, annotations: store.annotations(id).filter(note => !note.taskId) };
  }

  app.get('/api/health', { config: { access: 'public' } }, () => listener.kind === 'local' ? { ok: true, name: 'Papilot', version: options.version, ...(options.updateInstance ? { updateInstance: options.updateInstance } : {}) } : { ok: true });
  // Environment reports include host paths, so they are available only to the owner.
  app.post('/api/diagnostics', owner, request => {
    const projectId = (request.body as { projectId?: unknown } | null)?.projectId;
    if (projectId !== undefined && (typeof projectId !== 'string' || !projectId || projectId.length > 64)) throw new Error('Select a valid paper to check.');
    const repo = projectId ? store.project(projectId).path : undefined;
    return diagnostics.check(repo, listener.kind === 'local' ? listener.port : undefined);
  });
  if (options.updates) {
    app.get('/api/updates', owner, () => options.updates!.snapshot());
    app.post('/api/updates/check', owner, () => options.updates!.check());
    app.post('/api/updates/channel', owner, request => options.updates!.setChannel((request.body as any)?.channel));
    app.post('/api/updates/install', owner, request => options.updates!.install((request.body as any)?.version));
  }
  app.get('/api/state', any, request => {
    const viewer = request.viewer!;
    return { ...visibleSnapshot(workspace.snapshot(), viewer, accounts), csrf: csrfFor(viewer), viewer: viewerInfo(viewer, accounts) };
  });
  // Signed-in people get at most a few event streams each.
  const streams = new Map<string, number>();
  app.get('/api/events', any, (request, reply) => {
    const viewer = request.viewer!, session = viewer.listener === 'account' ? viewer.session.id : '';
    if (session && (streams.get(session) || 0) >= 6) return reply.code(429).send({ error: 'Too many open Papilot tabs. Close one and try again.' });
    if (session) streams.set(session, (streams.get(session) || 0) + 1);
    reply.hijack();
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    reply.raw.write('event: change\ndata: {}\n\n');
    let timer: NodeJS.Timeout | undefined;
    const change = () => { timer ??= setTimeout(() => { timer = undefined; reply.raw.write('event: change\ndata: {}\n\n'); }, 400); };
    // Removing someone or unsharing a paper reaches their open tabs at once;
    // a stream whose session ended closes, and the tab then asks to sign in.
    const revoked = (event: { userId?: string; sessionId?: string }) => {
      if (viewer.listener !== 'account' || (event.userId !== viewer.user.id && event.sessionId !== viewer.session.id)) return;
      if (!accounts.session(cookie(request.headers.cookie, SESSION_COOKIE))) { reply.raw.write('event: change\ndata: {}\n\n'); reply.raw.end(); } else change();
    };
    workspace.on('change', change);
    accounts.on('revoked', revoked);
    const heartbeat = setInterval(() => reply.raw.write(': heartbeat\n\n'), 15000);
    reply.raw.on('close', () => {
      clearInterval(heartbeat); if (timer) clearTimeout(timer); workspace.off('change', change); accounts.off('revoked', revoked);
      if (session) { const open = (streams.get(session) || 1) - 1; if (open) streams.set(session, open); else streams.delete(session); }
    });
  });
  app.post('/api/reconnect', any, async request => { await workspace.connect(); return visibleSnapshot(workspace.snapshot(), request.viewer!, accounts).runtime; });
  // Codex names reasoning efforts with short lowercase words (low, medium, xhigh).
  const agent = (value: unknown): AgentId => isAgentId(value) ? value : 'codex';
  const effort = (value: unknown) => typeof value === 'string' && /^[a-z]{1,16}$/.test(value) ? value : undefined;
  const string = (value: unknown, name: string, max = 20000) => { if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${name} is required and must be no longer than ${max} characters.`); return value.trim(); };
  // Adding a paper names a folder on this host, so only the owner can.
  app.post('/api/projects', owner, async request => { const b = request.body as any; return workspace.addProject(string(b.path, 'Repository path', 4000), b.name ? string(b.name, 'Paper name', 120) : undefined); });
  app.post('/api/imports', { ...owner, bodyLimit: 90 * 1024 * 1024 }, request => imports!.create((request.body || {}) as any));
  app.get<{ Params: { id: string } }>('/api/imports/:id', owner, request => imports!.get(request.params.id));
  app.post<{ Params: { id: string } }>('/api/imports/:id/build', owner, request => imports!.build(request.params.id, (request.body || {}) as any));
  app.post<{ Params: { id: string } }>('/api/imports/:id/repair', owner, request => imports!.build(request.params.id, (request.body || {}) as any, (root, error) => workspace.repairImport(root, error, { agent: agent((request.body as any)?.agent) })));
  app.post<{ Params: { id: string } }>('/api/imports/:id/finish', owner, request => imports!.finish(request.params.id, (root, name) => workspace.addProject(root, name)));
  app.post<{ Params: { id: string } }>('/api/projects/:id/rename', project(), request => workspace.renameProject(request.params.id, string((request.body as any).name, 'Paper name', 120)));
  const paperIdle = (id: string) => { if (manuscripts.busyForProject(id) || changes.busyForProject(id)) throw Object.assign(new Error('Wait for this paper’s PDF build to finish before changing its path or removing it.'), { statusCode: 409 }); };
  const forgetPaper = (id: string) => { manuscripts.forgetProject(id); changes.forgetProject(id); };
  app.post<{ Params: { id: string } }>('/api/projects/:id/path', owner, async request => {
    const id = request.params.id, body = request.body as any;
    const result = await workspace.changeProjectPath(id, string(body?.path, 'Repository path', 4000), () => paperIdle(id), body?.name === undefined ? undefined : string(body.name, 'Paper name', 120));
    forgetPaper(id); return result;
  });
  app.post<{ Params: { id: string } }>('/api/projects/:id/remove', owner, request => {
    const id = request.params.id, result = workspace.removeProject(id, () => paperIdle(id));
    forgetPaper(id); return result;
  });
  // A skill's name: what the author typed after "/".
  const skillName = (value: unknown) => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,47}$/.test(value) ? value : undefined;
  // Text the author may leave empty when a skill or review feedback says enough.
  const optional = (value: unknown, name: string, max = 20000) => value === undefined || value === '' ? '' : string(value, name, max);
  app.get<{ Params: { id: string } }>('/api/projects/:id/skills', project(), request => ({ skills: loadSkills(store.project(request.params.id).path).map(listedSkill) }));
  app.post('/api/tasks', { config: { access: { project: 'projectId', from: 'body' } } }, async request => {
    const b = request.body as any, skill = skillName(b.skill), attachments = attachmentIds(b.attachments);
    if (b.annotations !== undefined && (!Array.isArray(b.annotations) || b.annotations.length > 500 || b.annotations.some((id: unknown) => typeof id !== 'string' || !id || id.length > 64))) throw new Error('Select valid PDF notes for this task.');
    const annotations: string[] | undefined = b.annotations, groupInstructions = parseGroupInstructions(b.groupInstructions);
    return workspace.createTask({ id: string(b.id, 'Task ID', 64), projectId: string(b.projectId, 'Paper ID', 64), title: string(b.title, 'Task title', 120), instructions: skill || annotations?.length || attachments.length ? optional(b.instructions, 'Instructions') : string(b.instructions, 'Instructions'), skill, annotations, groupInstructions, attachments, agent: agent(b.agent), model: typeof b.model === 'string' ? b.model : undefined, effort: effort(b.effort), serviceTier: b.serviceTier === undefined ? undefined : string(b.serviceTier, 'Service tier', 64), author: author(request.viewer) });
  });
  app.get<{ Params: { id: string } }>('/api/tasks/:id/items', task, request => { store.task(request.params.id); return { items: store.items(request.params.id) }; });
  app.get<{ Params: { id: string } }>('/api/tasks/:id/note-results', task, async request => {
    const task = store.task(request.params.id), client = await connectReview(store.project(task.projectId).path);
    return { notes: await taskNoteResults(task, store.items(task.id), store.runs().filter(run => run.taskId === task.id), client) };
  });
  app.get<{ Params: { id: string }; Querystring: { round?: string; version?: string; download?: string } }>('/api/tasks/:id/pdf', task, async (request, reply) => {
    const task = store.task(request.params.id), project = store.project(task.projectId);
    const round = request.query.round === undefined ? task.review?.round : Number(request.query.round);
    const side = request.query.version || 'after';
    if (!round || !Number.isSafeInteger(round) || round < 1 || (side !== 'before' && side !== 'after')) return reply.code(400).send({ error: 'Select an existing review round and either the before or after PDF.' });
    const pdf = await fullPaperPdf(project.path, task.name, round, side);
    const filename = `papilot-${task.name}-r${round}-${side}.pdf`;
    return reply.type('application/pdf').header('Content-Disposition', `${request.query.download === '1' ? 'attachment' : 'inline'}; filename="${filename}"`).sendFile(path.basename(pdf), path.dirname(pdf), { cacheControl: false });
  });
  app.post<{ Params: { id: string } }>('/api/tasks/:id/messages', task, async request => {
    const b = request.body as any, task = store.task(request.params.id), feedback = b.feedback === true, name = skillName(b.skill);
    const attachments = attachmentIds(b.attachments);
    if (feedback && attachments.length) throw new Error('Send attachments with a message, separately from review feedback.');
    const skill = name ? findSkill(store.project(task.projectId).path, name) : undefined;
    let reviewNotes: NoteSummary[] | undefined;
    if (b.notes !== undefined) {
      if (!Array.isArray(b.notes) || !b.notes.length || b.notes.length > 500 || feedback || skill) throw new Error('Select valid review notes.');
      reviewNotes = b.notes.map((note: any) => {
        if (!note || typeof note !== 'object') throw new Error('Select valid review notes.');
        if (note.group !== undefined && !isNoteGroup(note.group)) throw new Error('Invalid annotation group.');
        const anchor = note.anchor;
        if (anchor && (!Array.isArray(anchor.sources) || anchor.sources.length > 40 || (anchor.round !== undefined && (!Number.isSafeInteger(anchor.round) || anchor.round < 1 || anchor.round > (task.review?.round || 0))))) throw new Error('Invalid note location.');
        const sources = anchor?.sources.map((source: any) => {
          if (!source || !Array.isArray(source.lines) || source.lines.length !== 2 || !source.lines.every((line: unknown) => Number.isSafeInteger(line) && Number(line) >= 1) || source.lines[1] < source.lines[0]) throw new Error('Invalid note location.');
          return { file: string(source.file, 'Source file', 4096), lines: source.lines as [number, number] };
        });
        return { ...(note.id ? { id: string(note.id, 'Note ID', 100) } : {}), where: string(note.where, 'Note location', 4000), quote: optional(note.quote, 'PDF text', 2000), comment: note.group ? optional(note.comment, 'Note', 4000) : string(note.comment, 'Note', 4000), ...(note.group ? { group: note.group } : {}), ...(anchor ? { anchor: { sources, ...(anchor.round ? { round: anchor.round } : {}) } } : {}) };
      });
    }
    const text = feedback || skill || reviewNotes || attachments.length ? optional(b.text, 'Revision instructions') : string(b.text, 'Revision instructions');
    return workspace.enqueue(task.id, text, string(b.requestKey, 'Request ID', 100), true, { skill, feedback, reviewNotes, attachments, author: author(request.viewer) });
  });
  // Commits what the author accepted from this task, with the message they confirmed.
  app.post<{ Params: { id: string } }>('/api/tasks/:id/commit', task, request => {
    const task = store.task(request.params.id), b = request.body as any;
    return serialGit(task.projectId, () => workspace.commitTask(task.id, string(b.message, 'Commit message', 5000), b.push === true));
  });
  app.post<{ Params: { id: string } }>('/api/tasks/:id/apply', task, request => {
    const task = store.task(request.params.id);
    return serialGit(task.projectId, () => workspace.deliverTask(task.id, 'workspace'));
  });
  app.post<{ Params: { id: string } }>('/api/tasks/:id/commit-message', task, request => {
    const task = store.task(request.params.id);
    return workspace.commitMessage(task.projectId, task.review?.files || [], { taskId: task.id, agent: task.agent, fresh: (request.body as any)?.fresh === true });
  });
  app.post<{ Params: { id: string } }>('/api/tasks/:id/rename', task, request => workspace.renameTask(request.params.id, string((request.body as any).title, 'Task title', 120)));
  app.post<{ Params: { id: string } }>('/api/tasks/:id/title', task, request => workspace.requestTaskTitle(request.params.id));
  app.post<{ Params: { id: string } }>('/api/tasks/:id/archive', task, request => workspace.archiveTask(request.params.id, (request.body as any)?.archived, (request.body as any)?.finished === true));
  app.post<{ Params: { id: string } }>('/api/tasks/:id/interrupt', task, request => workspace.interrupt(request.params.id).then(() => ({ ok: true })));
  // Deleting a task that is already gone succeeds, so a lost response can be retried; a hidden one answers the same.
  app.post<{ Params: { id: string } }>('/api/tasks/:id/delete', { config: { access: { task: 'id' }, hidden: 'ok' } }, request => {
    if ((request.body as any)?.confirm !== true) throw new Error('Confirm permanent task deletion before continuing.');
    return workspace.deleteTask(request.params.id);
  });
  app.post<{ Params: { id: string } }>('/api/tasks/:id/reconcile', task, request => workspace.reconcile(request.params.id));
  app.post<{ Params: { id: string } }>('/api/tasks/:id/publish', task, request => {
    const task = store.task(request.params.id); if (['running', 'waiting_input', 'building'].includes(task.status)) throw new Error('This task is busy. Wait for it to finish or pause it first.');
    void workspace.publish(task.id); return { ok: true };
  });
  // The manuscript preview compiles each paper's working tree and reports its Git status.
  app.get<{ Params: { id: string } }>('/api/projects/:id/manuscript', project(), request => manuscript(request.params.id));
  app.get<{ Params: { id: string } }>('/api/projects/:id/git', project(), request => gitStatus(store.project(request.params.id).path));
  // The paper's bibliography: every entry, its problems and its online check.
  app.get<{ Params: { id: string }; Querystring: { check?: string; retry?: string } }>('/api/projects/:id/references', project(), request =>
    bibliography(store.project(request.params.id).path, request.query.check === '1', request.query.retry === '1'));
  app.post<{ Params: { id: string } }>('/api/projects/:id/references/confirm', project(), request => {
    const b = request.body as any;
    if (typeof b?.id !== 'string' || typeof b?.confirmed !== 'boolean') throw new Error('Choose an entry to confirm.');
    return confirmEntry(store.project(request.params.id).path, b.id, b.confirmed);
  });
  app.get<{ Params: { id: string } }>('/api/projects/:id/git/overview', project(), request => gitOverview(store.project(request.params.id).path, store.tasks().filter(task => task.projectId === request.params.id)));
  app.get<{ Params: { id: string }; Querystring: { path?: string } }>('/api/projects/:id/git/diff', project(), request => gitDiff(store.project(request.params.id).path, string(request.query.path, 'File path', 4096)));
  const paths = (value: unknown): string[] => Array.isArray(value) ? value.filter((p: unknown): p is string => typeof p === 'string').slice(0, 5000) : [];
  app.post<{ Params: { id: string } }>('/api/projects/:id/git/commit', project(), request => {
    const project = store.project(request.params.id), b = request.body as any;
    const message = string(b.message, 'Commit message', 5000), chosen = b.staged === true ? null : paths(b.paths);
    let pushError: string | undefined;
    return serialGit(project.id, () => workspace.exclusiveCommit(project.id, async () => {
      const commit = await gitCommit(project.path, message, chosen);
      // The commit stands even when the push fails; the author can push again.
      if (b.push === true) try { await gitRemote(project.path, 'push'); } catch (error) { pushError = (error as Error).message; }
      return { commit, git: await gitStatus(project.path), ...(pushError ? { pushError } : {}) };
    }));
  });
  // The Git panel's checkboxes stage or unstage whole files.
  app.post<{ Params: { id: string } }>('/api/projects/:id/git/stage', project(), request => {
    const project = store.project(request.params.id), b = request.body as any;
    return serialGit(project.id, async () => ({ git: await gitStage(project.path, paths(b.paths), b.stage !== false) }));
  });
  // An agent writes a commit message for the chosen files, or a fresh one
  // instead of the message it already wrote for them; nothing is written.
  app.post<{ Params: { id: string } }>('/api/projects/:id/git/message', project(), request => {
    const b = request.body as any;
    return workspace.commitMessage(store.project(request.params.id).id, paths(b.paths), { agent: b.agent === undefined ? undefined : agent(b.agent), fresh: b.fresh === true, staged: b.staged === true });
  });
  // A merge in progress is resolved by an agent, committed, or abandoned.
  app.post<{ Params: { id: string } }>('/api/projects/:id/git/resolve', project(), request => {
    const project = store.project(request.params.id), b = request.body as any;
    return serialGit(project.id, () => workspace.resolveConflicts(project.id, { agent: b.agent === undefined ? undefined : agent(b.agent), model: typeof b.model === 'string' ? b.model : undefined }));
  });
  app.post<{ Params: { id: string } }>('/api/projects/:id/git/finish', project(), request => {
    const project = store.project(request.params.id);
    return serialGit(project.id, () => workspace.exclusiveCommit(project.id, async () => ({ commit: await gitFinishMerge(project.path), git: await gitStatus(project.path) })));
  });
  app.post<{ Params: { id: string } }>('/api/projects/:id/git/abort', project(), request => {
    const project = store.project(request.params.id);
    return serialGit(project.id, async () => { await gitAbortMerge(project.path); return { git: await gitStatus(project.path) }; });
  });
  // Chosen untracked build files go into .gitignore by kind.
  app.post<{ Params: { id: string } }>('/api/projects/:id/git/ignore', project(), request => {
    const project = store.project(request.params.id);
    return serialGit(project.id, async () => ({ git: await gitIgnore(project.path, paths((request.body as any).paths)) }));
  });
  app.post<{ Params: { id: string; action: string } }>('/api/projects/:id/git/:action', project(), request => {
    const project = store.project(request.params.id), action = request.params.action;
    if (action !== 'fetch' && action !== 'pull' && action !== 'merge' && action !== 'push') throw Object.assign(new Error('Unknown Git action.'), { statusCode: 404 });
    return serialGit(project.id, async () => { await gitRemote(project.path, action); return { git: await gitStatus(project.path) }; });
  });
  app.post<{ Params: { id: string } }>('/api/projects/:id/manuscript', project(), request => manuscript(request.params.id, true));
  // Notes marked on the manuscript PDF become one agent task when sent.
  app.post<{ Params: { id: string } }>('/api/projects/:id/annotations', project(), async request => {
    const project = store.project(request.params.id), b = request.body as any;
    const isRect = (value: unknown): value is [number, number, number, number] => Array.isArray(value) && value.length === 4 && value.every(v => typeof v === 'number' && v >= 0 && v <= 1) && value[2] > value[0] && value[3] > value[1];
    if (!isRect(b.rect)) throw new Error('Select text or mark a region on the page first.');
    const rects = Array.isArray(b.rects) ? b.rects.slice(0, 80).filter(isRect) : [];
    if (b.group !== undefined && !isNoteGroup(b.group)) throw new Error('Invalid annotation group.');
    const comment = b.group ? optional(b.comment, 'Note', 4000) : string(b.comment, 'Note', 4000), key = string(b.key, 'Preview key', 64), page = Number(b.page);
    const selected = typeof b.quote === 'string' ? b.quote.slice(0, 2000) : '';
    const { quote, source } = await manuscripts.locate(project.id, key, page, b.rect, rects, selected);
    const by = author(request.viewer);
    return store.saveAnnotation({ id: randomUUID(), projectId: project.id, key, page, rect: b.rect, ...(b.group ? { group: b.group } : {}), ...(rects.length ? { rects } : {}), comment, quote, source, createdAt: Date.now(), ...(by ? { author: by } : {}) });
  });
  app.post<{ Params: { id: string; note: string } }>('/api/projects/:id/annotations/:note', project(), request => {
    const note = store.annotation(request.params.id, request.params.note);
    if (workspace.annotationSending(note.id)) throw new Error('This note is being sent. Wait for the task to finish creating.');
    if (note.taskId) throw new Error('This note has already been sent.');
    if (note.deletedAt !== undefined) throw new Error('This note has been deleted. Undo the deletion first.');
    return store.saveAnnotation({ ...note, comment: string((request.body as any)?.comment, 'Note', 4000) });
  });
  app.post<{ Params: { id: string; note: string } }>('/api/projects/:id/annotations/:note/delete', project(), request => {
    const note = store.annotation(request.params.id, request.params.note);
    if (workspace.annotationSending(note.id)) throw new Error('This note is being sent. Wait for the task to finish creating.');
    store.deleteAnnotation(request.params.id, request.params.note); return { ok: true };
  });
  app.post<{ Params: { id: string; note: string } }>('/api/projects/:id/annotations/:note/restore', project(), request => {
    const note = store.annotation(request.params.id, request.params.note);
    if (workspace.annotationSending(note.id)) throw new Error('This note is being sent. Wait for the task to finish creating.');
    if (note.taskId) throw new Error('This note has already been sent.');
    const { deletedAt: _, ...restored } = note;
    store.saveAnnotation(restored);
    // Return the original order, including any notes added since the deletion.
    return { annotations: store.annotations(request.params.id).filter(note => !note.taskId) };
  });
  app.post<{ Params: { id: string } }>('/api/projects/:id/annotations/send', project(), async request => {
    const project = store.project(request.params.id), b = request.body as any, id = string(b.id, 'Task ID', 64);
    // A retried send returns its task; an ID from another paper is refused.
    const existing = store.tasks().find(task => task.id === id);
    if (existing) { if (existing.projectId !== project.id) throw new Error('Invalid task ID.'); return existing; }
    const notes = store.annotations(project.id).filter(note => !note.taskId);
    if (!notes.length) throw new Error('Mark a region on the PDF and add a note first.');
    const { title } = annotationTask(notes);
    return workspace.createTask({ id, projectId: project.id, title, instructions: '', annotations: notes.map(note => note.id), agent: agent(b.agent), model: typeof b.model === 'string' ? b.model : undefined, effort: effort(b.effort), serviceTier: b.serviceTier === undefined ? undefined : string(b.serviceTier, 'Service tier', 64), author: author(request.viewer) });
  });
  // Exact word places for the PDF view's selection layer; immutable per build key.
  app.get<{ Params: { id: string }; Querystring: { key?: string; page?: string } }>('/api/projects/:id/manuscript/words', project(), async (request, reply) => {
    const project = store.project(request.params.id);
    const words = await manuscripts.words(project.id, String(request.query.key || ''), Number(request.query.page));
    return reply.header('Cache-Control', 'private, max-age=31536000, immutable').send(words);
  });
  app.get<{ Params: { id: string }; Querystring: { key?: string; download?: string } }>('/api/projects/:id/manuscript.pdf', project(), (request, reply) => {
    const project = store.project(request.params.id), pdf = manuscripts.pdf(project.id, String(request.query.key || ''));
    const name = (project.name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'manuscript') + '.pdf';
    // Each key names one immutable build, so the viewer can cache and range-read it.
    return reply.type('application/pdf').header('Content-Disposition', `${request.query.download === '1' ? 'attachment' : 'inline'}; filename="${name}"`).header('Cache-Control', 'private, max-age=31536000, immutable').sendFile(path.basename(pdf), path.dirname(pdf), { cacheControl: false });
  });
  app.post<{ Params: { id: string } }>('/api/requests/:id', { config: { access: { request: 'id' } } }, request => { workspace.answer(request.params.id, request.body as any); return { ok: true }; });

  // People and sharing, for the owner. Papers shared with someone must exist.
  const papers = (value: unknown) => { const known = new Set(store.projects().map(p => p.id)); return paths(value).filter(id => known.has(id)); };
  app.get('/api/people', owner, () => accounts.people());
  app.post('/api/people', owner, request => { const b = request.body as any; return accounts.addPerson(string(b.name, 'Name', 80), papers(b.projects)); });
  app.post<{ Params: { person: string } }>('/api/people/:person/rename', owner, request => { accounts.rename(request.params.person, string((request.body as any).name, 'Name', 80)); return accounts.people(); });
  app.post<{ Params: { person: string } }>('/api/people/:person/share', owner, request => { accounts.share(request.params.person, papers((request.body as any).projects)); return accounts.people(); });
  app.post<{ Params: { person: string } }>('/api/people/:person/invite', owner, request => ({ link: accounts.invite(request.params.person) }));
  app.post<{ Params: { person: string } }>('/api/people/:person/remove', owner, request => { accounts.remove(request.params.person); return accounts.people(); });
  app.post<{ Params: { person: string; device: string } }>('/api/people/:person/devices/:device/remove', owner, request => { accounts.revoke(request.params.person, request.params.device); return accounts.people(); });
  app.post<{ Params: { person: string } }>('/api/people/:person/sign-out', owner, request => { accounts.signOutEverywhere(request.params.person); return accounts.people(); });

  // Signing in at the public URL: an invite registers a passkey, which then signs in.
  if (listener.kind === 'account') {
    // __Host- cookies must be Secure; browsers accept that on http://localhost too.
    const limiter = new Limiter();
    const auth = { config: { access: 'public' as const, csrf: false as const }, bodyLimit: 16 * 1024 };
    const limited = (request: any, reply: any) => { if (!limiter.take(clientAddress(request))) { reply.code(429).send({ error: 'Too many attempts. Wait a minute and try again.' }); return true; } return false; };
    const signIn = (reply: any, started: { token: string }) => reply.header('Set-Cookie', `${SESSION_COOKIE}=${started.token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${90 * 86400}`).send({ ok: true });
    const paperName = (id: string) => store.projects().find(p => p.id === id)?.name;
    app.post('/api/auth/invite', auth, (request, reply) => limited(request, reply) || reply.send(accounts.inviteInfo(String((request.body as any)?.token || ''), paperName)));
    app.post('/api/auth/invite/options', auth, async (request, reply) => limited(request, reply) || reply.send(await accounts.registrationOptions(String((request.body as any)?.token || ''))));
    app.post('/api/auth/invite/verify', auth, async (request, reply) => {
      if (limited(request, reply)) return;
      const b = request.body as any;
      return signIn(reply, await accounts.register(String(b?.token || ''), b?.response, deviceLabel(request.headers['user-agent'])));
    });
    app.post('/api/auth/options', auth, async (request, reply) => limited(request, reply) || reply.send(await accounts.authenticationOptions()));
    app.post('/api/auth/verify', auth, async (request, reply) => {
      if (limited(request, reply)) return;
      return signIn(reply, await accounts.authenticate((request.body as any)?.response, deviceLabel(request.headers['user-agent'])));
    });
    app.post('/api/auth/logout', any, (request, reply) => {
      const viewer = request.viewer!;
      if (viewer.listener === 'account') accounts.endSession(viewer.session.id);
      return reply.header('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`).header('Clear-Site-Data', '"cache"').send({ ok: true });
    });
  }

  // The review viewer also shows a paper's uncommitted changes against its
  // last commit. Papilot answers those routes itself, ahead of the engine's
  // below, and the viewer posts with Papilot's token. Staging writes the
  // index; reverting writes files, so it waits for review actions and commits.
  const changesAccess = { config: { access: { project: 'projectId' }, csrf: false as const } };
  const changesToken = (request: { headers: Record<string, unknown>; viewer?: Parameters<typeof csrfFor>[0] }) => {
    if (!equals(String(request.headers['x-review-token'] || ''), csrfFor(request.viewer!))) throw Object.assign(new Error('This page has expired. Refresh it and try again.'), { statusCode: 403 });
  };
  const CHANGE_ACTIONS: Record<string, ChangeAction> = { accept: 'stage', unstage: 'unstage', reject: 'revert' };
  app.get<{ Params: { projectId: string }; Querystring: { round?: string } }>('/review/:projectId/api/changes/state', changesAccess, request => {
    const project = store.project(request.params.projectId), round = Number(request.query.round);
    return changes.state(project.id, project.path, csrfFor(request.viewer!), Number.isSafeInteger(round) && round > 0 ? round : undefined);
  });
  app.get<{ Params: { projectId: string; number: string } }>('/review/:projectId/api/changes/rounds/:number', changesAccess, request => changes.detail(store.project(request.params.projectId).id, Number(request.params.number)));
  app.get<{ Params: { projectId: string; number: string; unit: string } }>('/review/:projectId/api/changes/rounds/:number/effects/:unit', changesAccess, request =>
    changes.effects(store.project(request.params.projectId).id, Number(request.params.number), request.params.unit));
  app.get<{ Params: { projectId: string; number: string }; Querystring: { check?: string; retry?: string } }>('/review/:projectId/api/changes/rounds/:number/references', changesAccess, request => {
    const project = store.project(request.params.projectId);
    return changes.references(project.id, project.path, Number(request.params.number), request.query.check === '1', request.query.retry === '1');
  });
  app.post<{ Params: { projectId: string; number: string } }>('/review/:projectId/api/changes/rounds/:number/references/confirm', changesAccess, request => {
    changesToken(request);
    const project = store.project(request.params.projectId), b = request.body as any;
    if (typeof b?.id !== 'string' || typeof b?.confirmed !== 'boolean') throw new Error('Choose an entry to confirm.');
    return changes.confirmReference(project.id, project.path, Number(request.params.number), b.id, b.confirmed);
  });
  app.get<{ Params: { projectId: string; number: string; file: string } }>('/review/:projectId/changes/files/:number/:file', changesAccess, (request, reply) => {
    const file = changes.file(store.project(request.params.projectId).id, Number(request.params.number), request.params.file);
    return reply.header('Cache-Control', 'private, max-age=31536000, immutable').type(file.endsWith('.svg') ? 'image/svg+xml' : 'image/png').send(fs.createReadStream(file));
  });
  app.post<{ Params: { projectId: string } }>('/review/:projectId/api/changes/decide', changesAccess, request => {
    changesToken(request);
    const project = store.project(request.params.projectId), b = request.body as any, action = CHANGE_ACTIONS[String(b?.action)];
    if (!action) throw new Error('Choose stage, unstage or revert.');
    const ids = Array.isArray(b.changes) ? b.changes.filter((id: unknown): id is string => typeof id === 'string').slice(0, 2000) : [];
    const act = () => changes.act(project.id, project.path, csrfFor(request.viewer!), action, Number(b.round), ids);
    return serialGit(project.id, () => action === 'revert' ? workspace.exclusiveCommit(project.id, act) : act());
  });
  app.post<{ Params: { projectId: string } }>('/review/:projectId/api/changes/undo', changesAccess, request => {
    changesToken(request);
    const project = store.project(request.params.projectId), id = string((request.body as any)?.id, 'Revert ID', 80);
    return serialGit(project.id, () => workspace.exclusiveCommit(project.id, () => changes.undo(project.id, project.path, csrfFor(request.viewer!), id)));
  });

  app.route<{ Params: { projectId: string; '*': string } }>({
    // The review page posts with the review engine's token rather than Papilot's.
    method: ['GET', 'POST'], url: '/review/:projectId/*', config: { access: { project: 'projectId' }, csrf: false }, handler: async (request, reply) => {
      const project = store.project(request.params.projectId);
      const route = '/' + request.params['*'];
      if (route.includes('..') || !allowedReviewRoute(route, request.method)) return reply.code(404).send({ error: 'Review resource not found.' });
      const client = await connectReview(project.path);
      if (request.method === 'POST') {
        if (!equals(String(request.headers['x-review-token'] || ''), client.token)) return reply.code(403).send({ error: 'This review page has expired. Refresh it and try again.' });
      }
      const reviewTask = request.method === 'POST' ? store.tasks().find(t => t.projectId === project.id && t.name === route.split('/')[3]) : undefined;
      const writesFiles = route.endsWith('/undo') || (route.endsWith('/decide') && (request.body as any)?.action !== 'comment');
      if (request.method === 'POST' && writesFiles) string((request.body as any)?.id, 'Review action ID', 80);
      const forward = async () => {
        const search = new URL(request.url, 'http://localhost').search;
        const response = await fetch(client.url + route + search, {
          method: request.method, headers: { 'Content-Type': 'application/json', 'X-Review-Token': client.token },
          ...(request.method === 'POST' ? { body: JSON.stringify(request.body) } : {}),
          signal: AbortSignal.timeout(120000), redirect: 'error',
        });
        reply.code(response.status);
        const type = response.headers.get('content-type') || 'application/octet-stream';
        const prefix = `/review/${project.id}`;
        if (type.includes('application/json')) {
          const value = await response.json();
          if (reviewTask && writesFiles && !confirmedReviewResponse(response.status, value, reviewTask.name)) throw new Error('The review engine could not confirm this action. Select Check status before continuing.');
          if (!response.ok && request.method === 'POST' && (value as any).error) {
            const task = store.tasks().find(t => t.projectId === project.id && t.name === route.split('/')[3]);
            if (task) store.updateTask(task.id, { error: 'Review action failed: ' + (value as any).error });
          }
          if (response.ok && request.method === 'POST' && !route.endsWith('/references/confirm')) {
            const task = store.tasks().find(t => t.projectId === project.id && t.name === route.split('/')[3]);
            if (task) {
              store.updateTask(task.id, { error: null });
              await workspace.refresh(task.id);
              void workspace.prepareCommitMessage(task.id);
            }
          }
          return rewriteReviewJson(value, prefix);
        }
        if (reviewTask && writesFiles) throw new Error('The review engine returned an unexpected response. Select Check status before continuing.');
        reply.type(type);
        if (type.includes('text/html')) return rewriteReviewHtml(await response.text(), prefix);
        const cache = response.headers.get('cache-control'); if (cache && route.startsWith('/files/')) reply.header('Cache-Control', cache);
        if (route.startsWith('/assets/')) reply.header('Cache-Control', 'private, max-age=31536000, immutable');
        return Buffer.from(await response.arrayBuffer());
      };
      if (request.method === 'POST' && !reviewTask) throw new Error('This review task does not belong to this workspace.');
      const result = await (reviewTask ? workspace.reviewWrite(reviewTask.id, writesFiles, forward, writesFiles ? { route, body: request.body as Record<string, unknown> } : undefined) : forward());
      return annotateReviewState(result, store.tasks().filter(task => task.projectId === project.id));
    },
  });

  if (options.dist) await registerFrontend(app, options.dist);
  else app.get('/', { config: { access: 'public' } }, (_request, reply) => reply.type('text/plain').send('Papilot: run npm run build, then restart the server.'));
  return app;
}
