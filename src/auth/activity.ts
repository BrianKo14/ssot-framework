// Activity monitor
// (Who is signed in right now and what they are doing)

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Request, RequestHandler } from 'express';
import { type Db, withValues } from '../db/postgres.js';
import { checkedValues, rowValues } from '../schema/values.js';
import type { Activity, Online } from '../shared/api.js';
import type { ColumnInfo, Columns } from '../schema/model.js';
import { equalities, filterConditions, where } from '../sql/filter.js';
import { columnList, q, tableRef } from '../sql/identifier.js';
import { activityTable, col, sessionTable, userTable } from './entities.js';


// --- Column names ---

const   A_USER = col(activityTable, 'user'),
	A_AT = col(activityTable, 'at'),
	A_SCREEN = col(activityTable, 'screen'),
	A_REQUEST = col(activityTable, 'request'),
	A_STATEMENTS = col(activityTable, 'statements');

const   U_USERNAME = col(userTable, 'username'),
	U_ROLE = col(userTable, 'role'),
	U_ACTIVE = col(userTable, 'active');

const   S_USER = col(sessionTable, 'user'),
	S_EXPIRES_AT = col(sessionTable, 'expires_at');

/** Columns of the activity table written on insert. */
const NOTED = [A_USER, A_SCREEN, A_REQUEST, A_STATEMENTS];
/** Columns of the activity table read on select. */
const LAST = [A_AT, A_SCREEN, A_REQUEST, A_STATEMENTS];

/** Three little helper functions that turn a column into a quoted, alias-prefixed SQL reference.
 * Users, sessions, activities. */
const [u, s, a] = ['u', 's', 'a'].map(alias => (c: ColumnInfo) => `${q(alias)}.${q(c.name)}`);

const named = (columns: ColumnInfo[]): Columns => new Map(columns.map(c => [c.name, c]));

/** What the user list can be filtered by. */
export const USER_FILTERS = [U_USERNAME, U_ROLE, A_AT, A_SCREEN];

/** A map of column names -> SQL references. */
const userAt = new Map([...[U_USERNAME, U_ROLE].map(c => [c, u(c)] as const), ...[A_AT, A_SCREEN].map(c => [c, a(c)] as const)]);

/** The columns that are shown in the activity log. */
export const ACTION_FILTERS = LAST;

/** A row of the log as it goes out. */
const activityOf = (row: Record<string, unknown>): Activity | null => {
	const one = rowValues(LAST, row);

	return one[A_AT.name] === null ? null : {
		at: String(one[A_AT.name]),
		screen: one[A_SCREEN.name] === null ? null : String(one[A_SCREEN.name]),
		request: String(one[A_REQUEST.name]),
		statements: String(one[A_STATEMENTS.name]),
	};
};



// --- SQL statement storage ---

/** SQL statement separator in the log. */
const BETWEEN = ';\n';

/** Stashes per-request list of statements async. */
const said = new AsyncLocalStorage<string[]>();

/** Wraps the database so every query is logged in the AsyncLocalStorage `said`. */
export const traced = (db: Db): Db => ({
	query(text, params) {
		said.getStore()?.push(withValues(text, params));

		return db.query(text, params);
	},
	close: () => db.close(),
});


// --- The activity log ---

export interface Noted {
	user: string;
	screen: string | null;
	request: string;
	statements: string[];
}

/** Watcher's blocklist. The tables and screens they cannot see, per role.
 * One list of hidden tables spelled in two ways: the screen holds an entity
 * name, the statements the qualified table. Later converted. */
export interface Unseen {
	/** The entity names, as a screen is named. */
	screens: string[];
	/** The same tables as their statements name them, e.g. `"ventas"."reserva"`. */
	tables: string[];
}

export interface Activities {
	note(done: Noted): Promise<void>;

	/** Every active user with a live session + their newest action.
	 * @param filter as `?filter=` carries it, on `USER_FILTERS` */
	online(unseen: Unseen, filter: Record<string, unknown>): Promise<Online[]>;

	/** Actions by the user, newest first, signed in now or not.
	 * @param filter as `?filter=` carries it, on `ACTION_FILTERS` */
	of(user: unknown, unseen: Unseen, filter: Record<string, unknown>): Promise<Activity[]>;
}

