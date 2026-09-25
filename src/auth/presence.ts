// Who is looking at what, right now (SCOPE 6d).
// Like `store.ts`, this is the database side of a seam the HTTP layer never reaches around.

import type { Db } from '../db/postgres.js';
import { checkedValues, rowValues } from '../schema/values.js';
import type { Viewer, Watching } from '../shared/api.js';
import { equalities, where } from '../sql/filter.js';
import { columnList, q, tableRef } from '../sql/identifier.js';
import { token as tokenType } from '../types/builtin.js';
import { col, presenceTable } from './entities.js';
import { mintToken } from './hash.js';


// --- Column names ---
// (Typed once here to avoid security holes from typos, as in `store.ts`.)

const   P_TAB = col(presenceTable, 'tab'),
	P_USER = col(presenceTable, 'user'),
	P_ENTITY = col(presenceTable, 'entity'),
	P_RECORD = col(presenceTable, 'record'),
	P_SEEN_AT = col(presenceTable, 'seen_at');

/** What the caller supplies. `seen_at` is not here: it is the database's clock. */
const PRESENTED = [P_TAB, P_USER, P_ENTITY, P_RECORD];

const SHOWN = [P_USER, P_RECORD];

/** How many polls a tab may miss before it stops counting as present. */
const MISSES = 3;


/** Where a tab says it is. */
export interface At {
	/** As the client presented it; anything unusable is answered with a new name. */
	tab: unknown;
	user: string;
	/** The entity being watched, named by the router that serves it — never by the request. */
	entity: string;
	/** The record the cursor is on, or null on the grid. */
	record: string | null;
}

export interface Presence {
	/** Says this tab is here, and answers with the others. */
	see(at: At): Promise<Watching>;
}


export function presenceStore(db: Db, pollSeconds: number): Presence {
	const table = tableRef(presenceTable);

	/** Seen recently enough to still count. The window is derived from the poll the browser was
	 * told to keep, so the two cannot drift; `make_interval` keeps the number a parameter, which
	 * an interval written as text could not be. */
	const fresh = (params: unknown[]): string =>
		`${q(P_SEEN_AT.name)} > now() - make_interval(secs => $${params.push(pollSeconds * MISSES)})`;

	/** This tab is here now. Insert or move, in one statement, because a tab that changes screens
	 * is the same tab: its name is the key. */
	const arrive = async (values: Record<string, unknown>): Promise<void> => {
		const params = PRESENTED.map(c => values[c.name]);
		const ph = PRESENTED.map((_, i) => `$${i + 1}`).join(', ');
		const moved = [...PRESENTED.filter(c => c !== P_TAB), P_SEEN_AT];

		await db.query(
			`insert into ${table} (${columnList([...PRESENTED, P_SEEN_AT])}) values (${ph}, now())`
			+ ` on conflict (${columnList([P_TAB])})`
			+ ` do update set ${moved.map(c => `${q(c.name)} = excluded.${q(c.name)}`).join(', ')}`,
			params);
	};

	return {
		async see({ tab, user, entity, record }) {
			const named = tokenType.check(tab);
			const name = named.ok ? named.value : mintToken();

			// Quiet tabs go on every poll, the way expired sessions go on every login: the table
			// stays bounded and the framework still owns no timer and no background job.
			const reaping: unknown[] = [];
			await db.query(`delete from ${table} where not (${fresh(reaping)})`, reaping);

			await arrive(checkedValues(PRESENTED, {
				[P_TAB.name]: name,
				[P_USER.name]: user,
				[P_ENTITY.name]: entity,
				[P_RECORD.name]: record,
			}, true));

			const params: unknown[] = [];
			const conds = [
				...equalities({ [P_ENTITY.name]: entity }, params),
				fresh(params),
				`${q(P_TAB.name)} <> $${params.push(name)}`,		// everyone else, that is
			];

			const rows = await db.query(
				`select ${columnList(SHOWN)} from ${table}${where(conds)}`
				+ ` order by ${columnList([P_USER, P_TAB])}`, params);

			const viewers: Viewer[] = rows.map(row => {
				const seen = rowValues(SHOWN, row);
				const at = seen[P_RECORD.name];

				return { user: String(seen[P_USER.name]), record: at === null ? null : String(at) };
			});

			return { tab: name, viewers };
		},
	};
}
