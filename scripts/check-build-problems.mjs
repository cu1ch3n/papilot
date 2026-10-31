import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import { chromium, expect } from '../vendor/latex-review/node_modules/@playwright/test/index.mjs';

const server = Fastify();
await server.register(staticFiles, { root: path.resolve('dist') });
await server.listen({ host: '127.0.0.1', port: 0 });
const browser = await chromium.launch({ channel: process.env.PAPILOT_BROWSER_CHANNEL || 'chrome', headless: true });
const snapshot = { version: 'test', csrf: 'fixture', projects: [{ id: 'paper', name: 'Paper', path: '/tmp/paper' }], tasks: [], requests: [], runtime: { connected: true, authenticated: true, models: [] } };
const skill = { id: 'latex-warnings', name: 'Fix LaTeX warnings', description: 'Resolve undefined references, overfull boxes and other build warnings', hint: '', source: 'builtin' };
const warnings = [
  { kind: 'reference', severity: 'warning', message: "Reference `sec:missing' on page 2 undefined on input line 9.", key: 'sec:missing', file: 'sections/intro.tex', line: 9, page: 1, rect: [0.4, 0.3, 0.45, 0.32] },
  { kind: 'citation', severity: 'warning', message: "Citation `knuth84' on page 1 undefined on input line 4.", key: 'knuth84', file: 'main/chapters/04-a-rather-long-directory-name/08-mechanization.tex', line: 123, page: 0, rect: [0.2, 0.2, 0.23, 0.22] },
  { kind: 'overfull', severity: 'minor', message: 'Overfull \\hbox (48.1pt too wide) in paragraph at lines 6--7', amount: 48.1, file: 'sections/intro.tex', line: 6, end: 7, page: 1, rect: [0.2, 0.5, 1, 0.52] },
  { kind: 'other', severity: 'minor', message: 'destination with the same identifier (name{equation.1}) has been already used, duplicate ignored', count: 51, file: 'sections/model.tex' },
];
const error = { kind: 'missing-file', severity: 'error', message: "LaTeX Error: File `figures/plot' not found.", key: 'figures/plot', file: 'sections/geometry.tex', line: 4 };
const state = { build: { status: 'ready', key: 'pdf', pages: [[612, 792], [612, 792]], current: true, problems: { errors: 0, warnings: 2, minor: 2 } }, problems: { status: 'ready', key: 'pdf', problems: warnings, log: true } };
let problemReads = 0;

async function open(options) {
  const page = await browser.newPage({ locale: 'en-US', colorScheme: 'light', viewport: { width: 1440, height: 900 }, ...options });
  await page.addInitScript(() => localStorage.setItem('papilot:task', ''));
  const errors = []; page.on('pageerror', failure => errors.push(failure.message));
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url()), json = value => route.fulfill({ json: value });
    if (url.pathname === '/api/state') return json(snapshot);
    if (url.pathname === '/api/updates') return json({ phase: 'idle', currentVersion: 'test', latestVersion: 'test', canUpdate: false });
    if (url.pathname.endsWith('/events')) return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
    if (url.pathname.endsWith('/skills')) return json({ skills: [skill] });
    if (url.pathname.endsWith('/items')) return json({ items: [] });
    if (url.pathname.endsWith('/note-results')) return json({ notes: [] });
    if (url.pathname.endsWith('/git')) return json({ branch: 'main', files: [] });
    if (url.pathname.endsWith('/manuscript')) return json({ git: { branch: 'main', files: [] }, build: state.build, annotations: [] });
    if (url.pathname.endsWith('/manuscript/problems')) { problemReads++; return json(state.problems); }
    if (url.pathname.endsWith('/manuscript/log')) return route.fulfill({ contentType: 'text/plain', body: 'LaTeX Warning: fixture' });
    if (url.pathname.endsWith('/manuscript.pdf')) return route.fulfill({ contentType: 'application/pdf', body: fs.readFileSync('tests/fixtures/outline.pdf') });
    if (url.pathname.endsWith('/manuscript/words')) return json(JSON.parse(fs.readFileSync('tests/fixtures/outline-words.json', 'utf8'))[Number(url.searchParams.get('page'))]);
    throw new Error(`Unexpected fixture request: ${url.pathname}`);
  });
  await page.goto(`http://127.0.0.1:${server.server.address().port}`);
  return { page, errors };
}

