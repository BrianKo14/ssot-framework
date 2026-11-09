// Password hashing and verification + session token generation and digesting

import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { TOKEN_BYTES } from '../types/builtin.js';

/** scrypt's cost parameters (scrambling function).
 * Node's own defaults, and they are chosen: scrypt's default `maxmem` is 32 MB,
 * and anything past N=2^14 throws unless `maxmem` is raised with it. */
interface Params { N: number; r: number; p: number }

const DEFAULTS: Params = { N: 16384, r: 8, p: 1 };

const SALT_BYTES = 16;
const KEY_BYTES = 64;

// Running the async form to avoid blocking
const derive = (secret: string, salt: Buffer, keyBytes: number, params: Params): Promise<Buffer> =>
	new Promise((resolve, reject) =>
		scrypt(secret, salt, keyBytes, params, (err, key) => { if (err) reject(err); else resolve(key); }));

const writeParams = (p: Params) => `N=${p.N},r=${p.r},p=${p.p}`;

const readParams = (raw: string): Params | undefined => {
	const m = /^N=(\d+),r=(\d+),p=(\d+)$/.exec(raw);

	return m ? { N: Number(m[1]), r: Number(m[2]), p: Number(m[3]) } : undefined;
};

/** PHC-shaped (`scrypt$N=...,r=...,p=...$salt$key`), i.e. cost parameters are stored with the hash.
 * 
 * Raising them later then re-hashes each user on their next login instead of invalidating
 * every stored password at once. */
export async function hashPassword(secret: string, params: Params = DEFAULTS): Promise<string> {
	const salt = randomBytes(SALT_BYTES);
	const key = await derive(secret, salt, KEY_BYTES, params);

	return ['scrypt', writeParams(params), salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifyPassword(secret: string, stored: string): Promise<boolean> {
	const [scheme, paramText, saltText, keyText] = stored.split('$');

	if (scheme !== 'scrypt' || !paramText || !saltText || !keyText) return false;

	const params = readParams(paramText);

	if (!params) return false;

	const expected = Buffer.from(keyText, 'base64url');

	if (!expected.length) return false;

	const actual = await derive(secret, Buffer.from(saltText, 'base64url'), expected.length, params);

	return actual.length === expected.length && timingSafeEqual(actual, expected); // compare length first to avoid throwing RangeError
}

/** Fake hash, for unknown users. See `login` in `store.ts`. */
let dummy: Promise<string> | undefined;

export const dummyHash = (): Promise<string> =>
	(dummy ??= hashPassword(randomBytes(32).toString('base64url')));

/** A new session token. */
export const mintToken = (): string => randomBytes(TOKEN_BYTES).toString('base64url');

/** The one-way fingerprint of a session token, to store in the database. */
export const digestOf = (token: string): string => createHash('sha256').update(token).digest('hex');
