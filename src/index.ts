import { defineEntity } from 'system-definition';
import { loadConfig } from './config.js';
import { connect } from './db.js';
import { buildApp } from './app.js';
import { tablesFrom } from './schema.js';

const config = loadConfig();
const db = await connect(config.databaseUrl);

// The system definition: every concept is named once here, and the backend derives its behaviour from it.
// This is the schema author's file, so it speaks the library's vocabulary directly; the framework itself
// only reaches system-definition through schema.ts.
const entityDefs = {
	cliente: defineEntity({
		pk: ['id'],
		fields: {
			id: { type: 'integer' },
			nombre: { type: 'text', nullable: false, isName: true },
			email: { type: 'text' },
		},
	}),
};

const server = buildApp(db, tablesFrom(entityDefs))
	.listen(config.port, () => console.log(`Listening on port ${config.port}`));

// Catch Ctrl+C and process-manager stop signals => close server and DB pool cleanly.
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
	process.on(sig, () => server.close(() => void db.close()));
}