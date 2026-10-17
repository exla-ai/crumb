# crumb

**Logged-in browsers for AI agents, one account at a time.**

`crumb` is a CLI vault for browser sessions. Sign in to `github:work`, `github:personal` and `google:me` once. After that, any agent (Claude Code, Codex, browser-use, a Playwright script) can ask for an account by name and get a browser that's already logged in. The agent never sees a password or a cookie.

```bash
crumb login github:work --url https://github.com/login   # you sign in once; crumb saves the session
crumb launch github:work                                  # → a logged-in Chromium plus its CDP endpoint
crumb close github:work                                   # rotated cookies are saved back
```

---

## The prompt

Paste this into your agent (or into `AGENTS.md` / `CLAUDE.md`):

```text
When a task needs a website logged in as a specific account, use `crumb`.
Run `crumb guide` once to read how it works. In short:

1. `crumb list --site <site>` or `crumb resolve <site>` picks the account (e.g. github:work).
   If it says AMBIGUOUS, ask me which account to use.
2. `crumb launch <site:account>` returns a JSON handle; connect your browser tool to handle.cdp.http
   (Playwright connectOverCDP, Playwright MCP --cdp-endpoint, Chrome DevTools MCP --browserUrl,
   browser-use cdp_url). Use the existing context; it is already logged in.
3. If the account is missing or expired, run `crumb import chrome --url <site> --as <id>`.
   If that fails, run `crumb login <id> --url <login page>` and ask me to sign in. Never type passwords yourself.
4. When done, run `crumb close <site:account>` so refreshed cookies are saved.

Never read files under ~/.crumb and never print session data. If a crumb error says
"needsHuman": true, stop and tell me what its "hint" says.
```

The full version is [`skills/crumb/SKILL.md`](skills/crumb/SKILL.md). It installs as a skill for Claude Code and Codex, and `crumb guide` prints it, so any agent with a shell can learn the tool from the binary itself.

---

## Install

```bash
npm install -g --install-links github:exla-ai/crumb   # Node 22+
crumb setup                          # installs the skill for Claude Code (~/.claude/skills) and Codex (~/.agents/skills)
```

crumb uses your installed Google Chrome or Chromium; any Playwright-downloaded Chromium works too. Set `CRUMB_BROWSER=/path/to/chrome` to pick one.

**Claude Code plugin.** This adds the skill and a hook that blocks agents from reading the vault directly:

```bash
claude plugin marketplace add exla-ai/crumb
claude plugin install crumb@crumb
```

**Codex.** Run `crumb setup codex` to install the skill. To add the same guard, register `hooks/guard.mjs` as a `PreToolUse` hook in `~/.codex/hooks.json`, then trust it with `/hooks`. The guard checks every tool input for vault paths, so it's safe to match all tools:

```json
{ "hooks": { "PreToolUse": [ { "hooks": [ { "type": "command", "command": "node /path/to/crumb/hooks/guard.mjs" } ] } ] } }
```

**Codex sandbox note.** Codex's `workspace-write` sandbox blocks network access by default, including localhost. If `crumb launch` fails to connect from inside Codex, enable `sandbox_workspace_write.network_access`, or approve the command to run outside the sandbox.

---

## How it works

### Accounts

Every session is an **account** named `<site>:<account>`. A site can have as many accounts as you like.

```
$ crumb list
ID                MODE     STATUS  COOKIES  EXPIRES  UPDATED
github:work *     state    valid   14       in 11mo  2h ago    open http://127.0.0.1:53211
github:personal   state    valid   12       in 11mo  3d ago
google:me         profile  valid   41       in 1y    1d ago
```

When an agent asks for just `github`, crumb decides which account to use in this order:

1. a `.crumb.toml` in the project (commit it: it holds no secrets);
2. your default (`crumb default github github:work`);
3. the only account, if the site has one;
4. otherwise an `AMBIGUOUS` error, so the agent asks you.

```toml
# .crumb.toml
version = 1
[accounts]
github = "github:work"
```

### Getting a session into the vault

| How | When |
|---|---|
| `crumb login <id> --url <login page>` | Most reliable. crumb opens its own browser and you sign in; the session is saved when you close the window. Works on every OS. |
| `crumb import chrome --url <site> --as <id> [--profile "Work"]` | You're already signed in in Chrome, Brave, Arc, Edge, Firefox or Safari. Works on macOS and Linux; macOS asks for Keychain access once. On Windows, Chrome 127+ encrypts cookies so other apps can't read them, so use `login`. |
| `crumb capture <id> --cdp http://127.0.0.1:9222` | Save the session from a browser an agent is already driving. |
| `crumb import file state.json --as <id>` | Any Playwright `storageState` or cookie JSON. |

### Two storage modes

