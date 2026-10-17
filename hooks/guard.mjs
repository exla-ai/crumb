#!/usr/bin/env node
// PreToolUse guard for Claude Code and Codex: block any tool call that touches
// the crumb vault directly. Agents must go through the `crumb` CLI instead.
// Protocol: JSON on stdin; exit 2 with a reason on stderr blocks the call.
import { homedir } from 'node:os';
import { join } from 'node:path';

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
let input;
try {
  input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
} catch {
  process.exit(0);
}

const roots = [join(homedir(), '.crumb'), process.env.CRUMB_HOME].filter(Boolean);
// ".crumb" as a directory (not ".crumb.toml"), or the CRUMB_HOME variable itself.
const pattern = new RegExp(
  [String.raw`\.crumb(?=[\\/]|$|["'\s;|&)])`, String.raw`\$\{?CRUMB_HOME\b`, ...roots.map((r) => r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))].join('|'),
);

const strings = [];
(function walk(v) {
  if (typeof v === 'string') strings.push(v);
  else if (v && typeof v === 'object') Object.values(v).forEach(walk);
})(input.tool_input ?? {});

if (strings.some((s) => pattern.test(s))) {
  process.stderr.write(
    'Blocked by crumb: the session vault is off-limits to agents. Use `crumb list`, `crumb launch <site:account>` and `crumb close` instead (see `crumb guide`).\n',
  );
  process.exit(2);
}
process.exit(0);
