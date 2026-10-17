# Crumb Session Format — v1

**Status:** draft · **Version:** 1 · **Schemas:** [`schema/v1/`](schema/v1)

This document defines a portable format and runtime contract for **logged-in browser sessions held on behalf of AI agents**. It covers:

- how a session for one account is represented, stored and listed;
- how an agent asks for a session and gets back a browser it can drive, without ever receiving the secret values;
- how sessions that rotate while in use get written back.

`crumb` is the reference implementation, but the format is meant to work for any tool. The key words MUST, SHOULD and MAY are used as in RFC 2119.

## 1. Goals

1. **Account-addressed.** A session belongs to exactly one account, named `site:account`. Many accounts per site are normal.
2. **Agent-safe.** Agents work with account ids, value-free descriptors and browser handles, never with cookie values.
3. **Interoperable.** The session payload is a superset of Playwright's `storageState`, which most browser-agent tools already read.
4. **Durable.** Sessions are written back after use, so cookie rotation doesn't log the account out.

Out of scope for v1: passwords and TOTP secrets (use a password manager), syncing vaults across machines, and remote browser providers. A provider can adopt the format by accepting a `crumb.session` the same way it accepts `storageState`.

## 2. Identifiers

```
account-id = site ":" account
site       = [a-z0-9][a-z0-9.-]{0,62}        ; e.g. github, google, staging.acme
account    = [a-z0-9][a-z0-9._-]{0,62}       ; e.g. work, personal, viraat
```

- Ids are case-insensitive and MUST be normalized to lower case.
- `site` is a label chosen by the user. It is not a domain; the domains an account covers are listed in its `scope`.
- Ids MUST NOT contain secret material such as email addresses with tokens. Plain email-like labels belong in `label`.

## 3. Documents

Each document carries `format` and `version` fields so a reader can tell them apart.

| `format` | Schema | Secret? | Purpose |
|---|---|---|---|
| `crumb.session` | [session.schema.json](schema/v1/session.schema.json) | **yes** | The complete session for one account |
| `crumb.account` | [account.schema.json](schema/v1/account.schema.json) | no | Value-free descriptor for listing and choosing an account |
| `crumb.handle` | [handle.schema.json](schema/v1/handle.schema.json) | no | A running, logged-in browser that an agent can drive |
| `crumb.vault-entry` | [vault-entry.schema.json](schema/v1/vault-entry.schema.json) | ciphertext | At-rest file: an encrypted session plus a clear-text descriptor |
| `crumb.error` | [error.schema.json](schema/v1/error.schema.json) | no | Machine-readable failure, including whether a human is needed |
| `.crumb.toml` | [bindings.schema.json](schema/v1/bindings.schema.json) | no | Per-project pinning of site → account |

### 3.1 `crumb.session`

```json
{
  "$schema": "https://raw.githubusercontent.com/exla-ai/crumb/main/schema/v1/session.schema.json",
  "format": "crumb.session",
  "version": 1,
  "id": "github:work",
  "site": "github",
  "account": "work",
  "label": "Work GitHub",
  "home": "https://github.com/",
  "scope": ["github.com"],
  "mode": "state",
  "state": {
    "cookies": [
      { "name": "user_session", "value": "…", "domain": "github.com", "path": "/", "expires": 1793000000,
        "httpOnly": true, "secure": true, "sameSite": "Lax" }
    ],
    "origins": [
      { "origin": "https://github.com", "localStorage": [{ "name": "theme", "value": "dark" }] }
    ]
  },
  "browser": { "engine": "chromium", "version": "151.0.7922.34", "userAgent": "…", "platform": "darwin" },
  "provenance": { "source": "login", "from": "https://github.com/login", "capturedAt": "2026-10-17T00:00:00Z" },
  "createdAt": "2026-10-17T00:00:00Z",
  "updatedAt": "2026-10-17T00:00:00Z"
}
```

