---
name: crumb
description: Use when a task needs a browser that is logged in to a website as a specific account (e.g. "post this from my work GitHub", "check my Google Calendar", "use the staging admin login"). crumb stores logged-in sessions per account (site:account, e.g. github:work) and launches a browser already signed in, so you never handle passwords or cookies.
---

# crumb: logged-in browsers by account

`crumb` is a CLI vault of logged-in browser sessions. Each stored session is an **account** named `<site>:<account>`, for example `github:work`, `github:personal`, `google:viraat`. You ask crumb for an account and get back a running browser that is already signed in, plus a CDP endpoint to drive it.

**Hard rules**
- Never read, cat, grep, copy or open anything under `~/.crumb` (or `$CRUMB_HOME`). Only talk to the vault through `crumb` commands.
- Never print session data. Don't run `crumb export` with `--stdout`. If another tool needs a file, export it with `-o <file>` and don't read that file back.
- Never type passwords or 2FA codes yourself. If an account needs a login, ask the human to complete it (see below).
- Pick the account deliberately. When a site has several accounts and nothing says which one to use, ask the human.
- Always `crumb close <id>` when you are done, so rotated cookies get saved.

All commands print JSON when not run in a terminal. Errors look like `{"format":"crumb.error","code":"...","message":"...","hint":"...","needsHuman":true|false}`. If `needsHuman` is true, stop and tell the user what `hint` says.

## 1. Pick the account

```bash
crumb list --site github        # value-free account list: id, status, mode, expiry
crumb resolve github            # which account this project uses, and why
```

`crumb resolve <site>` checks, in order: a `.crumb.toml` in this directory or a parent, then the user's `crumb default`, then the site's only account. If it returns `AMBIGUOUS`, show the user the `candidates` and ask which one to use.

Each account has a `status`:
- `valid`: ready to use.
- `expired` or `logged-out`: needs a fresh login (step 4).
- `empty`: never captured (step 4).

## 2. Launch a logged-in browser

```bash
crumb launch github:work              # visible window
crumb launch github:work --headless   # no window
crumb launch github                   # resolves the site to an account first
```

It returns a `crumb.handle`:

```json
{"handle":{"format":"crumb.handle","id":"github:work","cdp":{"http":"http://127.0.0.1:53211","ws":"ws://127.0.0.1:53211/devtools/browser/..."},"pid":4242,"home":"https://github.com/"}}
```

Running `launch` again for the same account returns the same browser. Different accounts run in separate browsers at the same time, so `github:work` and `github:personal` can both be open.

## 3. Drive it

Connect whatever browser tool you have to `handle.cdp.http`:

- **Playwright (script):** `const browser = await chromium.connectOverCDP(cdpHttp); const page = browser.contexts()[0].pages()[0];`
- **Playwright MCP:** start it with `--cdp-endpoint <cdp.http>`.
- **Chrome DevTools MCP:** start it with `--browserUrl <cdp.http>`.
- **browser-use:** `Browser(cdp_url=cdp_http)`.
- **agent-browser:** `agent-browser --cdp <port>`.

Work in the **existing** context (`contexts()[0]`). A new context won't have the login. Don't call `browser.close()` from your tool; use `crumb close` so the session is saved first.

When you finish:

```bash
crumb close github:work        # saves rotated cookies, then closes the browser
crumb sync github:work         # or: save now and keep the browser open
crumb sessions                 # list what's open
```

## 4. When the account isn't logged in

Pick the first option that applies:

1. **The user is already signed in to the site in their own browser** (macOS/Linux):
   ```bash
   crumb import chrome --url https://github.com --as github:work
   crumb import chrome --url https://github.com --as github:work --profile "Work"   # a specific Chrome profile
   ```
   Also supported: `brave`, `arc`, `edge`, `chromium`, `firefox`, `safari`. On macOS this can trigger a Keychain prompt the user must approve; tell them it's coming.
2. **Otherwise, ask the user to log in.** Run this, then tell the user a window is open and to close it after signing in:
   ```bash
   crumb login github:work --url https://github.com/login
   ```
   The command blocks until the window closes. For Google, or any site that binds sessions to the device, add `--mode profile`.
3. **You logged in through your own browser** with the user's help and want to keep that session:
   ```bash
   crumb capture github:work --cdp http://127.0.0.1:9222 --url https://github.com
   ```

To verify a session without a window: `crumb check github:work` returns `logged-in` or `logged-out` and exits with code 4 when logged out.

## 5. Handing a session to another tool (only if CDP won't work)

```bash
crumb export github:work -f playwright -o /tmp/gh-state.json   # Playwright storageState
crumb export github:work -f netscape  -o /tmp/cookies.txt      # curl / yt-dlp
```

Pass the file path to the tool. Don't read the file yourself, and delete it when you're done.

## Pinning accounts for a project

To tie this repo to specific accounts, create `.crumb.toml` (safe to commit, contains no secrets):

```toml
version = 1

[accounts]
github = "github:work"
google = "google:viraat"
```

## Exit codes

`0` ok · `2` bad input · `3` not found / ambiguous / not running · `4` needs a human (login, display, keychain) · `5` locked (profile already open) · `6` no browser installed.
