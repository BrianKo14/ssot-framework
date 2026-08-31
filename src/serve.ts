// Boots the generic backend

import { buildApp } from './api/app.js';
import { dbAuthenticator } from './auth/store.js';
import { loadConfig } from './config.js';
import { connect } from './db/postgres.js';
import type { TableInfo } from './schema/model.js';

/** Reads the configuration, opens the database, serves the app built from `tables`.
 * @param tables as `tablesFrom` built it */
export async function serve(tables: TableInfo[]): Promise<void> {
	const config = loadConfig();
	const db = await connect(config.databaseUrl);
	const auth = dbAuthenticator(db, config.sessionTtl);

	const server = buildApp(db, tables, auth, config)
		.listen(config.port, () => console.log(`Listening on port ${config.port}`));

	// Catch Ctrl+C and process-manager stop signals => close server and DB pool cleanly.
	for (const sig of ['SIGINT', 'SIGTERM'] as const) {
		process.on(sig, () => server.close(() => void db.close()));
	}
}
