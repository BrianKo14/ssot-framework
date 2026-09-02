// The schema generator

import type { ColumnInfo, TableInfo } from '../schema/model.js';
import {
	checkedName, checkedSchema, columnList, DEFAULT_SCHEMA, generatedName, q, qualified, storageType, tableRef,
} from './identifier.js';


// --- Schemas ---

/** `create schema` for every schema except the default one, which Postgres already provides. */
const schemaStatements = (schemas: string[]): string[] =>
	schemas.filter(schema => schema !== DEFAULT_SCHEMA).map(schema => `create schema ${q(schema)}`);


// --- Domains (custom types) ---

/** A domain's qualified name. */
const domainRef = (typeName: string): string => qualified(DEFAULT_SCHEMA, typeName);

/** Type names Postgres already holds in `pg_catalog`.
 * We guarantee that no domain is created with the same name as one of these.
 * 
 * This is a readability guard. We forbid this becausee.g. a if a domain `text` existed,
 * a person writing a query by hand and typing `text` would get the built-in type, no the domain.
 * Even though every type reference is fully qualified `"public"."text"`. */
const SHADOWED = new Set([
	'bigint', 'bool', 'boolean', 'bpchar', 'bytea', 'char', 'date', 'decimal',
	'double precision', 'float4', 'float8', 'int', 'int2', 'int4', 'int8', 'integer',
	'interval', 'json', 'jsonb', 'money', 'numeric', 'real', 'smallint', 'text', 'time',
	'timestamp', 'timestamptz', 'timetz', 'uuid', 'varchar', 'xml',
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

			return `create domain ${domainRef(typeName)} as ${sqlType}`;
		});


// --- Tables ---

const columnType = (c: ColumnInfo): string =>
	needsDomain(c.typeName, c.type.sqlType) ? domainRef(c.typeName) : storageType(c.type.sqlType);

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

	return `create table ${tableRef(t)} (\n  ${parts.join(',\n  ')}\n)`;
}


// --- References ---

/** Creates the SQL statement for adding a foreign key constraint to a table. */
const foreignKeyStatement = (t: TableInfo, taken: Set<string>): string[] =>
	t.references.map(ref =>
		`alter table ${tableRef(t)} add constraint ${q(generatedName([t.table, ref.name, 'fk'], taken))}`
		+ ` foreign key (${columnList(ref.columns)})`
		// the target's own schema, so a fk across schemas needs no special case
		+ ` references ${tableRef(ref.to)} (${columnList(ref.targetColumns)})`);

/** Determines if a list of columns (in order) is the start of a key, in order. */
const leads = (cols: ColumnInfo[], key: ColumnInfo[]): boolean =>
	cols.length <= key.length && cols.every((c, i) => key[i] === c);

/** Creates a list of SQL statements for creating indexes on a table's foreign key columns. */
const indexStatement = (t: TableInfo, taken: Set<string>): string[] =>
	t.references
		// Skip indexes that are already covered by a primary key or unique constraint
		.filter(ref => ![t.pk, ...Object.values(t.uks)].some(key => leads(ref.columns, key)))
		.map(ref => `create index ${q(generatedName([t.table, ref.name, 'ix'], taken))}`
			+ ` on ${tableRef(t)} (${columnList(ref.columns)})`);


// --- The schema ---

function takenBySchema(tables: TableInfo[]): Map<string, Set<string>> {
	const bySchema = new Map<string, Set<string>>();

	for (const t of tables) {
		let taken = bySchema.get(t.schema);

		if (!taken) bySchema.set(checkedSchema(t.schema), taken = new Set<string>());

		if (taken.has(t.table))
			throw new Error(`two entities are both stored in table "${t.schema}"."${t.table}"`);

		taken.add(checkedName(t.table, 'table'));
	}

	return bySchema;
}

/** The SQL script that creates the schema for all the tables. */
export function schemaSql(tables: TableInfo[]): string {
	const taken = takenBySchema(tables);

	/** The names already used in the schema this table lives in. */
	const namesIn = (t: TableInfo): Set<string> => taken.get(t.schema)!;

	const statements = [
		...schemaStatements([...taken.keys()]),
		...domainStatements(storages(tables)),
		...tables.map(t => tableStatement(t, namesIn(t))),
		...tables.flatMap(t => foreignKeyStatement(t, namesIn(t))),
		...tables.flatMap(t => indexStatement(t, namesIn(t))),
	];

	return `-- Generated from the system definition. Edit the definition, not this.\n\n`
		+ statements.join(';\n\n') + ';\n';
}
