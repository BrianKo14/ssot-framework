// The `/api/_monitor` and `/api/_dump` endpoints

import { type Request, Router } from 'express';
import type { Activities, DumpLog, Unseen } from '../auth/activity.js';
import { credentialTable } from '../auth/entities.js';
import type { Presence } from '../auth/presence.js';
import { literal } from '../db/postgres.js';
import { accessOf } from '../schema/access.js';
import type { Access, TableInfo } from '../schema/model.js';
import type { Activity, DumpRead, Monitored } from '../shared/api.js';
import { wrap } from './handler.js';
import { parseFilter } from '../sql/filter.js';
import { tableRef } from '../sql/identifier.js';
import { type Guarded, permit, readableBy } from './permission.js';

/** Name of the monitor endpoint, and of its screen. */
export const MONITOR = '_monitor';

/** Name of the SQL dump's endpoint, and of its screen. */
export const DUMP = '_dump';

/** The access control for the monitor endpoint. */
export const monitorAccess = (roles: readonly string[]): Access =>
	accessOf(MONITOR, Object.fromEntries(roles.map(role => [role, ['read'] as const])));

/** The tables, and their screens, this request may not read. */
const unseenBy = (tables: TableInfo[]) => (req: Request): Unseen => {
	const hidden = tables.filter(t => !readableBy(req)(t));
	return { screens: hidden.map(t => t.entity), tables: hidden.map(tableRef) };
};

/** Mounted beside the entities. Nothing here is noted down as activity.
 * 
 * @param activities the activity store to read from
 * @param presence the presence store to read from
 * @param guarded the grant the application stated for the monitor, as `serve` was handed it
 * @param tables the application's tables, which an action or a tab may be about */
export function monitorRouter(activities: Activities, presence: Presence, guarded: Guarded, tables: TableInfo[]): Router {
	const unseen = unseenBy(tables);
	const readable = (req: Request) => tables.filter(readableBy(req)).map(t => t.entity);

	return Router()
		.use(permit(guarded))

		// GET /[?filter=...][&tab=...] — who is signed in with their newest action + every open tab.
		.get('/', wrap(async (req, res) => {
			const [online, tabs] = await Promise.all([
				activities.online(unseen(req), parseFilter(req.query.filter)),
				presence.tabs(readable(req), req.query.tab),
			]);

			res.json({ online, tabs } satisfies Monitored);
		}))

		// GET /:user[?filter=...] — everything they did, newest first
		.get('/:user', wrap(async (req, res) => {
			res.json(await activities.of(req.params.user, unseen(req), parseFilter(req.query.filter)) satisfies Activity[]);
		}));
}


/** The list of statements not visible to the user. */
const hiddenIn = (unseen: Unseen): string[] =>
	[...unseen.tables, ...unseen.screens.map(literal), tableRef(credentialTable)];

/** Mounted beside the monitor. */
export function dumpRouter(dump: DumpLog, guarded: Guarded, tables: TableInfo[]): Router {
	const unseen = unseenBy(tables);

	return Router()
		.use(permit(guarded))

		// GET /[?filter=...] — what took effect, newest first
		.get('/', wrap(async (req, res) => {
			res.json(await dump.read(hiddenIn(unseen(req)), parseFilter(req.query.filter)) satisfies DumpRead);
		}));
}
