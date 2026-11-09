// Loading rows: a table's rows, read from some file, as the statements that insert them.
// For: sample data (`db:seed`), initial data (`db:create` / `db:update`), an import over HTTP

import { withValues } from '../db/postgres.js';
import { located } from '../errors.js';
import type { TableInfo } from '../schema/model.js';
import { inserted, namedColumns } from '../schema/values.js';
import { script } from './ddl.js';
import { insertSql } from './insert.js';

type Row = Record<string, unknown>;

/** One file's rows, already read by its format (see `Format.read`). */
export interface Source {
	name: string;
	entity: string;
	/** The column names from its header. */
	names: string[];
	/** Keyed by column name. Fields left empty are absent. */
	rows: Row[];
}

export interface Loading {
	/** The tables to fill. */
	into?: ReadonlySet<TableInfo>;
	/** Optional step that changes each row before it gets checked. */
	fill?: (row: Row) => Row;
}

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

/** Gives SQL INSERT statements for each row in the source. */
function insertsOf(t: TableInfo, source: Source, fill: (row: Row) => Row): string[] {
	try { namedColumns(t.byName, Object.fromEntries(source.names.map(name => [name, null]))); }
	catch (err) { throw located(`${source.name}, header: `, err); }

	return source.rows.map((row, i) => {
		try {
			const { given, values } = inserted(t, fill(row));

			return withValues(insertSql(t, given), given.map(c => values[c.name]));
		} catch (err) { throw located(`${source.name}, row ${i + 1}: `, err); }
	});
}

/** The inserts of every row of `sources`, parents' tables before their children's, each file in its own order.
 *
 * @param tables the system's tables, as `tablesFrom` built them.
 * @param sources one per entity. */
export function loadStatements(tables: TableInfo[], sources: Source[], { into, fill = row => row }: Loading = {}): string[] {
	const byEntity = new Map(sources.map(s => [s.entity, s]));
	const known = new Set(tables.map(t => t.entity));
	const unknown = sources.find(s => !known.has(s.entity));

	// Refuse files for entities the system doesn't define
	if (unknown) throw new Error(`${unknown.name}: the system has no entity "${unknown.entity}"`);

	return parentsFirst(tables).flatMap(t => {
		const source = byEntity.get(t.entity);
		return source && (into?.has(t) ?? true) ? insertsOf(t, source, fill) : [];
	});
}

/** The script that inserts every row of `sources`, as one statement, all or nothing. */
export const seedSql = (tables: TableInfo[], sources: Source[], header: string): string =>
	script(loadStatements(tables, sources), header);
