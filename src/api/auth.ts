// HTTP for authentication

import { Router, type CookieOptions, type Request, type RequestHandler } from 'express';
import type { Authenticator, Principal } from '../auth/store.js';
import { loginFields } from '../auth/entities.js';
import type { AppConfig } from '../config.js';
import { HttpError } from '../errors.js';
import { asRecord, checkedValues } from '../schema/values.js';
import { wrap } from './handler.js';

/** Name of the authentication endpoint. */
export const AUTH = '_auth';

/** The cookie the browser holds. */
const COOKIE = 'session';

// Attach principal (logged-in user) to the request, if any.
declare module 'express-serve-static-core' {
	interface Request { principal?: Principal }
}


// --- How a token arrives ---

/** We parse cookies manually for simplicity's sake. */
const cookies = (req: Request): Record<string, string> => {
	const jar: Record<string, string> = Object.create(null);

	for (const pair of req.get('cookie')?.split(';') ?? []) {
		const at = pair.indexOf('=');

		if (at < 0) continue;

		jar[pair.slice(0, at).trim()] = decoded(pair.slice(at + 1).trim());
	}

	return jar;
};

const decoded = (raw: string): string => {
	try { return decodeURIComponent(raw); } catch { return raw; } // ignore malformed cookie, let the auth gate handle it
};

/** The token may arrive in two supported ways:
 * 
 * - The `Authorization` header, as a Bearer token. Esp. good for curl, the ops script, and tests.
 * - The `session` cookie, which the browser holds and sends automatically. */
const transports: ((req: Request) => string | undefined)[] = [
	req => /^Bearer +(\S+)$/i.exec(req.get('authorization') ?? '')?.[1],
	req => cookies(req)[COOKIE],
];

/** Grab a token from the request, if any, whatever the transport. */
const presented = (req: Request): string | undefined => {
	for (const read of transports) {
		const token = read(req);

		if (token) return token;
	}

	return undefined;
};

const cookieOptions = (config: AppConfig): CookieOptions =>
	({ httpOnly: true, sameSite: 'strict', secure: config.cookieSecure, path: '/' });


// --- The gate ---

/** The authentication checkpoint. Refuse requests without a valid session. */
export const gate = (auth: Authenticator): RequestHandler =>
	wrap(async (req, _res, next) => {
		const token = presented(req);
		const principal = token ? await auth.identify(token) : null;

		if (!principal) throw new HttpError(401, 'authentication required');

		req.principal = principal;
		next();
	});


// --- The routes ---

/** `POST /api/_auth` - the one endpoint outside the gate. */
export const login = (auth: Authenticator, config: AppConfig): RequestHandler =>
	wrap(async (req, res) => {
		const given = checkedValues(loginFields, asRecord(req.body), true);

		const old = presented(req);	// login attempt invalidates any existing session

		if (old) await auth.logout(old);

		const issued = await auth.login(String(given.username), String(given.password));

		if (!issued) throw new HttpError(401, 'invalid username or password');

		res.cookie(COOKIE, issued.token, cookieOptions(config));

		// The token goes back for clients with no cookie jar, ignored by browsers
		res.json({ token: issued.token, expiresAt: issued.expiresAt, user: issued.principal });
	});

/** `GET`/`DELETE /api/_auth`
 * Mounted *after* the gate so it inherits the principal. */
export const sessionRouter = (auth: Authenticator, config: AppConfig): Router =>
	Router()
		.get('/', (req, res) => { res.json({ user: req.principal }); })
		.delete('/', wrap(async (req, res) => {
			const token = presented(req);

			if (token) await auth.logout(token);

			res.clearCookie(COOKIE, cookieOptions(config));
			res.status(204).end();
		}));
