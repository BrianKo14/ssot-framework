// We define a shared error type that lets the backend tell the error-handling middlewhere what status to use.

export class HttpError extends Error {
	constructor(readonly status: number, message: string) {
		super(message);
	}
}