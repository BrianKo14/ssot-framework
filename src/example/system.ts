// The example system of an SSOT: a small restaurant that takes reservations.
// `index.ts` serves it; `schema.ts` creates its database.
//
// It is a fixture, not the framework: nothing under `src/` outside this folder names any of
// it. It is meant to be the smallest system that still reaches every path the generators
// have, so each entity below says which one it is here for.

import { CAPABILITIES } from '../schema/access.js';
import { boxType, defineEntities, defineEntity, defineTypes, inSchema, type RecordDef, tablesFrom } from '../schema/build.js';
import { type BaseType, builtinTypeDefs, handlersFor } from '../types/registry.js';
import { textual } from '../types/handler.js';


// --- THE SYSTEM DEFINITION ---

// --> Types

/** The worked example of a type the framework does not ship: one shape, one bound, and no
 * framework file touched. The bound is read from the definition's own attrs, so the length
 * the recogniser enforces is the length the DDL is generated from. */
const emailBase: BaseType = attrs => ({
	sqlType: 'text',
	...textual('an e-mail address',
		/^[^\s@]+@[^\s@]+\.[^\s@]+$/,
		m => [...m[0]].length <= (attrs?.kind === 'bound' ? attrs.maxLength : Infinity) ? m[0] : undefined),
});

/** Four types over three of the shipped attribute kinds, plus one type of its own base.
 * Each becomes a Postgres domain named after the type, because none is stored under its
 * own name; the built-ins spread in above (`text`, `date`, `interval`, ...) are. */
const typeDefs = defineTypes({
	...builtinTypeDefs,
	nombre: { tsType: boxType<string>(), base: 'text', attrs: { kind: 'bound', maxLength: 100 } },
	email: { tsType: boxType<string>(), attrs: { kind: 'bound', maxLength: 254 } },
	importe: { tsType: boxType<string>(), base: 'decimal', attrs: { kind: 'decimal', precision: 12, scale: 2 } },
	cantidad: { tsType: boxType<number>(), base: 'integer', attrs: { kind: 'range', min: 1, max: 99 } },
});

const types = handlersFor(typeDefs, { email: emailBase });


// --> Structure
//
// Three roles, chosen so all three outcomes are visible at once: `recepcion` may register a
// `cliente` but not delete one, `cocina` may run the kitchen's own menu and never learns
// `cliente` exists — including through `ventas.reserva`'s fk to it, which `_meta` drops for
// a role that cannot read the far side.

const entityDefs = defineEntities({

	/** The default schema, a single-column pk, a unique key, and an fk to itself. */
	cliente: defineEntity({
		pk: ['id'],
		fields: {
			id: { type: 'integer' },
			nombre: { type: 'nombre', nullable: false, isName: true },
			email: { type: 'email' },
			alta: { type: 'date', nullable: false },
			recomendado_por: { type: 'integer' },
		} satisfies RecordDef<typeof typeDefs>,
		uks: { email: ['email'] },
		fks: { recomendado_por: { entity: 'cliente', fields: { recomendado_por: 'id' } } },
		access: { admin: CAPABILITIES, recepcion: ['read', 'create', 'update'] },
	}),

	...inSchema('menu', {
		/** A named schema, and the unique key another entity's fk points at instead of the pk. */
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
		/** A composite pk, a composite unique key, an fk across schemas, and every remaining
		 * built-in type: `time`, `interval`, `datetime` and `boolean`. No field is marked
		 * `isName`, so a row is labelled by its key — the other half of that rule. */
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
				confirmada: { type: 'boolean', nullable: false },
				notas: { type: 'text' },
				creada_en: { type: 'datetime', nullable: false },
			} satisfies RecordDef<typeof typeDefs>,
			uks: { mesa: ['fecha', 'hora', 'mesa'] },
			fks: { cliente: { entity: 'cliente', fields: { cliente: 'id' } } },
			access: { admin: CAPABILITIES, recepcion: CAPABILITIES, cocina: ['read'] },
		}),

		/** A detail: its fk to `reserva` is part of its own pk, which is what makes it one, so
		 * it is also reachable under its master's URL. That fk is written in the shorthand form
		 * (same names on both sides) and needs no index of its own, since it leads this pk.
		 * The second fk points at a unique key rather than a pk, so it is neither a detail nor
		 * addressable through. Stored under a name of its own, which the entity's identity
		 * does not have to follow. */
		linea: defineEntity({
			pk: ['fecha', 'id', 'linea'],
			fields: {
				fecha: { type: 'date' },
				id: { type: 'integer' },
				linea: { type: 'cantidad' },
				plato: { type: 'text', nullable: false },
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
		/** Closed reservations, kept by the name the client had at the time — so no fk at all,
		 * and an entity only one role sees. Its local name is `ventas.reserva`'s, which is
		 * exactly what the schema is for: two tables named `reserva`, told apart by where they
		 * live. Append-only, so its policy grants less than the whole set. */
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
