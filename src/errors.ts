// We define a shared error type that lets the backend tell the error-handling middlewhere what status to use.

import type { FieldErrors } from './shared/api.js';

export class HttpError extends Error {
	constructor(readonly status: number, message: string, readonly fields?: FieldErrors) {
		super(message);
	}
}

export const located = (at: string, err: unknown): Error => {
	const message = `${at}${(err as Error).message}`;

	return err instanceof HttpError ? new HttpError(err.status, message) : new Error(message);
};
