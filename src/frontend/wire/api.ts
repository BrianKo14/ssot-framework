// All frontend API calls go through here.

import type { FieldErrors } from '../../shared/api.js';

/** A refusal: the status code (401, 404, etc.), the message, and the fields it was about. */
export class ApiError extends Error {
	constructor(readonly status: number, message: string, readonly fields?: FieldErrors) {
		super(message);
	}
}

const fieldErrors = (raw: unknown): FieldErrors | undefined => {
	if (raw === null || typeof raw !== 'object') return undefined;

	const named = Object.entries(raw).filter(([, message]) => typeof message === 'string');

	return named.length ? (Object.fromEntries(named) as FieldErrors) : undefined;
};

/** The response itself, for what isn't JSON (an exported file). A refusal is always JSON, so it
 * is thrown here for every caller. */
export async function fetched(path: string, init?: RequestInit): Promise<Response> {
	const res = await fetch(path, init);

	if (res.ok) return res;

	const refusal = await res.json().catch(() => null) as { error?: unknown; fields?: unknown } | null;
	const said = refusal?.error;

	throw new ApiError(res.status,
		typeof said === 'string' ? said : res.statusText, fieldErrors(refusal?.fields));
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
	return await (await fetched(path, init)).json().catch(() => null) as T;	// a 204 (DELETE) has no body
}

/** A request with a JSON body. The session cookie goes by itself.
 * @param version the row's version, sent as `If-Match`: a row that changed since refuses the
 * write (412). Without it the write is unconditional. */
export const sending = (method: string, body?: unknown, version?: unknown): RequestInit => {
	const headers: Record<string, string> = {};

	if (body !== undefined) headers['content-type'] = 'application/json';
	if (version !== undefined && version !== null) headers['If-Match'] = `"${String(version)}"`;

	return { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
};
