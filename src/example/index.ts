import { defineEntities, defineEntity, type RecordDef, tablesFrom, typeCollectionOf } from '../schema/build.js';
import { serve } from '../serve.js';
import { commonTypes, text } from '../types/builtin.js';

const types = { ...commonTypes, nombre: text(100) };
const typeDefs = typeCollectionOf(types);

// The system definition: every concept is named once here
const entityDefs = defineEntities({
	cliente: defineEntity({
		pk: ['id'],
		fields: {
			id: { type: 'integer' },
			nombre: { type: 'text', nullable: false, isName: true },
			email: { type: 'text' },
		} satisfies RecordDef<typeof typeDefs>,
		fks: {}, // TODO: if left out, `defineEntity` widens its fk parameter to the constraint
	}),

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

	item: defineEntity({
		pk: ['fecha', 'id', 'item'],
		fields: {
			fecha: { type: 'date' },
			id: { type: 'integer' },
			item: { type: 'integer' },
			descripcion: { type: 'nombre', nullable: false, isName: true },
			cantidad: { type: 'integer' },
		} satisfies RecordDef<typeof typeDefs>,
		fks: { reserva: { entity: 'reserva', fields: ['fecha', 'id'] } },
	}),
});

await serve(tablesFrom(entityDefs, types));
