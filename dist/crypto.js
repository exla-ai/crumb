import { execFileSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { readConfig, writeConfig } from './config.js';
import { CrumbError } from './errors.js';
import { dirs } from './paths.js';
const SERVICE = 'crumb';
const ACCOUNT = 'vault-key';
let cached = null;
function decodeKey(s) {
    const t = s.trim();
    const buf = /^[0-9a-f]{64}$/i.test(t) ? Buffer.from(t, 'hex') : Buffer.from(t, 'base64');
    if (buf.length !== 32)
        throw new CrumbError('KEY_UNAVAILABLE', 'vault key must be 32 bytes (hex or base64)');
    return buf;
}
function run(cmd, args, input) {
    try {
        return execFileSync(cmd, args, { input, stdio: ['pipe', 'pipe', 'ignore'], timeout: 15000 }).toString();
    }
    catch {
        return null;
    }
}
const stores = {
    keychain: {
        available: () => process.platform === 'darwin',
        get: () => run('security', ['find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w']),
        set: (k) => run('security', ['add-generic-password', '-U', '-s', SERVICE, '-a', ACCOUNT, '-l', 'crumb vault key', '-w', k]) !== null,
    },
    'secret-service': {
        available: () => process.platform === 'linux' && !!process.env.DBUS_SESSION_BUS_ADDRESS && run('which', ['secret-tool']) !== null,
        get: () => run('secret-tool', ['lookup', 'service', SERVICE, 'account', ACCOUNT]),
        set: (k) => run('secret-tool', ['store', '--label=crumb vault key', 'service', SERVICE, 'account', ACCOUNT], k) !== null,
    },
    file: {
        available: () => true,
        get: () => (existsSync(dirs.keyFile()) ? readFileSync(dirs.keyFile(), 'utf8') : null),
        set: (k) => {
            mkdirSync(dirname(dirs.keyFile()), { recursive: true, mode: 0o700 });
            writeFileSync(dirs.keyFile(), k + '\n', { mode: 0o600 });
            return true;
        },
    },
};
export function vaultKey() {
    if (cached)
        return cached;
    const cfg = readConfig();
    if (process.env.CRUMB_KEY) {
        if (!cfg.keyStore)
            writeConfig({ ...cfg, keyStore: 'env' });
        return (cached = { key: decodeKey(process.env.CRUMB_KEY), store: 'env' });
    }
    if (cfg.keyStore === 'env') {
        throw new CrumbError('KEY_UNAVAILABLE', 'this vault is encrypted with CRUMB_KEY, which is not set', 'export CRUMB_KEY=<your key>');
    }
    if (cfg.keyStore) {
        const v = stores[cfg.keyStore].get();
        if (!v) {
            throw new CrumbError('KEY_UNAVAILABLE', `vault key not found in ${cfg.keyStore}`, 'Unlock your keychain, or set CRUMB_KEY');
        }
        return (cached = { key: decodeKey(v), store: cfg.keyStore });
    }
    // First use: create a key in the best available store. Never mint a new key
    // over an existing vault; its entries would become unreadable.
    if (existsSync(dirs.vault()) && readdirSync(dirs.vault()).length > 0) {
        throw new CrumbError('KEY_UNAVAILABLE', `vault at ${dirs.vault()} exists but its key location is unknown`, 'Set CRUMB_KEY, or restore config.json');
    }
    const fresh = randomBytes(32).toString('base64');
    const order = ['keychain', 'secret-service', 'file'];
    for (const name of order) {
        const s = stores[name];
        if (s.available() && s.set(fresh) && s.get()?.trim() === fresh) {
            writeConfig({ ...cfg, keyStore: name });
            return (cached = { key: decodeKey(fresh), store: name });
        }
    }
    throw new CrumbError('KEY_UNAVAILABLE', 'could not store a vault key anywhere');
}
export function seal(plaintext, aad) {
    const { key, store } = vaultKey();
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', key, iv);
    c.setAAD(Buffer.from(aad, 'utf8'));
    const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
    return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ciphertext: ct.toString('base64'), store };
}
export function open(box, aad) {
    const { key } = vaultKey();
    try {
        const d = createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
        d.setAAD(Buffer.from(aad, 'utf8'));
        d.setAuthTag(Buffer.from(box.tag, 'base64'));
        return Buffer.concat([d.update(Buffer.from(box.ciphertext, 'base64')), d.final()]).toString('utf8');
    }
    catch {
        throw new CrumbError('KEY_UNAVAILABLE', 'could not decrypt vault entry (wrong key or tampered file)');
    }
}
