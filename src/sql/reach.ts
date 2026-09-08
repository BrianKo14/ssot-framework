// Querying across foreign keys

import { HttpError } from '../errors.js';
import type { ColumnInfo, Columns, ReferenceInfo, TableInfo } from '../schema/model.js';
import { namedColumns } from '../schema/values.js';
import { jsonParam } from './filter.js';
import { columnList, q, tableRef } from './identifier.js';

/** What separates the steps of a path of foreign keys. */
const STEP = '.';

/** The alias of the table being read. */
const BASE = 't';

/** A path may not be longer than this. A table that points at itself makes it infinite. */
const MAX_STEPS = 4;

/** How many tables one read may reach. Each is a join. */
const MAX_REACHED = 10;

/** How one of the read table's own columns is called in the query.
 * E.g. `atBase('fecha')` = `"t"."fecha"` */
export const atBase = (name: string) => `${q(BASE)}.${q(name)}`;

/** Checks if a value is an array of strings. */
const isNames = (x: unknown): x is string[] =>
	Array.isArray(x) && x.every(name => typeof name === 'string');

/** Parses the `with` query parameter and validates it. */
export const parseReached = (raw: unknown): string[] =>
	jsonParam(raw, 'with', 'a JSON array of column names', isNames, []);

/** One read table w/ info about what it reached. */
export interface Reading {
	/** The columns this read can name. I.e. the table's own columns, plus each one it reached. */
	byName: Columns;
	/** How a column is written in this query, e.g. `"t"."fecha"` or `"j1"."nombre"`. */
	at(c: ColumnInfo): string;
	/** The columns the answer holds: the table's own, then the reached ones `asked` for.
	 * Refuses a name that reached nothing, in the same words as an unknown filter key.
	 * @param asked the `?with=` names; one of the table's own is a no-op. */
	shown(asked: string[]): ColumnInfo[];
	/** `select … from … left join … [conditions]`
	 * @param columns what to select, as `shown` returned it. */
	statement(columns: ColumnInfo[], conditions: string): string;
	/** What to `order by`: the pk, written for this query. */
	order: string;
}

/** A column of a reached table, seen from the table being read: the very same column, under the
    name the path gives it. `nullable` because an unmatched row answers null however the column
    is declared over there, and no default because nothing here is ever written. */
const borrowed = (name: string, c: ColumnInfo): ColumnInfo =>
	({ ...c, name, nullable: true, defaultValue: null, defaultSql: null });

const joinOn = (alias: string, ref: ReferenceInfo, from: string) =>
	ref.targetColumns
		.map((c, i) => `${q(alias)}.${q(c.name)} = ${q(from)}.${q(ref.columns[i].name)}`)
		.join(' and ');

/** A reading of a table + info about other tables it reached.
 * 
 * @param t the table being read
 * @param mentioned the columns the request named, in `?with=` or in its filter
 * @param mayRead whether the caller has permission to read a table */
export function reading(t: TableInfo, mentioned: string[], mayRead: (x: TableInfo) => boolean): Reading {

	const byName = new Map(t.byName);
	/** The columns this read has found in the tables it reached. */
	const written = new Map<ColumnInfo, string>(t.columns.map(c => [c, atBase(c.name)]));

	/** The aliases of each table reached + mark that it's been walked.
	 * E.g. `reserva` -> `j1`, `reserva.cliente` -> `j2` */
	const aliases = new Map<string, string>();
	const joins: string[] = [];

	/** Walks one path, joining each table it steps into. */
	const reach = (steps: string[]): { table: TableInfo; alias: string; via: ReferenceInfo[] } | undefined => {
		let table = t, alias = BASE, path = '';
		const via: ReferenceInfo[] = [];

		for (const step of steps) {
			const ref = table.references.find(r => r.name === step);

			if (!ref || !mayRead(ref.to)) return undefined;	// names nothing this caller can follow

			if (via.length === MAX_STEPS)
				throw new HttpError(400, `a column may be reached through at most ${MAX_STEPS} foreign keys`);

			via.push(ref);
			path = path === '' ? step : `${path}${STEP}${step}`;

			let reached = aliases.get(path);

			if (reached === undefined) {
				if (aliases.size === MAX_REACHED)
					throw new HttpError(400, `a read may reach at most ${MAX_REACHED} tables`);

				reached = `j${aliases.size + 1}`;

				joins.push(` left join ${tableRef(ref.to)} ${q(reached)} on ${joinOn(reached, ref, alias)}`);
				aliases.set(path, reached);
			}

			alias = reached;
			table = ref.to;
		}

		return { table, alias, via };
	};

	// For each mentioned column, try to reach it.
	for (const name of mentioned) {
		if (byName.has(name)) continue;				// in this table already 

		const steps = name.split(STEP);
		const last = steps.at(-1);

		if (steps.length < 2 || last === undefined) continue;	// no FK path to follow

		const reached = reach(steps.slice(0, -1));
		const column = reached?.table.byName.get(last);

		if (!reached || !column) continue;			// names nothing readable

		// Rebuild the name from schema data (for security)
		const called = [...reached.via.map(r => r.name), column.name].join(STEP);
		const borrowedColumn = borrowed(called, column);

		byName.set(called, borrowedColumn);
		written.set(borrowedColumn, `${q(reached.alias)}.${q(column.name)}`);
	}

	// Return the SQL expression for a column, or fall back to its base name
	const at = (c: ColumnInfo) => written.get(c) ?? atBase(c.name);

	const from = `${tableRef(t)} ${q(BASE)}${joins.join('')}`;

	return {
		byName,
		at,
		order: columnList(t.pk, at),

		// `namedColumns` is what refuses a name nothing declares, so it is asked here rather
		// than a second refusal being written for `?with=`
		shown: asked => [
			...t.columns,
			...namedColumns(byName, Object.fromEntries(asked.map(name => [name, null])))
				.filter(c => !t.columns.includes(c)),
		],

		// every column is aliased, the table's own included: one shape, reached or not
		statement: (columns, conditions) =>
			`select ${columnList(columns, c => `${at(c)} as ${q(c.name)}`)} from ${from}${conditions}`,
	};
}