/** @param db the plain connection, not `traced`. */
export function activityStore(db: Db): Activities {
	const [users, sessions, activities] = [userTable, sessionTable, activityTable].map(tableRef);

	/** SQL to filter the activity log to tables the user is allowed to see. */
	const visible = ({ screens, tables }: Unseen, params: unknown[]): string =>
		`(${q(A_SCREEN.name)} is null or not ${q(A_SCREEN.name)} = any($${params.push(screens)}::text[]))`
		+ ` and not exists (select 1 from unnest($${params.push(tables)}::text[]) as ${q('hidden')}(${q('ref')})`
		+ ` where strpos(${q(A_STATEMENTS.name)}, ${q('ref')}) > 0)`;

	return {

		/** Logs a user's activity. */
		async note({ user, screen, request, statements }) {
			const values = checkedValues(NOTED, {
				[A_USER.name]: user,
				[A_SCREEN.name]: screen,
				[A_REQUEST.name]: request,
				[A_STATEMENTS.name]: statements.join(BETWEEN),
			}, true);

			// Never rewritten, so a plain insert. Two of one user's requests finishing in the same
			// microsecond would share a key, and the second is the one not written down.
			await db.query(
				`insert into ${activities} (${columnList(NOTED)}) values (${NOTED.map((_, i) => `$${i + 1}`).join(', ')})`,
				NOTED.map(c => values[c.name]));
		},

		/** The list of online users and their last activity. */
		async online(unseen, filter) {
			const params: unknown[] = [];
			const rows = await db.query(
				`select ${columnList([U_USERNAME, U_ROLE], u)}, ${columnList(LAST, a)}`
				+ ` from ${users} as ${q('u')}`
				+ ` left join lateral (select ${columnList(LAST)} from ${activities}`
				+ ` where ${q(A_USER.name)} = ${u(U_USERNAME)} and ${visible(unseen, params)}`
				+ ` order by ${q(A_AT.name)} desc limit 1) as ${q('a')} on true`
				+ `${where([
					u(U_ACTIVE),
					`exists (select 1 from ${sessions} as ${q('s')}`
					+ ` where ${s(S_USER)} = ${u(U_USERNAME)} and ${s(S_EXPIRES_AT)} > now())`,
					...filterConditions(named(USER_FILTERS), filter, params, c => userAt.get(c)!),
				])}`
				+ ` order by ${a(A_AT)} desc nulls last, ${u(U_USERNAME)}`, params);

			return rows.map(row => {
				const user = rowValues([U_USERNAME, U_ROLE], row);

				return { user: String(user[U_USERNAME.name]), role: String(user[U_ROLE.name]), last: activityOf(row) };
			});
		},

		/** The activity of a specific user. */
		async of(user, unseen, filter) {
			const params: unknown[] = [];
			const rows = await db.query(
				`select ${columnList(LAST)} from ${activities}`
				+ `${where([
					...equalities(checkedValues([A_USER], { [A_USER.name]: user }, true), params),
					visible(unseen, params),
					...filterConditions(named(ACTION_FILTERS), filter, params),
				])}`
				+ ` order by ${q(A_AT.name)} desc`, params);

			return rows.map(row => activityOf(row)!);
		},
	};
}


// --- Noticing a request ---

const decoded = (raw: string): string | null => {
	try { return decodeURIComponent(raw); } catch { return null; }
};

/** The screen from which the request was made. */
const screenOf = (req: Request, screens: ReadonlySet<string>): string | null => {
	const from = req.get('referer');

	if (from === undefined || !URL.canParse(from)) return null;

	const [first = ''] = new URL(from).pathname.split('/').filter(part => part !== '');
	const screen = decoded(first);

	return screen !== null && screens.has(screen) ? screen : null;
};

/** Middleware that logs user activity.
 * Notes down what the request did, once it has been answered.
 * 
 * @param store the activity store to write to
 * @param screens the names a screen can have, i.e. the entities served
 * @returns an Express request handler that logs activity for each request */
export const noticing = (store: Activities, screens: ReadonlySet<string>): RequestHandler =>
	(req, res, next) => {
		// The request is only noticed once, even if it passes through several routers.
		if (said.getStore() !== undefined) { next(); return; }

		const statements: string[] = [];
		const screen = screenOf(req, screens);

		res.on('finish', () => {
			store.note({ user: req.principal!.username, screen, request: `${req.method} ${req.originalUrl}`, statements })
				.catch((err: unknown) => console.error(err));
		});

		said.run(statements, next);
	};
