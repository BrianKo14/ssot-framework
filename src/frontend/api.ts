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
/** @param version the row's version, when the write is meant for the row that was read and for
 * no other: it travels as `If-Match`, and a row that has moved on since refuses it (412).
 * Left out, the write is unconditional — which is what a client knowing nothing of versions
 * still gets, so nothing that worked before stopped working. */
export const sending = (method: string, body?: unknown, version?: unknown): RequestInit => {
	const headers: Record<string, string> = {};

	if (body !== undefined) headers['content-type'] = 'application/json';
	if (version !== undefined && version !== null) headers['If-Match'] = `"${String(version)}"`;

	return { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
};
