// Who is looking at what right now

import type { Db } from '../db/postgres.js';
import { checkedValues, rowValues } from '../schema/values.js';
import type { Viewer, Watching } from '../shared/api.js';
import { equalities, where } from '../sql/filter.js';
import { columnList, q, tableRef } from '../sql/identifier.js';
import { token as tokenType } from '../types/builtin.js';
import { col, presenceTable } from './entities.js';
import { digestOf, mintToken } from './hash.js';


// --- Column names ---
// (To avoid typos)

const   P_TAB = col(presenceTable, 'tab'),
	P_USER = col(presenceTable, 'user'),
	P_ENTITY = col(presenceTable, 'entity'),
	P_RECORD = col(presenceTable, 'record'),
	P_OPENED = col(presenceTable, 'opened'),
	P_SEEN_AT = col(presenceTable, 'seen_at');

const PRESENTED = [P_TAB, P_USER, P_ENTITY, P_RECORD, P_OPENED];
const SHOWN = [P_TAB, P_USER, P_ENTITY, P_RECORD, P_OPENED];

/** The set of records a tab is currently on. */
const occupying = (...places: unknown[]): string[] =>
	[...new Set(places.filter(p => p !== null && p !== undefined).map(String))];

/** Num. of ID chars from the tab's fingerprint to keep. */
const ID_CHARS = 12;

/** How many polls a tab may miss before it stops counting as present. */
const MISSES = 3;

/** How long a tab is considered present, in seconds. */
const PRESENT_FOR = 15;


/** Where the tab is currently located. */
export interface At {
	/** Tab identifier, however the browser gives it. */
	tab: unknown;
	user: string;
	/** The entity being watched, named by the router that serves it. */
	entity: string;
	/** The record whose cell is being edited, or null. */
	record: string | null;
	/** The record the side panel is showing, or null. */
	opened: string | null;
	/** The set of entities the caller may be told about, per their role. */
	within: string[];
}

export type Seen = Omit<Watching, 'locks'>;

export interface Presence {
	/** Returns the set of tabs that are currently present and watching something. */
	see(at: At): Promise<Seen>;
}


export function presenceStore(db: Db, pollSeconds: number): Presence {
	const table = tableRef(presenceTable);

	const presentFor = Math.max(pollSeconds * MISSES, PRESENT_FOR);

	/** SQL expression that checks if a tab is still present. */
	const fresh = (params: unknown[]): string =>
		`${q(P_SEEN_AT.name)} > now() - make_interval(secs => $${params.push(presentFor)})`;

	/** Updates the presence record for the given tab. */
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
		async see({ tab, user, entity, record, opened, within }) {
			const named = tokenType.check(tab);
			const name = named.ok ? named.value : mintToken();

			// Delete unfresh presence records
			const reaping: unknown[] = [];
			await db.query(`delete from ${table} where not (${fresh(reaping)})`, reaping);

			// Insert or update this tab's presence record + validate
			await arrive(checkedValues(PRESENTED, {
				[P_TAB.name]: name,
				[P_USER.name]: user,
				[P_ENTITY.name]: entity,
				[P_RECORD.name]: record,
				[P_OPENED.name]: opened,
			}, true));

			const params: unknown[] = [];
			/** Conditions to filter the presence records. */
			const conds = [
				// Only the entities the caller may be told about, per their role.
				`${q(P_ENTITY.name)} = any($${params.push(within)}::text[])`,
				// Only the tabs that are still present.
				fresh(params),
				// Don't tell the caller about their own tab.
				`${q(P_TAB.name)} <> $${params.push(name)}`,
			];

			const rows = await db.query(
				`select ${columnList(SHOWN)} from ${table}${where(conds)}`
				+ ` order by ${columnList([P_ENTITY, P_USER, P_TAB])}`, params);

			const viewers: Viewer[] = rows.map(row => {
				const seen = rowValues(SHOWN, row);

				return {
					id: digestOf(String(seen[P_TAB.name])).slice(0, ID_CHARS),
					user: String(seen[P_USER.name]),
					entity: String(seen[P_ENTITY.name]),
					records: occupying(seen[P_RECORD.name], seen[P_OPENED.name]),
				};
			});

			return { tab: name, viewers };
		},
	};
}
