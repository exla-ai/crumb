import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { CrumbError } from './errors.js';
import { dirs, ID_RE, SITE_RE } from './paths.js';
export function readConfig() {
    try {
        const c = JSON.parse(readFileSync(dirs.config(), 'utf8'));
        return { version: 1, defaults: {}, ...c };
    }
    catch {
        return { version: 1, defaults: {} };
    }
}
export function writeConfig(c) {
    mkdirSync(dirname(dirs.config()), { recursive: true, mode: 0o700 });
    writeFileSync(dirs.config(), JSON.stringify(c, null, 2) + '\n', { mode: 0o600 });
}
// Minimal parser for the subset of TOML that .crumb.toml uses:
// `version = 1` and an `[accounts]` table of `site = "site:account"` pairs.
export function parseBindings(text, file) {
    const out = { file, version: 1, accounts: {} };
    let table = '';
    text.split(/\r?\n/).forEach((raw, i) => {
        const line = raw.replace(/#.*$/, '').trim();
        if (!line)
            return;
        const t = /^\[([^\]]+)\]$/.exec(line);
        if (t) {
            table = t[1].trim();
            return;
        }
        const kv = /^("?)([A-Za-z0-9._-]+)\1\s*=\s*(.+)$/.exec(line);
        if (!kv)
            throw new CrumbError('INVALID_INPUT', `${file}:${i + 1}: cannot parse "${raw}"`);
        const key = kv[2];
        const value = kv[3].trim().replace(/^"(.*)"$/, '$1');
        if (table === '' && key === 'version') {
            if (value !== '1')
                throw new CrumbError('INVALID_INPUT', `${file}: unsupported version ${value}`);
        }
        else if (table === 'accounts') {
            if (!SITE_RE.test(key) || !ID_RE.test(value)) {
                throw new CrumbError('INVALID_INPUT', `${file}:${i + 1}: expected site = "site:account"`);
            }
            out.accounts[key] = value;
        }
    });
    return out;
}
export function findBindings(from = process.cwd()) {
    let dir = resolve(from);
    for (;;) {
        const file = join(dir, '.crumb.toml');
        if (existsSync(file))
            return parseBindings(readFileSync(file, 'utf8'), file);
        const parent = dirname(dir);
        if (parent === dir)
            return null;
        dir = parent;
    }
}
