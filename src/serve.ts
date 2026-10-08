// Boots the generic backend

import { buildApp } from './api/app.js';
import { monitorAccess } from './api/monitor.js';
import { dbAuthenticator } from './auth/store.js';
import { loadConfig } from './config.js';
import { connect } from './db/postgres.js';
import type { TableInfo } from './schema/model.js';

/** Permissions granted on the framework's own screens. */
export interface Grants {
	/** The roles that may see who is signed in, what they last did and which tabs they have open. */
	monitor?: readonly string[];
}

/** Reads the configuration, opens the database, serves the app built from `tables`.
 * @param tables as `tablesFrom` built it */
export async function serve(tables: TableInfo[], grants: Grants = {}): Promise<void> {
	const monitor = monitorAccess(grants.monitor ?? []);		// checked before anything is opened
	const config = loadConfig();
	const db = await connect(config.databaseUrl);
	const auth = dbAuthenticator(db, config.sessionTtl);

	const server = buildApp(db, tables, auth, config, monitor)
		.listen(config.port, () => console.log(`Listening on port ${config.port}`));

	// Catch Ctrl+C and process-manager stop signals => close server and DB pool cleanly.
	for (const sig of ['SIGINT', 'SIGTERM'] as const) {
		process.on(sig, () => server.close(() => void db.close()));
	}
}
