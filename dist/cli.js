#!/usr/bin/env node
import { cpSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command, Option } from 'commander';
import { readConfig, writeConfig } from './config.js';
import { CrumbError } from './errors.js';
import { parseId } from './paths.js';
import { resolveTarget } from './resolve.js';
import { capture, check, closeSession, launchDetached, login, runningHandle, runningHandles, supervise, syncSession } from './session.js';
import { exportTo, importFromBrowser, importFromFile } from './transfer.js';
import { exists, listAccounts, removeAccount } from './vault.js';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const SKILL = join(ROOT, 'skills', 'crumb', 'SKILL.md');
// Agents run us without a TTY, so they get JSON unless they ask otherwise.
let jsonMode = !process.stdout.isTTY;
function emit(data, human) {
    process.stdout.write(jsonMode ? JSON.stringify(data, null, 2) + '\n' : human() + '\n');
}
const note = (msg) => process.stderr.write(msg + '\n');
const ago = (iso) => {
    if (!iso)
        return '-';
    const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
    const abs = Math.abs(s);
    const v = abs < 90 ? `${abs}s` : abs < 5400 ? `${Math.round(abs / 60)}m` : abs < 129600 ? `${Math.round(abs / 3600)}h` : `${Math.round(abs / 86400)}d`;
    return s >= 0 ? `${v} ago` : `in ${v}`;
};
function table(rows) {
    const w = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
    return rows.map((r) => r.map((c, i) => c.padEnd(w[i])).join('  ').trimEnd()).join('\n');
}
function handleLine(h) {
    return [`${h.id} is open${h.headless ? ' (headless)' : ''}`, `  cdp  ${h.cdp.http}`, `  ws   ${h.cdp.ws}`, `  stop crumb close ${h.id}`].join('\n');
}
function accountLine(a) {
    return `${a.id}  ${a.mode}  ${a.status}  ${a.cookies.count} cookies, ${a.origins} origins  (updated ${ago(a.updatedAt)})`;
}
const program = new Command();
program
    .name('crumb')
    .description('Logged-in browser sessions for AI agents, one account at a time.')
    .version(PKG.version)
    .option('--json', 'force JSON output (default when stdout is not a terminal)')
    .option('--plain', 'force human output')
    .hook('preAction', (cmd) => {
    const o = cmd.opts();
    if (o.json)
        jsonMode = true;
    if (o.plain)
        jsonMode = false;
})
    .showSuggestionAfterError();
