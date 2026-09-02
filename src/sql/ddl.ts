// The schema generator

import type { ColumnInfo, TableInfo } from '../schema/model.js';
import { checkedName, columnList, generatedName, q, storageType } from './identifier.js';


// --- Domains ---

/** Type names Postgres already holds in `pg_catalog`.
 * 
 * We guarantee that no domain is created with the same name as one of these.
 * `integer` and `bigint` are not in this list because they are aliases of `int4` and `int8`. */
const SHADOWED = new Set([
	'bool', 'bpchar', 'bytea', 'char', 'date', 'float4', 'float8', 'int2', 'int4', 'int8',
	'interval', 'json', 'jsonb', 'money', 'numeric', 'text', 'time', 'timestamp', 'timestamptz',
	'timetz', 'uuid', 'varchar', 'xml',
]);

/** Collects all the distinct types used in the schema and their storage types. */
function storages(tables: TableInfo[]): Map<string, string> {
	const byName = new Map<string, string>();

	for (const t of tables)
		for (const c of t.columns) {
			const seen = byName.get(c.typeName);

			// Refuse to store the same type in two different ways
			if (seen !== undefined && seen !== c.type.sqlType)
				throw new Error(`type "${c.typeName}" is stored as both ${seen} and ${c.type.sqlType}`);

			byName.set(c.typeName, storageType(c.type.sqlType));
		}

	return byName;
}

/** Determines if a type needs a domain of its own.
 * E.g. `nombre` stored as `varchar(100)` but not `text` as `text`. */
const needsDomain = (typeName: string, sqlType: string): boolean => typeName !== sqlType;

const domainStatements = (byName: Map<string, string>): string[] =>
	[...byName]
		.filter(([typeName, sqlType]) => needsDomain(typeName, sqlType))
		.map(([typeName, sqlType]) => {
			if (SHADOWED.has(typeName))
				throw new Error(`type "${typeName}" cannot be stored as ${sqlType}: `
					+ `Postgres already has a type of that name and would use it instead`);

			return `create domain ${q(typeName)} as ${sqlType}`;
		});


// --- Tables ---

const columnType = (c: ColumnInfo): string =>
	needsDomain(c.typeName, c.type.sqlType) ? q(c.typeName) : storageType(c.type.sqlType);

/** e.g. `"nombre" varchar(100) not null` */
const columnDefinition = (c: ColumnInfo): string =>
	`${q(checkedName(c.name, 'column'))} ${columnType(c)}${c.nullable ? '' : ' not null'}`;

/** Generates the SQL statement for creating a table. */
function tableStatement(t: TableInfo, taken: Set<string>): string {
	const parts = [
		...t.columns.map(columnDefinition),
		`constraint ${q(generatedName([t.table, 'pk'], taken))} primary key (${columnList(t.pk)})`,
		...Object.entries(t.uks).map(([uk, cols]) =>
			`constraint ${q(generatedName([t.table, uk, 'uk'], taken))} unique (${columnList(cols)})`),
	];

	return `create table ${q(t.table)} (\n  ${parts.join(',\n  ')}\n)`;
}


// --- References ---

/** Creates the SQL statement for adding a foreign key constraint to a table. */
const foreignKeyStatement = (t: TableInfo, taken: Set<string>): string[] =>
	t.references.map(ref =>
		`alter table ${q(t.table)} add constraint ${q(generatedName([t.table, ref.name, 'fk'], taken))}`
		+ ` foreign key (${columnList(ref.columns)})`
		+ ` references ${q(ref.to.table)} (${columnList(ref.targetColumns)})`);

/** Determines if a list of columns (in order) is the start of a key, in order. */
const leads = (cols: ColumnInfo[], key: ColumnInfo[]): boolean =>
	cols.length <= key.length && cols.every((c, i) => key[i] === c);

/** Creates a list of SQL statements for creating indexes on a table's foreign key columns. */
const indexStatement = (t: TableInfo, taken: Set<string>): string[] =>
	t.references
		// Skip indexes that are already covered by a primary key or unique constraint
		.filter(ref => ![t.pk, ...Object.values(t.uks)].some(key => leads(ref.columns, key)))
		.map(ref => `create index ${q(generatedName([t.table, ref.name, 'ix'], taken))}`
			+ ` on ${q(t.table)} (${columnList(ref.columns)})`);


// --- The schema ---

/** A set of all table names in the schema. */
function tableNames(tables: TableInfo[]): Set<string> {
	const taken = new Set<string>();

	for (const t of tables) {
		if (taken.has(t.table)) throw new Error(`two entities are both stored in table "${t.table}"`);

		taken.add(checkedName(t.table, 'table'));
	}

	return taken;
}

/** The SQL script that creates the schema for all the tables. */
export function schemaSql(tables: TableInfo[]): string {
	const taken = tableNames(tables);

	const statements = [
		...domainStatements(storages(tables)),
		...tables.map(t => tableStatement(t, taken)),
		...tables.flatMap(t => foreignKeyStatement(t, taken)),
		...tables.flatMap(t => indexStatement(t, taken)),
	];

	return `-- Generated from the system definition. Edit the definition, not this.\n\n`
		+ statements.join(';\n\n') + ';\n';
}
