// What the schema says about a foreign key: which columns carry it, where it points, what a
// row over there is called, and what picking one writes. Shared by the grid and the row panel,
// so both stay derived from `_meta` instead of guessing on their own.

import type { ReferenceMeta, TableMeta } from '../shared/api.js';

type Row = Record<string, unknown>;

/** A table's fks, indexed by each column that carries one (a composite fk appears under all of them). */
export const referencesOf = (t: TableMeta): ReadonlyMap<string, ReferenceMeta> =>
	new Map(t.references.flatMap(r => r.columns.map(name => [name, r] as const)));

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
