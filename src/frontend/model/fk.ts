// Foreign keys, as `_meta` describes them: which columns carry one, where it points, what a row
// over there is called, what picking one writes, and the ancestors they lead to.

import type { ColumnMeta, ReferenceMeta, TableMeta } from '../../shared/api.js';
import type { Row } from './rows.js';


// --- Foreign keys ---

/** A column's fk, plus the table it points at. */
export interface Fk {
	ref: ReferenceMeta;
	target: TableMeta;
}

export type FkOf = (t: TableMeta, c: ColumnMeta) => Fk | undefined;

/** The fk's target table. Missing only if `_meta` didn't publish it to this role. */
export const targetOf = (tables: TableMeta[], r: ReferenceMeta): TableMeta | undefined =>
	tables.find(t => t.entity === r.to);

/** Each table's fks, by the columns that carry them (a composite fk is under all of its columns).
 * @returns the fk a column carries, if any this role may read */
export const fkIndex = (tables: TableMeta[]): FkOf => {
	const fks = new Map(tables.map(t =>
		[t, new Map(t.references.flatMap(r => r.columns.map(name => [name, r] as const)))]));

	return (t, c) => {
		const ref = fks.get(t)?.get(c.name);
		const target = ref && targetOf(tables, ref);

		return ref && target ? { ref, target } : undefined;
	};
};

/** A table that is a detail of some master, and the fk that makes it one. */
export interface Detail {
	table: TableMeta;
	ref: ReferenceMeta;
}

export const detailsOf = (tables: TableMeta[], master: TableMeta): Detail[] =>
	tables.flatMap(table => table.references
		.filter(ref => ref.isDetail && ref.to === master.entity)
		.map(ref => ({ table, ref })));

/** A row's values under these columns, as the address writes them. */
export const valuesOf = (names: string[], row: Row): string[] => names.map(name => String(row[name]));

/** A row's label: its `isName` columns, or its key when none are marked. */
export function labelOf(t: TableMeta, row: Row): string {
	const named = t.columns.filter(c => c.isName).map(c => c.name);
	const said = (named.length ? named : t.pk).filter(name => row[name] !== null);

	return said.length ? valuesOf(said, row).join(' · ') : valuesOf(t.pk, row).join(' · ');
}

/** The pk of the row the fk points at, or `undefined` if it points at a unique key instead of
 * the pk, or holds a null. Mirrors `isNestable` in `api/crud/mount.ts`. */
export function keyThrough(r: ReferenceMeta, target: TableMeta, row: Row): string[] | undefined {
	if (r.targetColumns.length !== target.pk.length) return undefined;

	const key: string[] = [];

	for (const name of target.pk) {
		const at = r.targetColumns.indexOf(name);

		if (at < 0) return undefined;				// a unique key, not the pk

		const value = row[r.columns[at]];

		if (value === null || value === undefined) return undefined;	// no row is addressed

		key.push(String(value));
	}

	return key;
}

/** What picking `chosen` writes: each fk column takes the value of the target column it maps to.
 * e.g. linea's fk `plato` (plato -> codigo) writes `{ plato: chosen.codigo }` */
export const valuesFrom = (r: ReferenceMeta, chosen: Row): Row =>
	Object.fromEntries(r.columns.map((name, i) => [name, chosen[r.targetColumns[i]]]));

/** The column an fk's list is searched by: the target's first `isName` column, or its pk when
 * that's a single column. `undefined` leaves the list unfiltered. */
export const searchColumn = (target: TableMeta): string | undefined =>
	target.columns.find(c => c.isName)?.name ?? (target.pk.length === 1 ? target.pk[0] : undefined);



// --- Ancestry (SCOPE 6b) ---

/** What a table reached through fks is called, by how many fks it took. The screen goes only as
 * deep as it has words for; the server's own limit is separate and looser. */
export const KINSHIP = ['padre', 'abuelo'];

/** Separates the steps of a reached column's name, e.g. `reserva.cliente.nombre` from `linea`.
 * The server reads the same grammar (`sql/reach.ts`). */
const STEP = '.';

/** A table reached from the one on screen, and the fks walked to get there. */
export interface Ancestor {
	via: ReferenceMeta[];
	table: TableMeta;
}

/** e.g. one fk -> `padre`, two -> `abuelo`. */
export const kinshipOf = (via: ReferenceMeta[]): string => KINSHIP[via.length - 1];

/** The name an ancestor's column goes by, on the wire and in the row. */
export const reachedName = (a: Ancestor, c: ColumnMeta): string =>
	[...a.via.map(r => r.name), c.name].join(STEP);

/** Every table reachable from `t` through fks, nearest first, as deep as `KINSHIP` goes.
 * Two fks onto the same table are two ancestors, told apart by the fk's name. */
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

/** A column a screen can name: one of the table's own (`via` empty), or an ancestor's.
 * What the grid draws, the filter bar offers and the address carries. */
export interface Reachable {
	column: ColumnMeta;
	/** The table the column belongs to. */
	owner: TableMeta;
	via: ReferenceMeta[];
	/** Its name on the wire: its own, or the path that reached it. */
	name: string;
}

export const ownColumns = (t: TableMeta): Reachable[] =>
	t.columns.map(column => ({ column, owner: t, via: [], name: column.name }));

export const reachedColumn = (a: Ancestor, column: ColumnMeta): Reachable =>
	({ column, owner: a.table, via: a.via, name: reachedName(a, column) });

/** Every column a screen can name, its own first. */
export const reachableFrom = (tables: TableMeta[], t: TableMeta): Reachable[] => [
	...ownColumns(t),
	...ancestorsOf(tables, t).flatMap(a => a.table.columns.map(c => reachedColumn(a, c))),
];
