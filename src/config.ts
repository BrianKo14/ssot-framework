import { boolean, integer, interval, text } from './types/builtin.js';
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
  /** File every statement that took effect is appended to. */
  sqlDump: string | undefined;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

/** An optional variable. Read through a type handler to catch type errors.
 * @param fallback may be of another type, e.g. `undefined` for "not set" */
function optional<T, F = T>(name: string, fallback: F, type: TypeHandler<T>): T | F {
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
    sqlDump: optional('SQL_DUMP', undefined, text()),
  };
}
