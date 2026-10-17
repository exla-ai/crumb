import { findBindings, readConfig } from './config.js';
import { CrumbError } from './errors.js';
import { ID_RE, parseId, SITE_RE } from './paths.js';
import { exists, listAccounts } from './vault.js';
// Turn "github:work" or just "github" into an account id.
// Order: explicit id > nearest .crumb.toml > `crumb default` > the only account for that site.
export function resolveTarget(target) {
    const t = target.trim().toLowerCase();
    if (t.includes(':')) {
        const { id } = parseId(t);
        if (!exists(id))
            throw new CrumbError('NOT_FOUND', `no account ${id}`, `crumb login ${id} --url <login url>`);
        return { id, via: 'explicit' };
    }
    if (!SITE_RE.test(t))
        throw new CrumbError('INVALID_ID', `"${target}" is not a site or account id`);
    const b = findBindings();
    const bound = b?.accounts[t];
    if (bound) {
        if (!exists(bound))
            throw new CrumbError('NOT_FOUND', `${b.file} binds ${t} to ${bound}, which is not in the vault`, `crumb login ${bound} --url <login url>`);
        return { id: bound, via: 'project', file: b.file };
    }
    const def = readConfig().defaults[t];
    if (def && exists(def))
        return { id: def, via: 'default' };
    const candidates = listAccounts().filter((a) => a.site === t).map((a) => a.id);
    if (candidates.length === 1)
        return { id: candidates[0], via: 'only' };
    if (candidates.length === 0)
        throw new CrumbError('NOT_FOUND', `no accounts for ${t}`, `crumb login ${t}:<account> --url <login url>`);
    throw new CrumbError('AMBIGUOUS', `${t} has ${candidates.length} accounts`, `Pick one explicitly, or pin it: crumb default ${t} <id>`, candidates);
}
export function isId(s) {
    return ID_RE.test(s.toLowerCase());
}
