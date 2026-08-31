// This file connects auth to the databaste. It decides who a token belongs to and how one is issued.
// All the syntax here is already token-shaped, not request-shaped.

import type { Db } from '../db/postgres.js';
import type { ColumnInfo, TableInfo } from '../schema/model.js';
import { checkedValues, rowValues } from '../schema/values.js';
import { equalities, where } from '../sql/filter.js';
import { columnList, q } from '../sql/identifier.js';
import { token as tokenType } from '../types/builtin.js';
import { clave as CLAVE, col, credencial, sesion, usuario } from './entities.js';
import { digestOf, dummyHash, hashPassword, mintToken, verifyPassword } from './hash.js';

/** Who is making the request. */
export interface Principal {
	nombre: string;
	esAdmin: boolean;
}

/** A token that has been issued to a user. */
export interface Issued {
	token: string;
	expira: string;
	principal: Principal;
}

export interface UserProfile {
	email?: string | null;
	esAdmin?: boolean;
	activo?: boolean;
}


export interface Authenticator {
	identify(token: string): Promise<Principal | null>;
	login(nombre: string, clave: string): Promise<Issued | null>;
	logout(token: string): Promise<void>;
}


// --- Column names ---
// (Typed once here to avoid security holes from typos.)

const   U_NOMBRE = col(usuario, 'nombre'),
	U_EMAIL = col(usuario, 'email'),
	U_ES_ADMIN = col(usuario, 'es_admin'),
	U_ACTIVO = col(usuario, 'activo');

const   C_USUARIO = col(credencial, 'usuario'),
	C_HASH = col(credencial, 'hash');

const   S_TOKEN = col(sesion, 'token'),
	S_USUARIO = col(sesion, 'usuario'),
	S_CREADO_EN = col(sesion, 'creado_en'),
	S_EXPIRA = col(sesion, 'expira');

const USUARIO_COLUMNS = [U_NOMBRE, U_EMAIL, U_ES_ADMIN, U_ACTIVO];


// --- The authenticator ---

