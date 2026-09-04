// The schema generator

import type { ColumnInfo, TableInfo } from '../schema/model.js';
import {
	checkedName, checkedSchema, columnList, DEFAULT_SCHEMA, generatedName, q, qualified, storageType, tableRef,
} from './identifier.js';


// --- Objects the framework creates ---

export type ObjectKind = 'schema' | 'domain' | 'table' | 'column' | 'constraint' | 'index';

/** Object kind + qualified name. */
export const objectKey = (kind: ObjectKind, ...parts: string[]): string =>
	`${kind} ${parts.map(q).join('.')}`;

/** One database object the definition asks for. */
export interface Target {
	/** Its identity in the catalogue, e.g. `column "ventas"."reserva"."hora"`. */
	key: string;
	/** The SQL statement that creates it. */
	sql: string;
	/** Things bundled with it, e.g. a table's columns. */
	parts?: Target[];
	/** This is the table.
	 * It only gets set when adding a required column with no default value that might already have rows.
	 * `sql` only applies while this table holds no rows. */
	onlyIfEmpty?: TableInfo;
}

/** List of SQL commands -> SQL (text) script. */
export const script = (statements: string[], header: string): string =>
	header.split('\n').map(line => `-- ${line}\n`).join('') + '\n'
	+ statements.map(s => `${s};\n`).join('\n');


// --- Schemas ---

/** `create schema` for every schema except the default one, which Postgres already provides. */
const schemaTargets = (schemas: string[]): Target[] =>
	schemas.filter(schema => schema !== DEFAULT_SCHEMA).map(schema =>
		({ key: objectKey('schema', schema), sql: `create schema ${q(schema)}` }));


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

const domainTargets = (byName: Map<string, string>): Target[] =>
	[...byName]
		.filter(([typeName, sqlType]) => needsDomain(typeName, sqlType))
		.map(([typeName, sqlType]) => {
			if (SHADOWED.has(typeName))
				throw new Error(`type "${typeName}" cannot be stored as ${sqlType}: `
					+ `Postgres already has a type of that name and would use it instead`);

			return {
				key: objectKey('domain', DEFAULT_SCHEMA, typeName),
				sql: `create domain ${domainRef(typeName)} as ${sqlType}`,
			};
		});


// --- Constraints ---

/** A constraint by name and body. */
interface Constraint {
	name: string;		// a name for the constraint
	body: string;		// e.g. `primary key ("fecha", "id")`
}

/** How a constraint is written inside a `create table`, and after `alter table … add`. */
const inline = (c: Constraint): string => `constraint ${q(c.name)} ${c.body}`;

const constraintTarget = (t: TableInfo, c: Constraint): Target => ({
	key: objectKey('constraint', t.schema, t.table, c.name),
	sql: `alter table ${tableRef(t)} add ${inline(c)}`,
});

/** A table's own keys, in the order `create table` writes them: the pk, then the uks. */
const keyConstraints = (t: TableInfo, taken: Set<string>): Constraint[] => [
	{ name: generatedName([t.table, 'pk'], taken), body: `primary key (${columnList(t.pk)})` },
	...Object.entries(t.uks).map(([uk, cols]) => ({
		name: generatedName([t.table, uk, 'uk'], taken),
		body: `unique (${columnList(cols)})`,
	})),
];


// --- Tables and columns ---

const columnType = (c: ColumnInfo): string =>
	needsDomain(c.typeName, c.type.sqlType) ? domainRef(c.typeName) : storageType(c.type.sqlType);

/** e.g. `"nombre" varchar(100) not null default 'sin nombre'` */
const columnDefinition = (c: ColumnInfo): string =>
	`${q(checkedName(c.name, 'column'))} ${columnType(c)}${c.nullable ? '' : ' not null'}`
	+ (c.defaultSql === null ? '' : ` default ${c.defaultSql}`);

function columnTarget(t: TableInfo, c: ColumnInfo): Target {
	const target: Target = {
		key: objectKey('column', t.schema, t.table, c.name),
		sql: `alter table ${tableRef(t)} add column ${columnDefinition(c)}`,
	};

	if (!c.nullable && c.defaultSql === null) target.onlyIfEmpty = t;

	return target;
}

/** The table w/ everything that goes inside. */
function tableTarget(t: TableInfo, taken: Set<string>): Target {
	const keys = keyConstraints(t, taken);

	return {
		key: objectKey('table', t.schema, t.table),
		sql: `create table ${tableRef(t)} (\n  `
			+ [...t.columns.map(columnDefinition), ...keys.map(inline)].join(',\n  ') + `\n)`,
		parts: [...t.columns.map(c => columnTarget(t, c)), ...keys.map(c => constraintTarget(t, c))],
	};
}


// --- References ---

/** Foreign key constraints from a table. */
const foreignKeyTargets = (t: TableInfo, taken: Set<string>): Target[] =>
	t.references.map(ref => constraintTarget(t, {
		name: generatedName([t.table, ref.name, 'fk'], taken),
		body: `foreign key (${columnList(ref.columns)})`
			// the target's own schema, so a fk across schemas needs no special case
			+ ` references ${tableRef(ref.to)} (${columnList(ref.targetColumns)})`,
	}));

/** Determines if a list of columns (in order) is the start of a key, in order. */
const leads = (cols: ColumnInfo[], key: ColumnInfo[]): boolean =>
	cols.length <= key.length && cols.every((c, i) => key[i] === c);

/** Indexes on a table's foreign key columns. */
const indexTargets = (t: TableInfo, taken: Set<string>): Target[] =>
	t.references
		// Skip indexes that are already covered by a primary key or unique constraint
		.filter(ref => ![t.pk, ...Object.values(t.uks)].some(key => leads(ref.columns, key)))
		.map(ref => {
			const name = generatedName([t.table, ref.name, 'ix'], taken);

			return {
				key: objectKey('index', t.schema, name),
				sql: `create index ${q(name)} on ${tableRef(t)} (${columnList(ref.columns)})`,
			};
		});


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

/** Returns everything that needs to be created in the correct order. */
export function targets(tables: TableInfo[]): Target[] {
	const taken = takenBySchema(tables);

	/** The names already used in the schema this table lives in. */
	const namesIn = (t: TableInfo): Set<string> => taken.get(t.schema)!;

	return [
		...schemaTargets([...taken.keys()]),
		...domainTargets(storages(tables)),
		...tables.map(t => tableTarget(t, namesIn(t))),
		...tables.flatMap(t => foreignKeyTargets(t, namesIn(t))),
		...tables.flatMap(t => indexTargets(t, namesIn(t))),
	];
}

/** The SQL script that creates the schema for all the tables. */
export const schemaSql = (tables: TableInfo[]): string =>
	script(targets(tables).map(t => t.sql),
		'Generated from the system definition. Edit the definition, not this.');
