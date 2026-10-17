// End-to-end: drives the real CLI against a local site with real Chromium.
// Needs a Chromium; set CRUMB_BROWSER to override discovery.
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(ROOT, 'dist', 'cli.js');
const HOME = mkdtempSync(join(tmpdir(), 'crumb-test-'));
const WORK = mkdtempSync(join(tmpdir(), 'crumb-proj-'));
const ENV = { ...process.env, CRUMB_HOME: HOME, CRUMB_KEY: Buffer.alloc(32, 7).toString('base64') };

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
for (const f of readdirSync(join(ROOT, 'schema', 'v1'))) ajv.addSchema(JSON.parse(readFileSync(join(ROOT, 'schema', 'v1', f), 'utf8')));
const valid = (name, doc) => {
  const v = ajv.getSchema(`https://raw.githubusercontent.com/exla-ai/crumb/main/schema/v1/${name}.schema.json`);
  assert.ok(v(doc), `${name}: ${ajv.errorsText(v.errors)}`);
};

function crumb(args, { cwd = WORK } = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env: ENV, cwd, timeout: 120000 }, (err, stdout, stderr) => {
      let json = null;
      try {
        json = JSON.parse(stdout);
      } catch {}
      resolve({ code: err ? err.code : 0, stdout, stderr, json });
    });
  });
}

