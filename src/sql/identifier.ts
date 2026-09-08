// Utilities for handling SQL identifiers and types.

import { createHash } from 'node:crypto';
import type { ColumnInfo, TableInfo } from '../schema/model.js';

/** Quote an identifier for use in a query; treat them as names, not commands. */
export const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;

export const DEFAULT_SCHEMA = 'public';

/** A qualified name for a database object: schema + name, both quoted. */
export const qualified = (schema: string, name: string) => `${q(schema)}.${q(name)}`;
export const tableRef = (t: TableInfo) => qualified(t.schema, t.table);

/** List of names -> comma-separated string of quoted identifiers for SQL. */
export const nameList = (names: string[]) => names.map(q).join(', ');

/** List of columns -> comma-separated string for SQL.
 * @param at column context, for use in joins. E.g. `c => `"orders"."${c.name}"` */
export const columnList = (cols: ColumnInfo[], at: (c: ColumnInfo) => string = c => q(c.name)) =>
	cols.map(at).join(', ');


// --- Types ---

/** A SQL type: a name + modfier, e.g. `varchar` + `(100)`. */
const TYPE_SHAPE = /^([a-z][a-z0-9 ]*?)(\(\d{1,4}(,\d{1,4})?\))?$/i;

/** Throws an error if the SQL type is not valid. */
export function storageType(sqlType: string): string {
	if (!TYPE_SHAPE.test(sqlType))
		throw new Error(`"${sqlType}" does not read as a SQL type`);

	return sqlType;
}

/** Postgres type names. What we write -> what Postgres answers.
 * With `%` where the modifier goes.
*/
const CANONICAL: ReadonlyMap<string, string> = new Map([
	['bool', 'boolean'],
	['bpchar', 'character%'],
	['char', 'character%'],
	['decimal', 'numeric%'],
	['float4', 'real'],
	['float8', 'double precision'],
	['int', 'integer'],
	['int2', 'smallint'],
	['int4', 'integer'],
	['int8', 'bigint'],
	['time', 'time% without time zone'],
	['timestamp', 'timestamp% without time zone'],
	['timestamptz', 'timestamp% with time zone'],
	['timetz', 'time% with time zone'],
	['varchar', 'character varying%'],
]);

/** A SQL type as the catalogue spells it, e.g. `varchar(100)` -> `character varying(100)`. */
export function canonicalType(sqlType: string): string {
	const parts = TYPE_SHAPE.exec(storageType(sqlType));

	if (!parts) throw new Error(`"${sqlType}" does not read as a SQL type`);

	const [, name, modifier = ''] = parts;

	return (CANONICAL.get(name.toLowerCase()) ?? `${name}%`).replace('%', modifier);
}



// --> Cutting names the framework generates (constaints, indexes)

// A long entity name plus a long fk name can exceed what Postgres can store.
// We cut the name and append a hash of the whole (avoids collision).

/** Postgres truncates an identifier to `NAMEDATALEN - 1` = 63 *bytes*. */
const MAX_NAME_BYTES = 63;

/** How many characters to use for the hash. */
const HASH_CHARS = 8;

/** Cuts a string to fit within a byte limit. */
function cut(s: string, maxBytes: number): string {
	let kept = '';

	for (const ch of s) {
		if (Buffer.byteLength(kept + ch) > maxBytes) break;
		kept += ch;
	}

	return kept;
}

/** Generates a unique name for a generated object.
 * Truncating and hashing to stay within the Postgres identifier length limit.
 * 
 * @param parts the name in pieces, e.g. `['reserva', 'cliente', 'fk']`
 * @param taken names already used in this schema; the result is added to it */
export function generatedName(parts: string[], taken: Set<string>): string {
	const full = parts.join('_');

	const name = Buffer.byteLength(full) <= MAX_NAME_BYTES
		? full
		: cut(full, MAX_NAME_BYTES - HASH_CHARS - 1) + '_'
			+ createHash('sha256').update(full).digest('hex').slice(0, HASH_CHARS);

	if (taken.has(name)) throw new Error(`two generated objects would both be named "${name}"`);

	taken.add(name);

	return name;
}


// --> Checking names and types that come from the schema author[]

/** Checks that a name is within the Postgres identifier length limit.
 * @param what what the name is for, e.g. "table" or "column" */
export function checkedName(name: string, what: string): string {
	if (Buffer.byteLength(name) > MAX_NAME_BYTES)
		throw new Error(`${what} "${name}" is longer than the ${MAX_NAME_BYTES} bytes Postgres keeps`);

	return name;
}

/** Postgres reserves this prefix for its own schemas and refuses a `create schema` using it. */
const RESERVED_SCHEMA_PREFIX = 'pg_';

/** Checks a schema name the same way, plus the prefix Postgres keeps for itself. */
export function checkedSchema(name: string): string {
	if (name.startsWith(RESERVED_SCHEMA_PREFIX))
		throw new Error(`schema "${name}" starts with "${RESERVED_SCHEMA_PREFIX}", which Postgres reserves`);

	return checkedName(name, 'schema');
}