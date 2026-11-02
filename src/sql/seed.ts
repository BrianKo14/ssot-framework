// Sample data: the rows of .tab files, as the statements that insert them

import { parseTab } from 'tab-plus';
import { withValues } from '../db/postgres.js';
import type { TableInfo } from '../schema/model.js';
import { inserted, namedColumns } from '../schema/values.js';
import { script } from './ddl.js';
import { insertSql } from './insert.js';

/** One .tab file. */
export interface Source { entity: string; text: string }

/** A field with nothing in it.
 * (An explicit null is written `\N`, and an empty string `\E`.) */
const OMITTED = Symbol('omitted');

/** Orders the tables so that a row's parents are always inserted before it. */
function parentsFirst(tables: TableInfo[]): TableInfo[] {
	const ordered = new Set<TableInfo>();
	const pending: TableInfo[] = [];

	const visit = (t: TableInfo): void => {
		if (ordered.has(t)) return;

		if (pending.includes(t))
			throw new Error(`no order inserts ${[...pending.slice(pending.indexOf(t)), t].map(p => p.entity).join(' -> ')}: they reference each other`);

		pending.push(t);
		for (const r of t.references) if (r.to !== t) visit(r.to);
		pending.pop();

		ordered.add(t);
	};

	tables.forEach(visit);

	return [...ordered];
}

/** Gives SQL INSERT statements for each row in the source file. */
function insertsOf(t: TableInfo, source: Source): string[] {
	const { fields, rows } = parseTab(source.text, { emptyField: OMITTED });
	const file = `${source.entity}.tab`;

	const names = fields.map(name => {
		if (typeof name !== 'string' || !name) throw new Error(`${file}: the header has a column with no name`);
		return name;
	});

	const repeated = names.find((name, i) => names.indexOf(name) !== i);

	if (repeated !== undefined) throw new Error(`${file}: the header names "${repeated}" twice`);

	try { namedColumns(t.byName, Object.fromEntries(names.map(name => [name, null]))); }
	catch (err) { throw new Error(`${file}, header: ${(err as Error).message}`); }

	return rows.map((row, i) => {
		const at = `${file}, row ${i + 1}`;

		if (row.length > names.length)
			throw new Error(`${at}: ${row.length} fields, but the header names ${names.length}`);

		// A row shorter than the header leaves its last columns empty, as if they were written so
		const raw = Object.fromEntries(names.flatMap((name, j) =>
			row[j] === undefined || row[j] === OMITTED ? [] : [[name, row[j]]]));

		try {
			const { given, values } = inserted(t, raw);

			return withValues(insertSql(t, given), given.map(c => values[c.name]));
		} catch (err) { throw new Error(`${at}: ${(err as Error).message}`); }
	});
}

/** The script that inserts every row of `sources`.
 * Parents go before children, each file in its own order.
 *
 * @param tables the system's tables, as `tablesFrom` built them.
 * @param sources one per entity. */
export function seedSql(tables: TableInfo[], sources: Source[], header: string): string {
	const byEntity = new Map(sources.map(s => [s.entity, s]));
	const known = new Set(tables.map(t => t.entity));
	const unknown = sources.find(s => !known.has(s.entity));

	// Refuse .tab files for entities the system doesn't define
	if (unknown) throw new Error(`${unknown.entity}.tab: the system has no entity "${unknown.entity}"`);

	return script(parentsFirst(tables).flatMap(t => {
		const source = byEntity.get(t.entity);
		return source ? insertsOf(t, source) : [];
	}), header);
}