// A tiny site: "/" says who you are or bounces to /login; /rotate rotates the session cookie.
let server, base;
before(async () => {
  server = createServer((req, res) => {
    const cookies = Object.fromEntries((req.headers.cookie ?? '').split(/;\s*/).filter(Boolean).map((c) => c.split('=')));
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/auto-login') {
      res.writeHead(302, { 'set-cookie': `session=${url.searchParams.get('user')}-1; Path=/; HttpOnly; Max-Age=86400`, location: '/' });
      return res.end();
    }
    if (url.pathname === '/rotate' && cookies.session) {
      const [user, n] = cookies.session.split('-');
      res.writeHead(200, { 'set-cookie': `session=${user}-${Number(n) + 1}; Path=/; HttpOnly; Max-Age=86400`, 'content-type': 'text/html' });
      return res.end(`<script>localStorage.setItem('theme','dark-${user}')</script>rotated`);
    }
    if (url.pathname === '/login') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<form><input name=u><input type=password name=p></form>');
    }
    if (!cookies.session) {
      res.writeHead(302, { location: '/login' });
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<h1 id=who>${cookies.session.split('-')[0]}</h1>`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://localhost:${server.address().port}`;
});

after(async () => {
  await crumb(['close', '--all']);
  server.close();
  rmSync(HOME, { recursive: true, force: true });
  rmSync(WORK, { recursive: true, force: true });
});

const stateFor = (user) => ({
  cookies: [{ name: 'session', value: `${user}-1`, domain: 'localhost', path: '/', expires: Math.floor(Date.now() / 1000) + 86400, httpOnly: true, secure: false, sameSite: 'Lax' }],
  origins: [],
});

async function whoAmI(cdp) {
  const browser = await chromium.connectOverCDP(cdp);
  const page = browser.contexts()[0].pages()[0];
  await page.goto(base + '/');
  const who = await page.locator('#who').textContent().catch(() => null);
  await browser.close();
  return who;
}

test('import two accounts for the same site; list is value-free and schema-valid', async () => {
  for (const user of ['alice', 'bob']) {
    const f = join(WORK, `${user}.json`);
    writeFileSync(f, JSON.stringify(stateFor(user)));
    const r = await crumb(['import', 'file', f, '--as', `local:${user}`, '--url', base + '/']);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    valid('account', r.json.account);
    rmSync(f);
  }
  const r = await crumb(['list']);
  assert.equal(r.json.accounts.length, 2);
  r.json.accounts.forEach((a) => valid('account', a));
  assert.ok(!r.stdout.includes('alice-1'), 'list must not leak cookie values');

  const vaultFile = readFileSync(join(HOME, 'vault', 'local', 'alice.crumb'), 'utf8');
  assert.ok(!vaultFile.includes('alice-1'), 'vault must be encrypted');
  valid('vault-entry', JSON.parse(vaultFile));
});

test('resolution: ambiguous, then default, then project binding', async () => {
  let r = await crumb(['resolve', 'local']);
  assert.equal(r.code, 3);
  valid('error', r.json);
  assert.equal(r.json.code, 'AMBIGUOUS');
  assert.deepEqual(r.json.candidates.sort(), ['local:alice', 'local:bob']);

  r = await crumb(['default', 'local', 'local:alice']);
  r = await crumb(['resolve', 'local']);
  assert.deepEqual([r.json.id, r.json.via], ['local:alice', 'default']);

  writeFileSync(join(WORK, '.crumb.toml'), 'version = 1\n\n[accounts]\nlocal = "local:bob"\n');
  r = await crumb(['resolve', 'local']);
  assert.deepEqual([r.json.id, r.json.via], ['local:bob', 'project']);
  rmSync(join(WORK, '.crumb.toml'));
});

test('launch two accounts side by side, each logged in as itself', async () => {
  const a = await crumb(['launch', 'local:alice', '--headless']);
  const b = await crumb(['launch', 'local:bob', '--headless']);
  assert.equal(a.code, 0, a.stdout + a.stderr);
  assert.equal(b.code, 0, b.stdout + b.stderr);
  valid('handle', a.json.handle);
  assert.notEqual(a.json.handle.cdp.http, b.json.handle.cdp.http);
  assert.equal(await whoAmI(a.json.handle.cdp.http), 'alice');
  assert.equal(await whoAmI(b.json.handle.cdp.http), 'bob');

  const again = await crumb(['launch', 'local:alice', '--headless']);
  assert.equal(again.json.alreadyRunning, true);
  assert.equal(again.json.handle.cdp.http, a.json.handle.cdp.http);

  const ps = await crumb(['sessions']);
  assert.equal(ps.json.sessions.length, 2);
});

test('rotated cookies and localStorage are saved back on sync/close', async () => {
  const h = (await crumb(['launch', 'local:alice', '--headless'])).json.handle;
  const browser = await chromium.connectOverCDP(h.cdp.http);
  await browser.contexts()[0].pages()[0].goto(base + '/rotate');
  await browser.close();

  const s = await crumb(['sync', 'local:alice']);
  assert.equal(s.code, 0, s.stdout + s.stderr);
  assert.ok(s.json.handle.autosave.lastSavedAt);

  const c = await crumb(['close', 'local:alice']);
  assert.deepEqual(c.json.closed, ['local:alice']);

  const out = join(WORK, 'state.json');
  const e = await crumb(['export', 'local:alice', '-f', 'playwright', '-o', out]);
  assert.equal(e.code, 0, e.stdout);
  const state = JSON.parse(readFileSync(out, 'utf8'));
  rmSync(out);
  assert.equal(state.cookies.find((x) => x.name === 'session').value, 'alice-2');
  const ls = state.origins.find((o) => o.origin === base);
  assert.equal(ls.localStorage.find((i) => i.name === 'theme').value, 'dark-alice');

  // Re-launch picks up the rotated cookie.
  const h2 = (await crumb(['launch', 'local:alice', '--headless'])).json.handle;
  assert.equal(await whoAmI(h2.cdp.http), 'alice');
  await crumb(['close', 'local:alice']);
});

test('export refuses to print to stdout implicitly', async () => {
  const r = await crumb(['export', 'local:alice']);
  assert.equal(r.code, 2);
  assert.equal(r.json.code, 'INVALID_INPUT');
});

test('check reports logged-in vs logged-out', async () => {
  let r = await crumb(['check', 'local:alice']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.json.check.result, 'logged-in');

  const f = join(WORK, 'nobody.json');
  writeFileSync(f, JSON.stringify({ cookies: [{ ...stateFor('x').cookies[0], name: 'other' }], origins: [] }));
  await crumb(['import', 'file', f, '--as', 'local:nobody', '--url', base + '/']);
  rmSync(f);
  r = await crumb(['check', 'local:nobody']);
  assert.equal(r.code, 4);
  assert.equal(r.json.check.result, 'logged-out');
  const l = await crumb(['list', '--site', 'local']);
  assert.equal(l.json.accounts.find((a) => a.id === 'local:nobody').status, 'logged-out');
});

test('login (headless, --until-cookie) and capture from a running browser', async () => {
  const r = await crumb(['login', 'local:carol', '--headless', '--url', base + '/auto-login?user=carol', '--until-cookie', 'session', '--timeout', '30']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.json.account.provenance.source, 'login');
  assert.equal(r.json.account.home, base + '/');

  const h = (await crumb(['launch', 'local:carol', '--headless'])).json.handle;
  const cap = await crumb(['capture', 'local:carol-copy', '--cdp', h.cdp.http, '--url', base + '/']);
  assert.equal(cap.code, 0, cap.stdout + cap.stderr);
  assert.equal(cap.json.account.provenance.source, 'capture');
  // capture must only disconnect, not close the browser
  assert.equal(await whoAmI(h.cdp.http), 'carol');
  await crumb(['close', 'local:carol']);

  const h2 = (await crumb(['launch', 'local:carol-copy', '--headless'])).json.handle;
  assert.equal(await whoAmI(h2.cdp.http), 'carol');
  await crumb(['close', 'local:carol-copy']);
});

test('exported crumb.session documents are schema-valid and round-trip', async () => {
  const out = join(WORK, 'alice.session.json');
  await crumb(['export', 'local:alice', '-f', 'crumb', '-o', out]);
  const doc = JSON.parse(readFileSync(out, 'utf8'));
  valid('session', doc);
  const r = await crumb(['import', 'file', out, '--as', 'local:alice2']);
  rmSync(out);
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.account.home, base + '/');
});

test('rm requires --yes', async () => {
  assert.equal((await crumb(['rm', 'local:alice2'])).code, 2);
  assert.equal((await crumb(['rm', 'local:alice2', '--yes'])).code, 0);
});
