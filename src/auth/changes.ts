// Versioning

import type { Db } from '../db/postgres.js';
import type { ColumnInfo, TableInfo } from '../schema/model.js';
import { STAMP } from '../schema/reserved.js';
import { rowValues } from '../schema/values.js';
import type { Change, Logged, Undoable } from '../shared/api.js';
import { where } from '../sql/filter.js';
import { columnList, q, tableRef } from '../sql/identifier.js';
import { changeTable, col } from './entities.js';


// --- Column names ---
// (To avoid typos)

const	C_ENTITY = col(changeTable, 'entity'),
	C_RECORD = col(changeTable, 'record'),
	C_FIELD = col(changeTable, 'field'),
	C_VERSION = col(changeTable, 'version'),
	C_WAS = col(changeTable, 'was'),
	C_AT = col(changeTable, 'at'),
	C_BY = col(changeTable, 'by');

/** The set of columns that a change record contains. */
const WRITTEN = [C_ENTITY, C_RECORD, C_FIELD, C_VERSION, C_WAS, C_BY];

/** The set of columns that a change record shows. */
const SHOWN = [C_FIELD, C_WAS, C_VERSION, C_AT, C_BY];

/** CTEs */
const BEFORE = 'before', WROTE = 'wrote', PER_COLUMN = 'changed', GONE = 'gone';

const DIFFERS = 'differs';

/** The column name for the undoable changes. */
export const UNDO = '_undo';

const table = tableRef(changeTable);

/** The address of a record in the log. */
const addressAt = (alias: string, pk: ColumnInfo[]) =>
	`concat_ws('/', ${columnList(pk, c => `${q(alias)}.${q(c.name)}::text`)})`;

/** A change as it is read from the log. */
const change = (row: Record<string, unknown>): Change => {
	const read = rowValues(SHOWN, row);

	return {
		field: String(read[C_FIELD.name]),
		was: read[C_WAS.name] === null ? null : String(read[C_WAS.name]),
		version: String(read[C_VERSION.name]),
		at: String(read[C_AT.name]),
		by: String(read[C_BY.name]),
	};
};


// --- Writing ---

/** A write that is being logged. */
export interface Writing {
	t: TableInfo;
	/** The columns the write sets. */
	given: ColumnInfo[];
	/** `where` conditions for the write. */
	addressed: string[];
	/** Who is writing. */
	by: string;
	params: unknown[];
}

/** A write, wrapped in the CTEs that log what it overwrote.
 * Atomic, as one statement: before + write + log.
 *
 * @param write the `update ... returning ...` as it would be sent unlogged
 * @param answer the columns the statement gives back, named as `write` returns them */
export function logging({ t, given, addressed, by, params }: Writing, write: string, answer: string): string {
	const per = given.map(c =>
		`($${params.push(c.name)}::text, ${q(BEFORE)}.${q(c.name)}::text,`
		+ ` ${q(BEFORE)}.${q(c.name)} is distinct from ${q(WROTE)}.${q(c.name)})`);

	const logged =
		`insert into ${table} (${columnList(WRITTEN)})`
		+ ` select $${params.push(t.entity)}, ${addressAt(WROTE, t.pk)},`
		+ ` ${q(PER_COLUMN)}.${q(C_FIELD.name)}, ${q(WROTE)}.${q(STAMP.name)},`
		+ ` ${q(PER_COLUMN)}.${q(C_WAS.name)}, $${params.push(by)}`
		+ ` from ${q(BEFORE)}, ${q(WROTE)},`
		+ ` lateral (values ${per.join(', ')})`
		+ ` as ${q(PER_COLUMN)}(${columnList([C_FIELD, C_WAS])}, ${q(DIFFERS)})`
		+ ` where ${q(PER_COLUMN)}.${q(DIFFERS)}`;

	return `with ${q(BEFORE)} as (select ${columnList(given)} from ${tableRef(t)}${where(addressed)}),`
		+ ` ${q(WROTE)} as (${write}),`
		+ ` "logged" as (${logged})`
		+ ` select ${answer} from ${q(WROTE)}`;
}

/** A delete, wrapped so the record's history also goes
 * Atomic, one statement: delete + log + forget.
 *
 * @param remove the `delete ... returning <pk>` as it would be sent unlogged
 * @param answer the pk columns, named as `remove` returns them */
export function forgetting(t: TableInfo, params: unknown[], remove: string, answer: string): string {
	const forgotten =
		`delete from ${table} where ${q(C_ENTITY.name)} = $${params.push(t.entity)}`
		+ ` and ${q(C_RECORD.name)} in (select ${addressAt(GONE, t.pk)} from ${q(GONE)})`;

	return `with ${q(GONE)} as (${remove}), "forgotten" as (${forgotten})`
		+ ` select ${answer} from ${q(GONE)}`;
}


// --- Reading ---

export interface Changes {
	/** The newest change per column, for each of the records: what an undo writes back.
	 * Keyed by the record's address. */
	newest(entity: string, records: string[]): Promise<Map<string, Undoable>>;

	/** A record's history, newest first.
	 * @param field one column's, when the question is about a field rather than a record
	 * @param now the record right now */
	history(entity: string, record: string, field: string | null,
		now: Record<string, unknown>): Promise<Logged[]>;
}

export function changeStore(db: Db): Changes {
	return {
		async newest(entity, records) {
			const by = new Map<string, Undoable>();

			if (!records.length) return by;

			const params: unknown[] = [entity, records];

			// `distinct on` + `order by` returns the newest row per column
			const rows = await db.query(
				`select distinct on (${columnList([C_RECORD, C_FIELD])})`
				+ ` ${columnList([C_RECORD, ...SHOWN])} from ${table}`
				+ ` where ${q(C_ENTITY.name)} = $1 and ${q(C_RECORD.name)} = any($2::text[])`
				+ ` order by ${columnList([C_RECORD, C_FIELD])}, ${q(C_VERSION.name)} desc`,
				params);

			for (const row of rows) {
				const at = String(row[C_RECORD.name]);
				const undoable = by.get(at) ?? {};
				const one = change(row);

				undoable[one.field] = one;
				by.set(at, undoable);
			}

			return by;
		},

		async history(entity, record, field, now) {
			const params: unknown[] = [entity, record];

			// about a field rather than a record (i.e. one more condition)
			const named = field === null ? '' : ` and ${q(C_FIELD.name)} = $${params.push(field)}`;

			const rows = await db.query(
				`select ${columnList(SHOWN)} from ${table}`
				+ ` where ${q(C_ENTITY.name)} = $1 and ${q(C_RECORD.name)} = $2${named}`
				+ ` order by ${q(C_VERSION.name)} desc, ${q(C_FIELD.name)}`,
				params);

			/** History of a record, newest first, incl. current. */
			const since = new Map<string, unknown>();

			return rows.map(change).map(one => {
				const became = since.has(one.field)
					? since.get(one.field)
					: now[one.field] ?? null;

				since.set(one.field, one.was);

				return { ...one, became: became === null ? null : String(became) };
			});
		},
	};
}
