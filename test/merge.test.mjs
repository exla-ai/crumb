import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeState, normalizeCookie } from '../dist/vault.js';
import { parseBindings } from '../dist/config.js';

const ck = (name, value) => normalizeCookie({ name, value, domain: '.example.com', path: '/', expires: -1 });

test('three-way merge keeps changes from two concurrent runs', () => {
  const base = { cookies: [ck('a', '1'), ck('b', '1'), ck('c', '1')], origins: [] };
  // run 1 rotated `a` and already landed in the vault
  const latest = { cookies: [ck('a', '2'), ck('b', '1'), ck('c', '1')], origins: [] };
  // run 2 started from base, rotated `b`, deleted `c`, added `d`
  const after = { cookies: [ck('a', '1'), ck('b', '2'), ck('d', '1')], origins: [{ origin: 'https://example.com', localStorage: [{ name: 'k', value: 'v' }] }] };
  const out = mergeState(latest, base, after);
  const m = Object.fromEntries(out.cookies.map((c) => [c.name, c.value]));
  assert.deepEqual(m, { a: '2', b: '2', d: '1' });
  assert.deepEqual(out.origins[0].localStorage, [{ name: 'k', value: 'v' }]);
});

test('normalizeCookie handles extension/CDP shapes', () => {
  const c = normalizeCookie({ name: 'x', value: 'y', domain: 'github.com', hostOnly: false, expirationDate: 2e9, sameSite: 'no_restriction', partitionKey: { topLevelSite: 'https://a.com' } });
  assert.equal(c.domain, '.github.com');
  assert.equal(c.expires, 2e9);
  assert.equal(c.sameSite, 'None');
  assert.equal(c.partitionKey, 'https://a.com');
});

test('.crumb.toml parsing', () => {
  const b = parseBindings('version = 1\n# comment\n[accounts]\ngithub = "github:work"  # pinned\n"google" = "google:me"\n', 'x');
  assert.deepEqual(b.accounts, { github: 'github:work', google: 'google:me' });
  assert.throws(() => parseBindings('[accounts]\ngithub = "nope"\n', 'x'));
});
