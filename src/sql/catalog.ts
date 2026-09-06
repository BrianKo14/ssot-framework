// Access to what the database already holds, read from Postgres
// Used by updates to check what's already there

import {
	type ColumnHeld, type ConstraintHeld, type DomainHeld, fkBody, type Held, indexBody, type IndexHeld,
	objectKey, type ObjectKind, pkBody, type SchemaHeld, type TableHeld, ukBody,
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

interface ColumnRow extends InTableRow {
	/** The type it is stored as, in Postgres's own spelling. */
	type: string;
	/** Whether it admits no null. */
	notNull: Flag;
	/** The column's own type: `d` when it is a domain, and then `typeSchema`/`typeName` name it. */
	typeKind: TypeKind;
	typeSchema: string;
	typeName: string;
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

/** One row from a catalogue query, mirror of `Held`.
 * Which fields it has depends on which query returned it. */
export type CatalogRow = SchemaRow | DomainRow | TableRow | ColumnRow | ConstraintRow | IndexRow;


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

/** A columna's type.
 * The domain it is typed by, or else Postgres's own spelling of the plain type. */
const columnType = (row: ColumnRow): string =>
	row.typeKind === 'd' ? qualified(row.typeSchema, row.typeName) : row.type;

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
			key: objectKey('schema', row.name), kind: 'schema', schema: row.name, name: row.name,
		})),

	domain: entry(
		`select n.nspname as schema, t.typname as name,
				format_type(t.typbasetype, t.typtypmod) as type
			from pg_type t join pg_namespace n on n.oid = t.typnamespace
			where t.typtype = 'd' and t.typrelid = 0 and ${IN_SCHEMAS}`, 
		(row: DomainRow): DomainHeld => ({
			key: objectKey('domain', row.schema, row.name), kind: 'domain',
			schema: row.schema, name: row.name,
			shape: row.type,
		})),

	table: entry(
		`select n.nspname as schema, c.relname as name
			from pg_class c join pg_namespace n on n.oid = c.relnamespace
			where c.relkind = 'r' and ${IN_SCHEMAS}`,
		(row: TableRow): TableHeld => ({
			key: objectKey('table', row.schema, row.name), kind: 'table',
			schema: row.schema, name: row.name,
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
			dependsOn: row.typeKind === 'd' ? objectKey('domain', row.typeSchema, row.typeName) : null,
			type: columnType(row),
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
			dependsOn: row.type === 'f' ? refersTo(row.refKey) : null,
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
