// Boots the generic backend. Everything it mounts is derived from the tables it is handed,
// so pointing the framework at another system means calling this with another set.

import { buildApp } from './api/app.js';
import { loadConfig } from './config.js';
import { connect } from './db/postgres.js';
import type { TableInfo } from './schema/model.js';

/** Reads the configuration, opens the database, serves the app built from `tables`.
 * @param tables the system as `tablesFrom` built it */
export async function serve(tables: TableInfo[]): Promise<void> {
	const config = loadConfig();
	const db = await connect(config.databaseUrl);

	const server = buildApp(db, tables)
		.listen(config.port, () => console.log(`Listening on port ${config.port}`));

	// Catch Ctrl+C and process-manager stop signals => close server and DB pool cleanly.
	for (const sig of ['SIGINT', 'SIGTERM'] as const) {
		process.on(sig, () => server.close(() => void db.close()));
	}
}
