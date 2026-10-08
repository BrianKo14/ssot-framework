// This file connects auth to the databaste. It decides who a token belongs to and how one is issued.
// All the syntax here is already token-shaped, not request-shaped.

import type { Db } from '../db/postgres.js';
import type { ColumnInfo, TableInfo } from '../schema/model.js';
import { checkedValues, rowValues } from '../schema/values.js';
import { equalities, where } from '../sql/filter.js';
import { columnList, q, tableRef } from '../sql/identifier.js';
import { upsert } from '../sql/upsert.js';
import { token as tokenType } from '../types/builtin.js';
import { col, credentialTable, password as PASSWORD, sessionTable, userTable } from './entities.js';
import { digestOf, dummyHash, hashPassword, mintToken, verifyPassword } from './hash.js';

/** Who is making the request. */
export interface Principal {
	username: string;
	role: string;
}

/** A token that has been issued to a user. */
export interface Issued {
	token: string;
	expiresAt: string;
	principal: Principal;
}

export interface UserProfile {
	email?: string | null;
	role?: string;
	active?: boolean;
}


export interface Authenticator {
	identify(token: string): Promise<Principal | null>;
	login(username: string, password: string): Promise<Issued | null>;
	logout(token: string): Promise<void>;
}


// --- Column names ---
// (Typed once here to avoid security holes from typos.)

const   U_USERNAME = col(userTable, 'username'),
	U_EMAIL = col(userTable, 'email'),
	U_ROLE = col(userTable, 'role'),
	U_ACTIVE = col(userTable, 'active');

const   C_USER = col(credentialTable, 'user'),
	C_HASH = col(credentialTable, 'hash');

const   S_TOKEN = col(sessionTable, 'token'),
	S_USER = col(sessionTable, 'user'),
	S_CREATED_AT = col(sessionTable, 'created_at'),
	S_EXPIRES_AT = col(sessionTable, 'expires_at');

const USER_COLUMNS = [U_USERNAME, U_EMAIL, U_ROLE, U_ACTIVE];


// --- The authenticator ---

export function dbAuthenticator(db: Db, sessionTtl: string): Authenticator & {
	saveUser(username: string, profile: UserProfile, password?: string): Promise<void>;
} {

	/** SELECT <cols> FROM <table> WHERE <conds> */
	async function rowsWhere(t: TableInfo, conds: string[], params: unknown[]): Promise<Record<string, unknown>[]> {
		if (!conds.length) throw new Error(`refusing an unconditional read of "${t.entity}"`);

		const rows = await db.query(`select ${columnList(t.columns)} from ${tableRef(t)}${where(conds)}`, params);

		return rows.map(r => rowValues(t.columns, r));
	}

	/** An active user by name */
	async function activeUser(username: unknown): Promise<Record<string, unknown> | null> {
		const params: unknown[] = [];
		const conds = equalities({ [U_USERNAME.name]: username, [U_ACTIVE.name]: true }, params);
		const [row] = await rowsWhere(userTable, conds, params);

		return row ?? null;
	}

	const principalOf = (row: Record<string, unknown>): Principal =>
		({ username: String(row[U_USERNAME.name]), role: String(row[U_ROLE.name]) });

	async function storedHash(username: unknown): Promise<string | null> {
		const params: unknown[] = [];
		const conds = equalities({ [C_USER.name]: username }, params);
		const [row] = await rowsWhere(credentialTable, conds, params);

		return row ? String(row[C_HASH.name]) : null;
	}

	/** Insert or update one row of an auth table, addressed by `key`. */
	async function save(t: TableInfo, cols: ColumnInfo[], values: Record<string, unknown>, key: ColumnInfo[]) {
		await db.query(upsert(t, key, cols), cols.map(c => values[c.name]));
	}

	async function forgetSessionsOf(username: unknown): Promise<void> {
		const params: unknown[] = [];
		const conds = equalities({ [S_USER.name]: username }, params);

		await db.query(`delete from ${tableRef(sessionTable)}${where(conds)}`, params);
	}

	return {
		async identify(raw) {
			const token = tokenType.check(raw);

			if (!token.ok) return null;			// malformed token refused

			const params: unknown[] = [];
			const conds = [
				...equalities({ [S_TOKEN.name]: digestOf(token.value) }, params),
				// Decided by the database's clock, not the process's
				// (Using `timezone=UTC` on the connection.)
				`${q(S_EXPIRES_AT.name)} > now()`,
			];

			const [session] = await rowsWhere(sessionTable, conds, params);

			if (!session) return null;

			const user = await activeUser(session[S_USER.name]);

			return user ? principalOf(user) : null;
		},

		async login(username, password) {
			// Clean up expired sesssions every time someone logs in
			await db.query(`delete from ${tableRef(sessionTable)} where ${q(S_EXPIRES_AT.name)} <= now()`);

			const user = await activeUser(username);
			const stored = user ? await storedHash(user[U_USERNAME.name]) : null;

			// Always do some password check, even when the username doesn't exist,
			// so that the response time doesn't leak whether the username is valid.
			const matches = await verifyPassword(password, stored ?? await dummyHash());

			if (!user || !stored || !matches) return null;

			const token = mintToken();
			const cols = [S_TOKEN, S_USER, S_CREATED_AT, S_EXPIRES_AT];

			// Set the session's expiration to `now() + sessionTtl`
			const rows = await db.query(
				`insert into ${tableRef(sessionTable)} (${columnList(cols)})`
				+ ` values ($1, $2, now(), now() + $3::interval)`
				+ ` returning ${columnList(sessionTable.columns)}`,
				[digestOf(token), user[U_USERNAME.name], sessionTtl]);

			const row = rowValues(sessionTable.columns, rows[0]);

			return { token, expiresAt: String(row[S_EXPIRES_AT.name]), principal: principalOf(user) };
		},

		async logout(raw) {
			const token = tokenType.check(raw);

			if (!token.ok) return;

			const params: unknown[] = [];
			const conds = equalities({ [S_TOKEN.name]: digestOf(token.value) }, params);

			await db.query(`delete from ${tableRef(sessionTable)}${where(conds)}`, params);
		},

		/** Create / updates a user. */
		async saveUser(username, profile, password) {

			const existing = await activeUser(username) ?? await (async () => {
				// If no active user exists, look again: one might still exist but be inactive
				const params: unknown[] = [];
				const [row] = await rowsWhere(userTable, equalities({ [U_USERNAME.name]: username }, params), params);

				return row ?? null;
			})();

			const role = profile.role ?? existing?.[U_ROLE.name];	// no default role

			if (role === undefined) throw new Error(`new user "${username}" needs a role`);

			const values = checkedValues(USER_COLUMNS, {
				[U_USERNAME.name]: username,
				[U_EMAIL.name]: profile.email ?? existing?.[U_EMAIL.name] ?? null,
				[U_ROLE.name]: role,
				[U_ACTIVE.name]: profile.active ?? existing?.[U_ACTIVE.name] ?? true,
			}, true);

			await save(userTable, USER_COLUMNS, values, [U_USERNAME]);

			if (password === undefined) return;

			checkedValues([PASSWORD], { [PASSWORD.name]: password }, true);

			const credential = checkedValues([C_USER, C_HASH], {
				[C_USER.name]: values[U_USERNAME.name],
				[C_HASH.name]: await hashPassword(password),
			}, true);

			await save(credentialTable, [C_USER, C_HASH], credential, [C_USER]);

			// A password change ends every session opened with the old one
			await forgetSessionsOf(values[U_USERNAME.name]);
		},
	};
}
