// What every route handler in this folder is built with

import type { RequestHandler } from 'express';

/** Route handler wrapper to reroute errors to the error handling middleware. */
export const wrap = (h: RequestHandler): RequestHandler =>
	(req, res, next) => { void Promise.resolve(h(req, res, next)).catch(next); };
