// Access to what the database already holds, read from Postgres
// Used by updates to check what's already there

import {
	type ColumnHeld, type ConstraintHeld, type DomainHeld, fkBody, type FunctionHeld, type Held, indexBody, type IndexHeld,
	objectKey, type ObjectKind, pkBody, type ProcedureHeld, routineSignature, routineSource, type SchemaHeld,
	type TableHeld, triggerBody, type TriggerHeld, ukBody,
} from './ddl.js';
import { nameList, qualified } from './identifier.js';

/** Every object the database holds, keyed like `objectKey`. */
export type Catalog = ReadonlyMap<string, Held>;


// --- ROWS ---

/** A Postgres boolean as the driver hands it back. */
type Flag = 't' | 'f';

/** `pg_type.typtype`: `d` is a domain, the rest are Postgres's other kinds of type. */
type TypeKind = 'b' | 'c' | 'd' | 'e' | 'm' | 'p' | 'r';


// --> Row types

/** Fields every row has that names an object living in a schema. */
interface RowBase {
	schema: string;
	name: string;
}

/** Fields a row has on top of those when its object lives in a table. */
interface InTableRow extends RowBase {
	/** The table where it lives. */
	in: string;
}

/** A schema is in no schema but itself, so its query selects the one column. */
interface SchemaRow { name: string }

interface DomainRow extends RowBase {
	/** How the domain is stored, in Postgres's own spelling. */
	type: string;
}

type TableRow = RowBase;

/** A type something is declared with, as `pg_type` has it. */
interface TypeRow {
	/** The type it is stored as, in Postgres's own spelling. */
	type: string;
	/** Its own type: `d` when it is a domain, and then `typeSchema`/`typeName` name it. */
	typeKind: TypeKind;
	typeSchema: string;
	typeName: string;
}

interface ColumnRow extends InTableRow, TypeRow {
	/** Whether it admits no null. */
	notNull: Flag;
}

/** A primary or unique key. */
interface KeyRow extends InTableRow {
	/** 'p' for primary key, 'u' for unique key. */
	type: 'p' | 'u';
	/** Its columns, in order, as a JSON array. */
	cols: string;
}

/** A foreign key. */
interface ForeignKeyRow extends InTableRow {
	type: 'f';
	/** Its columns, in order, as a JSON array. */
	cols: string;
	refSchema: string;
	refTable: string;
	refCols: string;
	/** The key it references, as a JSON `[kind, ...parts]` array. */
	refKey: string;
}

type ConstraintRow = KeyRow | ForeignKeyRow;

interface IndexRow extends InTableRow {
	/** `t`/`f` for whether the index is unique — not a type name. */
	type: Flag;
	/** Its columns, in order, as a JSON array. */
	cols: string;
}

interface RoutineRow extends RowBase {
	language: string;
	/** Code, written between the dollar quotes. */
	body: string;
	/** Params in order, as a JSON array of `{name, ...TypeRow}`. */
	params: string;
	/** Result, as a JSON `TypeRow` (or null for a procedure). */
	returns: string | null;
}

interface TriggerRow extends InTableRow {
	/** `pg_trigger.tgtype` (the bits of `TRIGGER_BITS`, as text). */
	type: string;
	routineSchema: string;
	routineName: string;
}

/** One row from a catalogue query, mirror of `Held`.
 * Which fields it has depends on which query returned it. */
export type CatalogRow = SchemaRow | DomainRow | TableRow | ColumnRow | ConstraintRow | IndexRow | RoutineRow | TriggerRow;


// --- QUERIES ---

/** A query, paired with the held object each of its rows describes.
 * Its kind is the key it is held under, so no entry can name a kind other than its own. */
interface CatalogQuery<H extends Held> {
	/** The SQL query to execute. */
	text: string;
	/** The object one of its rows describes. */
	held(row: CatalogRow): H;
}

/** An entry of a catalog query. */
const entry = <R extends CatalogRow, H extends Held>(
	text: string,
	held: (row: R) => H,
): CatalogQuery<H> => ({ text, held: row => held(row as R) });

