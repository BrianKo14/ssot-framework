// Router for presence polling (who has what table open, held records)

import type { Request, RequestHandler, Router } from 'express';
import type { Presence } from '../../auth/presence.js';
import { LOCK } from '../../schema/reserved.js';
import { checkedValues } from '../../schema/values.js';
import type { Lock, Watching } from '../../shared/api.js';
import { q } from '../../sql/identifier.js';
import { wrap } from '../handler.js';
import { type Mount, routes } from './mount.js';

/** What the poll of a table is called, under that table's own path. */
const VIEWERS = '_viewers';

/** Presence + the set of entities the caller may be told about. */
export interface Seeing {
	see: Presence['see'];
	readable(req: Request): string[];
}

/** A list of all the records that are currently locked. */
const claims = async (m: Mount): Promise<Lock[]> => {
	const rows = await m.db.query(
		`select ${m.pkCols}, ${q(LOCK.name)} from ${m.table} where ${q(LOCK.name)} is not null`);

	return rows.map(row => ({
		record: m.addressOf(row),
		holder: String(row[LOCK.name]),
	}));
};

/** Record opened in the side panel. */
const openedRecord = (m: Mount, raw: unknown): string | null => {
	if (typeof raw !== 'string' || raw === '') return null;

	const parts = raw.split('/');

	if (parts.length !== m.t.pk.length) return null;

	try {
		return m.addressOf(checkedValues(m.t.pk, Object.fromEntries(m.t.pk.map((c, i) => [c.name, parts[i]])), true));
	} catch {
		return null;						     // not a key of this table
	}
};

/** Mounted above the activity tracker: polling is not activity. */
export function viewersRouter(m: Mount, presence: Seeing): Router {

	/** Who else has this table open, on which records + what is held.
	 * A GET request that also writes to refresh the caller's presence.
	 * Requires only view access. */
	const watching = (addressed: boolean): RequestHandler => wrap(async (req, res) => {
		const row = addressed ? m.addressedRow(req) : null;		     // validated elsewhere

		const [seen, locks] = await Promise.all([
			presence.see({
				tab: req.query.tab,
				user: req.principal!.username,
				entity: m.t.entity,
				record: row && m.addressOf(row),			     // PK from validated row data
				opened: openedRecord(m, req.query.opened),
				within: presence.readable(req),				     // every screen this role may open
			}),
			claims(m),
		]);

		res.json({ ...seen, locks } satisfies Watching);
	});

	return routes()
		// GET /_viewers[?tab=…] — before `byPk`, so the name wins over a single-column key
		.get(`/${VIEWERS}`, watching(false))

		// GET /:pk0[/:pk1...]/_viewers[?tab=…]
		.get(`${m.byPk}/${VIEWERS}`, watching(true));
}