- **`state`:**
  - It MUST be a valid Playwright `storageState` once fields Playwright doesn't know are removed. Cookie `expires` is in Unix seconds, with `-1` for a session cookie.
  - A leading dot in `domain` means the cookie also applies to subdomains.
  - `partitionKey` holds the top-level site for CHIPS (partitioned) cookies.
  - `origins[].indexedDB` uses Playwright's IndexedDB snapshot format. Sites such as Firebase Auth keep their tokens there.
  - `origins[].sessionStorage` MAY be captured. Implementations MAY ignore it when injecting.
- **`mode`:**
  - `state`: the session is fully described by `state` and MAY be injected into any number of fresh browser contexts at once.
  - `profile`: the session also lives in a persistent browser profile directory owned by the implementation. `state` is kept as a best-effort snapshot for export. Only one browser MAY use the profile at a time. Use `profile` for device-bound sessions, such as Google's DBSC, where copied cookies stop working.
- **`browser`:** records where the session was captured. Replaying it with a very different user agent, IP or region can trigger bot detection, so launchers SHOULD prefer a matching browser.
- **`provenance.source`:** one of
  - `login`: a human signed in inside a browser the implementation launched;
  - `import`: copied from another browser or a file;
  - `capture`: snapshotted from a running browser over CDP;
  - `sync`: written back after an agent run.

### 3.2 `crumb.account`

This is a projection of a session with every value removed: counts, domains, expiry range, status, provenance and timestamps. `status` is one of:

| status | meaning |
|---|---|
| `valid` | at least one unexpired cookie |
| `expired` | all persistent cookies expired and there are no session cookies |
| `empty` | nothing captured yet |
| `logged-out` | the last `check` landed on a login page |

Implementations MUST be able to produce descriptors without decrypting anything. That is why the vault entry stores the descriptor in clear text.

### 3.3 `crumb.handle`

`cdp.http` is the Chrome DevTools Protocol HTTP endpoint and `cdp.ws` is the browser-level WebSocket URL. Consumers attach to the **existing** default context; a new context won't have the session. `pid` identifies the process that owns the browser. Stopping that process MUST save the session (§5) before the browser exits.

### 3.4 `crumb.vault-entry`

- **Location:** one file per account at `<vault>/<site>/<account>.crumb`.
- **Encryption:** `ciphertext` is AES-256-GCM over the UTF-8 JSON session, with a fresh 96-bit IV for every write. The AAD is the account id, so ciphertext can't be moved to another id.
- **Key:** a 256-bit key held outside the file, in the OS keychain, Secret Service, a 0600 key file, or an environment variable. `cipher.keyStore` records which, for information only.
- **Header:** the clear-text `account` header is not authenticated, so readers MUST treat it as advisory and MUST NOT make security decisions from it.

### 3.5 `.crumb.toml`

```toml
version = 1

[accounts]
github = "github:work"
google = "google:viraat"
```

The file is looked up from the working directory upward, and the nearest one wins. It contains no secrets and is meant to be committed.

## 4. Resolving a site to an account

Given a target that is either an account id or a bare site, implementations MUST resolve it in this order:

1. **Explicit id** (`github:work`).
2. **Project binding:** the nearest `.crumb.toml`.
3. **User default** for the site.
4. **Only account:** the site's single account, if there is exactly one.
5. Otherwise, fail with `AMBIGUOUS`, listing the account ids in `candidates`, or with `NOT_FOUND`.

An agent that receives `AMBIGUOUS` SHOULD ask the human which account to use, not guess.

## 5. Lifecycle and write-back

```
login/import/capture ──► vault ──► launch ──► handle ──► agent drives browser
                                     ▲                         │
                                     └──── sync / close ◄──────┘  (three-way merge)
```

