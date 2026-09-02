// The framework's users, credentials and sessions

import { defineEntities, defineEntity, type RecordDef, tablesFrom, typeCollectionOf } from '../schema/build.js';
import type { ColumnInfo, TableInfo } from '../schema/model.js';
import { commonTypes, digest, password as passwordType, role, text } from '../types/builtin.js';

const authTypes = {
	...commonTypes,
	username: text(60),		// login identifier
	secret: text(200),		// PHC-format scrypt hash
	digest,				// SHA-256 of a session token, see `digestOf` in `hash.ts`
	role,				// what the access policy grants against, see `schema/access.ts`
};

const typeDefs = typeCollectionOf(authTypes);

/** The framework's own tables live in their own namespace. */
const AUTH_SCHEMA = 'auth';

const entityDefs = defineEntities({

	/** User's identity and profile.
	 * Hold no secrets, so one could mount this entity to the screen later. */
	user: defineEntity({
		pk: ['username'],
		fields: {
			username: { type: 'username', isName: true },
			email: { type: 'text' },
			role: { type: 'role', nullable: false },
			active: { type: 'boolean', nullable: false },
		} satisfies RecordDef<typeof typeDefs>,
		fks: {},
		schema: AUTH_SCHEMA,
	}),

	/** User's credentials. */
	credential: defineEntity({
		pk: ['user'],
		fields: {
			user: { type: 'username' },
			hash: { type: 'secret', nullable: false },
		} satisfies RecordDef<typeof typeDefs>,
		fks: { user: { entity: 'user', fields: { user: 'username' } } },
		schema: AUTH_SCHEMA,
	}),

	/** A live login session. */
	session: defineEntity({
		pk: ['token'],
		fields: {
			token: { type: 'digest' },			  	// SHA-256 of the session token, see `digestOf` in `hash.ts`
			user: { type: 'username', nullable: false },
			created_at: { type: 'datetime', nullable: false },	// UTC timestamp of creation, see `now()` in `store.ts`
			expires_at: { type: 'datetime', nullable: false },	// Idem.
		} satisfies RecordDef<typeof typeDefs>,
		fks: { user: { entity: 'user', fields: { user: 'username' } } },
		schema: AUTH_SCHEMA,
	}),
});

/** Framework's tables.
 * Built separately and never mixed with the app's regular tables.
 *
 * Exported with a `Table` suffix: `store.ts` needs plain `user` / `session` as local variable
 * names for the *rows* it reads, and the suffix keeps those from colliding with the `TableInfo`
 * these actually are. */
export const authTables = tablesFrom(entityDefs, authTypes);

const find = (name: string): TableInfo => {
	const t = authTables.find(x => x.table === name);

	if (!t) throw new Error(`auth entity "${name}" is missing`);

	return t;
};

export const userTable = find('user');
export const credentialTable = find('credential');
export const sessionTable = find('session');

/** A column in an auth table. */
export const col = (t: TableInfo, name: string): ColumnInfo => {
	const c = t.byName.get(name);

	if (!c) throw new Error(`auth table "${t.table}" has no column "${name}"`);

	return c;
};

/** What a password must look like.
 * The plaintext password is not stored, but it still has a type. */
export const password: ColumnInfo = { name: 'password', typeName: 'password', nullable: false, type: passwordType() };

/** What a login request must carry. */
export const loginFields: ColumnInfo[] = [col(userTable, 'username'), password];
