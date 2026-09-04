// The example system of an SSOT.
// `index.ts` serves it; `schema.ts` creates its database.

import { CAPABILITIES } from '../schema/access.js';
import { boxType, defineEntities, defineEntity, defineTypes, inSchema, type RecordDef, tablesFrom } from '../schema/build.js';
import { type BaseType, builtinTypeDefs, handlersFor } from '../types/registry.js';
import { textual } from '../types/handler.js';


// --- THE SYSTEM DEFINITION ---

// --> Types

const emailBase: BaseType = attrs => ({
	sqlType: 'text',
	...textual('an e-mail address',
		/^[^\s@]+@[^\s@]+\.[^\s@]+$/,
		m => [...m[0]].length <= (attrs?.kind === 'bound' ? attrs.maxLength : Infinity) ? m[0] : undefined),
});

const typeDefs = defineTypes({
	...builtinTypeDefs,
	nombre: { tsType: boxType<string>(), base: 'text', attrs: { kind: 'bound', maxLength: 100 } },
	email: { tsType: boxType<string>(), attrs: { kind: 'bound', maxLength: 254 } },
	importe: { tsType: boxType<string>(), base: 'decimal', attrs: { kind: 'decimal', precision: 12, scale: 2 } },
});

const types = handlersFor(typeDefs, { email: emailBase });

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
		access: { admin: CAPABILITIES, sub: ['read', 'create'] },
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
				importe: { type: 'importe' },
				confirmada: { type: 'boolean' },
			} satisfies RecordDef<typeof typeDefs>,
			fks: { cliente: { entity: 'cliente', fields: { cliente: 'id' } } },
			access: { admin: CAPABILITIES, sub: ['read'] }
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
			access: { admin: CAPABILITIES, sub: ['read'] }
		}),

		archivo: defineEntity({
			pk: ['fecha', 'id'],
			fields: {
				fecha: { type: 'date' },
				id: { type: 'integer' },
				motivo: { type: 'nombre', nullable: false, isName: true },
			} satisfies RecordDef<typeof typeDefs>,
			fks: {},
			table: 'archivo_2019',
			access: { admin: CAPABILITIES, sub: ['read'] }
		}),
	}),

	...inSchema('groupA', {
		test: defineEntity({
			pk: ['id'],
			fields: {
				id: { type: 'integer' },
			} satisfies RecordDef<typeof typeDefs>,
			fks: {},
			access: { admin: CAPABILITIES, sub: ['read'] }
		}),
	}),

	...inSchema('groupB', {
		test: defineEntity({
			pk: ['id'],
			fields: {
				id: { type: 'integer' },
			} satisfies RecordDef<typeof typeDefs>,
			fks: {},
			access: { admin: CAPABILITIES, sub: ['read'] }
		}),
	}),
});

export const tables = tablesFrom(entityDefs, types);
