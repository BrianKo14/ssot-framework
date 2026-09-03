// The example system of an SSOT.
// `index.ts` serves it; `schema.ts` creates its database.

import { type AccessDef, CAPABILITIES } from '../schema/access.js';
import { defineEntities, defineEntity, inSchema, type RecordDef, tablesFrom, typeCollectionOf } from '../schema/build.js';
import { commonTypes, text } from '../types/builtin.js';
import { textual, type TypeHandler } from '../types/handler.js';


// --- The system definition ---

// --> Types
const email: TypeHandler<string> = {
	sqlType: 'text',
	...textual('an e-mail address',
		/^[^\s@]+@[^\s@]+\.[^\s@]+$/,
		m => [...m[0]].length <= 254 ? m[0] : undefined),
};

const types = { ...commonTypes, nombre: text(100), email };
const typeDefs = typeCollectionOf(types);

// --> Structure
const entityDefs = defineEntities({
	cliente: defineEntity({
		pk: ['id'],
		fields: {
			id: { type: 'integer' },
			nombre: { type: 'text', nullable: false, isName: true },
			email: { type: 'email' },
		} satisfies RecordDef<typeof typeDefs>,
		fks: {}, // TODO: if left out, `defineEntity` widens its fk parameter to the constraint
	}),

	...inSchema('ventas', {
		reserva: defineEntity({
			pk: ['fecha', 'id'],
			fields: {
				fecha: { type: 'date' },
				id: { type: 'integer' },
				cliente: { type: 'integer' },
				nombre: { type: 'nombre', nullable: false, isName: true },
				notas: { type: 'text' },
				hora: { type: 'time' },
				creado_en: { type: 'datetime' },
				duracion: { type: 'interval' },
				importe: { type: 'decimal' },
				confirmada: { type: 'boolean' },
			} satisfies RecordDef<typeof typeDefs>,
			fks: { cliente: { entity: 'cliente', fields: { cliente: 'id' } } },
		}),
	}),

	...inSchema('operacion', {
		item: defineEntity({
			pk: ['fecha', 'id', 'item'],
			fields: {
				fecha: { type: 'date' },
				id: { type: 'integer' },
				item: { type: 'integer' },
				descripcion: { type: 'nombre', nullable: false, isName: true },
				cantidad: { type: 'integer' },
			} satisfies RecordDef<typeof typeDefs>,
			fks: { reserva: { entity: 'ventas.reserva', fields: ['fecha', 'id'] } },
		}),
	}),

	...inSchema('groupA', {
		test: defineEntity({
			pk: ['id'],
			fields: {
				id: { type: 'integer' },
			} satisfies RecordDef<typeof typeDefs>,
			fks: {},
		}),
	}),

	...inSchema('groupB', {
		test: defineEntity({
			pk: ['id'],
			fields: {
				id: { type: 'integer' },
			} satisfies RecordDef<typeof typeDefs>,
			fks: {},
		}),
	}),
});

// --> Authorization policy
const access = {
	cliente: { admin: CAPABILITIES, sub: ['read', 'create'] },
	'ventas.reserva': { admin: CAPABILITIES, sub: ['read'] },
	'operacion.item': { admin: CAPABILITIES, sub: ['read'] },
	'groupA.test': { admin: CAPABILITIES, sub: ['read'] },
	'groupB.test': { admin: CAPABILITIES, sub: ['read'] },
} satisfies AccessDef<typeof entityDefs>;



export const tables = tablesFrom(entityDefs, types, access);
