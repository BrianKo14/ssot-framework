// The schema generator

import type { ColumnInfo, TableInfo } from '../schema/model.js';
import { stored } from '../schema/reserved.js';
import {
	canonicalType, checkedName, checkedSchema, columnList, DEFAULT_SCHEMA, generatedName, q, qualified,
	storageType, tableRef,
} from './identifier.js';


// --- OBJECTS FOR COMPARISON ---
// `Target`s (what the definition asks for) against `Held` (what the database has)

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
	/** Shape of the object, to be used in comparisons. */
	shape?: string;
	/** Things bundled with it, e.g. a table's columns. */
	parts?: Target[];
	/** This is the table.
	 * It only gets set when adding a required column with no default value that might already have rows.
	 * `sql` only applies while this table holds no rows. */
	onlyIfEmpty?: TableInfo;
}

/** Fields every held object has, whatever its kind. */
interface HeldBase {
	key: string;
	schema: string;
	name: string;
}

export interface SchemaHeld extends HeldBase { kind: 'schema' }
export interface TableHeld extends HeldBase { kind: 'table' }
export interface DomainHeld extends HeldBase { kind: 'domain'; shape: string }
export interface ColumnHeld extends HeldBase {
	kind: 'column';
	/** The table where it lives. */
	in: string;
	/** The domain type it depends on; else null. */
	dependsOn: string | null;
	/** The type it has and whether it admits null: the halves of its shape,
	 * so a change can be told from a rebuild. */
	type: string;
	notNull: boolean;
}
export interface ConstraintHeld extends HeldBase {
	kind: 'constraint';
	/** The table where it lives. */
	in: string;
	/** Shape of the object, to be used in comparisons. */
	shape: string;
	/** Its columns, in order. */
	columns: string[];
	/** If an FK, the key it references; else null. */
	dependsOn: string | null;
}
export interface IndexHeld extends HeldBase {
	kind: 'index';
	/** The table where it lives. */
	in: string;
	/** Shape of the object, to be used in comparisons. */
	shape: string;
	/** Its columns, in order. */
	columns: string[];
}

/** One database object that is already there, mirror of `Target`.
 * To be used in comparisons and drop statements.
 * Which fields apply depends on `kind`. */
export type Held = SchemaHeld | TableHeld | DomainHeld | ColumnHeld | ConstraintHeld | IndexHeld;

/** List of SQL commands -> SQL (text) script. */
export const script = (statements: string[], header: string): string =>
	header.split('\n').map(line => `-- ${line}\n`).join('') + '\n'
	+ statements.map(s => `${s};\n`).join('\n');


// --- SCHEMAS

/** `create schema` for every schema except the default one, which Postgres already provides. */
const schemaTargets = (schemas: string[]): Target[] =>
	schemas.filter(schema => schema !== DEFAULT_SCHEMA).map(schema =>
		({ key: objectKey('schema', schema), sql: `create schema ${q(schema)}` }));


// --- DOMAINS ---

/** A domain's qualified name. */
const domainRef = (typeName: string): string => qualified(DEFAULT_SCHEMA, typeName);

/** Type names Postgres already holds in `pg_catalog`.
 * We guarantee that no domain is created with the same name as one of these.
 * 
 * This is a readability guard. We forbid this because e.g. a if a domain `text` existed,
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
				shape: canonicalType(sqlType),		// a domain that is stored otherwise is rebuilt
			};
		});


// --- BODIES ---

const FOREIGN_KEY = 'foreign key';
const PRIMARY_KEY = 'primary key';
const NOT_NULL = ' not null';

export const pkBody = (cols: string): string => `${PRIMARY_KEY} (${cols})`;
export const ukBody = (cols: string): string => `unique (${cols})`;
export const fkBody = (cols: string, to: string, targetCols: string): string =>
	`${FOREIGN_KEY} (${cols}) references ${to} (${targetCols})`;
export const indexBody = (cols: string, unique: boolean): string =>
	`${unique ? 'unique ' : ''}(${cols})`;
export const columnBody = (type: string, notNull: boolean): string =>
	`${type}${notNull ? NOT_NULL : ''}`;

export const isForeignKey = (shape: string): boolean => shape.startsWith(`${FOREIGN_KEY} (`);


// --- CONSTRAINTS ---

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
	shape: c.body,
});

/** A table's own keys, in the order `create table` writes them: the pk, then the uks. */
const keyConstraints = (t: TableInfo, taken: Set<string>): Constraint[] => [
	{ name: generatedName([t.table, 'pk'], taken), body: pkBody(columnList(t.pk)) },
	...Object.entries(t.uks).map(([uk, cols]) => ({
		name: generatedName([t.table, uk, 'uk'], taken),
		body: ukBody(columnList(cols)),
	})),
];


