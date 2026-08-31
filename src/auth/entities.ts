// The framework's users, credentials and sessions

import { defineEntities, defineEntity, type RecordDef, tablesFrom, typeCollectionOf } from '../schema/build.js';
import type { ColumnInfo, TableInfo } from '../schema/model.js';
import { commonTypes, digest, password, text } from '../types/builtin.js';

const authTypes = {
	...commonTypes,
	nombre: text(60),		// login identifier
	secreto: text(200),		// PHC-format scrypt hash
	digest,				// SHA-256 of a session token, see `digestOf` in `hash.ts`
};

const typeDefs = typeCollectionOf(authTypes);

const entityDefs = defineEntities({

	/** User's identity and profile.
	 * Hold no secrets, so one could mount this entity to the screen later.*/
	usuario: defineEntity({
		pk: ['nombre'],
		fields: {
			nombre: { type: 'nombre', isName: true },
			email: { type: 'text' },
			es_admin: { type: 'boolean', nullable: false },
			activo: { type: 'boolean', nullable: false },
		} satisfies RecordDef<typeof typeDefs>,
		fks: {},
	}),

	/** User's credentials. */
	credencial: defineEntity({
		pk: ['usuario'],
		fields: {
			usuario: { type: 'nombre' },
			hash: { type: 'secreto', nullable: false },
		} satisfies RecordDef<typeof typeDefs>,
		fks: { usuario: { entity: 'usuario', fields: { usuario: 'nombre' } } },
	}),

	/** A live login session. */
	sesion: defineEntity({
		pk: ['token'],
		fields: {
			token: { type: 'digest' },			  	// SHA-256 of the session token, see `digestOf` in `hash.ts`
			usuario: { type: 'nombre', nullable: false },
			creado_en: { type: 'datetime', nullable: false },	// UTC timestamp of creation, see `now()` in `store.ts`
			expira: { type: 'datetime', nullable: false },		// Idem.
		} satisfies RecordDef<typeof typeDefs>,
		fks: { usuario: { entity: 'usuario', fields: { usuario: 'nombre' } } },
	}),
});

/** Framework's tables.
 * Built separately and never mixed with the app's regular tables. */
export const authTables = tablesFrom(entityDefs, authTypes);

const find = (name: string): TableInfo => {
	const t = authTables.find(x => x.table === name);

	if (!t) throw new Error(`auth entity "${name}" is missing`);

	return t;
};

export const usuario = find('usuario');
export const credencial = find('credencial');
export const sesion = find('sesion');

/** A column in an auth table. */
export const col = (t: TableInfo, name: string): ColumnInfo => {
	const c = t.byName.get(name);

	if (!c) throw new Error(`auth table "${t.table}" has no column "${name}"`);

	return c;
};

/** What a password must look like.
 * The plaintext password is not stored, but it still has a type. */
export const clave: ColumnInfo = { name: 'clave', typeName: 'clave', nullable: false, type: password() };

/** What a login request must carry. */
export const loginFields: ColumnInfo[] = [col(usuario, 'nombre'), clave];
