// Access to what the database already holds, read from Postgres
// Used by updates to check what's already there

import { fkBody, type Held, indexBody, objectKey, type ObjectKind, pkBody, ukBody } from './ddl.js';
import { nameList, qualified } from './identifier.js';

/** Result of a catalog query.
 * The object's name, its schema, and the table that contains it. */
export type CatalogRow = {
	schema: string;
	name: string;
	in: string;

	/** For a constraint: `p`, `u` or `f`.
	 * For an index: `t`/`f` for whether it is unique. */
	type: string;
	/** The object's columns, in order, as a JSON array. */
	cols: string | null;

	// A foreign key's target
	refSchema: string | null;
	refTable: string | null;
	refCols: string | null;
	refKey: string | null;
};

/** Every object the database holds, keyed like `objectKey`. */
export type Catalog = ReadonlyMap<string, Held>;

/** A query, paired with what the objects it finds are.
 * Its kind is the key it is held under, so no entry can name a kind other than its own. */
interface CatalogQuery {
	/** The SQL query to execute. */
	text: string;
	/** A function that extracts the parts of the object from a catalog row. */
	parts(row: CatalogRow): string[];
	/** The table the object lives in, for the kinds that live in one. */
	in?(row: CatalogRow): string;
	/** The shape of the object, for the kinds whose shape can be different. */
	shape?(row: CatalogRow): string;
	/** The key whose index this object needs, by `objectKey`. */
	dependsOn?(row: CatalogRow): string | null;
}

/** Restrict queries to the schemas the definition names.
 * I.e. schema binds to parameter to avoid injections. */
const IN_SCHEMAS = `n.nspname = any($1::text[])`;

/** The column names of a constraint or an index, in order. */
const columnsOf = (row: CatalogRow, which: 'cols' | 'refCols'): string[] =>
	row[which] === null ? [] : (JSON.parse(row[which]) as string[]);

/** A column list, quoted and joined the way the generator writes one. */
const listOf = (row: CatalogRow, which: 'cols' | 'refCols'): string => nameList(columnsOf(row, which));

/** Where we define the queries to fetch the catalog information we need to tell diffs.
 * One query per kind of object the framework creates, keyed by `ObjectKind`. */
const CATALOG_QUERIES: Readonly<Record<ObjectKind, CatalogQuery>> = {

	schema: {
		text: `select n.nspname as name from pg_namespace n where ${IN_SCHEMAS}`,
		parts: row => [row.name],
	},

	domain: {
		text: `select n.nspname as schema, t.typname as name
			from pg_type t join pg_namespace n on n.oid = t.typnamespace
			where t.typtype = 'd' and t.typrelid = 0 and ${IN_SCHEMAS}`, // a table's own row type is 'c'
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
		in: row => row.in,
	},

	constraint: {
		text: `select n.nspname as schema, c.relname as "in", k.conname as name, k.contype as type,
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
		parts: row => [row.schema, row.in, row.name],
		in: row => row.in,
		shape: row => row.type === 'f'
			? fkBody(listOf(row, 'cols'),
				qualified(row.refSchema ?? '', row.refTable ?? ''), listOf(row, 'refCols'))
			: row.type === 'p' ? pkBody(listOf(row, 'cols')) : ukBody(listOf(row, 'cols')),
		dependsOn: row => {
			if (row.refKey === null) return null;

			const [kind, ...parts] = JSON.parse(row.refKey) as [ObjectKind, ...string[]];

			return objectKey(kind, ...parts);
		},
	},

	index: {
		text: `select n.nspname as schema, c.relname as name, tc.relname as "in",
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
		parts: row => [row.schema, row.name],
		in: row => row.in,
		shape: row => indexBody(listOf(row, 'cols'), row.type === 't'),
	},
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
	for (const [kind, catalogue] of Object.entries(CATALOG_QUERIES) as [ObjectKind, CatalogQuery][])
		// For each row returned by the query...
		for (const row of await query(catalogue.text, [schemas])) {

			const parts = catalogue.parts(row);
			const key = objectKey(kind, ...parts);

			// Create a new `Held` object and add it to the map.
			held.set(key, {
				key,
				kind,
				schema: parts[0],
				name: parts[parts.length - 1],
				in: catalogue.in?.(row) ?? null,
				columns: catalogue.shape === undefined ? null : columnsOf(row, 'cols'),
				shape: catalogue.shape?.(row) ?? null,
				dependsOn: catalogue.dependsOn?.(row) ?? null,
			});
		}

	return held;
}