// --- TABLES AND COLUMNS ---

/** Is this column's type stored in a domain of its own? */
export const hasDomain = (c: ColumnInfo): boolean => needsDomain(c.typeName, c.type.sqlType);

/** The type a column is declared with. */
const columnType = (c: ColumnInfo): string =>
	hasDomain(c) ? domainRef(c.typeName) : storageType(c.type.sqlType);

/** The same type as the catalogue reports it: a domain by its name, a plain type in
 * Postgres's own spelling. Only for comparing — what gets written is `columnType`. */
export const comparedType = (c: ColumnInfo): string =>
	hasDomain(c) ? domainRef(c.typeName) : canonicalType(c.type.sqlType);

/** e.g. `"nombre" varchar(100) not null default 'sin nombre'` */
const columnDefinition = (c: ColumnInfo): string =>
	`${q(checkedName(c.name, 'column'))} ${columnBody(columnType(c), !c.nullable)}`
	+ (c.defaultSql === null ? '' : ` default ${c.defaultSql}`);

function columnTarget(t: TableInfo, c: ColumnInfo): Target {
	const target: Target = {
		key: objectKey('column', t.schema, t.table, c.name),
		sql: `alter table ${tableRef(t)} add column ${columnDefinition(c)}`,
		shape: columnBody(comparedType(c), !c.nullable),
	};

	if (!c.nullable && c.defaultSql === null) target.onlyIfEmpty = t;

	return target;
}

/** The table w/ everything that goes inside. */
function tableTarget(t: TableInfo, taken: Set<string>): Target {
	const keys = keyConstraints(t, taken);
	const columns = stored(t);			// the described columns + reserved ones

	return {
		key: objectKey('table', t.schema, t.table),
		sql: `create table ${tableRef(t)} (\n  `
			+ [...columns.map(columnDefinition), ...keys.map(inline)].join(',\n  ') + `\n)`,
		parts: [...columns.map(c => columnTarget(t, c)), ...keys.map(c => constraintTarget(t, c))],
	};
}


// --- REFERENCES ---

/** Foreign key constraints from a table. */
const foreignKeyTargets = (t: TableInfo, taken: Set<string>): Target[] =>
	t.references.map(ref => constraintTarget(t, {
		name: generatedName([t.table, ref.name, 'fk'], taken),
		body: fkBody(columnList(ref.columns), tableRef(ref.to), columnList(ref.targetColumns)),
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

			const body = indexBody(columnList(ref.columns), false);

			return {
				key: objectKey('index', t.schema, name),
				sql: `create index ${q(name)} on ${tableRef(t)} ${body}`,
				shape: body,
			};
		});


// --- THE SCHEMA ---

/** @returns Schema names -> set of object names in that schema. */
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
		// 1. Schemas
		...schemaTargets([...taken.keys()]),
		// 2. Domains
		...domainTargets(storages(tables)),
		// 3. Tables
		...tables.map(t => tableTarget(t, namesIn(t))),
		// 4. Foreign keys
		...tables.flatMap(t => foreignKeyTargets(t, namesIn(t))),
		// 5. Indexes
		...tables.flatMap(t => indexTargets(t, namesIn(t))),
	];
}

/** The SQL script that creates the schema for all the tables. */
export const schemaSql = (tables: TableInfo[]): string =>
	script(targets(tables).map(t => t.sql),
		'Generated from the system definition. Edit the definition, not this.');



// --- DROPPING OBJECTS ---

function inTable(h: ColumnHeld | ConstraintHeld | IndexHeld): string {
	return qualified(h.schema, h.in);
}

