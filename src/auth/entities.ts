// The framework's users, credentials and sessions

import { boxType, defineEntities, defineEntity, defineTypes, type RecordDef, inSchema, tablesFrom } from '../schema/build.js';
import type { ColumnInfo, TableInfo } from '../schema/model.js';
import { password as passwordType } from '../types/builtin.js';
import { builtinTypeDefs, handlersFor } from '../types/registry.js';

const typeDefs = defineTypes({
	...builtinTypeDefs,
	username: { tsType: boxType<string>(), base: 'text', attrs: { kind: 'bound', maxLength: 60 } },
	secret: { tsType: boxType<string>(), base: 'text', attrs: { kind: 'bound', maxLength: 200 } },
	digest: { tsType: boxType<string>() },	// SHA-256 of a session token, see `digestOf` in `hash.ts`
	role: { tsType: boxType<string>() },	// what the access policy grants against, see `schema/access.ts`
	token: { tsType: boxType<string>() },	// browser tab identifier, minted like a session's token
});

const authTypes = handlersFor(typeDefs);

/** The framework's own tables live in their own namespace, which no app entity may enter. */
export const AUTH_SCHEMA = 'auth';

const entityDefs = defineEntities({ ...inSchema(AUTH_SCHEMA, {

	/** User's identity and profile.
	 * Hold no secrets, so one could mount this entity to the screen later. */
	user: defineEntity({
		pk: ['username'],
		fields: {
			username: { type: 'username', isName: true },
			email: { type: 'text' },
			role: { type: 'role', nullable: false },
			active: { type: 'boolean', nullable: false, defaultValue: { value: true } },
		} satisfies RecordDef<typeof typeDefs>,
		fks: {},
	}),

	/** User's credentials. */
	credential: defineEntity({
		pk: ['user'],
		fields: {
			user: { type: 'username' },
			hash: { type: 'secret', nullable: false },
		} satisfies RecordDef<typeof typeDefs>,
		fks: { user: { entity: `${AUTH_SCHEMA}.user`, fields: { user: 'username' } } },
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
		fks: { user: { entity: `${AUTH_SCHEMA}.user`, fields: { user: 'username' } } },
	}),

	/** One browser tab. */
	presence: defineEntity({
		pk: ['tab'],
		fields: {
			tab: { type: 'token' },
			user: { type: 'username', nullable: false },
			entity: { type: 'text', nullable: false },
			record: { type: 'text' },			// where the cursor is, pk values as the address writes them
			seen_at: { type: 'datetime', nullable: false },	// UTC, by the database's clock
		} satisfies RecordDef<typeof typeDefs>,
		fks: { user: { entity: `${AUTH_SCHEMA}.user`, fields: { user: 'username' } } },
	}),
}) });

/** Framework's tables.
 * Built separately and never mixed with the app's regular tables.
 *
 * Exported with a `Table` suffix: `store.ts` needs plain `user` / `session` as local variable
 * names for the *rows* it reads, and the suffix keeps those from colliding with the `TableInfo`
 * these actually are. */
export const authTables = tablesFrom(entityDefs, authTypes);

const find = (name: string): TableInfo => {
	const t = authTables.find(x => x.entity === name);

	if (!t) throw new Error(`auth entity "${name}" is missing`);

	return t;
};

export const userTable = find(`${AUTH_SCHEMA}.user`);
export const credentialTable = find(`${AUTH_SCHEMA}.credential`);
export const sessionTable = find(`${AUTH_SCHEMA}.session`);
export const presenceTable = find(`${AUTH_SCHEMA}.presence`);

/** A column in an auth table. */
export const col = (t: TableInfo, name: string): ColumnInfo => {
	const c = t.byName.get(name);

	if (!c) throw new Error(`auth table "${t.entity}" has no column "${name}"`);

	return c;
};

/** What a password must look like.
 * The plaintext password is not stored, but it still has a type. */
export const password: ColumnInfo =
	{ name: 'password', typeName: 'password', nullable: false, isName: false, type: passwordType(), defaultValue: null, defaultSql: null };

/** What a login request must carry. */
export const loginFields: ColumnInfo[] = [col(userTable, 'username'), password];
