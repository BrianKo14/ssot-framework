// The example system of an SSOT

import { CAPABILITIES } from '../schema/access.js';
import { boxType, defineEntities, defineEntity, defineRecord, describeTypes, inSchema, tablesFrom, withRecords } from '../schema/build.js';
import { type BaseType, builtinTypeDefs } from '../types/registry.js';
import { textual } from '../types/handler.js';


// --- THE SYSTEM DEFINITION ---

// --> Types

const emailBase: BaseType = attrs => ({
	sqlType: 'text',

	convert: from => `nullif(lower(trim(${from})), '')`,

	...textual('an e-mail address',
		/^[^\s@]+@[^\s@]+\.[^\s@]+$/,
		m => [...m[0]].length <= (attrs?.kind === 'bound' ? attrs.maxLength : Infinity) ? m[0] : undefined),
});

const restaurante = describeTypes({
	...builtinTypeDefs,
	nombre: { tsType: boxType<string>(), base: 'text', attrs: { kind: 'bound', maxLength: 100 } },
	email: { tsType: boxType<string>(), attrs: { kind: 'bound', maxLength: 254 } },
	importe: { tsType: boxType<string>(), base: 'decimal', attrs: { kind: 'decimal', precision: 12, scale: 2 } },
	cantidad: { tsType: boxType<number>(), base: 'integer', attrs: { kind: 'range', min: 1, max: 99 } },
}, { email: emailBase });


// --> Context

const cliente = defineRecord(restaurante, {
	id: { type: 'integer' },
	nombre: { type: 'nombre', nullable: false, isName: true },
	email: { type: 'email' },
	alta: { type: 'date', nullable: false, defaultValue: { fn: 'today' } },
	recomendado_por: { type: 'integer' },
});

const plato = defineRecord(restaurante, {
	id: { type: 'integer' },
	codigo: { type: 'text', nullable: false },
	nombre: { type: 'nombre', nullable: false, isName: true },
	precio: { type: 'importe', nullable: false },
	vegetariano: { type: 'boolean', nullable: false },
});

const reserva = defineRecord(restaurante, {
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
});

const linea = defineRecord(restaurante, {
	fecha: { type: 'date' },
	id: { type: 'integer' },
	plato: { type: 'text' },
	cantidad: { type: 'cantidad', nullable: false },
});

const pago = defineRecord(restaurante, {
	fecha: { type: 'date' },
	id: { type: 'integer' },
	nro: { type: 'cantidad' },
	medio: { type: 'nombre', nullable: false, isName: true },
	importe: { type: 'importe', nullable: false },
	cobrado_en: { type: 'datetime', nullable: false, defaultValue: { fn: 'now' } },
});

const reserva_historica = defineRecord(restaurante, {
	fecha: { type: 'date' },
	id: { type: 'integer' },
	cliente: { type: 'nombre', nullable: false, isName: true },
	importe: { type: 'importe' },
});

const restauranteConRecords = withRecords(restaurante, { cliente, plato, reserva, linea, pago, reserva_historica });


// --> Structure

const entityDefs = defineEntities({

	cliente: defineEntity(restauranteConRecords, {
		name: 'cliente',
		record: 'cliente',
		pk: ['id'],
		uks: { email: ['email'] },
		fks: { recomendado_por: { entity: 'cliente', fields: { recomendado_por: 'id' } } },
		access: { admin: CAPABILITIES, recepcion: ['read', 'create', 'update', 'lock'] },
	}),

	...inSchema('menu', {
		plato: defineEntity(restauranteConRecords, {
			name: 'plato',
			record: 'plato',
			pk: ['id'],
			uks: { codigo: ['codigo'] },
			fks: {},
			access: { admin: CAPABILITIES, recepcion: ['read'], cocina: CAPABILITIES },
		}),
	}),

	...inSchema('ventas', {
		reserva: defineEntity(restauranteConRecords, {
			name: 'reserva',
			record: 'reserva',
			pk: ['fecha', 'id'],
			uks: { mesa: ['fecha', 'hora', 'mesa'] },
			fks: { cliente: { entity: 'cliente', fields: { cliente: 'id' } } },
			access: { admin: CAPABILITIES, recepcion: CAPABILITIES, cocina: ['read'] },
		}),

		linea: defineEntity(restauranteConRecords, {
			name: 'linea',
			record: 'linea',
			pk: ['fecha', 'id', 'plato'],
			fks: {
				reserva: { entity: 'ventas.reserva', fields: ['fecha', 'id'] },
				plato: { entity: 'menu.plato', fields: { plato: 'codigo' } },
			},
			table: 'reserva_linea',
			access: { admin: CAPABILITIES, recepcion: CAPABILITIES, cocina: ['read'] },
		}),

		pago: defineEntity(restauranteConRecords, {
			name: 'pago',
			record: 'pago',
			pk: ['fecha', 'id', 'nro'],
			fks: { reserva: { entity: 'ventas.reserva', fields: ['fecha', 'id'] } },
			access: { admin: CAPABILITIES, recepcion: CAPABILITIES },
		}),
	}),

	...inSchema('historico', {
		reserva: defineEntity(restauranteConRecords, {
			name: 'reserva',
			record: 'reserva_historica',
			pk: ['fecha', 'id'],
			fks: {},
			access: { admin: ['read', 'create'] },
		}),
	}),
});

export const tables = tablesFrom(entityDefs, restaurante.handlers);

/** Which roles are allowed to monitor. */
export const monitor = ['admin'];