export function dbAuthenticator(db: Db, sessionTtl: string): Authenticator & {
	saveUser(nombre: string, profile: UserProfile, clave?: string): Promise<void>;
} {

	/** SELECT <cols> FROM <table> WHERE <conds> */
	async function rowsWhere(t: TableInfo, conds: string[], params: unknown[]): Promise<Record<string, unknown>[]> {
		if (!conds.length) throw new Error(`refusing an unconditional read of "${t.table}"`);

		const rows = await db.query(`select ${columnList(t.columns)} from ${q(t.table)}${where(conds)}`, params);

		return rows.map(r => rowValues(t.columns, r));
	}

	/** An active user by name */
	async function activeUser(nombre: unknown): Promise<Record<string, unknown> | null> {
		const params: unknown[] = [];
		const conds = equalities({ [U_NOMBRE.name]: nombre, [U_ACTIVO.name]: true }, params);
		const [row] = await rowsWhere(usuario, conds, params);

		return row ?? null;
	}

	const principalOf = (row: Record<string, unknown>): Principal =>
		({ nombre: String(row[U_NOMBRE.name]), esAdmin: row[U_ES_ADMIN.name] === true });

	async function storedHash(nombre: unknown): Promise<string | null> {
		const params: unknown[] = [];
		const conds = equalities({ [C_USUARIO.name]: nombre }, params);
		const [row] = await rowsWhere(credencial, conds, params);

		return row ? String(row[C_HASH.name]) : null;
	}

	/** Insert or update one row of an auth table, addressed by `key`. */
	async function upsert(t: TableInfo, cols: ColumnInfo[], values: Record<string, unknown>, key: ColumnInfo[]) {
		const params: unknown[] = [];
		const ph = cols.map(c => `$${params.push(values[c.name])}`).join(', ');
		const rest = cols.filter(c => !key.includes(c));

		const onConflict = rest.length
			? `do update set ${rest.map(c => `${q(c.name)} = excluded.${q(c.name)}`).join(', ')}`
			: 'do nothing';

		await db.query(
			`insert into ${q(t.table)} (${columnList(cols)}) values (${ph})`
			+ ` on conflict (${columnList(key)}) ${onConflict}`, params);
	}

	async function forgetSessionsOf(nombre: unknown): Promise<void> {
		const params: unknown[] = [];
		const conds = equalities({ [S_USUARIO.name]: nombre }, params);

		await db.query(`delete from ${q(sesion.table)}${where(conds)}`, params);
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
				`${q(S_EXPIRA.name)} > now()`,
			];

			const [session] = await rowsWhere(sesion, conds, params);

			if (!session) return null;

			const user = await activeUser(session[S_USUARIO.name]);

			return user ? principalOf(user) : null;
		},

		async login(nombre, clave) {
			// Clean up expired sesssions every time someone logs in
			await db.query(`delete from ${q(sesion.table)} where ${q(S_EXPIRA.name)} <= now()`);

			const user = await activeUser(nombre);
			const stored = user ? await storedHash(user[U_NOMBRE.name]) : null;

			// Always do some password check, even when the username doesn't exist,
			// so that the response time doesn't leak whether the username is valid.
			const matches = await verifyPassword(clave, stored ?? await dummyHash());

			if (!user || !stored || !matches) return null;

			const token = mintToken();
			const cols = [S_TOKEN, S_USUARIO, S_CREADO_EN, S_EXPIRA];

			// Set the session's expiration to `now() + sessionTtl`
			const rows = await db.query(
				`insert into ${q(sesion.table)} (${columnList(cols)})`
				+ ` values ($1, $2, now(), now() + $3::interval)`
				+ ` returning ${columnList(sesion.columns)}`,
				[digestOf(token), user[U_NOMBRE.name], sessionTtl]);

			const row = rowValues(sesion.columns, rows[0]);

			return { token, expira: String(row[S_EXPIRA.name]), principal: principalOf(user) };
		},

		async logout(raw) {
			const token = tokenType.check(raw);

			if (!token.ok) return;

			const params: unknown[] = [];
			const conds = equalities({ [S_TOKEN.name]: digestOf(token.value) }, params);

			await db.query(`delete from ${q(sesion.table)}${where(conds)}`, params);
		},

		/** Create / updates a user.
		 * 
		 * TODO: This is used by the ops script, no HTTP yet (requires authorization rules). */
		async saveUser(nombre, profile, clave) {

			const existing = await activeUser(nombre) ?? await (async () => {
				// If no active user exists, look again: one might still exist but be inactive
				const params: unknown[] = [];
				const [row] = await rowsWhere(usuario, equalities({ [U_NOMBRE.name]: nombre }, params), params);

				return row ?? null;
			})();

			const values = checkedValues(USUARIO_COLUMNS, {
				[U_NOMBRE.name]: nombre,
				[U_EMAIL.name]: profile.email ?? existing?.[U_EMAIL.name] ?? null,
				[U_ES_ADMIN.name]: profile.esAdmin ?? existing?.[U_ES_ADMIN.name] ?? false,
				[U_ACTIVO.name]: profile.activo ?? existing?.[U_ACTIVO.name] ?? true,
			}, true);

			await upsert(usuario, USUARIO_COLUMNS, values, [U_NOMBRE]);

			if (clave === undefined) return;

			checkedValues([CLAVE], { [CLAVE.name]: clave }, true);

			const credential = checkedValues([C_USUARIO, C_HASH], {
				[C_USUARIO.name]: values[U_NOMBRE.name],
				[C_HASH.name]: await hashPassword(clave),
			}, true);

			await upsert(credencial, [C_USUARIO, C_HASH], credential, [C_USUARIO]);

			// A password change ends every session opened with the old one
			await forgetSessionsOf(values[U_NOMBRE.name]);
		},
	};
}
