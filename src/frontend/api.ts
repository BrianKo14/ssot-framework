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

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(path, init);

	const body: unknown = await res.json().catch(() => null);
	const refusal = body as { error?: unknown; fields?: unknown } | null;
	const said = refusal?.error;

	if (!res.ok) throw new ApiError(res.status,
		typeof said === 'string' ? said : res.statusText, fieldErrors(refusal?.fields));

	return body as T;
}

// The session cookie is sent automatically, so we don't need to include it in the headers.
export const sending = (method: string, body?: unknown): RequestInit =>
	body === undefined
		? { method }
		: { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
