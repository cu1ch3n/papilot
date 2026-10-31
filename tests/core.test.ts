import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { Store } from '../src/server/store.ts';
import { Codex } from '../src/server/codex.ts';
import { authorize } from '../src/server/security.ts';
import { allowedReviewRoute, rewriteReviewHtml, rewriteReviewJson } from '../src/server/review.ts';
import type { Task, Run } from '../src/shared.ts';

test('restart preserves queued instructions and marks in-flight work interrupted', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-store-'));
  try {
    const store = new Store(path.join(folder, 'state.sqlite'));
    const task: Task = { id: 'task', projectId: 'paper', name: 'task', title: 'Example', instructions: 'Edit', worktree: '/tmp/example', threadId: 'thread', turnId: 'turn', model: null, status: 'running', createdAt: 1, updatedAt: 1, feedbackCursor: 42, error: null, review: null };
    store.saveTask(task);
    const run: Run = { id: 'run', taskId: task.id, requestKey: 'request', prompt: 'Keep this feedback', status: 'running', createdAt: 1, finishedAt: null };
    store.saveRun(run); store.saveRun({ ...run, id: 'next', requestKey: 'next-request', status: 'queued' }); store.close();
    const restarted = new Store(path.join(folder, 'state.sqlite')); restarted.recover();
    assert.equal(restarted.task('task').status, 'interrupted');
    assert.equal(restarted.task('task').threadId, 'thread');
    assert.equal(restarted.task('task').feedbackCursor, 42);
    assert.equal(restarted.runByKey('next-request')?.status, 'queued');
    assert.equal(restarted.runByKey('request')?.status, 'interrupted');
    assert.throws(() => restarted.saveRun({ ...run, id: 'duplicate' }), /UNIQUE/);
    restarted.close();
  } finally { fs.rmSync(folder, { recursive: true }); }
});

test('remote access requires the configured Tailscale identity and matching browser origin', () => {
  const origin = 'https://mini.example.ts.net:8443';
  const check = (headers: any, address = '127.0.0.1') => authorize(headers, address, 7274, origin, 'owner@example');
  assert.equal(check({ host: '127.0.0.1:7274' }), null);
  assert.ok(check({ host: '127.0.0.1:7274', origin: 'https://evil.example' }));
  assert.ok(check({ host: 'evil.example' }));
  assert.ok(check({ host: '127.0.0.1:7274', 'x-forwarded-for': '100.64.0.2', 'tailscale-user-login': 'other@example' }));
  assert.ok(check({ host: 'mini.example.ts.net:8443' }));
  assert.ok(check({ host: 'mini.example.ts.net:8443', 'tailscale-user-login': 'other@example' }));
  assert.equal(check({ host: 'mini.example.ts.net:8443', origin, 'tailscale-user-login': 'owner@example' }), null);
  assert.ok(check({ host: 'mini.example.ts.net:8443', origin: 'https://evil.example', 'tailscale-user-login': 'owner@example' }));
  assert.ok(check({ host: '127.0.0.1:7274' }, '192.168.1.4'));
});

test('review proxy only exposes review routes and keeps assets on the remote origin', () => {
  assert.ok(allowedReviewRoute('/api/tasks/p-test/rounds/1', 'GET'));
  assert.ok(allowedReviewRoute('/api/tasks/p-test/decide', 'POST'));
  assert.ok(allowedReviewRoute('/api/tasks/p-test/rounds/1/effects/c001', 'GET'));
  assert.ok(allowedReviewRoute('/api/tasks/p-test/rounds/1/references', 'GET'));
  assert.equal(allowedReviewRoute('/api/tasks/p-test/rounds/1/references', 'POST'), false);
  assert.ok(allowedReviewRoute('/api/tasks/p-test/rounds/1/references/confirm', 'POST'));
  assert.equal(allowedReviewRoute('/api/tasks/p-test/rounds/1/references/confirm', 'GET'), false);
  assert.equal(allowedReviewRoute('/api/tasks/p-test/rounds/1/effects/../x', 'GET'), false);
  assert.equal(allowedReviewRoute('/api/tasks/p-test/rounds/1/effects/c001', 'POST'), false);
  assert.equal(allowedReviewRoute('/api/shutdown', 'POST'), false);
  assert.equal(allowedReviewRoute('/api/tasks/p-test/finish', 'POST'), false);
  assert.equal(allowedReviewRoute('/api/tasks', 'POST'), false);
  assert.equal(allowedReviewRoute('/files/p-test/1/secret.sqlite', 'GET'), false);
  assert.equal(allowedReviewRoute('/assets/../secret', 'GET'), false);
  const value = rewriteReviewJson({ files: '/files/p-test/1/', url: 'http://127.0.0.1:1234/?task=p-test', body: 'Keep my text' }, '/review/project');
  assert.equal(value.files, '/review/project/files/p-test/1/');
  assert.equal(value.url, '/review/project/?task=p-test');
  assert.equal(value.body, 'Keep my text');
  const html = rewriteReviewHtml('<html><head><script src="/assets/app.js"></script><link href="/assets/app.css"></head></html>', '/review/project');
  assert.match(html, /src="\/review\/project\/assets\/app.js"/);
  assert.match(html, /window.fetch=/);
});

test('Codex RPC correlates concurrent calls and supports server approval responses', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'papilot-rpc-'));
  const fake = path.join(folder, 'fake.mjs');
  fs.writeFileSync(fake, `import readline from 'node:readline';
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
readline.createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l);
if(m.method==='initialize')send({id:m.id,result:{userAgent:'test'}});
else if(m.method==='echo')setTimeout(()=>send({id:m.id,result:m.params}),m.params.delay);
else if(m.method==='fail')send({id:m.id,error:{message:'intentional failure'}});
else if(m.method==='approve'){send({id:999,method:'item/commandExecution/requestApproval',params:{threadId:'test'}});send({id:m.id,result:{}})}
else if(m.id===999)send({method:'approved',params:m.result});
});`);
  const codex = new Codex(process.execPath, [fake]);
  try {
    await codex.start();
    const [slow, fast] = await Promise.all([codex.request('echo', { name: 'slow', delay: 25 }), codex.request('echo', { name: 'fast', delay: 1 })]);
    assert.equal(slow.name, 'slow'); assert.equal(fast.name, 'fast');
    await assert.rejects(codex.request('fail', {}), /intentional failure/);
    const requested = once(codex, 'request'); await codex.request('approve', {}); const [request] = await requested;
    const notified = once(codex, 'notification'); codex.respond(request.id, { decision: 'accept' });
    const [event] = await notified; assert.equal(event.params.decision, 'accept');
  } finally { codex.close(); fs.rmSync(folder, { recursive: true }); }
});