/** Restrict queries to the schemas the definition names.
 * I.e. schema binds to parameter to avoid injections. */
const IN_SCHEMAS = `n.nspname = any($1::text[])`;

/** The column names an aggregate selected, in order. */
const columnsOf = (json: string): string[] => JSON.parse(json) as string[];

/** A column list, quoted and joined the way the generator writes one. */
const listOf = (json: string): string => nameList(columnsOf(json));

/** The type a column or a param is declared with.
 * The domain it is typed by, or else Postgres's own spelling of the plain type. */
const typeOf = (row: TypeRow): string =>
	row.typeKind === 'd' ? qualified(row.typeSchema, row.typeName) : row.type;

/** The type of a domain. (None for a plain type.) */
const domainOf = (row: TypeRow): string[] =>
	row.typeKind === 'd' ? [objectKey('domain', row.typeSchema, row.typeName)] : [];

/** The fields of a `TypeRow`, as a `json_build_object` list.
 * Reused for both a routine's params and return type. */
const TYPE_JSON = `'type', format_type(t.oid, null), 'typeKind', t.typtype,
	'typeSchema', tn.nspname, 'typeName', t.typname`;

/** SQL that reads functions (`'f'`) or procedures (`'p'`) + their params and return types.
 * Skips extension-owned routines, which are not the definition's. */
const routineQuery = (prokind: 'f' | 'p'): string =>
	`select n.nspname as schema, p.proname as name, l.lanname as language, p.prosrc as body,
			coalesce((select json_agg(json_build_object('name', p.proargnames[u.ord::int], ${TYPE_JSON}) order by u.ord)
				from unnest(p.proargtypes::oid[]) with ordinality as u(oid, ord)
				join pg_type t on t.oid = u.oid
				join pg_namespace tn on tn.oid = t.typnamespace), '[]') as params,
			(select json_build_object(${TYPE_JSON})
				from pg_type t join pg_namespace tn on tn.oid = t.typnamespace
				where p.prokind = 'f' and t.oid = p.prorettype) as returns
		from pg_proc p
		join pg_namespace n on n.oid = p.pronamespace
		join pg_language l on l.oid = p.prolang
		where p.prokind = '${prokind}' and ${IN_SCHEMAS}
			and not exists (
				select 1 from pg_depend d
				where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')`;

/** `routineQuery` -> `Held` of a function or procedure. */
function routineHeld<K extends 'function' | 'procedure'>(kind: K, row: RoutineRow) {
	const params = JSON.parse(row.params) as (TypeRow & { name: string })[];
	const returns = row.returns === null ? null : JSON.parse(row.returns) as TypeRow;
	const typed = [...params, ...returns === null ? [] : [returns]];

	return {
		key: objectKey(kind, row.schema, row.name), kind,
		schema: row.schema, name: row.name,
		shape: routineSignature(params.map(p => [p.name, typeOf(p)]), returns === null ? null : typeOf(returns)),
		source: routineSource(row.language, row.body),
		dependsOn: [...new Set(typed.flatMap(domainOf))],
	};
}

/** `pg_trigger.tgtype`, bit by bit, in the order `triggerBody` writes events. */
const TRIGGER_BITS = { row: 1, before: 2, insert: 4, update: 16, delete: 8, truncate: 32, instead: 64 } as const;
const EVENT_BITS = ['insert', 'update', 'delete', 'truncate'] as const;

/** Rebuilds a trigger's definition from its `tgtype` bits, written the way the generator would write it. */
function triggerSource(row: TriggerRow): string {
	const bits = Number(row.type);
	const has = (bit: number): boolean => (bits & bit) !== 0;

	const timing = has(TRIGGER_BITS.before) ? 'before' : has(TRIGGER_BITS.instead) ? 'instead of' : 'after';

	return triggerBody(timing, EVENT_BITS.filter(event => has(TRIGGER_BITS[event])),
		qualified(row.schema, row.in), has(TRIGGER_BITS.row) ? 'row' : 'statement',
		qualified(row.routineSchema, row.routineName));
}

