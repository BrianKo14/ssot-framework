// What every route handler in this folder is built with

import type { ErrorRequestHandler, RequestHandler, Response } from 'express';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { HttpError } from '../errors.js';
import type { Format, Sheet } from '../format/registry.js';

/** Route handler wrapper to reroute errors to the error handling middleware. */
export const wrap = (h: RequestHandler): RequestHandler =>
	(req, res, next) => { void Promise.resolve(h(req, res, next)).catch(next); };

/** Error handling middleware. */
export const onError: ErrorRequestHandler = (err, _req, res, _next) => {
	const status = err instanceof HttpError ? err.status : 500;

	if (status === 500) console.error(err);

	res.status(status).json({ error: status === 500 ? 'internal error' : err.message });
};


const fileName = (name: string) => name.replace(/[^\w.-]/g, '_');

/** Writes a sheet as one of the formats.
 * A format with a file name is handed over as a file, and one without is shown. */
export async function sendAs(res: Response, format: Format, sheet: Sheet): Promise<void> {

	if (format.extension) res.attachment(`${fileName(sheet.name)}.${format.extension}`);
	res.type(format.contentType);

	// Note: `pipeline` is used to slow down the stream to the speed of the response + reports failures.
	await pipeline(Readable.from(format.render(sheet), { objectMode: false }), res);
}
