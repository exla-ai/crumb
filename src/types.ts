// TypeScript mirror of schema/v1/*.schema.json. The JSON Schemas are normative.

export type Mode = 'state' | 'profile';
export type SameSite = 'Strict' | 'Lax' | 'None';

export interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: SameSite;
  partitionKey?: string;
}

export interface StorageItem {
  name: string;
  value: string;
}

export interface OriginState {
  origin: string;
  localStorage: StorageItem[];
  sessionStorage?: StorageItem[];
  indexedDB?: unknown[];
}

export interface State {
  cookies: Cookie[];
  origins: OriginState[];
}

export interface Provenance {
  source: 'login' | 'import' | 'capture' | 'sync';
  from?: string;
  capturedAt: string;
}

export interface BrowserHints {
  engine?: 'chromium' | 'firefox' | 'webkit';
  product?: string;
  version?: string;
  userAgent?: string;
  platform?: string;
}

export interface Session {
  $schema?: string;
  format: 'crumb.session';
  version: 1;
  id: string;
  site: string;
  account: string;
  label?: string;
  home?: string;
  scope?: string[];
  mode: Mode;
  state: State;
  browser?: BrowserHints;
  provenance?: Provenance;
  policy?: { confirm?: boolean; allowExport?: boolean };
  createdAt: string;
  updatedAt: string;
}

export interface LastCheck {
  at: string;
  result: 'logged-in' | 'logged-out' | 'unknown';
  url?: string;
}

export interface Handle {
  format: 'crumb.handle';
  version: 1;
  id: string;
  mode: Mode;
  pid: number;
  headless: boolean;
  home?: string;
  cdp: { http: string; ws: string };
  autosave?: { intervalSeconds: number; lastSavedAt: string | null };
  startedAt: string;
}

export interface Account {
  format: 'crumb.account';
  version: 1;
  id: string;
  site: string;
  account: string;
  label?: string;
  home?: string;
  scope?: string[];
  mode: Mode;
  status: 'valid' | 'expired' | 'empty' | 'logged-out';
  isDefault?: boolean;
  cookies: {
    count: number;
    session?: number;
    httpOnly?: number;
    domains?: string[];
    earliestExpiry?: string | null;
    latestExpiry?: string | null;
  };
  origins: number;
  provenance?: Provenance;
  lastCheck?: LastCheck;
  session?: Handle;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
}

export type KeyStore = 'keychain' | 'secret-service' | 'file' | 'env';

export interface VaultEntry {
  format: 'crumb.vault-entry';
  version: 1;
  account: Account;
  cipher: { alg: 'AES-256-GCM'; keyStore: KeyStore; iv: string; tag: string; aad: 'id' };
  ciphertext: string;
}

export const SCHEMA_BASE = 'https://raw.githubusercontent.com/exla-ai/crumb/main/schema/v1';
