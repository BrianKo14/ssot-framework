// One CRUD router per table, and each detail's collection under its master

import { type RequestHandler, Router } from 'express';
import { type Changes, changeStore } from '../../auth/changes.js';
import type { Presence } from '../../auth/presence.js';
import type { Db } from '../../db/postgres.js';
import type { ReferenceInfo, TableInfo } from '../../schema/model.js';
import { permit, readableBy } from '../permission.js';
import { detailPath, isNestable, mounted, routes } from './mount.js';
import { readRouter } from './read.js';
import { type Seeing, viewersRouter } from './viewers.js';
import { writeRouter } from './write.js';

/** Generic CRUD router factory.
 * The order of its routers is the rule: the gate before anything, and only what comes after
 * `noticed` counts as the user's activity.
 * @param master when this table is mounted as a detail, the reference it was mounted through. */
export function crudRouter(
	db: Db, t: TableInfo, presence: Seeing, changes: Changes, noticed: RequestHandler, master?: ReferenceInfo,
): Router {
	const m = mounted(db, t, changes, master);

	return routes()
		.use(permit(t))					// first thing: authorization gate
		.use(viewersRouter(m, presence))		// the poll, above the tracker: it is not activity
		.use(noticed)					// everything under this point is logged as user activity
		.use(readRouter(m))
		.use(writeRouter(m));
}


/** Gather all the CRUD routers for the given tables. Mounted whole at `/api`. */
/** @param noticed what notes a request down as its user's activity, see `auth/activity.ts` */
export function entityRouter(db: Db, tables: TableInfo[], presence: Presence, noticed: RequestHandler): Router {
	const r = Router();

	const seeing: Seeing = {
		see: presence.see,
		readable: req => tables.filter(readableBy(req)).map(t => t.entity),
	};

	const changes = changeStore(db);

	for (const t of tables) {					// per table CRUD router at /api/<table>
		r.use(`/${t.entity}`, crudRouter(db, t, seeing, changes, noticed));

		// ...and mount each of its details' collections under it, at /api/<master>/<master key>/<detail>.
		for (const ref of t.details.filter(isNestable))
			r.use(`/${t.entity}${detailPath(ref)}`, crudRouter(db, ref.from, seeing, changes, noticed, ref));
	}

	return r;
}