/** A constraint's body, written the way the generator writes the same one. */
function constraintBody(row: ConstraintRow): string {
	const cols = listOf(row.cols);

	if (row.type === 'f')
		return fkBody(cols, qualified(row.refSchema, row.refTable), listOf(row.refCols));

	return row.type === 'p' ? pkBody(cols) : ukBody(cols);
}

/** The key a foreign key's `refKey` names, as `objectKey` writes it. */
function refersTo(refKey: string): string {
	const [kind, ...parts] = JSON.parse(refKey) as [ObjectKind, ...string[]];

	return objectKey(kind, ...parts);
}

// --> THE QUERY OPERATOR

/** Where we define the queries to fetch the catalog information we need to tell diffs.
 * One query per kind of object the framework creates, keyed by `ObjectKind`. */
const CATALOG_QUERIES: { readonly [K in ObjectKind]: CatalogQuery<Extract<Held, { kind: K }>> } = {

	schema: entry(
		`select n.nspname as name from pg_namespace n where ${IN_SCHEMAS}`,
		(row: SchemaRow): SchemaHeld => ({
			key: objectKey('schema', row.name), kind: 'schema', schema: row.name, name: row.name, dependsOn: [],
		})),

	domain: entry(
		`select n.nspname as schema, t.typname as name,
				format_type(t.typbasetype, t.typtypmod) as type
			from pg_type t join pg_namespace n on n.oid = t.typnamespace
			where t.typtype = 'd' and t.typrelid = 0 and ${IN_SCHEMAS}`, 
		(row: DomainRow): DomainHeld => ({
			key: objectKey('domain', row.schema, row.name), kind: 'domain',
			schema: row.schema, name: row.name, dependsOn: [],
			shape: row.type,
		})),

	table: entry(
		`select n.nspname as schema, c.relname as name
			from pg_class c join pg_namespace n on n.oid = c.relnamespace
			where c.relkind = 'r' and ${IN_SCHEMAS}`,
		(row: TableRow): TableHeld => ({
			key: objectKey('table', row.schema, row.name), kind: 'table',
			schema: row.schema, name: row.name, dependsOn: [],
		})),

	column: entry(
		`select n.nspname as schema, c.relname as "in", a.attname as name,
				format_type(a.atttypid, a.atttypmod) as type,
				case when a.attnotnull then 't' else 'f' end as "notNull",
				t.typtype as "typeKind", tn.nspname as "typeSchema", t.typname as "typeName"
			from pg_attribute a
			join pg_class c on c.oid = a.attrelid
			join pg_namespace n on n.oid = c.relnamespace
			join pg_type t on t.oid = a.atttypid
			join pg_namespace tn on tn.oid = t.typnamespace
			where c.relkind = 'r' and a.attnum > 0 and not a.attisdropped and ${IN_SCHEMAS}`,
		(row: ColumnRow): ColumnHeld => ({
			key: objectKey('column', row.schema, row.in, row.name), kind: 'column',
			schema: row.schema, name: row.name,
			in: row.in,
			dependsOn: domainOf(row),
			type: typeOf(row),
			notNull: row.notNull === 't',
		})),

	constraint: entry(
		`select n.nspname as schema, c.relname as "in", k.conname as name, k.contype as type,
				(select json_agg(a.attname order by u.ord)
					from unnest(k.conkey) with ordinality as u(attnum, ord)
					join pg_attribute a on a.attrelid = k.conrelid and a.attnum = u.attnum) as cols,
				fn.nspname as "refSchema", fc.relname as "refTable",
				(select json_agg(a.attname order by u.ord)
					from unnest(k.confkey) with ordinality as u(attnum, ord)
					join pg_attribute a on a.attrelid = k.confrelid and a.attnum = u.attnum) as "refCols",
				(select case when k2.conname is not null
						then json_build_array('constraint', kn.nspname, kc.relname, k2.conname)
						else json_build_array('index', ins.nspname, ic.relname) end
					from pg_class ic
					join pg_namespace ins on ins.oid = ic.relnamespace
					left join pg_constraint k2 on k2.conindid = ic.oid and k2.contype in ('p', 'u')
					left join pg_class kc on kc.oid = k2.conrelid
					left join pg_namespace kn on kn.oid = kc.relnamespace
					where k.contype = 'f' and ic.oid = k.conindid) as "refKey"
			from pg_constraint k
			join pg_class c on c.oid = k.conrelid
			join pg_namespace n on n.oid = c.relnamespace
			left join pg_class fc on fc.oid = k.confrelid
			left join pg_namespace fn on fn.oid = fc.relnamespace
			where k.contype in ('p', 'u', 'f') and ${IN_SCHEMAS}`,
		(row: ConstraintRow): ConstraintHeld => ({
			key: objectKey('constraint', row.schema, row.in, row.name), kind: 'constraint',
			schema: row.schema, name: row.name,
			in: row.in,
			shape: constraintBody(row),
			columns: columnsOf(row.cols),
			dependsOn: row.type === 'f' ? [refersTo(row.refKey)] : [],
		})),

	index: entry(
		`select n.nspname as schema, c.relname as name, tc.relname as "in",
				case when i.indisunique then 't' else 'f' end as type,
				(select json_agg(coalesce(a.attname, pg_get_indexdef(i.indexrelid, u.ord::int, true))
						order by u.ord)
					from unnest(i.indkey) with ordinality as u(attnum, ord)
					left join pg_attribute a on a.attrelid = i.indrelid and a.attnum = u.attnum
					where u.ord <= i.indnkeyatts) as cols
			from pg_class c
			join pg_namespace n on n.oid = c.relnamespace
			join pg_index i on i.indexrelid = c.oid
			join pg_class tc on tc.oid = i.indrelid
			where c.relkind = 'i' and tc.relkind = 'r' and ${IN_SCHEMAS}
				and not exists (
					select 1 from pg_depend d
					where d.classid = 'pg_class'::regclass and d.objid = c.oid
						and d.refclassid = 'pg_constraint'::regclass and d.deptype = 'i')`,
		(row: IndexRow): IndexHeld => ({
			key: objectKey('index', row.schema, row.name), kind: 'index',
			schema: row.schema, name: row.name,
			in: row.in,
			shape: indexBody(listOf(row.cols), row.type === 't'),
			columns: columnsOf(row.cols),
			dependsOn: [],
		})),

		function: entry(routineQuery('f'), (row: RoutineRow): FunctionHeld => routineHeld('function', row)),

		procedure: entry(routineQuery('p'), (row: RoutineRow): ProcedureHeld => routineHeld('procedure', row)),

		trigger: entry(
			`select n.nspname as schema, c.relname as "in", g.tgname as name, g.tgtype as type,
					fn.nspname as "routineSchema", f.proname as "routineName"
				from pg_trigger g
				join pg_class c on c.oid = g.tgrelid
				join pg_namespace n on n.oid = c.relnamespace
				join pg_proc f on f.oid = g.tgfoid
				join pg_namespace fn on fn.oid = f.pronamespace
				where not g.tgisinternal and ${IN_SCHEMAS}`,
			(row: TriggerRow): TriggerHeld => ({
				key: objectKey('trigger', row.schema, row.in, row.name), kind: 'trigger',
				schema: row.schema, name: row.name,
				in: row.in,
				source: triggerSource(row),
				dependsOn: [objectKey('function', row.routineSchema, row.routineName)],
			})),
};

/** Reads what the database holds in the given schemas.
 *
 * @param query function that runs one statement (`Db.query`)
 * @param schemas the names of the schemas to look in.
 *
 * @returns A map of the objects already in the database. */
export async function readCatalog(
	query: (text: string, params: unknown[]) => Promise<CatalogRow[]>,
	schemas: string[],
): Promise<Catalog> {
	const held = new Map<string, Held>();

	// For each kind of object we want to track...
	for (const catalogue of Object.values(CATALOG_QUERIES))
		// For each row returned by the query...
		for (const row of await query(catalogue.text, [schemas])) {
			const h = catalogue.held(row);

			held.set(h.key, h);
		}

	return held;
}
