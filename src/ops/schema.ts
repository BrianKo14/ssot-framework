// The CLI that generates the database schema. Not part of the API.

// See src/ops/README.md for usage instructions.

import { authTables } from '../auth/entities.js';
import { loadConfig } from '../config.js';
import type { TableInfo } from '../schema/model.js';
import { schemaSql } from '../sql/ddl.js';
import { run, waitForDb } from './cli.js';

const USAGE = 'usage: npm run db:create [-- --apply]';

/** If `--apply` is specified, the schema will be applied to the database.
 * If not, the schema will be printed to stdout. */
function wantsApply(argv: string[]): boolean {
	const unknown = argv.filter(arg => arg !== '--apply');

	if (unknown.length) throw new Error(`unknown option ${unknown[0]}\n${USAGE}`);

	return argv.includes('--apply');
}

async function generate(tables: TableInfo[]): Promise<void> {
	const sql = schemaSql([...authTables, ...tables]); 	// + the framework's own backend tables

	if (!wantsApply(process.argv.slice(2))) { console.log(sql); return; }

	const db = await waitForDb(loadConfig().databaseUrl);

	try {
		await db.query(sql);
		console.log('schema created');
	} finally {
		await db.close();
	}
}

/** Print the schema of a system, or apply it to the configured database.
 * @param tables the application's own tables, as `tablesFrom` built them */
export const schemaCli = (tables: TableInfo[]): void => run(() => generate(tables));
