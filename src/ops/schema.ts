// The CLI that creates / updates the database schema. Not part of the API.

// See src/ops/README.md for usage instructions.

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { authTables } from '../auth/entities.js';
import { loadConfig } from '../config.js';
import type { Db } from '../db/postgres.js';
import type { RoutineInfo, TableInfo } from '../schema/model.js';
import { type CatalogRow, readCatalog } from '../sql/catalog.js';
import {
	type Alteration, alterationKey, columnBody, comparedType, type Held, schemaSql, type Target,
} from '../sql/ddl.js';
import { DEFAULT_SCHEMA, qualified, tableRef } from '../sql/identifier.js';
import { altered, changes, type Changes, updateSql } from '../sql/migrate.js';
import { seedSql } from '../sql/seed.js';
import { run, waitForDb } from './cli.js';


// --- Options ---

/** Command options:
 *
 * * `--apply` runs the SQL instead of printing it.
 * * `--drop` allows removing objects from the database.
 * * `--retype` allows changing the type of columns that already hold data. */
const OPTION_NAMES = ['apply', 'drop', 'retype'] as const;
type Options = Record<typeof OPTION_NAMES[number], boolean>;

// Documentation
const CREATE_USAGE = 'usage: npm run db:create [-- --apply]';
const UPDATE_USAGE = 'usage: npm run db:update [-- --drop] [-- --retype] [-- --apply]';
const SEED_USAGE = 'usage: npm run db:seed [-- --apply]';

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

/** Prints a script, or with `--apply` runs it on the configured database.
 * Atomic transaction.
 * 
 * @param done what to say once it ran */
async function printOrApply(sql: string, argv: string[], usage: string, done: string): Promise<void> {
	if (!options(argv, usage, ['apply']).apply) { console.log(sql); return; }

	const db = await waitForDb(loadConfig().databaseUrl);

	try {
		await db.query(sql);
		console.log(done);
	} finally {
		await db.close();
	}
}

const create = (tables: TableInfo[], routines: RoutineInfo[], argv: string[]): Promise<void> =>
	printOrApply(schemaSql(allTables(tables), routines), argv, CREATE_USAGE, 'schema created');


// --- Seeding ---

/** Loads every `<entity>.tab` file in `dir` into the table of that entity. */
async function seed(tables: TableInfo[], dir: string, argv: string[]): Promise<void> {
	const files = (await readdir(dir)).filter(name => name.endsWith('.tab')).sort();

	const sources = await Promise.all(files.map(async name =>
		({ entity: name.slice(0, -'.tab'.length), text: await readFile(path.join(dir, name), 'utf8') })));

	const sql = seedSql(tables, sources, `sample data from ${dir}`);

	await printOrApply(sql, argv, SEED_USAGE, `${sources.length} files loaded from ${dir}`);
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

/** The string representation of the column's body as declared in the definition. */
const declaredBody = (a: Alteration): string =>
	columnBody(comparedType(a.column), !a.column.nullable);

/** Prevents the modification of column bodies if the column already holds data and the change is not explicitly allowed. */
function refuseUnretypable(c: Changes, opts: Options): void {
	const columns = altered(c);

	if (!columns.length || opts.retype) return;

	const bodies = new Map([...c.detachments, ...c.alterations]
		.map(a => [alterationKey(a), declaredBody(a)]));

	throw new Error(`the database holds ${columns.length} column(s) with a body other than the `
		+ `one the definition declares:\n`
		+ columns.map(key => `  ${key} — declared ${bodies.get(key)}`).join('\n')
		+ `\nchanging one means converting the data it holds, so pass --retype to write that`);
}

interface Touched { key: string; table: string }

/** An object is touched if it is going to be modified, deleted, or created by a statement.*/
const touched = (c: Changes): Touched[] => [
	...c.removals.flatMap(h => {
		const holder = h.kind === 'table' ? h.name : h.kind === 'column' ? h.in : null;

		return holder === null ? [] : [{ key: h.key, table: qualified(h.schema, holder) }];
	}),
	...[...c.detachments, ...c.alterations]
		.map(a => ({ key: alterationKey(a), table: tableRef(a.table) })),
];

/** Returns a map of the notes for each statement, by `Held.key` / `alterationKey`. */
async function rowNotes(db: Db, c: Changes): Promise<Map<string, string>> {
	const notes = new Map<string, string>();
	const counted = new Map<string, number>();

	for (const { key, table } of touched(c)) {
		if (!counted.has(table)) {
			const [row] = await db.query<{ n: string }>(`select count(*) as n from ${table}`);

			counted.set(table, Number(row?.n ?? 0));
		}

		const rows = counted.get(table)!;

		if (rows) notes.set(key, `${key} — ${table} holds ${rows} row(s)`);
	}

	return notes;
}

/** Report the changes that were made. */
function report(c: Changes): void {
	const done = [c.removals.length && `${c.removals.length} object(s) removed or rebuilt`,
		c.additions.length && `${c.additions.length} object(s) added`,
		c.replacements.length && `${c.replacements.length} routine(s) or trigger(s) replaced`,
		altered(c).length && `${altered(c).length} column(s) altered`].filter(Boolean);

	console.log(done.length ? done.join(', ') : 'nothing to do');
}

async function update(tables: TableInfo[], routines: RoutineInfo[], argv: string[]): Promise<void> {
	const opts = options(argv, UPDATE_USAGE, ['apply', 'drop', 'retype']);
	const all = allTables(tables);
	const db = await waitForDb(loadConfig().databaseUrl);

	try {
		const schemas = [...new Set([DEFAULT_SCHEMA, ...all.map(t => t.schema), ...routines.map(r => r.schema)])];

		const held = await readCatalog((text, params) => db.query<CatalogRow>(text, params), schemas);
		const found = changes(all, held, routines);

		if (!found.removals.length && !found.additions.length && !found.replacements.length
			&& !altered(found).length) {
			console.log('the database already holds everything the definition asks for');
			return;
		}

		refuseUndroppable(found.removals, opts);
		refuseUnretypable(found, opts);
		await refuseUnfillable(db, found.additions);

		const sql = updateSql(found, await rowNotes(db, found));

		if (!opts.apply) { console.log(sql); return; }

		await db.query(sql);
		report(found);
	} finally {
		await db.close();
	}
}


/** Print the schema of a system, or apply it to the configured database.
 * 
 * @param tables the application's own tables, as `tablesFrom` built them
 * @param routines the application's routines, as `routinesFrom` built them
 * @param argv the command's options */
export const schemaCli = (tables: TableInfo[], routines: RoutineInfo[], argv = process.argv.slice(2)): void =>
	run(() => create(tables, routines, argv));

/** Print what the configured database is missing of a system, or add it.
 * 
 * @param tables the application's own tables, as `tablesFrom` built them
 * @param routines the application's routines, as `routinesFrom` built them
 * @param argv the command's options */
export const updateCli = (tables: TableInfo[], routines: RoutineInfo[], argv = process.argv.slice(2)): void =>
	run(() => update(tables, routines, argv));

/** Print the inserts of a system's sample data, or load it into the configured database.
 * 
 * @param tables the application's own tables, as `tablesFrom` built them
 * @param dir a folder of `<entity>.tab` files, one per entity it fills
 * @param argv the command's options */
export const seedCli = (tables: TableInfo[], dir: string, argv = process.argv.slice(2)): void =>
	run(() => seed(tables, dir, argv));
