// The CLI that creates / updates the database schema. Not part of the API.

// See src/ops/README.md for usage instructions.

import { authTables } from '../auth/entities.js';
import { loadConfig } from '../config.js';
import type { Db } from '../db/postgres.js';
import type { TableInfo } from '../schema/model.js';
import { type CatalogRow, readCatalog } from '../sql/catalog.js';
import { type Held, schemaSql, type Target } from '../sql/ddl.js';
import { DEFAULT_SCHEMA, qualified, tableRef } from '../sql/identifier.js';
import { changes, type Changes, updateSql } from '../sql/migrate.js';
import { run, waitForDb } from './cli.js';


// --- Options ---

/** Command options:
 *
 * * `--apply` runs the SQL instead of printing it.
 * * `--drop` allows removing objects from the database. */
const OPTION_NAMES = ['apply', 'drop'] as const;
type Options = Record<typeof OPTION_NAMES[number], boolean>;

// Documentation
const CREATE_USAGE = 'usage: npm run db:create [-- --apply]';
const UPDATE_USAGE = 'usage: npm run db:update [-- --drop] [-- --apply]';

/** Reads the options off the command line, refusing anything it does not know. */
function options(argv: string[], usage: string, allowed: (keyof Options)[]): Options {
	const flags = allowed.map(name => `--${name}`);
	const unknown = argv.filter(arg => !flags.includes(arg));

	if (unknown.length) throw new Error(`unknown option ${unknown[0]}\n${usage}`);

	// True iff an option is present
	return Object.fromEntries(OPTION_NAMES.map(name => [name, argv.includes(`--${name}`)])) as Options;
}

/** Application's tables + authentication tables. */
const allTables = (tables: TableInfo[]): TableInfo[] => [...authTables, ...tables];


// --- Creating ---

async function create(tables: TableInfo[]): Promise<void> {
	const sql = schemaSql(allTables(tables));

	if (!options(process.argv.slice(2), CREATE_USAGE, ['apply']).apply) { console.log(sql); return; }

	const db = await waitForDb(loadConfig().databaseUrl);

	try {
		await db.query(sql);
		console.log('schema created');
	} finally {
		await db.close();
	}
}


// --- Updating ---

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

/** Refuse to drop objects that are not explicitly allowed. */
function refuseUndroppable(removals: Held[], opts: Options): void {
	if (!removals.length || opts.drop) return;

	throw new Error(`the database holds ${removals.length} object(s) the definition does not ask `
		+ `for, or asks for differently:\n`
		+ removals.map(h => `  ${h.key}`).join('\n')
		+ `\nremoving or rebuilding one means dropping it, so pass --drop to write that`);
}

/** Returns a map of the notes for each removal, by `Held.key`. */
async function rowNotes(db: Db, removals: Held[]): Promise<Map<string, string>> {
	const notes = new Map<string, string>();
	const counted = new Map<string, number>();

	for (const h of removals) {
		const holder = h.kind === 'table' ? h.name : h.kind === 'column' ? h.in : null;

		if (holder === null) continue;

		const table = qualified(h.schema, holder);

		if (!counted.has(table)) {
			const [row] = await db.query<{ n: string }>(`select count(*) as n from ${table}`);

			counted.set(table, Number(row?.n ?? 0));
		}

		const rows = counted.get(table)!;

		if (rows) notes.set(h.key, `${h.key} — ${table} holds ${rows} row(s)`);
	}

	return notes;
}

/** Report the changes that were made. */
function report(c: Changes): void {
	const done = [c.removals.length && `${c.removals.length} object(s) removed or rebuilt`,
		c.additions.length && `${c.additions.length} object(s) added`].filter(Boolean);

	console.log(done.length ? done.join(', ') : 'nothing to do');
}

async function update(tables: TableInfo[]): Promise<void> {
	const opts = options(process.argv.slice(2), UPDATE_USAGE, ['apply', 'drop']);
	const all = allTables(tables);
	const db = await waitForDb(loadConfig().databaseUrl);

	try {
		const schemas = [...new Set([DEFAULT_SCHEMA, ...all.map(t => t.schema)])];

		const held = await readCatalog((text, params) => db.query<CatalogRow>(text, params), schemas);
		const found = changes(all, held);

		if (!found.removals.length && !found.additions.length) {
			console.log('the database already holds everything the definition asks for');
			return;
		}

		refuseUndroppable(found.removals, opts);
		await refuseUnfillable(db, found.additions);

		const sql = updateSql(found, await rowNotes(db, found.removals));

		if (!opts.apply) { console.log(sql); return; }

		await db.query(sql);
		report(found);
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
