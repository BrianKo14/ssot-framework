// The example system of an SSOT

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
	cantidad: { tsType: boxType<number>(), base: 'integer', attrs: { kind: 'range', min: 1, max: 99 } },
});

const types = handlersFor(typeDefs, { email: emailBase });


// --> Structure

const entityDefs = defineEntities({

	cliente: defineEntity({
		pk: ['id'],
		fields: {
			id: { type: 'integer' },
			nombre: { type: 'nombre', nullable: false, isName: true },
			email: { type: 'email' },
			alta: { type: 'date', nullable: false, defaultValue: { fn: 'today' } },
			recomendado_por: { type: 'integer' },
		} satisfies RecordDef<typeof typeDefs>,
		uks: { email: ['email'] },
		fks: { recomendado_por: { entity: 'cliente', fields: { recomendado_por: 'id' } } },
		access: { admin: CAPABILITIES, recepcion: ['read', 'create', 'update'] },
	}),

	...inSchema('menu', {
		plato: defineEntity({
			pk: ['id'],
			fields: {
				id: { type: 'integer' },
				codigo: { type: 'text', nullable: false },
				nombre: { type: 'nombre', nullable: false, isName: true },
				precio: { type: 'importe', nullable: false },
				vegetariano: { type: 'boolean', nullable: false },
			} satisfies RecordDef<typeof typeDefs>,
			uks: { codigo: ['codigo'] },
			fks: {},
			access: { admin: CAPABILITIES, recepcion: ['read'], cocina: CAPABILITIES },
		}),
	}),

	...inSchema('ventas', {
		reserva: defineEntity({
			pk: ['fecha', 'id'],
			fields: {
				fecha: { type: 'date' },
				id: { type: 'integer' },
				cliente: { type: 'integer', nullable: false },
				mesa: { type: 'cantidad', nullable: false },
				hora: { type: 'time', nullable: false },
				duracion: { type: 'interval' },
				comensales: { type: 'cantidad', nullable: false },
				importe: { type: 'importe' },
				confirmada: { type: 'boolean', nullable: false, defaultValue: { value: false } },
				notas: { type: 'text' },
				creada_en: { type: 'datetime', nullable: false, defaultValue: { fn: 'now' } },
			} satisfies RecordDef<typeof typeDefs>,
			uks: { mesa: ['fecha', 'hora', 'mesa'] },
			fks: { cliente: { entity: 'cliente', fields: { cliente: 'id' } } },
			access: { admin: CAPABILITIES, recepcion: CAPABILITIES, cocina: ['read'] },
		}),

		linea: defineEntity({
			pk: ['fecha', 'id', 'plato'],
			fields: {
				fecha: { type: 'date' },
				id: { type: 'integer' },
				plato: { type: 'text' },
				cantidad: { type: 'cantidad', nullable: false },
			} satisfies RecordDef<typeof typeDefs>,
			fks: {
				reserva: { entity: 'ventas.reserva', fields: ['fecha', 'id'] },
				plato: { entity: 'menu.plato', fields: { plato: 'codigo' } },
			},
			table: 'reserva_linea',
			access: { admin: CAPABILITIES, recepcion: CAPABILITIES, cocina: ['read'] },
		}),
	}),

	...inSchema('historico', {
		reserva: defineEntity({
			pk: ['fecha', 'id'],
			fields: {
				fecha: { type: 'date' },
				id: { type: 'integer' },
				cliente: { type: 'nombre', nullable: false, isName: true },
				importe: { type: 'importe' },
			} satisfies RecordDef<typeof typeDefs>,
			fks: {},
			access: { admin: ['read', 'create'] },
		}),
	}),
});

export const tables = tablesFrom(entityDefs, types);
