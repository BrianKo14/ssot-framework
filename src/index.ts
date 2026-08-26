import { defineEntity, type RecordDef } from 'system-definition';
import { loadConfig } from './config.js';
import { connect } from './db.js';
import { buildApp } from './app.js';
import { tablesFrom, typeCollectionOf } from './schema.js';
import { commonTypes, text } from './types.js';

const config = loadConfig();
const db = await connect(config.databaseUrl);

const types = { ...commonTypes, nombre: text(100) };
const typeDefs = typeCollectionOf(types);

// The system definition: every concept is named once here
const entityDefs = {
	cliente: defineEntity({
		pk: ['id'],
		fields: {
			id: { type: 'integer' },
			nombre: { type: 'text', nullable: false, isName: true },
			email: { type: 'text' },
		} satisfies RecordDef<typeof typeDefs>,
	}),

	reserva: defineEntity({
		pk: ['fecha', 'id'],
		fields: {
			fecha: { type: 'date' },
			id: { type: 'integer' },
			nombre: { type: 'nombre', nullable: false, isName: true },
			notas: { type: 'text' },
			hora: { type: 'time' },
			creado_en: { type: 'datetime' },
			duracion: { type: 'interval' },
			importe: { type: 'decimal' },
			confirmada: { type: 'boolean' },
		} satisfies RecordDef<typeof typeDefs>,
	}),
};

const server = buildApp(db, tablesFrom(entityDefs, types))
	.listen(config.port, () => console.log(`Listening on port ${config.port}`));

// Catch Ctrl+C and process-manager stop signals => close server and DB pool cleanly.
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
	process.on(sig, () => server.close(() => void db.close()));
}