program
    .command('list')
    .alias('ls')
    .description('List stored accounts (never shows cookie values)')
    .option('--site <site>', 'only accounts for this site')
    .action((o) => {
    const running = new Map(runningHandles().map((h) => [h.id, h]));
    const accounts = listAccounts()
        .filter((a) => !o.site || a.site === o.site.toLowerCase())
        .map((a) => (running.has(a.id) ? { ...a, session: running.get(a.id) } : a));
    emit({ accounts }, () => accounts.length === 0
        ? 'No accounts yet. Add one with: crumb login <site>:<account> --url <login url>'
        : table([
            ['ID', 'MODE', 'STATUS', 'COOKIES', 'EXPIRES', 'UPDATED', ''],
            ...accounts.map((a) => [
                a.id + (a.isDefault ? ' *' : ''),
                a.mode,
                a.status,
                String(a.cookies.count),
                a.cookies.session ? 'session' : ago(a.cookies.latestExpiry),
                ago(a.updatedAt),
                a.session ? `open ${a.session.cdp.http}` : '',
            ]),
        ]));
});
program
    .command('login <id>')
    .description('Open a browser so a human can sign in; saves the session when the window closes')
    .option('--url <url>', 'page to open (required the first time)')
    .addOption(new Option('--mode <mode>', 'state (portable) or profile (persistent browser profile)').choices(['state', 'profile']))
    .option('--label <text>', 'human-friendly name')
    .option('--headless', 'no window (only useful with --until-cookie/--until-url)')
    .option('--until-cookie <name>', 'finish as soon as this cookie exists')
    .option('--until-url <regex>', 'finish as soon as a tab URL matches')
    .option('--timeout <sec>', 'give up after this many seconds', '900')
    .action(async (id, o) => {
    const a = await login(id, {
        url: o.url,
        mode: o.mode,
        label: o.label,
        headless: o.headless,
        untilCookie: o.untilCookie,
        untilUrl: o.untilUrl,
        timeoutSec: Number(o.timeout),
        onReady: () => note(`A browser window is open for ${parseId(id).id}. Sign in, then close the window to save.`),
    });
    emit({ account: a }, () => `Saved ${accountLine(a)}`);
});
program
    .command('import <source> [file]')
    .description('Import a session from a browser (chrome, brave, arc, chromium, dia, edge, firefox, safari) or from a file')
    .requiredOption('--as <id>', 'account id to store it as, e.g. github:work')
    .option('--url <url>', 'site URL to import cookies for (required for browsers)')
    .option('--profile <name>', 'browser profile, e.g. "Profile 2" or its display name')
    .option('--origin <url...>', 'extra origins to include (SSO domains)')
    .option('--label <text>', 'human-friendly name')
    .addOption(new Option('--mode <mode>', 'mode for file imports').choices(['state', 'profile']))
    .action(async (source, file, o) => {
    if (source === 'file') {
        if (!file)
            throw new CrumbError('INVALID_INPUT', 'usage: crumb import file <path> --as <id>');
        const a = importFromFile(o.as, file, { url: o.url, label: o.label, mode: o.mode });
        return emit({ account: a }, () => `Imported ${accountLine(a)}`);
    }
    const browsers = ['chrome', 'brave', 'arc', 'chromium', 'dia', 'edge', 'firefox', 'safari'];
    if (!browsers.includes(source))
        throw new CrumbError('INVALID_INPUT', `unknown source "${source}"`, `Use one of: ${browsers.join(', ')}, file`);
    if (!o.url)
        throw new CrumbError('INVALID_INPUT', 'browser imports need --url', `crumb import ${source} --url https://github.com --as ${o.as}`);
    const r = await importFromBrowser(o.as, { url: o.url, browser: source, profile: o.profile, origins: o.origin, label: o.label });
    for (const w of r.warnings)
        note(`warning: ${w}`);
    emit(r, () => `Imported ${r.imported} cookies → ${accountLine(r.account)}`);
});
program
    .command('launch <target>')
    .alias('open')
    .description('Start a browser already logged in as <target> and print its CDP endpoint')
    .option('--headless', 'run without a window')
    .option('--url <url>', 'open this page instead of the account home')
    .option('--port <port>', 'fixed CDP port (default: random free port)')
    .option('--autosave <sec>', 'save rotated cookies every N seconds (0 = only on close)', '30')
    .action(async (target, o) => {
    const r = resolveTarget(target);
    const already = runningHandle(r.id);
    const h = await launchDetached(r.id, {
        headless: !!o.headless,
        url: o.url,
        port: o.port ? Number(o.port) : undefined,
        autosaveSec: Number(o.autosave),
    });
    emit({ handle: h, resolvedVia: r.via, alreadyRunning: !!already }, () => handleLine(h));
});
program
    .command('close [target]')
    .description('Save the session back to the vault and close its browser')
    .option('--all', 'close every running session')
    .action(async (target, o) => {
    const ids = o.all ? runningHandles().map((h) => h.id) : target ? [resolveTarget(target).id] : [];
    if (ids.length === 0 && !o.all)
        throw new CrumbError('INVALID_INPUT', 'usage: crumb close <target> | --all');
    const closed = [];
    for (const id of ids)
        closed.push((await closeSession(id)).id);
    emit({ closed }, () => (closed.length ? closed.map((id) => `Saved and closed ${id}`).join('\n') : 'Nothing running.'));
});
program
    .command('sync <target>')
    .description('Save a running session back to the vault now, without closing it')
    .action(async (target) => {
    const h = await syncSession(resolveTarget(target).id);
    emit({ handle: h }, () => `Synced ${h.id} (last saved ${ago(h.autosave?.lastSavedAt)})`);
});
program
    .command('sessions')
    .alias('ps')
    .description('List running browsers')
    .action(() => {
    const hs = runningHandles();
    emit({ sessions: hs }, () => (hs.length ? hs.map(handleLine).join('\n\n') : 'Nothing running.'));
});
program
    .command('check <target>')
    .description('Load the session headlessly and report whether it is still logged in')
    .option('--url <url>', 'page to test (default: account home)')
    .action(async (target, o) => {
    const r = await check(resolveTarget(target).id, { url: o.url });
    emit(r, () => `${r.account.id}: ${r.check.result} (landed on ${r.check.url})`);
    if (r.check.result === 'logged-out')
        process.exitCode = 4;
});
program
    .command('capture <id>')
    .description('Save the session from a browser you are already driving over CDP')
    .requiredOption('--cdp <endpoint>', 'CDP endpoint, e.g. http://127.0.0.1:9222')
    .option('--url <url>', 'account home URL')
    .option('--label <text>', 'human-friendly name')
    .action(async (id, o) => {
    const a = await capture(id, o.cdp, { url: o.url, label: o.label });
    emit({ account: a }, () => `Captured ${accountLine(a)}`);
});
program
    .command('export <target>')
    .description('Write raw session data to a file for another tool (contains secrets)')
    .addOption(new Option('-f, --format <format>', 'output format').choices(['playwright', 'crumb', 'cookies', 'netscape', 'header']).default('playwright'))
    .option('-o, --out <file>', 'file to write (mode 0600)')
    .option('--stdout', 'print to stdout instead (never do this inside an agent)')
    .option('--url <url>', 'URL to build a Cookie header for (header format)')
    .action((target, o) => {
    if (!o.out && !o.stdout)
        throw new CrumbError('INVALID_INPUT', 'export needs -o <file> (or --stdout)', `crumb export ${target} -f ${o.format} -o state.json`);
    const r = exportTo(resolveTarget(target).id, o.format, o.out ?? null, o.url);
    if (r.data !== undefined)
        return void process.stdout.write(r.data);
    emit({ path: r.path, format: o.format, bytes: r.bytes }, () => `Wrote ${o.format} to ${r.path}`);
});
program
    .command('default <site> [id]')
    .description('Show or set the default account for a site')
    .option('--unset', 'remove the default')
    .action((site, id, o) => {
    const cfg = readConfig();
    const s = site.toLowerCase();
    if (o.unset)
        delete cfg.defaults[s];
    else if (id) {
        const { id: norm, site: idSite } = parseId(id);
        if (idSite !== s)
            throw new CrumbError('INVALID_INPUT', `${norm} is not a ${s} account`);
        if (!exists(norm))
            throw new CrumbError('NOT_FOUND', `no account ${norm}`);
        cfg.defaults[s] = norm;
    }
    if (o.unset || id)
        writeConfig(cfg);
    emit({ site: s, default: cfg.defaults[s] ?? null }, () => `${s} → ${cfg.defaults[s] ?? '(none)'}`);
});
program
    .command('resolve <target>')
    .alias('which')
    .description('Show which account a site resolves to here, and why')
    .action((target) => {
    const r = resolveTarget(target);
    emit(r, () => `${r.id}  (via ${r.via}${r.file ? `: ${r.file}` : ''})`);
});
program
    .command('rm <id>')
    .description('Delete an account and its browser profile')
    .option('-y, --yes', 'do not ask')
    .action((id, o) => {
    const { id: norm } = parseId(id);
    if (!exists(norm))
        throw new CrumbError('NOT_FOUND', `no account ${norm}`);
    if (runningHandle(norm))
        throw new CrumbError('LOCKED', `${norm} is open`, `crumb close ${norm}`);
    if (!o.yes)
        throw new CrumbError('INVALID_INPUT', `refusing to delete ${norm} without --yes`);
    removeAccount(norm);
    emit({ removed: norm }, () => `Removed ${norm}`);
});
program
    .command('setup [agents...]')
    .description('Install the crumb skill for agents: claude, codex (default: both)')
    .action((agents) => {
    const want = agents.length ? agents : ['claude', 'codex'];
    const targets = {
        claude: join(homedir(), '.claude', 'skills', 'crumb'),
        codex: join(homedir(), '.agents', 'skills', 'crumb'),
    };
    const installed = {};
    for (const a of want) {
        const dest = targets[a];
        if (!dest)
            throw new CrumbError('INVALID_INPUT', `unknown agent "${a}"`, 'Use claude or codex');
        mkdirSync(dest, { recursive: true });
        cpSync(SKILL, join(dest, 'SKILL.md'));
        installed[a] = dest;
    }
    emit({ installed }, () => Object.entries(installed).map(([a, d]) => `${a}: ${d}/SKILL.md`).join('\n'));
});
program
    .command('guide')
    .description('Print the agent instructions (same as `crumb help agent`)')
    .action(() => {
    const md = readFileSync(SKILL, 'utf8').replace(/^---[\s\S]*?---\n+/, '');
    process.stdout.write(md);
});
program
    .command('schema [name]')
    .description('Print a JSON Schema: session, account, handle, bindings, vault-entry, error')
    .action((name) => {
    const names = ['session', 'account', 'handle', 'bindings', 'vault-entry', 'error'];
    if (!name)
        return emit({ schemas: names }, () => names.join('\n'));
    if (!names.includes(name))
        throw new CrumbError('INVALID_INPUT', `unknown schema ${name}`, names.join(', '));
    process.stdout.write(readFileSync(join(ROOT, 'schema', 'v1', `${name}.schema.json`), 'utf8'));
});
program
    .command('__supervise <id>', { hidden: true })
    .option('--headless')
    .option('--url <url>')
    .option('--port <port>')
    .option('--autosave <sec>')
    .action(async (id, o) => {
    await supervise(id, {
        headless: !!o.headless,
        url: o.url,
        port: o.port ? Number(o.port) : undefined,
        autosaveSec: o.autosave !== undefined ? Number(o.autosave) : undefined,
    });
});
const argv = process.argv.slice();
if (argv[2] === 'help' && argv[3] === 'agent')
    argv.splice(2, 2, 'guide');
program.parseAsync(argv).catch((e) => {
    const err = e instanceof CrumbError ? e : new CrumbError('INTERNAL', e?.message ?? String(e));
    if (jsonMode)
        process.stdout.write(JSON.stringify(err.toJSON(), null, 2) + '\n');
    else
        process.stderr.write(`crumb: ${err.message}${err.hint ? `\n  → ${err.hint}` : ''}${err.candidates ? `\n  candidates: ${err.candidates.join(', ')}` : ''}\n`);
    process.exit(err.exitCode);
});
