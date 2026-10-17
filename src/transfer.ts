import { readFileSync, writeFileSync } from 'node:fs';
import { getCookies, type BrowserName } from '@steipete/sweet-cookie';
import { CrumbError } from './errors.js';
import { parseId } from './paths.js';
import type { Account, Cookie, Session } from './types.js';
import { emptySession, exists, normalizeCookie, normalizeState, readSession, writeSession } from './vault.js';

const now = () => new Date().toISOString();
const key = (c: Cookie) => `${c.name}\u0000${c.domain}\u0000${c.path}\u0000${c.partitionKey ?? ''}`;

function upsertCookies(into: Cookie[], add: Cookie[]): Cookie[] {
  const m = new Map(into.map((c) => [key(c), c]));
  for (const c of add) m.set(key(c), c);
  return [...m.values()];
}

function ensureHome(s: Session, url: string) {
  const u = new URL(url);
  s.home ??= u.origin + '/';
  s.scope ??= [u.hostname.split('.').slice(-2).join('.')];
}

export type ImportBrowser = 'chrome' | 'brave' | 'arc' | 'chromium' | 'dia' | 'edge' | 'firefox' | 'safari';

export async function importFromBrowser(
  rawId: string,
  o: { url: string; browser: ImportBrowser; profile?: string; origins?: string[]; label?: string },
): Promise<{ account: Account; imported: number; warnings: string[] }> {
  const { id } = parseId(rawId);
  const chromiumBrowser = (['brave', 'arc', 'chromium', 'dia'] as const).find((b) => b === o.browser);
  const backend: BrowserName = chromiumBrowser ? 'chrome' : (o.browser as BrowserName);
  const res = await getCookies({
    url: o.url,
    origins: o.origins,
    browsers: [backend],
    ...(chromiumBrowser ? { chromiumBrowser } : o.browser === 'chrome' ? { chromiumBrowser: 'chrome' as const } : {}),
    ...(o.profile ? (backend === 'firefox' ? { firefoxProfile: o.profile } : backend === 'edge' ? { edgeProfile: o.profile } : { chromeProfile: o.profile }) : {}),
  });
  const cookies = res.cookies.map(normalizeCookie);
  if (cookies.length === 0) {
    const why = res.warnings.length ? res.warnings.join('; ') : 'no cookies matched';
    throw new CrumbError(
      'IMPORT_FAILED',
      `no ${o.browser} cookies for ${o.url}: ${why}`,
      `Sign in to the site in ${o.browser} first, or use: crumb login ${id} --url ${o.url}`,
    );
  }
  const s = exists(id) ? readSession(id) : emptySession(id, { label: o.label });
  if (o.label) s.label = o.label;
  ensureHome(s, o.url);
  s.state.cookies = upsertCookies(s.state.cookies, cookies);
  s.browser = { engine: backend === 'firefox' ? 'firefox' : backend === 'safari' ? 'webkit' : 'chromium', product: o.browser, platform: process.platform };
  const account = writeSession(s, { source: 'import', from: `${o.browser}:${o.profile ?? 'default'}`, capturedAt: now() });
  return { account, imported: cookies.length, warnings: res.warnings };
}

export function importFromFile(rawId: string, file: string, o: { url?: string; label?: string; mode?: 'state' | 'profile' }): Account {
  const { id, site, account } = parseId(rawId);
  let doc: any;
  try {
    doc = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new CrumbError('INVALID_INPUT', `cannot read ${file}: ${(e as Error).message}`);
  }
  const s = exists(id) ? readSession(id) : emptySession(id, { label: o.label, mode: o.mode });
  if (doc?.format === 'crumb.session') {
    const { id: _i, site: _s, account: _a, format: _f, version: _v, createdAt: _c, updatedAt: _u, $schema: _sc, ...rest } = doc;
    Object.assign(s, rest, { id, site, account });
    s.state = normalizeState(doc.state);
  } else {
    s.state = normalizeState(doc);
  }
  if (o.label) s.label = o.label;
  if (o.mode) s.mode = o.mode;
  if (o.url) ensureHome(s, o.url);
  return writeSession(s, { source: 'import', from: `file:${file.split(/[\\/]/).pop()}`, capturedAt: now() });
}

export type ExportFormat = 'playwright' | 'crumb' | 'cookies' | 'netscape' | 'header';

function domainMatch(host: string, c: Cookie): boolean {
  const d = c.domain.replace(/^\./, '');
  return c.domain.startsWith('.') ? host === d || host.endsWith('.' + d) : host === d;
}

export function render(s: Session, format: ExportFormat, url?: string): string {
  switch (format) {
    case 'crumb':
      return JSON.stringify(s, null, 2) + '\n';
    case 'playwright':
      return JSON.stringify(s.state, null, 2) + '\n';
    case 'cookies':
      return JSON.stringify(s.state.cookies, null, 2) + '\n';
    case 'netscape':
      return (
        '# Netscape HTTP Cookie File\n' +
        s.state.cookies
          .map((c) =>
            [
              (c.httpOnly ? '#HttpOnly_' : '') + c.domain,
              c.domain.startsWith('.') ? 'TRUE' : 'FALSE',
              c.path,
              c.secure ? 'TRUE' : 'FALSE',
              c.expires === -1 ? 0 : Math.floor(c.expires),
              c.name,
              c.value,
            ].join('\t'),
          )
          .join('\n') +
        '\n'
      );
    case 'header': {
      const target = url ?? s.home;
      if (!target) throw new CrumbError('INVALID_INPUT', 'header format needs --url');
      const u = new URL(target);
      return (
        s.state.cookies
          .filter((c) => domainMatch(u.hostname, c) && u.pathname.startsWith(c.path) && (!c.secure || u.protocol === 'https:'))
          .map((c) => `${c.name}=${c.value}`)
          .join('; ') + '\n'
      );
    }
    default:
      throw new CrumbError('INVALID_INPUT', `unknown format ${format}`, 'Use playwright, crumb, cookies, netscape or header');
  }
}

export function exportTo(rawId: string, format: ExportFormat, out: string | null, url?: string): { path: string | null; bytes: number; data?: string } {
  const s = readSession(rawId);
  if (s.policy?.allowExport === false) throw new CrumbError('EXPORT_DENIED', `${s.id} does not allow export`);
  const data = render(s, format, url);
  if (out) {
    writeFileSync(out, data, { mode: 0o600 });
    return { path: out, bytes: data.length };
  }
  return { path: null, bytes: data.length, data };
}
