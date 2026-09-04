// The CLI that creates / updates the database schema. Not part of the API.

// See src/ops/README.md for usage instructions.

import { authTables } from '../auth/entities.js';
import { loadConfig } from '../config.js';
import type { Db } from '../db/postgres.js';
import type { TableInfo } from '../schema/model.js';
import { type CatalogRow, readCatalog } from '../sql/catalog.js';
import { schemaSql, type Target } from '../sql/ddl.js';
import { DEFAULT_SCHEMA, tableRef } from '../sql/identifier.js';
import { missing, updateSql } from '../sql/migrate.js';
import { run, waitForDb } from './cli.js';

const CREATE_USAGE = 'usage: npm run db:create [-- --apply]';
const UPDATE_USAGE = 'usage: npm run db:update [-- --apply]';

/** If `--apply` is specified, the SQL will be applied to the database.
 * If not, it will be printed to stdout. */
function wantsApply(argv: string[], usage: string): boolean {
	const unknown = argv.filter(arg => arg !== '--apply');

	if (unknown.length) throw new Error(`unknown option ${unknown[0]}\n${usage}`);

	return argv.includes('--apply');
}

/** Application's tables + authentication tables. */
const allTables = (tables: TableInfo[]): TableInfo[] => [...authTables, ...tables];


// --- Creating ---

async function create(tables: TableInfo[]): Promise<void> {
	const sql = schemaSql(allTables(tables));

	if (!wantsApply(process.argv.slice(2), CREATE_USAGE)) { console.log(sql); return; }

	const db = await waitForDb(loadConfig().databaseUrl);

	try {
		await db.query(sql);
		console.log('schema created');
	} finally {
		await db.close();
	}
}


// --- Updating (SCOPE 5a) ---

/** Prevents adding required columns to tables that already have data,
 * if those columns don't have default values. */
async function refuseUnfillable(db: Db, additions: Target[]): Promise<void> {
	for (const target of additions) {
		if (!target.onlyIfEmpty) continue;

		const rows = await db.query<Record<string, unknown>>(
			`select 1 from ${tableRef(target.onlyIfEmpty)} limit 1`);

		if (rows.length)
			throw new Error(`${target.key} admits no null and declares no default, so it cannot be `
				+ `added to a table that already holds rows — give the field a "defaultValue"`);
	}
}

async function update(tables: TableInfo[]): Promise<void> {
	const apply = wantsApply(process.argv.slice(2), UPDATE_USAGE);
	const all = allTables(tables);
	const db = await waitForDb(loadConfig().databaseUrl);

	try {
		const schemas = [...new Set([DEFAULT_SCHEMA, ...all.map(t => t.schema)])];

		const held = await readCatalog((text, params) => db.query<CatalogRow>(text, params), schemas);
		const additions = missing(all, held);

		if (!additions.length) {
			console.log('the database already holds everything the definition asks for');
			return;
		}

		await refuseUnfillable(db, additions);

		const sql = updateSql(additions);

		if (!apply) { console.log(sql); return; }

		await db.query(sql);
		console.log(`${additions.length} object(s) added`);
	} finally {
		await db.close();
	}
}


/** Print the schema of a system, or apply it to the configured database.
 * @param tables the application's own tables, as `tablesFrom` built them */
export const schemaCli = (tables: TableInfo[]): void => run(() => create(tables));

/** Print what the configured database is missing of a system, or add it.
 * @param tables the application's own tables, as `tablesFrom` built them */
export const updateCli = (tables: TableInfo[]): void => run(() => update(tables));
