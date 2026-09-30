// For multilevel GETs

import type { Db } from '../db/postgres.js';
import { HttpError } from '../errors.js';
import type { ColumnInfo, ReferenceInfo, TableInfo } from '../schema/model.js';
import { STAMP } from '../schema/reserved.js';
import { isObject, jsonParam, where } from '../sql/filter.js';
import { columnList } from '../sql/identifier.js';
import { type Reading, reading } from '../sql/reach.js';


type Row = Record<string, unknown>;

/** The key a row carries its children under: `row._children[<entity>]` = the rows. */
export const CHILDREN = '_children';

/** One child table `?children=` asks for and through which fk (if clarification is needed).
 * E.g. `"ventas.linea"`, or `{"entity": "partido", "fk": "local"}` */
type Asked = string | { entity: string; fk: string };

const isAsked = (x: unknown): x is Asked =>
	typeof x === 'string'
	|| (isObject(x) && Object.keys(x).length === 2 && typeof x.entity === 'string' && typeof x.fk === 'string');

const isAskedList = (x: unknown): x is Asked[] => Array.isArray(x) && x.every(isAsked);


/** How a child table is read and its rows sent to the client. */
export type Send = (t: TableInfo, columns: ColumnInfo[], rows: Row[]) => Promise<Row[]>;

/** The children a read asked for, already checked against the schema. */
export interface Family {
	/** Puts on each row the children it has.
	 * @param parent how the rows were read
	 * @param conditions the `where` they were read with
	 * @param params that `where`'s parameters */
	attach(rows: Row[], parent: Reading, conditions: string, params: unknown[]): Promise<void>;
}



// --- GROUPING ---

/** Same values under the given columns, same key. */
const keyOf = (columns: ColumnInfo[], row: Row) => JSON.stringify(columns.map(c => row[c.name]));

const grouped = (rows: Row[], columns: ColumnInfo[]): Map<string, Row[]> => {
	const groups = new Map<string, Row[]>();

	for (const row of rows) {
		const key = keyOf(columns, row);
		groups.set(key, [...groups.get(key) ?? [], row]);
	}

	return groups;
};

/** A row's children, by entity. Created the first time something goes in. */
const childrenOf = (row: Row): Record<string, Row[]> => (row[CHILDREN] ??= {}) as Record<string, Row[]>;



/** Reads `?children=` against the tables that point at `t`.
 * Throws 400 before anything is queried, for a name that is not a child (or not readable).
 * @param raw the `children` query parameter */
export function family(db: Db, send: Send, t: TableInfo, raw: unknown, mayRead: (x: TableInfo) => boolean): Family {
	const asked = jsonParam(raw, 'children', 'a JSON array of child tables', isAskedList, []);

	const refs: ReferenceInfo[] = [];
	const unknown: string[] = [];

	// For each asked child table...
	for (const item of asked) {
		const { entity, fk } = typeof item === 'string' ? { entity: item, fk: undefined } : item;
		const through = t.referencedBy.filter(r => r.from.entity === entity && mayRead(r.from));
		const named = fk === undefined ? through : through.filter(r => r.name === fk);

		if (!named.length) { unknown.push(fk === undefined ? entity : `${entity} (${fk})`); continue; }

		// If not fk is mentioned but there are multiple fks pointing at `t`...
		if (named.length > 1)
			throw new HttpError(400, `${entity} points at ${t.entity} through ${named.map(r => r.name).join(', ')}; `
				+ `ask for {"entity": "${entity}", "fk": …}`);

		if (refs.some(r => r.from === named[0].from))
			throw new HttpError(400, `${entity}: a child table may be asked for once`);

		refs.push(named[0]);
	}

	if (unknown.length) throw new HttpError(400, `unknown child table(s): ${unknown.join(', ')}`);

	return {
		attach: async (rows, parent, conditions, params) => {
			await Promise.all(refs.map(async ref => {
				const child = ref.from;
				const read = reading(child, [], mayRead);

				const within = where([
					`(${columnList(ref.columns, read.at)}) in (${parent.statement(ref.targetColumns, conditions)})`]);

				const found = await send(child, child.columns, await db.query(
					`${read.statement([...child.columns, STAMP], within)} order by ${read.order}`, params));

				const byParent = grouped(found, ref.columns);

				for (const row of rows)
					childrenOf(row)[child.entity] = byParent.get(keyOf(ref.targetColumns, row)) ?? [];
			}));
		},
	};
}