- **Capture.** `login` opens a browser a human signs in to. The snapshot taken when the window closes, or when a stop condition such as a cookie appearing is met, replaces `state`. `import` merges cookies into the session; `capture` replaces `state`.
- **Launch.** In `state` mode, the session is injected into a fresh, temporary profile, which is deleted afterwards. In `profile` mode, the persistent profile is opened under an exclusive lock.
- **Write-back.** While running, the owner SHOULD snapshot periodically (the reference default is 30 s) and MUST snapshot on orderly shutdown. Each write is a **three-way merge**:
  - `before` is the snapshot taken right after injection;
  - `after` is the current snapshot;
  - `latest` is the vault's current value;
  - only the keys that changed between `before` and `after` (added, modified or deleted) are applied to `latest`.
  - Cookies are keyed by `(name, domain, path, partitionKey)` and localStorage items by `(origin, name)`. This lets concurrent runs of the same account avoid overwriting each other.

## 6. Security requirements

1. **No values to agents.** Sessions MUST be encrypted at rest. Commands meant for agents MUST NOT emit cookie or storage values. The only exception is an explicit export, which SHOULD require an output file, write it with mode 0600, and honor `policy.allowExport = false`.
2. **Guarding the vault.** Implementations SHOULD ship an agent-harness guard, such as a PreToolUse hook, that blocks direct reads of the vault directory.
3. **What CDP access means.** Handing a CDP endpoint to an agent gives it full control of that browser, including the ability to read non-httpOnly cookies and web storage through JavaScript. A handle protects against *accidental* leakage into transcripts and logs, not against a hostile agent. A stricter broker MAY expose a reduced tool surface instead of raw CDP; that is planned for v2.
4. **Humans handle credentials.** Login flows MUST be completed by a human (or by a password manager). Implementations SHOULD surface `needsHuman: true` and not let the agent type credentials.
5. **Loopback only.** CDP endpoints MUST bind to loopback.

## 7. Agent contract (CLI)

A conforming CLI emits JSON documents from §3 on stdout when stdout is not a terminal, or when `--json` is passed. Failures are reported as `crumb.error`.

| Command | Returns |
|---|---|
| `list [--site s]` | `{ accounts: crumb.account[] }` |
| `resolve <target>` | `{ id, via: explicit\|project\|default\|only, file? }` |
| `launch <target> [--headless] [--url u]` | `{ handle: crumb.handle, resolvedVia, alreadyRunning }` |
| `sync <target>` · `close <target>\|--all` | `{ handle }` · `{ closed: id[] }` |
| `sessions` | `{ sessions: crumb.handle[] }` |
| `check <target>` | `{ account, check: { at, result, url } }` |
| `login <id> --url u [--mode profile]` | `{ account }` (blocks until a human finishes) |
| `import <browser\|file> --as id [--url u]` | `{ account, imported?, warnings? }` |
| `capture <id> --cdp endpoint` | `{ account }` |
| `export <target> -f playwright\|crumb\|cookies\|netscape\|header -o file` | `{ path, format, bytes }` |

**Exit codes:**

| Code | Meaning |
|---|---|
| `0` | ok |
| `1` | internal / import failed |
| `2` | bad input |
| `3` | not found / ambiguous / not running |
| `4` | needs a human (login, display, keychain, or `check` found it logged out) |
| `5` | locked / export denied |
| `6` | no browser |

## 8. Interoperability

| Consumer | How to use a crumb session |
|---|---|
| Playwright | `chromium.connectOverCDP(handle.cdp.http)`, or `newContext({ storageState })` from `export -f playwright` |
| Playwright MCP | `--cdp-endpoint <handle.cdp.http>`, or `--isolated --storage-state <file>` |
| Chrome DevTools MCP | `--browserUrl <handle.cdp.http>` |
| browser-use | `Browser(cdp_url=...)` or `storage_state=<file>` |
| agent-browser | `--cdp <port>` or `--state <file>` |
| curl / yt-dlp | `export -f netscape -o cookies.txt` |
| Browserbase / Kernel / Steel | upload `export -f playwright` into a context or profile (cookies + localStorage) |

## 9. Versioning

- **Additive changes** (new optional fields) keep `version: 1`. Readers MUST ignore unknown fields in `state` and in cookie objects.
- **Breaking changes** bump `version` and publish new schemas under `schema/v2/`.