- **`state`** (default) stores cookies, localStorage and IndexedDB. Each launch injects them into a fresh temporary browser profile, which is deleted afterwards. It's portable and exportable, and several copies can run at once.
- **`profile`** (`--mode profile`) gives the account its own persistent Chrome profile owned by crumb. Use it for Google, or for any site that binds sessions to the device ([DBSC](https://developer.chrome.com/docs/web-platform/device-bound-session-credentials)) where copied cookies stop working. Only one browser can use a profile at a time.

### Launching, and running accounts in parallel

`crumb launch <id>` starts a small supervisor process. It opens Chromium on a random loopback CDP port, loads the session and prints a handle:

```json
{ "handle": { "format": "crumb.handle", "id": "github:work",
  "cdp": { "http": "http://127.0.0.1:53211", "ws": "ws://127.0.0.1:53211/devtools/browser/…" },
  "pid": 4242, "home": "https://github.com/", "autosave": { "intervalSeconds": 30 } } }
```

- Each account gets its own browser, so `github:work` and `github:personal` can be open side by side.
- Running `launch` again for the same account returns the existing browser.
- The supervisor saves rotated cookies every 30 seconds and when you run `crumb close`. It merges only what changed, so two runs of the same account don't overwrite each other.

### Commands

```
crumb list [--site s]            accounts, value-free          crumb launch <target> [--headless]   logged-in browser + CDP
crumb resolve <site>             which account, and why        crumb close <target> | --all         save and close
crumb login <id> --url u         you sign in once              crumb sync <target>                  save now, keep open
crumb import <browser|file> ...  copy an existing session      crumb sessions                       what's running
crumb capture <id> --cdp e       save from a running browser   crumb check <target>                 still logged in?
crumb export <t> -f fmt -o file  playwright|crumb|cookies|netscape|header
crumb default <site> [id]        pin a default                 crumb rm <id> --yes                  delete
crumb setup [claude|codex]       install the skill             crumb guide | crumb schema [name]    agent docs / JSON Schemas
```

Output is JSON whenever stdout isn't a terminal, so agents always get structured output. Failures are reported as `crumb.error` with a `needsHuman` flag and stable exit codes (`4` means a human is needed).

---

## The format (for other tools to adopt)

[`SPEC.md`](SPEC.md) defines the **Crumb Session Format v1**, with JSON Schemas under [`schema/v1/`](schema/v1):

- `crumb.session`: one account's full session. `state` is a superset of Playwright's `storageState`, so existing tools can read it. It adds partitioned cookies, IndexedDB, scope, browser hints and provenance.
- `crumb.account`: a value-free descriptor that is safe to show an agent.
- `crumb.handle`: a running, logged-in browser (CDP endpoints).
- `crumb.vault-entry`: an AES-256-GCM encrypted session, with the descriptor in clear text for listing.
- `crumb.error`: machine-readable failures, including whether a human is needed.
- `.crumb.toml`: per-project account pinning.

The spec also defines how a site resolves to an account, how rotated cookies are merged back (a three-way merge), and the CLI contract and exit codes, so other tools can implement it too.

---

## Why it's built this way

We looked at how Claude Code, Codex and the browser-agent ecosystem handle this as of October 2026:

- **No major agent supports multiple accounts on one site.** Claude in Chrome uses your real Chrome; you can only switch accounts by switching Chrome profiles, and its picker labels them "Browser 1/2". Codex's built-in browser exists only in the ChatGPT desktop app, not the CLI. Hosted browsers (Browserbase, Kernel, Steel, browser-use Cloud) each model "one profile per account" in their own format.
- **CLI plus a skill is the common ground.** Claude Code and Codex both read the same `SKILL.md` format and both run shell commands, so one CLI with one skill covers both. Both also support PreToolUse hooks, which is how the vault guard works.
- **Everyone reads `storageState`.** Playwright, Playwright MCP, browser-use and agent-browser all accept it, so crumb's format extends it rather than replacing it.
- **Hand over a browser, not cookies.** Agents get a CDP endpoint, which keeps cookie values out of transcripts and logs. Be aware this isn't a hard boundary: an agent that controls the browser can still read non-httpOnly cookies with JavaScript. A stricter MCP broker that exposes only safe browser tools is on the roadmap.
- **Chrome is locking down cookie theft**: app-bound encryption since Chrome 127, `--remote-debugging-port` ignored on the default profile since 136, and DBSC. So `login` into a browser crumb owns is the main path, and `import` is a shortcut where the OS allows it.

## Security model

- **Encrypted at rest.** Sessions are AES-256-GCM encrypted. The key lives in the macOS Keychain, Linux Secret Service, `~/.crumb/key` (0600), or `CRUMB_KEY`.
- **No values in normal output.** Only `export` emits session data, and it requires an output file (written 0600).
- **Vault guard.** The hook in `hooks/guard.mjs` blocks agents from reading `~/.crumb` with Read, Grep or shell commands.
- **Loopback only.** CDP endpoints bind to 127.0.0.1.
- **Limits.** Anyone holding a CDP handle controls that browser, and copying a session to a new device or IP can trip bot detection. crumb records the user agent a session was captured with for this reason.

## Roadmap

- `crumb mcp`: an MCP session broker (`open_session` / `navigate` / `snapshot` / `close_session`) for agents without a shell, and a strict mode that never exposes raw CDP.
- Human approval per launch (`policy.confirm`, Touch ID on macOS).
- Windows import through a browser extension.
- Uploading sessions into Browserbase, Kernel and Steel profiles.
- Vault sync across machines.

## Development

```bash
npm install
npm test        # unit tests plus end-to-end tests against a local site with real Chromium
```

MIT licensed.
