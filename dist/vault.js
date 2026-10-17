import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readConfig, writeConfig } from './config.js';
import { open, seal } from './crypto.js';
import { CrumbError } from './errors.js';
import { dirs, entryPath, parseId, profileDir } from './paths.js';
import { SCHEMA_BASE } from './types.js';
const now = () => new Date().toISOString();
const iso = (secs) => new Date(secs * 1000).toISOString();
export function emptySession(id, opts = {}) {
    const { site, account } = parseId(id);
    const t = now();
    return {
        $schema: `${SCHEMA_BASE}/session.schema.json`,
        format: 'crumb.session',
        version: 1,
        id: `${site}:${account}`,
        site,
        account,
        ...(opts.label ? { label: opts.label } : {}),
        ...(opts.home ? { home: opts.home } : {}),
        mode: opts.mode ?? 'state',
        state: { cookies: [], origins: [] },
        createdAt: t,
        updatedAt: t,
    };
}
// Normalize any Playwright / CDP / extension cookie into the crumb.session cookie shape.
export function normalizeCookie(c) {
    const sameSite = { strict: 'Strict', lax: 'Lax', none: 'None', no_restriction: 'None', unspecified: 'Lax' }[String(c.sameSite ?? 'Lax').toLowerCase()] ?? 'Lax';
    let domain = c.domain ?? (c.url ? new URL(c.url).hostname : '');
    if (c.hostOnly === false && !domain.startsWith('.'))
        domain = '.' + domain;
    const out = {
        name: String(c.name),
        value: String(c.value ?? ''),
        domain,
        path: c.path || '/',
        expires: typeof c.expires === 'number' && c.expires > 0 ? c.expires : typeof c.expirationDate === 'number' ? c.expirationDate : -1,
        httpOnly: !!c.httpOnly,
        secure: !!c.secure,
        sameSite,
    };
    if (c.partitionKey)
        out.partitionKey = typeof c.partitionKey === 'string' ? c.partitionKey : c.partitionKey.topLevelSite;
    return out;
}
export function normalizeState(s) {
    const cookies = Array.isArray(s) ? s : (s?.cookies ?? []);
    return {
        cookies: cookies.map(normalizeCookie),
        origins: (Array.isArray(s) ? [] : (s?.origins ?? [])).map((o) => ({
            ...o,
            origin: String(o.origin),
            localStorage: (o.localStorage ?? []).map((i) => ({ name: String(i.name), value: String(i.value) })),
        })),
    };
}
function registrable(host) {
    const parts = host.replace(/^\./, '').split('.');
    return parts.length <= 2 ? parts.join('.') : parts.slice(-2).join('.');
}
export function describe(s, prev) {
    const nowSecs = Date.now() / 1000;
    const live = s.state.cookies.filter((c) => c.expires === -1 || c.expires > nowSecs);
    const persistent = live.filter((c) => c.expires !== -1).map((c) => c.expires);
    const status = s.state.cookies.length === 0 && s.state.origins.length === 0
        ? 'empty'
        : live.length === 0
            ? 'expired'
            : 'valid';
    return {
        format: 'crumb.account',
        version: 1,
        id: s.id,
        site: s.site,
        account: s.account,
        ...(s.label ? { label: s.label } : {}),
        ...(s.home ? { home: s.home } : {}),
        ...(s.scope ? { scope: s.scope } : {}),
        mode: s.mode,
        status,
        cookies: {
            count: s.state.cookies.length,
            session: s.state.cookies.filter((c) => c.expires === -1).length,
            httpOnly: s.state.cookies.filter((c) => c.httpOnly).length,
            domains: [...new Set(s.state.cookies.map((c) => registrable(c.domain)))].sort(),
            earliestExpiry: persistent.length ? iso(Math.min(...persistent)) : null,
            latestExpiry: persistent.length ? iso(Math.max(...persistent)) : null,
        },
        origins: s.state.origins.length,
        ...(s.provenance ? { provenance: s.provenance } : {}),
        ...(prev?.lastCheck ? { lastCheck: prev.lastCheck } : {}),
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        ...(prev?.lastUsedAt ? { lastUsedAt: prev.lastUsedAt } : {}),
    };
}
function atomicWrite(file, data) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, data, { mode: 0o600 });
    renameSync(tmp, file);
}
export function readEntry(id) {
    const file = entryPath(id);
    if (!existsSync(file))
        return null;
    return JSON.parse(readFileSync(file, 'utf8'));
}
export function exists(id) {
    return existsSync(entryPath(id));
}
export function readSession(id) {
    const { id: norm } = parseId(id);
    const entry = readEntry(norm);
    if (!entry)
        throw new CrumbError('NOT_FOUND', `no account ${norm}`, `crumb login ${norm} --url <login url>`);
    return JSON.parse(open({ iv: entry.cipher.iv, tag: entry.cipher.tag, ciphertext: entry.ciphertext }, norm));
}
export function writeSession(s, provenance) {
    s.updatedAt = now();
    if (provenance)
        s.provenance = provenance;
    const prev = readEntry(s.id)?.account;
    const box = seal(JSON.stringify(s), s.id);
    const account = describe(s, prev);
    const entry = {
        format: 'crumb.vault-entry',
        version: 1,
        account,
        cipher: { alg: 'AES-256-GCM', keyStore: box.store, iv: box.iv, tag: box.tag, aad: 'id' },
        ciphertext: box.ciphertext,
    };
    atomicWrite(entryPath(s.id), JSON.stringify(entry, null, 2) + '\n');
    return account;
}
// The header is not covered by the AEAD tag (only the id is), so value-free
// bookkeeping such as lastUsedAt can be updated without the key.
export function touchHeader(id, patch) {
    const entry = readEntry(id);
    if (!entry)
        return;
    entry.account = { ...entry.account, ...patch };
    atomicWrite(entryPath(id), JSON.stringify(entry, null, 2) + '\n');
}
export function listAccounts() {
    const root = dirs.vault();
    if (!existsSync(root))
        return [];
    const defaults = readConfig().defaults;
    const out = [];
    for (const site of readdirSync(root).sort()) {
        for (const f of readdirSync(join(root, site)).sort()) {
            if (!f.endsWith('.crumb'))
                continue;
            const entry = JSON.parse(readFileSync(join(root, site, f), 'utf8'));
            const a = entry.account;
            // Re-derive time-based status from the header so `list` is accurate without the key.
            const nowIso = new Date().toISOString();
            if (a.status === 'valid' && a.cookies.session === 0 && a.cookies.latestExpiry && a.cookies.latestExpiry < nowIso) {
                a.status = 'expired';
            }
            out.push({ ...a, isDefault: defaults[a.site] === a.id });
        }
    }
    return out;
}
export function removeAccount(id) {
    const { id: norm, site } = parseId(id);
    rmSync(entryPath(norm), { force: true });
    rmSync(profileDir(norm), { recursive: true, force: true });
    const cfg = readConfig();
    if (cfg.defaults[site] === norm) {
        delete cfg.defaults[site];
        writeConfig(cfg);
    }
}
// ---- three-way merge -------------------------------------------------------
// A browser run starts from `before` and ends at `after`. Apply only what the
// run changed onto `latest` (the vault's current value), so two concurrent
// runs of the same account don't clobber each other.
const cookieKey = (c) => `${c.name}\u0000${c.domain}\u0000${c.path}\u0000${c.partitionKey ?? ''}`;
function mergeBy(latest, before, after, key) {
    const b = new Map(before.map((x) => [key(x), JSON.stringify(x)]));
    const a = new Map(after.map((x) => [key(x), x]));
    const out = new Map(latest.map((x) => [key(x), x]));
    for (const k of b.keys())
        if (!a.has(k))
            out.delete(k);
    for (const [k, v] of a)
        if (b.get(k) !== JSON.stringify(v))
            out.set(k, v);
    return [...out.values()];
}
export function mergeState(latest, before, after) {
    const cookies = mergeBy(latest.cookies, before.cookies, after.cookies, cookieKey);
    const origins = new Map(latest.origins.map((o) => [o.origin, o]));
    const bo = new Map(before.origins.map((o) => [o.origin, o]));
    const names = new Set([...bo.keys(), ...after.origins.map((o) => o.origin)]);
    const ao = new Map(after.origins.map((o) => [o.origin, o]));
    for (const name of names) {
        const b = bo.get(name);
        const a = ao.get(name);
        const l = origins.get(name);
        const ls = mergeBy(l?.localStorage ?? [], b?.localStorage ?? [], a?.localStorage ?? [], (i) => i.name);
        const merged = { ...(l ?? {}), ...(a ?? {}), origin: name, localStorage: ls };
        if (!a?.indexedDB && l?.indexedDB)
            merged.indexedDB = l.indexedDB;
        if (ls.length === 0 && !merged.indexedDB?.length && !merged.sessionStorage?.length)
            origins.delete(name);
        else
            origins.set(name, merged);
    }
    return { cookies, origins: [...origins.values()] };
}
