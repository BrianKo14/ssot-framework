import { loadConfig } from './config.js';
import { connect } from './db.js';
import { buildApp } from './app.js';

const config = loadConfig();
const db = await connect(config.databaseUrl);

// This just tells the Node app what to expect in the database, so it can generate the correct SQL queries for each table.
const tables = [
	{ table: 'cliente', pk: 'id', columns: ['id', 'nombre', 'email'] },
];

const server = buildApp(db, tables)
	.listen(config.port, () => console.log(`Listening on port ${config.port}`));

// Catch Ctrl+C and process-manager stop signals => close server and DB pool cleanly.
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
	process.on(sig, () => server.close(() => void db.close()));
}