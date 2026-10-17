import { homedir } from 'node:os';
import { join } from 'node:path';
import { CrumbError } from './errors.js';
export const ID_RE = /^([a-z0-9][a-z0-9.-]{0,62}):([a-z0-9][a-z0-9._-]{0,62})$/;
export const SITE_RE = /^[a-z0-9][a-z0-9.-]{0,62}$/;
export function home() {
    return process.env.CRUMB_HOME || join(homedir(), '.crumb');
}
export const dirs = {
    vault: () => join(home(), 'vault'),
    profiles: () => join(home(), 'profiles'),
    run: () => join(home(), 'run'),
    config: () => join(home(), 'config.json'),
    keyFile: () => join(home(), 'key'),
};
export function parseId(raw) {
    const id = raw.trim().toLowerCase();
    const m = ID_RE.exec(id);
    if (!m) {
        throw new CrumbError('INVALID_ID', `"${raw}" is not an account id`, 'Account ids look like <site>:<account>, e.g. github:work');
    }
    return { id, site: m[1], account: m[2] };
}
export function entryPath(id) {
    const { site, account } = parseId(id);
    return join(dirs.vault(), site, `${account}.crumb`);
}
export function profileDir(id) {
    const { site, account } = parseId(id);
    return join(dirs.profiles(), site, account);
}
export function runFile(id, ext) {
    const { site, account } = parseId(id);
    return join(dirs.run(), `${site}__${account}.${ext}`);
}
