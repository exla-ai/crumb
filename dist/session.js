import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { inject, launch, snapshot } from './browser.js';
import { CrumbError } from './errors.js';
import { dirs, parseId, profileDir, runFile } from './paths.js';
import { emptySession, exists, mergeState, readEntry, readSession, touchHeader, writeSession } from './vault.js';
const now = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function alive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
export function runningHandle(id) {
    const file = runFile(id, 'json');
    if (!existsSync(file))
        return null;
    try {
        const h = JSON.parse(readFileSync(file, 'utf8'));
        if (alive(h.pid))
            return h;
    }
    catch { }
    rmSync(file, { force: true });
    return null;
}
export function runningHandles() {
    if (!existsSync(dirs.run()))
        return [];
    return readdirSync(dirs.run())
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.replace(/\.json$/, '').replace('__', ':'))
        .map(runningHandle)
        .filter((h) => !!h);
}
function tempProfile() {
    mkdirSync(dirs.run(), { recursive: true, mode: 0o700 });
    return mkdtempSync(join(dirs.run(), 'tmp-'));
}
function originOf(url) {
    return new URL(url).origin + '/';
}
function registrable(url) {
    const parts = new URL(url).hostname.split('.');
    return parts.slice(-2).join('.');
}
export async function login(rawId, o) {
    const { id } = parseId(rawId);
    if (runningHandle(id))
        throw new CrumbError('LOCKED', `${id} is open in a running browser`, `crumb close ${id}`);
    const existing = exists(id) ? readSession(id) : null;
    const url = o.url ?? existing?.home;
    if (!url)
        throw new CrumbError('INVALID_INPUT', 'login needs --url the first time', `crumb login ${id} --url https://example.com/login`);
    const mode = o.mode ?? existing?.mode ?? 'state';
    const session = existing ?? emptySession(id, { mode, label: o.label });
    session.mode = mode;
    if (o.label)
        session.label = o.label;
    session.home ??= originOf(url);
    session.scope ??= [registrable(url)];
    const userDataDir = mode === 'profile' ? profileDir(id) : tempProfile();
    mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
    const b = await launch(userDataDir, { headless: !!o.headless });
    try {
        if (mode === 'state' && existing)
            await inject(b.context, existing.state);
        const page = b.context.pages()[0] ?? (await b.context.newPage());
        await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => { });
        o.onReady?.();
        let closed = false;
        b.context.on('close', () => (closed = true));
        let last = await snapshot(b.context);
        const deadline = Date.now() + (o.timeoutSec ?? 900) * 1000;
        const urlRe = o.untilUrl ? new RegExp(o.untilUrl) : null;
        while (!closed && Date.now() < deadline) {
            await sleep(1000);
            if (closed)
                break;
            try {
                last = await snapshot(b.context);
            }
            catch {
                break;
            }
            if (o.untilCookie && last.cookies.some((c) => c.name === o.untilCookie))
                break;
            if (urlRe && b.context.pages().some((p) => urlRe.test(p.url())))
                break;
        }
        session.state = last;
        session.browser = b.hints;
        const account = writeSession(session, { source: 'login', from: url, capturedAt: now() });
        return account;
    }
    finally {
        await b.context.close().catch(() => { });
        if (mode === 'state')
            rmSync(userDataDir, { recursive: true, force: true });
    }
}
const CLI = fileURLToPath(new URL('./cli.js', import.meta.url));
export async function launchDetached(rawId, o) {
    const { id } = parseId(rawId);
    const running = runningHandle(id);
    if (running)
        return running;
    const entry = readEntry(id);
    if (!entry)
        throw new CrumbError('NOT_FOUND', `no account ${id}`, `crumb login ${id} --url <login url>`);
    if (entry.account.status === 'empty')
        throw new CrumbError('NEEDS_LOGIN', `${id} has no saved session`, `crumb login ${id}`);
    mkdirSync(dirs.run(), { recursive: true, mode: 0o700 });
    const errFile = runFile(id, 'error');
    rmSync(errFile, { force: true });
    const log = openSync(runFile(id, 'log'), 'w', 0o600);
    const args = [CLI, '__supervise', id];
    if (o.headless)
        args.push('--headless');
    if (o.url)
        args.push('--url', o.url);
    if (o.port)
        args.push('--port', String(o.port));
    if (o.autosaveSec !== undefined)
        args.push('--autosave', String(o.autosaveSec));
    const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', log, log], env: process.env });
    child.unref();
    closeSync(log);
    const deadline = Date.now() + (o.timeoutSec ?? 60) * 1000;
    while (Date.now() < deadline) {
        const h = runningHandle(id);
        if (h)
            return h;
        if (existsSync(errFile)) {
            const e = JSON.parse(readFileSync(errFile, 'utf8'));
            rmSync(errFile, { force: true });
            throw new CrumbError(e.code ?? 'INTERNAL', e.message, e.hint);
        }
        if (child.exitCode !== null)
            break;
        await sleep(150);
    }
    throw new CrumbError('INTERNAL', `browser for ${id} did not start`, `see ${runFile(id, 'log')}`);
}
export async function supervise(id, o) {
    const errFile = runFile(id, 'error');
    let tmp = null;
    try {
        const session = readSession(id);
        const userDataDir = session.mode === 'profile' ? profileDir(id) : (tmp = tempProfile());
        mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
        const b = await launch(userDataDir, { headless: !!o.headless, port: o.port });
        if (session.mode === 'state')
            await inject(b.context, session.state);
        let before = await snapshot(b.context);
        const home = o.url ?? session.home;
        const page = b.context.pages()[0] ?? (await b.context.newPage());
        if (home)
            await page.goto(home, { waitUntil: 'domcontentloaded' }).catch(() => { });
        const handle = {
            format: 'crumb.handle',
            version: 1,
            id,
            mode: session.mode,
            pid: process.pid,
            headless: !!o.headless,
            ...(home ? { home } : {}),
            cdp: { http: b.cdpHttp, ws: b.cdpWs },
            autosave: { intervalSeconds: o.autosaveSec ?? 30, lastSavedAt: null },
            startedAt: now(),
        };
        const writeHandle = () => writeFileSync(runFile(id, 'json'), JSON.stringify(handle, null, 2) + '\n', { mode: 0o600 });
        writeHandle();
        touchHeader(id, { lastUsedAt: handle.startedAt });
        let saving = null;
        const save = () => (saving ??= (async () => {
            try {
                const after = await snapshot(b.context);
                if (JSON.stringify(after) === JSON.stringify(before))
                    return;
                const latest = readSession(id);
                latest.state = mergeState(latest.state, before, after);
                latest.browser = { ...latest.browser, ...b.hints };
                writeSession(latest, { source: 'sync', from: 'crumb launch', capturedAt: now() });
                before = after;
                handle.autosave.lastSavedAt = now();
                writeHandle();
            }
            catch (e) {
                console.error('autosave failed:', e.message);
            }
            finally {
                saving = null;
            }
        })());
        const cleanup = () => {
            rmSync(runFile(id, 'json'), { force: true });
            if (tmp)
                rmSync(tmp, { recursive: true, force: true });
        };
        const timer = handle.autosave.intervalSeconds > 0 ? setInterval(save, handle.autosave.intervalSeconds * 1000) : null;
        let stopping = false;
        const stop = async () => {
            if (stopping)
                return;
            stopping = true;
            if (timer)
                clearInterval(timer);
            await save();
            await b.context.close().catch(() => { });
            cleanup();
            process.exit(0);
        };
        process.on('SIGTERM', stop);
        process.on('SIGINT', stop);
        if (process.platform !== 'win32')
            process.on('SIGUSR2', () => void save());
        b.context.on('close', () => {
            if (stopping)
                return;
            if (timer)
                clearInterval(timer);
            cleanup();
            process.exit(0);
        });
    }
    catch (e) {
        const err = e instanceof CrumbError ? e : new CrumbError('INTERNAL', e.message);
        writeFileSync(errFile, JSON.stringify(err.toJSON()), { mode: 0o600 });
        if (tmp)
            rmSync(tmp, { recursive: true, force: true });
        process.exit(1);
    }
}
export async function closeSession(rawId, timeoutSec = 30) {
    const { id } = parseId(rawId);
    const h = runningHandle(id);
    if (!h)
        throw new CrumbError('NOT_RUNNING', `${id} is not running`);
    process.kill(h.pid, 'SIGTERM');
    const deadline = Date.now() + timeoutSec * 1000;
    while (alive(h.pid) && Date.now() < deadline)
        await sleep(100);
    if (alive(h.pid))
        process.kill(h.pid, 'SIGKILL');
    rmSync(runFile(id, 'json'), { force: true });
    return h;
}
export async function syncSession(rawId) {
    const { id } = parseId(rawId);
    const h = runningHandle(id);
    if (!h)
        throw new CrumbError('NOT_RUNNING', `${id} is not running`);
    const prev = h.autosave?.lastSavedAt ?? null;
    process.kill(h.pid, 'SIGUSR2');
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
        await sleep(200);
        const cur = runningHandle(id);
        if (!cur || cur.autosave?.lastSavedAt !== prev)
            return cur ?? h;
    }
    return runningHandle(id) ?? h; // nothing changed since the last save
}
// ---- capture from an arbitrary running browser ------------------------------
export async function capture(rawId, cdp, o) {
    const { id } = parseId(rawId);
    const browser = await chromium.connectOverCDP(cdp);
    try {
        const ctx = browser.contexts()[0];
        if (!ctx)
            throw new CrumbError('INVALID_INPUT', `no browser context at ${cdp}`);
        const after = await snapshot(ctx);
        const session = exists(id) ? readSession(id) : emptySession(id, { label: o.label });
        session.state = after;
        if (o.url) {
            session.home ??= originOf(o.url);
            session.scope ??= [registrable(o.url)];
        }
        session.browser = { engine: 'chromium', version: browser.version(), platform: process.platform };
        return writeSession(session, { source: 'capture', from: 'cdp', capturedAt: now() });
    }
    finally {
        // For connectOverCDP browsers, close() only disconnects; the user's browser keeps running.
        await browser.close().catch(() => { });
    }
}
// ---- check --------------------------------------------------------------------
const LOGIN_URL = /(\/|\.|^)(log-?in|sign-?in|signin|auth|sso|session|accounts\.google\.com)(\/|\?|$|\.)/i;
export async function check(rawId, o = {}) {
    const { id } = parseId(rawId);
    const session = readSession(id);
    const url = o.url ?? session.home;
    if (!url)
        throw new CrumbError('INVALID_INPUT', `${id} has no home URL`, `crumb check ${id} --url https://...`);
    if (session.mode === 'profile' && runningHandle(id)) {
        throw new CrumbError('LOCKED', `${id} is open; its profile can only be used by one browser`, `crumb close ${id}`);
    }
    const tmp = session.mode === 'profile' ? null : tempProfile();
    const b = await launch(tmp ?? profileDir(id), { headless: true });
    let result;
    try {
        if (session.mode === 'state')
            await inject(b.context, session.state);
        const page = b.context.pages()[0] ?? (await b.context.newPage());
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => { });
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => { });
        const final = page.url();
        const pathOf = (u) => {
            try {
                const x = new URL(u);
                return x.hostname + x.pathname;
            }
            catch {
                return u;
            }
        };
        const redirectedToLogin = LOGIN_URL.test(pathOf(final)) && !LOGIN_URL.test(pathOf(url));
        const passwordField = (await page.locator('input[type="password"]:visible').count().catch(() => 0)) > 0;
        result = {
            at: now(),
            result: redirectedToLogin || passwordField ? 'logged-out' : final.startsWith('http') ? 'logged-in' : 'unknown',
            url: final,
        };
    }
    finally {
        await b.context.close().catch(() => { });
        if (tmp)
            rmSync(tmp, { recursive: true, force: true });
    }
    const entry = readEntry(id);
    const status = result.result === 'logged-out' ? 'logged-out' : entry.account.status === 'logged-out' ? 'valid' : entry.account.status;
    touchHeader(id, { lastCheck: result, status });
    return { account: { ...entry.account, lastCheck: result, status }, check: result };
}