function dropOne(h: Held): string {
	switch (h.kind) {
		case 'constraint': return `alter table ${inTable(h)} drop constraint ${q(h.name)}`;
		case 'column': return `alter table ${inTable(h)} drop column ${q(h.name)}`;
		case 'index': return `drop index ${qualified(h.schema, h.name)}`;
		default: throw new Error(`${h.key} does not leave on its own`);
	}
}

/** A `--` line above a statement, e.g. what a drop is about to take with it. */
const noted = (note: string | undefined, sql: string): string =>
	note === undefined ? sql : `-- ${note}\n${sql}`;

/** The statements that remove everything in `removals`, in the right order for Postgres.
 * @param notes a line to write above an object's statement, by `Held.key` */
export function dropStatements(removals: Held[], notes: ReadonlyMap<string, string>): string[] {
	const ofKind = <K extends ObjectKind>(kind: K): Extract<Held, { kind: K }>[] =>
		removals.filter((h): h is Extract<Held, { kind: K }> => h.kind === kind);

	const alone = (held: Held[]): string[] =>
		held.map(h => noted(notes.get(h.key), dropOne(h)));

	const together = (verb: string, held: Held[]): string[] => held.length === 0 ? [] : [
		[...held.flatMap(h => notes.has(h.key) ? [`-- ${notes.get(h.key)}`] : []),
			`${verb} ${held.map(h => qualified(h.schema, h.name)).join(', ')}`].join('\n'),
	];

	const constraints = ofKind('constraint');

	return [
		// 1. Constraints (foreign keys)
		...alone(constraints.filter(h => isForeignKey(h.shape))),
		// 2. Indexes
		...alone(ofKind('index')),
		// 3. Other constraints (non-foreign key)
		...alone(constraints.filter(h => !isForeignKey(h.shape))),
		// 4. Columns
		...alone(ofKind('column')),
		// 5. Tables
		...together('drop table', ofKind('table')),
		// 6. Domains
		...together('drop domain', ofKind('domain')),
	];
}

// --- CHANGING COLUMNS ---

// A column is the one object that is never rebuilt when its body drifts: dropping it would
// take the data with it. It is altered in place instead.

/** Where a column's type is moving to. */
export type Retype =
	// When the column is being moved to the type declared in the definition.
	| 'declared'
	// When the column is being moved off a domain that is being rebuilt, onto the plain type behind it.
	| 'storage'
	// When the column is being moved back onto its domain once that is rebuilt.
	| 'rejoin';

/** One column the database holds differently than the definition declares it. */
export interface Alteration {
	table: TableInfo;
	column: ColumnInfo;
	/** The type to move to, or null when the type is not what drifted. */
	retype: Retype | null;
	/** The nullability to declare, or null when it already matches. */
	notNull: boolean | null;
}

export const alterationKey = (a: Alteration): string =>
	objectKey('column', a.table.schema, a.table.table, a.column.name);

/** Provides the `using` clause for converting a column's type.
 * I.e. don't use the default assignment cast. */
const conversion = (c: ColumnInfo): string =>
	c.type.convert === undefined ? '' : ` using ${c.type.convert(q(c.name))}`;

/** The SQL to use for each retyping option. */
const RETYPED: Readonly<Record<Retype, (c: ColumnInfo) => string>> = {
	declared: c => columnType(c) + conversion(c),
	storage: c => storageType(c.type.sqlType) + conversion(c),
	rejoin: c => columnType(c),
};

/** The statements to alter columns. One for type, one for nullability, if needed.
 * @param notes a line to write above a column's statements, by `alterationKey` */
export const alterStatements = (alterations: Alteration[], notes: ReadonlyMap<string, string>): string[] =>
	alterations.flatMap(a => {
		const alter = (what: string): string =>
			`alter table ${tableRef(a.table)} alter column ${q(a.column.name)} ${what}`;

		return [
			...a.retype === null ? [] : [alter(`type ${RETYPED[a.retype](a.column)}`)],
			...a.notNull === null ? [] : [alter(`${a.notNull ? 'set' : 'drop'} not null`)],
		].map((sql, i) => i === 0 ? noted(notes.get(alterationKey(a)), sql) : sql);
	});
