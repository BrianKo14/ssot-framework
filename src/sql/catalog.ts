// Access to what the database already holds, read from Postgres
// Used by updates to check what's already there

import { objectKey, type ObjectKind } from './ddl.js';

/** Result of a catalogue query. 
 * The object's name, its schema, and the table that contains it. */
export type CatalogRow = { schema: string; name: string; in: string };

/** Every object the database holds, named like `objectKey`. */
export type Catalog = ReadonlySet<string>;

/** A query, paired with the name parts of the objects it finds.
 * Its kind is the key it is held under, so no entry can name a kind other than its own. */
interface CatalogQuery {
	text: string;
	parts(row: CatalogRow): string[];
}

/** Restrict queries to the schemas the definition names.
 * I.e. schema binds to parameter to avoid injections. */
const IN_SCHEMAS = `n.nspname = any($1::text[])`;

/** One query per kind of object the framework creates, keyed by `ObjectKind`. */
const CATALOG_QUERIES: Readonly<Record<ObjectKind, CatalogQuery>> = {
	schema: {
		text: `select n.nspname as name from pg_namespace n where ${IN_SCHEMAS}`,
		parts: row => [row.name],
	},
	domain: {
		text: `select n.nspname as schema, t.typname as name
			from pg_type t join pg_namespace n on n.oid = t.typnamespace
			where t.typtype = 'd' and ${IN_SCHEMAS}`,
		parts: row => [row.schema, row.name],
	},
	table: {
		text: `select n.nspname as schema, c.relname as name
			from pg_class c join pg_namespace n on n.oid = c.relnamespace
			where c.relkind = 'r' and ${IN_SCHEMAS}`,
		parts: row => [row.schema, row.name],
	},
	column: {
		text: `select n.nspname as schema, c.relname as "in", a.attname as name
			from pg_attribute a
			join pg_class c on c.oid = a.attrelid
			join pg_namespace n on n.oid = c.relnamespace
			where c.relkind = 'r' and a.attnum > 0 and not a.attisdropped and ${IN_SCHEMAS}`, // filter the merely dropped
		parts: row => [row.schema, row.in, row.name],
	},
	constraint: {
		text: `select n.nspname as schema, c.relname as "in", k.conname as name
			from pg_constraint k
			join pg_class c on c.oid = k.conrelid
			join pg_namespace n on n.oid = c.relnamespace
			where k.contype in ('p', 'u', 'f') and ${IN_SCHEMAS}`,
		parts: row => [row.schema, row.in, row.name],
	},
	index: {
		text: `select n.nspname as schema, c.relname as name
			from pg_class c join pg_namespace n on n.oid = c.relnamespace
			where c.relkind = 'i' and ${IN_SCHEMAS}`,
		parts: row => [row.schema, row.name],
	},
};

/** Reads what the database holds in the given schemas.
 *
 * @param query function that runs one statement (`Db.query`)
 * @param schemas the names of the schemas to look in */
export async function readCatalog(
	query: (text: string, params: unknown[]) => Promise<CatalogRow[]>,
	schemas: string[],
): Promise<Catalog> {
	const held = new Set<string>();

	for (const [kind, catalogue] of Object.entries(CATALOG_QUERIES) as [ObjectKind, CatalogQuery][])
		for (const row of await query(catalogue.text, [schemas]))
			held.add(objectKey(kind, ...catalogue.parts(row)));

	return held;
}
