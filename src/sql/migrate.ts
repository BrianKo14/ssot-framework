// The schema comparator

import type { ColumnInfo, TableInfo } from '../schema/model.js';
import type { Catalog } from './catalog.js';
import {
	type Alteration, alterationKey, alterStatements, type ColumnHeld, comparedType, dropStatements, hasDomain,
	type Held, isForeignKey, objectKey, script, type Target, targets,
} from './ddl.js';

/** A list of targets that are missing from the database.
 * New objects are created. Existing ones are descended into. */
const missingIn = (target: Target, held: Catalog): Target[] =>
	held.has(target.key) ? (target.parts ?? []).flatMap(part => missingIn(part, held)) : [target];

/** A list of all the targets that are missing from the database. */
const missing = (tables: TableInfo[], held: Catalog): Target[] =>
	targets(tables).flatMap(target => missingIn(target, held));

/** Every object the definition asks for, a table's own columns and keys included. */
const wanted = (tables: TableInfo[]): Map<string, Target> => {
	const flat = (target: Target): Target[] => [target, ...(target.parts ?? []).flatMap(flat)];

	return new Map(targets(tables).flatMap(flat).map(target => [target.key, target]));
};

/** The results of comparing a definition against what a database holds. */
export interface Changes {
	/** Columns letting go of a domain that is being rebuilt, before it can be dropped. */
	detachments: Alteration[];
	/** What the database has that the definition does not, or asks for differently. */
	removals: Held[];
	/** What the definition has that the database does not. */
	additions: Target[];
	/** Columns whose body the database holds differently than the definition declares it. */
	alterations: Alteration[];
}

/** Compares a definition against what a database holds, in both directions.
 *
 * @param tables the definition, as `tablesFrom` built it
 * @param held what the database has, as `readCatalog` read it */
export function changes(tables: TableInfo[], held: Catalog): Changes {
	const asked = wanted(tables);

	const byTable = new Map(tables.map(t => [`${t.schema}.${t.table}`, t]));

	// TODO: schemas are never removed. The catalogue never looks at the schemas that are not in the definition.
	const leaving = new Map([...held.values()]
		.filter(h => h.kind !== 'schema')
		.filter(h => {
			const target = asked.get(h.key);

			// When the object is not in the definition.
			if (target === undefined) return true;

			// The types of column changes that require rebuilding.
			if (h.kind !== 'domain' && h.kind !== 'constraint' && h.kind !== 'index') return false;

			// When the object is in the definition but has a different shape.
			return target.shape !== undefined && target.shape !== h.shape;
		})
		.map(h => [h.key, h]));

	// Ensure that foreign keys are not left behind without their referenced keys.
	for (const h of held.values())
		if (h.kind === 'constraint' && isForeignKey(h.shape) && h.dependsOn !== null && leaving.has(h.dependsOn))
			leaving.set(h.key, h);

	// Don't bother with objects that are being dropped together with their table.
	const goingWithItsTable = (h: Held): boolean =>
		(h.kind === 'column' || h.kind === 'constraint' || h.kind === 'index')
		&& leaving.has(objectKey('table', h.schema, h.in));

	const removals = [...leaving.values()].filter(h => !goingWithItsTable(h));

	return {
		...columnChanges(paired(held, byTable, leaving), leaving),
		removals,
		additions: missing(tables, new Map([...held].filter(([key]) => !leaving.has(key)))),
	};
}


// --- COLUMNS ---

/** A pairing of a table, a column from the definition, and a column from the database. */
interface Pair {
	table: TableInfo;
	column: ColumnInfo;
	held: ColumnHeld;
}

/** Pairs the columns from the definition with the columns from the database. */
function paired(held: Catalog, byTable: Map<string, TableInfo>, leaving: ReadonlyMap<string, Held>): Pair[] {
	const pairs: Pair[] = [];

	for (const h of held.values()) {
		if (h.kind !== 'column') continue;
		if (leaving.has(objectKey('table', h.schema, h.in))) continue;

		const table = byTable.get(`${h.schema}.${h.in}`);
		const column = table?.byName.get(h.name);

		if (table !== undefined && column !== undefined) pairs.push({ table, column, held: h });
	}

	return pairs;
}

/** Returns the column changes needed to update the database to match the definition.
 * @param pairs the columns to compare.
 * @param leaving the columns that are being removed.
 * @returns the changes needed. */
function columnChanges(
	pairs: Pair[], leaving: ReadonlyMap<string, Held>,
): Pick<Changes, 'detachments' | 'alterations'> {
	const detachments: Alteration[] = [];
	const alterations: Alteration[] = [];

	/** Adds an alteration to the list if it has any changes. */
	const add = (into: Alteration[], a: Alteration): void => {
		if (a.retype !== null || a.notNull !== null) into.push(a);
	};

	for (const { table, column, held } of pairs) {
		const at = { table, column };
		const notNull = held.notNull === !column.nullable ? null : !column.nullable;

		// If a column depends on a domain that is being removed, we need to
		// detach it from the domain first, then reattach it once the domain is recreated.
		if (held.dependsOn !== null && leaving.has(held.dependsOn)) {
			detachments.push({ ...at, retype: 'storage', notNull: null });
			add(alterations, { ...at, retype: hasDomain(column) ? 'rejoin' : null, notNull });
			continue;
		}

		add(alterations, {
			...at,
			retype: held.type === comparedType(column) ? null : 'declared',
			notNull,
		});
	}

	return { detachments, alterations };
}

/** The columns some statement alters, each named once.
 * @param c the changes to analyze
 * @returns the keys of the columns that are altered */
export const altered = (c: Changes): string[] =>
	[...new Set([...c.detachments, ...c.alterations].map(alterationKey))];


// --- THE SCRIPT ---

/** The readable header of the generated SQL script.
 * It warns the user about the changes that will be made. */
const header = (c: Changes): string => {
	const columns = altered(c).length;

	return ['Generated by comparing the system definition against the database',
		[c.removals.length ? `${c.removals.length} object(s) removed or rebuilt` : '',
			c.additions.length ? `${c.additions.length} object(s) added` : '',
			columns ? `${columns} column(s) altered` : ''].filter(Boolean).join(', '),
	].filter(Boolean).join('\n');
};

/** The script that updates the database to match the definition.
 * @param notes a line to write above each update statement, by `Held.key` / `alterationKey` */
export const updateSql = (c: Changes, notes: ReadonlyMap<string, string> = new Map()): string =>
	script([
		// Columns letting go of a domain that is about to be rebuilt
		...alterStatements(c.detachments, notes),
		// Removals
		...dropStatements(c.removals, notes), 		// `notes` keyed by `Held.key`
		// Additions
		...c.additions.map(target => target.sql),
		// Columns moving to the body the definition declares
		...alterStatements(c.alterations, notes),	// `notes` keyed by `alterationKey`
	], header(c));
