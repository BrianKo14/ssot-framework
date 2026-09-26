// Authorization gate (may this principal do this to this table?)

import type { Request, RequestHandler } from 'express';
import { HttpError } from '../errors.js';
import { allows } from '../schema/access.js';
import type { TableInfo } from '../schema/model.js';
import type { Capability } from '../shared/api.js';

/** Level of permission required for each HTTP method. */
const CAPABILITY: ReadonlyMap<string, Capability> = new Map<string, Capability>([
	['GET', 'read'],
	['HEAD', 'read'],		// here because Express answers HEAD with the GET handler 
	['POST', 'create'],
	['PUT', 'update'],
	['PATCH', 'update'],
	['DELETE', 'delete'],
	['LOCK', 'lock'],
	['UNLOCK', 'lock'],
]);

/** May this request do `can` to this table? */
const may = (req: Request, t: TableInfo, can: Capability) => {
	const role = req.principal?.role;

	return role !== undefined && allows(t.access, role, can);
};

/** May this request read from this table? */
export const readableBy = (req: Request) => (t: TableInfo) => may(req, t, 'read');

/** May this request delete from this table? */
export const deletableBy = (req: Request) => (t: TableInfo) => may(req, t, 'delete');

/** The authorization gate.
 * Is mounted inside `crudRouter` so every mount of it is guarded.
 * 
 * If disallowed, throws a 402 error. */
export const permit = (t: TableInfo): RequestHandler => (req, _res, next) => {
	const can = CAPABILITY.get(req.method);

	if (can === undefined || !may(req, t, can))
		throw new HttpError(403, `not allowed to ${can ?? req.method.toLowerCase()} ${t.entity}`);

	next();
};