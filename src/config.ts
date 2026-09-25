import { boolean, integer, interval } from './types/builtin.js';
import type { TypeHandler } from './types/handler.js';

export interface AppConfig {
  databaseUrl: string;
  port: number;
  /** Session TTL as an ISO-8601 duration. */
  sessionTtl: string;
  /** Whether the session cookie is marked `Secure` (requires HTTPS).
   * Off by default because dev is plain http on localhost. */
  cookieSecure: boolean;
  /** Seconds between polling to a screen + presence window. */
  pollSeconds: number;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

/** An optional variable. Read through a type handler to catch type errors. */
function optional<T>(name: string, fallback: T, type: TypeHandler<T>): T {
  const raw = process.env[name];

  if (raw === undefined || raw === '') return fallback;

  const checked = type.check(raw);

  if (!checked.ok) throw new Error(`Env var ${name} must be ${type.expected}`);

  return checked.value;
}

export function loadConfig(): AppConfig {
  return {
    databaseUrl: required('DATABASE_URL'),
    port: optional('PORT', 3000, integer(1, 65535)),
    sessionTtl: optional('SESSION_TTL', 'PT8H', interval),
    cookieSecure: optional('COOKIE_SECURE', false, boolean),
    pollSeconds: optional('PRESENCE_POLL', 1, integer(1, 300)),
  };
}
