// What the schema says about a foreign key: which columns carry it, where it points, what a
// row over there is called, and what picking one writes. Shared by the grid and the row panel,
// so both stay derived from `_meta` instead of guessing on their own.

import type { ColumnMeta, ReferenceMeta, TableMeta } from '../shared/api.js';

type Row = Record<string, unknown>;

/** A table's fks, indexed by each column that carries one (a composite fk appears under all of them). */
export const referencesOf = (t: TableMeta): ReadonlyMap<string, ReferenceMeta> =>
	new Map(t.references.flatMap(r => r.columns.map(name => [name, r] as const)));

/** A table that is a detail of some master, together with the fk that makes it one. */
export interface Detail {
	table: TableMeta;
	ref: ReferenceMeta;
}

/** A detail table and its associated foreign key. */
export const detailsOf = (tables: TableMeta[], master: TableMeta): Detail[] =>
	tables.flatMap(table => table.references
		.filter(ref => ref.isDetail && ref.to === master.entity)
		.map(ref => ({ table, ref })));

/** The fk's target table. Missing only if `_meta` and the screen disagree. */
export const targetOf = (tables: TableMeta[], r: ReferenceMeta): TableMeta | undefined =>
	tables.find(t => t.entity === r.to);

/** A row's values under the named columns, as the address writes them. */
export const valuesOf = (names: string[], row: Row): string[] => names.map(name => String(row[name]));

/** A row's display label: its `isName` columns, or its key when none are marked. */
export function labelOf(t: TableMeta, row: Row): string {
	const named = t.columns.filter(c => c.isName).map(c => c.name);
	const said = (named.length ? named : t.pk).filter(name => row[name] !== null);

	return said.length ? valuesOf(said, row).join(' · ') : valuesOf(t.pk, row).join(' · ');
}

/** The target row's pk address, or `undefined` if the fk points at a unique key rather than
 * the pk, or has a null in it. Mirrors `isNestable` in `api/crud.ts`. */
export function keyThrough(r: ReferenceMeta, target: TableMeta, row: Row): string[] | undefined {
	if (r.targetColumns.length !== target.pk.length) return undefined;

	const key: string[] = [];

	for (const name of target.pk) {
		const at = r.targetColumns.indexOf(name);

		if (at < 0) return undefined;				// points at a unique key, not the pk

		const value = row[r.columns[at]];

		if (value === null || value === undefined) return undefined;	// no row is addressed

		key.push(String(value));
	}

	return key;
}

/** What picking `chosen` writes: each of this table's fk columns takes the value of the
 * target column it maps to — an fk is one value seen as several columns. */
export const valuesFrom = (r: ReferenceMeta, chosen: Row): Row =>
	Object.fromEntries(r.columns.map((name, i) => [name, chosen[r.targetColumns[i]]]));

/** The column an fk's list is searched by: the target's first `isName` column, or its pk when
 * that's a single column. `undefined` leaves the list unfiltered. */
export const searchColumn = (target: TableMeta): string | undefined =>
	target.columns.find(c => c.isName)?.name ?? (target.pk.length === 1 ? target.pk[0] : undefined);

// --- Ancestry (SCOPE 6b) ---

/** What a table reached by walking fks is called, by how many fks it took to get there. The
 * list of words *is* how deep the screen goes: it offers what it can name, and no further.
 * The server's own limit is a separate, looser thing — a guard on what a request may ask,
 * not a vocabulary — so the two can never disagree. */
export const KINSHIP = ['padre', 'abuelo'];

/** What separates the steps of a reached column's name — `reserva.cliente.nombre` is `nombre`
 * of what `cliente` points at, of what `reserva` points at. The server reads the same grammar
 * (`sql/reach.ts`), the way it already reads the one `filterQuery` writes. */
const STEP = '.';

/** A table reached from the one on screen, and the fks walked to reach it. */
export interface Ancestor {
	via: ReferenceMeta[];
	table: TableMeta;
}

/** What a path of this length is called on screen: `padre`, `abuelo`. */
export const kinshipOf = (via: ReferenceMeta[]): string => KINSHIP[via.length - 1];

/** The name a column of an ancestor answers to, on the wire and in the row. */
export const reachedName = (a: Ancestor, c: ColumnMeta): string =>
	[...a.via.map(r => r.name), c.name].join(STEP);

/** Every table reachable from `t` by walking fks, nearest first, as deep as `KINSHIP` can name.
 * An fk whose target this caller may not read is not in `_meta` at all, so it is not walked.
 * Two fks onto the same table are two ancestors: they are different paths, told apart by the
 * fk's own name, which is also what the wire calls them by. */
export function ancestorsOf(tables: TableMeta[], t: TableMeta): Ancestor[] {
	const found: Ancestor[] = [];

	let step: Ancestor[] = [{ via: [], table: t }];

	for (let depth = 0; depth < KINSHIP.length; depth++) {
		step = step.flatMap(from => from.table.references.flatMap(ref => {
			const table = targetOf(tables, ref);

			return table ? [{ via: [...from.via, ref], table }] : [];
		}));

		found.push(...step);
	}

	return found;
}

/** A column a screen can name: one of the table's own, or one of an ancestor's — told apart by
 * `via` alone. What the grid draws, what the filter bar offers, what the address carries. */
export interface Reachable {
	column: ColumnMeta;
	/** The table the column belongs to. */
	owner: TableMeta;
	/** The fks walked to reach it; empty for the table's own. */
	via: ReferenceMeta[];
	/** What the wire calls it: its own name, or the path that reached it. */
	name: string;
}

export const ownColumns = (t: TableMeta): Reachable[] =>
	t.columns.map(column => ({ column, owner: t, via: [], name: column.name }));

export const reachedColumn = (a: Ancestor, column: ColumnMeta): Reachable =>
	({ column, owner: a.table, via: a.via, name: reachedName(a, column) });

/** Every column a screen can name, its own first. Derived from `_meta` alone, so the address can
 * resolve one without the screen having to say which are on it. */
export const reachableFrom = (tables: TableMeta[], t: TableMeta): Reachable[] => [
	...ownColumns(t),
	...ancestorsOf(tables, t).flatMap(a => a.table.columns.map(c => reachedColumn(a, c))),
];
