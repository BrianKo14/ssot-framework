// All frontend API calls go through here

/** Remembers the status code (401, 404, etc.) + the error message. */
export class ApiError extends Error {
	constructor(readonly status: number, message: string) {
		super(message);
	}
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(path, init);

	const body: unknown = await res.json().catch(() => null);
	const said = (body as { error?: unknown } | null)?.error;

	if (!res.ok) throw new ApiError(res.status, typeof said === 'string' ? said : res.statusText);

	return body as T;
}

// The session cookie is sent automatically, so we don't need to include it in the headers.
export const sending = (method: string, body?: unknown): RequestInit =>
	body === undefined
		? { method }
		: { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