try {
  fs.mkdirSync('test-results', { recursive: true });
  const { page, errors } = await open();
  const button = page.locator('.pdf-toolbar .problems-button'), panel = page.locator('.problems-panel');
  // Quiet by default: an icon with a small count, nothing opened or fetched.
  await expect(button).toHaveAccessibleName('2 compilation warnings');
  await expect(button.locator('.problems-count')).toHaveText('2');
  await expect(button).not.toHaveAttribute('data-severity', 'error');
  await expect(panel).toBeHidden();
  assert.equal(problemReads, 0, 'The list loads only when opened');
  assert.equal(await button.innerText(), '2', 'The toolbar shows only the count');

  await button.click();
  await expect(panel).toBeVisible();
  await expect(panel.locator('h3')).toHaveText(['Warnings 2']);
  await expect(panel.locator('.problems-body > section li')).toHaveCount(2);
  // The page is listed one-based, and typesetting stays folded away.
  await expect(panel.locator('li').first()).toContainText('Undefined reference');
  await expect(panel.locator('li').first()).toContainText('sec:missing');
  await expect(panel.locator('li').first()).toContainText('sections/intro.tex:9');
  await expect(panel.locator('li').first()).toContainText('p. 2');
  await expect(panel.locator('.problems-minor')).not.toHaveAttribute('open', '');
  await panel.locator('.problems-minor summary').click();
  await expect(panel.locator('.problems-minor li').first()).toContainText('Line too wide by 48.1pt');
  await expect(panel.locator('.problems-minor li').nth(1)).toContainText('×51');
  await expect(panel.locator('.problems-minor li').nth(1).locator('button')).toHaveCount(0);
  await expect(panel.getByRole('link', { name: 'Raw log' })).toHaveAttribute('href', '/api/projects/paper/manuscript/log');
  await panel.screenshot({ path: 'test-results/build-problems.png' });

  // A row jumps to its place on the PDF and marks it briefly.
  await panel.locator('li button').first().click();
  await expect(panel).toBeHidden();
  const flash = page.locator('.page[data-page-number="2"] .problem-flash');
  await expect(flash).toBeVisible();
  const [mark, pageBox] = await Promise.all([flash.boundingBox(), page.locator('.page[data-page-number="2"]').boundingBox()]);
  assert.ok(Math.abs((mark.x - pageBox.x) / pageBox.width - 0.4) < 0.01 && Math.abs((mark.y - pageBox.y) / pageBox.height - 0.3) < 0.01, 'The mark sits on the problem');
  await expect(flash).toHaveCount(0, { timeout: 5000 });

  // Fixing fills the new-task composer with the skill and the list; nothing is sent.
  await button.click();
  await panel.getByRole('button', { name: 'Fix with an agent…' }).click();
  await expect(page.locator('.composer-skill .skill-chip')).toContainText('Fix LaTeX warnings');
  const draft = await page.getByRole('textbox', { name: 'Describe the revision' }).inputValue();
  assert.match(draft, /^Fix these problems from the last compilation:\n- sections\/intro\.tex:9 — Undefined reference `sec:missing`\n/);
  assert.match(draft, /08-mechanization\.tex:123 — Undefined citation `knuth84`/);
  assert.match(draft, /sections\/intro\.tex:6–7 — Overfull line, 48\.1pt too wide$/);
  assert.doesNotMatch(draft, /destination/, 'Package remarks are not sent to the agent');

  // A failed rebuild keeps the last PDF, says so in one line and turns the count red.
  state.build = { ...state.build, status: 'failed', current: false, error: 'LaTeX failed to compile.', problems: { errors: 1, warnings: 2, minor: 2 } };
  state.problems = { status: 'failed', key: 'pdf', problems: [error, ...warnings], log: true };
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(button).toHaveAttribute('data-severity', 'error');
  await expect(button).toHaveAccessibleName('1 compilation error');
  await expect(button.locator('.problems-count')).toHaveCSS('background-color', 'rgb(220, 38, 38)');
  const notice = page.locator('.manuscript-note.brief');
  await expect(notice).toHaveText(/The latest changes did not compile\. This is the last PDF that did\./);
  await expect(page.locator('.manuscript-note pre')).toHaveCount(0);
  await expect(page.locator('.pdfViewer .page').first()).toBeVisible();
  await notice.getByRole('button', { name: 'Show problems' }).click();
  await expect(panel.locator('h3').first()).toHaveText('Errors 1');
  await expect(panel.locator('li').first()).toContainText('Missing file');
  await expect(panel.locator('li').first()).toContainText('sections/geometry.tex:4');
  await expect(panel.locator('li').first().locator('button')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  assert.deepEqual(errors, []);
  await page.close();

  // On a phone the list is a sheet along the bottom, inside the screen.
  state.build = { ...state.build, status: 'ready', current: true, error: undefined, problems: { errors: 0, warnings: 2, minor: 2 } };
  state.problems = { status: 'ready', key: 'pdf', problems: warnings, log: true };
  const phone = await open({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const phoneButton = phone.page.locator('.pdf-toolbar .problems-button');
  await phoneButton.tap();
  const sheet = phone.page.locator('.problems-panel');
  await expect(sheet.locator('li').first()).toBeVisible();
  const box = await sheet.boundingBox();
  assert.ok(box.x >= 7 && box.x + box.width <= 383 && box.y + box.height <= 837 && box.height > 150, `The sheet fits the screen: ${JSON.stringify(box)}`);
  assert.equal(await phone.page.evaluate(() => document.documentElement.scrollWidth), 390, 'No horizontal scrolling');
  await sheet.screenshot({ path: 'test-results/build-problems-mobile.png' });
  assert.deepEqual(phone.errors, []);
  console.log('PASS: Compilation problems stay behind a quiet counted icon, list on demand, jump to their place, fill a fix request, report failures in one line, and fit a phone');
} finally { await browser.close(); await server.close(); }
