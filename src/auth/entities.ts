// The framework's users, credentials and sessions

import { boxType, defineEntities, defineEntity, defineRecord, describeTypes, inSchema, tablesFrom, withRecords } from '../schema/build.js';
import type { ColumnInfo, TableInfo } from '../schema/model.js';
import { VERSION_RANGE } from '../schema/reserved.js';
import { password as passwordType } from '../types/builtin.js';
import { builtinTypeDefs } from '../types/registry.js';

const authTypes = describeTypes({
	...builtinTypeDefs,
	username: { tsType: boxType<string>(), base: 'text', attrs: { kind: 'bound', maxLength: 60 } },
	secret: { tsType: boxType<string>(), base: 'text', attrs: { kind: 'bound', maxLength: 200 } },
	digest: { tsType: boxType<string>() },	// SHA-256 of a session token, see `digestOf` in `hash.ts`
	role: { tsType: boxType<string>() },	// what the access policy grants against, see `schema/access.ts`
	token: { tsType: boxType<string>() },	// browser tab identifier, minted like a session's token
	version: { tsType: boxType<number>(), base: 'integer', attrs: VERSION_RANGE },	// a row's `_version`, see `schema/reserved.ts`
});

/** The framework's own tables live in their own namespace, which no app entity may enter. */
export const AUTH_SCHEMA = 'auth';

const authRecords = withRecords(authTypes, {

	/** User's identity and profile.
	 * Hold no secrets, so one could mount this entity to the screen later. */
	user: defineRecord(authTypes, {
		username: { type: 'username', isName: true },
		email: { type: 'text' },
		role: { type: 'role', nullable: false },
		active: { type: 'boolean', nullable: false, defaultValue: { value: true } },
	}),

	/** User's credentials. */
	credential: defineRecord(authTypes, {
		user: { type: 'username' },
		hash: { type: 'secret', nullable: false },
	}),

	/** A live login session. */
	session: defineRecord(authTypes, {
		token: { type: 'digest' },			  	// SHA-256 of the session token, see `digestOf` in `hash.ts`
		user: { type: 'username', nullable: false },
		created_at: { type: 'datetime', nullable: false },	// UTC timestamp of creation, see `now()` in `store.ts`
		expires_at: { type: 'datetime', nullable: false },	// Idem.
	}),

	/** One browser tab. */
	presence: defineRecord(authTypes, {
		tab: { type: 'token' },
		user: { type: 'username', nullable: false },
		entity: { type: 'text', nullable: false },
		record: { type: 'text' },			// the record whose cell is being edited
		opened: { type: 'text' },			// the record the side panel is showing
		seen_at: { type: 'datetime', nullable: false },	// UTC, by the database's clock
	}),

	/** The history of changes.
	 * Each entry is one column of one record, as it stoof before somebody changed it.
	 * Addressed by plain text (entity name + record id) rather than FKs. */
	change: defineRecord(authTypes, {
		entity: { type: 'text' },			// the entity's identity, e.g. "ventas.reserva"
		record: { type: 'text' },			// the pk address, as `api/crud/mount.ts`'s `addressOf` writes it
		field: { type: 'text' },			// the column that changed
		version: { type: 'version' },			// what `_version` became with this write
		was: { type: 'text' },				// what it held before, as the database renders it
		at: { type: 'datetime', nullable: false, defaultValue: { fn: 'now' } },
		by: { type: 'username', nullable: false },
	}),

	/** Activity monitor. One row per request. */
	activity: defineRecord(authTypes, {
		user: { type: 'username' },
		at: { type: 'datetime', nullable: false, defaultValue: { fn: 'now' } },
		screen: { type: 'text' },			// the entity the page was showing
		request: { type: 'text', nullable: false },	// method + URL
		statements: { type: 'text', nullable: false },	// the SQL it ran, separated by semicolons
	}),
});

const entityDefs = defineEntities({ ...inSchema(AUTH_SCHEMA, {
	user: defineEntity(authRecords, { name: 'user', record: 'user', pk: ['username'], fks: {} }),

	credential: defineEntity(authRecords, { name: 'credential', record: 'credential', pk: ['user'],
		fks: { user: { entity: `${AUTH_SCHEMA}.user`, fields: { user: 'username' } } } }),

	session: defineEntity(authRecords, { name: 'session', record: 'session', pk: ['token'],
		fks: { user: { entity: `${AUTH_SCHEMA}.user`, fields: { user: 'username' } } } }),

	presence: defineEntity(authRecords, { name: 'presence', record: 'presence', pk: ['tab'],
		fks: { user: { entity: `${AUTH_SCHEMA}.user`, fields: { user: 'username' } } } }),

	change: defineEntity(authRecords, { name: 'change', record: 'change', pk: ['entity', 'record', 'field', 'version'],
		fks: { by: { entity: `${AUTH_SCHEMA}.user`, fields: { by: 'username' } } } }),

	activity: defineEntity(authRecords, { name: 'activity', record: 'activity', pk: ['user', 'at'],
		fks: { user: { entity: `${AUTH_SCHEMA}.user`, fields: { user: 'username' } } } }),
}) });

/** Framework's tables.
 * Built separately and never mixed with the app's regular tables.
 *
 * Exported with a `Table` suffix: `store.ts` needs plain `user` / `session` as local variable
 * names for the *rows* it reads, and the suffix keeps those from colliding with the `TableInfo`
 * these actually are. */
export const authTables = tablesFrom(entityDefs, authTypes.handlers);

const find = (name: string): TableInfo => {
	const t = authTables.find(x => x.entity === name);

	if (!t) throw new Error(`auth entity "${name}" is missing`);

	return t;
};

export const userTable = find(`${AUTH_SCHEMA}.user`);
export const credentialTable = find(`${AUTH_SCHEMA}.credential`);
export const sessionTable = find(`${AUTH_SCHEMA}.session`);
export const presenceTable = find(`${AUTH_SCHEMA}.presence`);
export const changeTable = find(`${AUTH_SCHEMA}.change`);
export const activityTable = find(`${AUTH_SCHEMA}.activity`);

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
