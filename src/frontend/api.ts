// All frontend API calls go through here

import type { FieldErrors } from '../shared/api.js';

/** Remembers the status code (401, 404, etc.) + the error message. */
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

/** The request itself, handing back the response rather than reading it — for what does not
 * come back as JSON (an export's file). A refusal is JSON whatever was asked for, so it is
 * read and thrown here, and every caller reports failure the one way. */
export async function fetched(path: string, init?: RequestInit): Promise<Response> {
	const res = await fetch(path, init);

	if (res.ok) return res;

	const refusal = await res.json().catch(() => null) as { error?: unknown; fields?: unknown } | null;
	const said = refusal?.error;

	throw new ApiError(res.status,
		typeof said === 'string' ? said : res.statusText, fieldErrors(refusal?.fields));
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
	// tolerant: a 204 (DELETE) has no body to read
	return await (await fetched(path, init)).json().catch(() => null) as T;
}

// The session cookie is sent automatically, so we don't need to include it in the headers.
export const sending = (method: string, body?: unknown): RequestInit =>
	body === undefined
		? { method }
		: { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
