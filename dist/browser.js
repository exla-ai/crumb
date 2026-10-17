import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { CrumbError } from './errors.js';
import { normalizeState } from './vault.js';
const SYSTEM_CHROMES = {
    darwin: [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ],
    linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'],
    win32: [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ],
};
function playwrightCached() {
    const root = process.env.PLAYWRIGHT_BROWSERS_PATH ||
        (process.platform === 'darwin'
            ? join(homedir(), 'Library', 'Caches', 'ms-playwright')
            : process.platform === 'win32'
                ? join(process.env.LOCALAPPDATA ?? '', 'ms-playwright')
                : join(homedir(), '.cache', 'ms-playwright'));
    if (!existsSync(root))
        return [];
    const rel = process.platform === 'darwin'
        ? ['chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']
        : process.platform === 'win32'
            ? ['chrome-win64\\chrome.exe', 'chrome-win\\chrome.exe']
            : ['chrome-linux64/chrome', 'chrome-linux/chrome'];
    return readdirSync(root)
        .filter((d) => /^chromium-\d+$/.test(d))
        .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
        .flatMap((d) => rel.map((r) => join(root, d, r)));
}
// Real Chrome first: sessions replay most reliably in the same product they were captured in.
export function resolveExecutable() {
    const env = process.env.CRUMB_BROWSER;
    if (env) {
        if (!existsSync(env))
            throw new CrumbError('BROWSER_NOT_FOUND', `CRUMB_BROWSER=${env} does not exist`);
        return env;
    }
    const candidates = [...(SYSTEM_CHROMES[process.platform] ?? []), ...playwrightCached()];
    try {
        candidates.push(chromium.executablePath());
    }
    catch { }
    const found = candidates.find((p) => p && existsSync(p));
    if (!found) {
        throw new CrumbError('BROWSER_NOT_FOUND', 'no Chrome or Chromium found', 'Install Google Chrome, run `npx playwright install chromium`, or set CRUMB_BROWSER=/path/to/chrome');
    }
    return found;
}
export function hasDisplay() {
    if (process.platform !== 'linux')
        return true;
    return !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}
async function readDevToolsPort(userDataDir, timeoutMs = 15000) {
    const file = join(userDataDir, 'DevToolsActivePort');
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
        try {
            const [port, path] = readFileSync(file, 'utf8').split('\n');
            if (port && path)
                return { port: Number(port), path };
        }
        catch { }
        await new Promise((r) => setTimeout(r, 100));
    }
    throw new CrumbError('INTERNAL', 'browser did not expose a DevTools port');
}
export async function launch(userDataDir, opts) {
    if (!opts.headless && !hasDisplay()) {
        throw new CrumbError('NO_DISPLAY', 'no display available for a visible browser window', 'Run this on a machine with a desktop session, or use --headless');
    }
    const context = await chromium.launchPersistentContext(userDataDir, {
        executablePath: resolveExecutable(),
        headless: opts.headless,
        viewport: null,
        args: [`--remote-debugging-port=${opts.port ?? 0}`, '--no-first-run', '--no-default-browser-check'],
    });
    const { port, path } = await readDevToolsPort(userDataDir);
    const browser = context.browser();
    const page = context.pages()[0] ?? (await context.newPage());
    const userAgent = await page.evaluate(() => navigator.userAgent).catch(() => undefined);
    return {
        context,
        cdpHttp: `http://127.0.0.1:${port}`,
        cdpWs: `ws://127.0.0.1:${port}${path}`,
        hints: {
            engine: 'chromium',
            version: browser?.version(),
            userAgent,
            platform: process.platform,
        },
    };
}
export async function inject(context, state) {
    // setStorageState handles cookies (incl. partitioned), localStorage and IndexedDB.
    await context.setStorageState(state);
}
export async function snapshot(context) {
    return normalizeState(await context.storageState({ indexedDB: true }));
}
