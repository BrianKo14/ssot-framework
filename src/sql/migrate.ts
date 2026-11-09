// The schema comparator

import type { ColumnInfo, RoutineInfo, TableInfo } from '../schema/model.js';
import type { Catalog } from './catalog.js';
import {
	type Alteration, alterationKey, alterStatements, type ColumnHeld, comparedType, dropStatements, hasDomain,
	type Held, objectKey, script, type Target, targets,
} from './ddl.js';

/** A list of targets that are missing from the database.
 * New objects are created. Existing ones are descended into. */
const missingIn = (target: Target, held: Catalog): Target[] =>
	held.has(target.key) ? (target.parts ?? []).flatMap(part => missingIn(part, held)) : [target];

/** A list of all the targets that are missing from the database. */
const missing = (asked: Target[], held: Catalog): Target[] =>
	asked.flatMap(target => missingIn(target, held));

/** Every object the definition asks for, a table's own columns and keys included. */
const wanted = (asked: Target[]): Map<string, Target> => {
	const flat = (target: Target): Target[] => [target, ...(target.parts ?? []).flatMap(flat)];

	return new Map(asked.flatMap(flat).map(target => [target.key, target]));
};

/** The results of comparing a definition against what a database holds. */
export interface Changes {
	/** Columns letting go of a domain that is being rebuilt, before it can be dropped. */
	detachments: Alteration[];
	/** What the database has that the definition does not, or asks for differently. */
	removals: Held[];
	/** What the definition has that the database does not. */
	additions: Target[];
	/** What the database has with the same signature but different body, i.e. in routines. */
	replacements: Target[];
	/** Columns whose body the database holds differently than the definition declares it. */
	alterations: Alteration[];
}

/** Compares a definition against what a database holds, in both directions.
 *
 * @param tables the definition, as `tablesFrom` built it
 * @param held what the database has, as `readCatalog` read it
 * @param routines the definition's routines, as `routinesFrom` built them */
export function changes(tables: TableInfo[], held: Catalog, routines: RoutineInfo[] = []): Changes {
	const all = targets(tables, routines);
	const asked = wanted(all);

	const byTable = new Map(tables.map(t => [`${t.schema}.${t.table}`, t]));

	// TODO: schemas are never removed. The catalogue never looks at the schemas that are not in the definition.
	const leaving = new Map<string, Held>([...held.values()]
		.filter(h => h.kind !== 'schema')
		.filter(h => {
			const target = asked.get(h.key);

			// When the object is not in the definition.
			if (target === undefined) return true;

			// Those rebuilt when their shape differs, as opposed to altered in place
			if (h.kind !== 'domain' && h.kind !== 'constraint' && h.kind !== 'index'
				&& h.kind !== 'function' && h.kind !== 'procedure') return false;

			// When the object is in the definition but has a different shape.
			return target.shape !== undefined && target.shape !== h.shape;
		})
		.map(h => [h.key, h]));

	// Remove references as well (FKs with no target, triggers with no routine, routines with no domain)
	for (let grew = true; grew;) {
		grew = false;

		for (const h of held.values())
			if (h.kind !== 'column' && !leaving.has(h.key) && h.dependsOn.some(key => leaving.has(key))) {
				leaving.set(h.key, h);
				grew = true;
			}
	}

	// Don't bother with objects that are being dropped together with their table
	const goingWithItsTable = (h: Held): boolean =>
		(h.kind === 'column' || h.kind === 'constraint' || h.kind === 'index' || h.kind === 'trigger')
		&& leaving.has(objectKey('table', h.schema, h.in));

	const removals = [...leaving.values()].filter(h => !goingWithItsTable(h));

	// Whatever stays but has another body is replaced in place
	const replacements = [...held.values()].flatMap(h => {
		const target = asked.get(h.key);

		const replaceable = h.kind === 'function' || h.kind === 'procedure' || h.kind === 'trigger';

		return replaceable && target?.source !== undefined && !leaving.has(h.key) && target.source !== h.source
			? [target] : [];
	});

	return {
		...columnChanges(paired(held, byTable, leaving), leaving),
		removals,
		additions: missing(all, new Map([...held].filter(([key]) => !leaving.has(key)))),
		replacements,
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
		if (held.dependsOn.some(key => leaving.has(key))) {
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
			c.replacements.length ? `${c.replacements.length} routine(s) or trigger(s) replaced` : '',
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
		// Replacements
		...c.replacements.map(target => target.sql),
		// Columns moving to the body the definition declares
		...alterStatements(c.alterations, notes),	// `notes` keyed by `alterationKey`
	], header(c));
