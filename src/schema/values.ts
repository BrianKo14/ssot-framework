// Checking values on their way into the database, and reading them back out.

import { HttpError } from '../errors.js';
import type { FieldErrors } from '../shared/api.js';
import type { ColumnInfo, Columns, TableInfo } from './model.js';

/** Takes the keys the client sent and returns the matching schema columns, in the order the client sent them.
 * Refuses any name the schema doesn't declare. */
export function namedColumns(columns: Columns, raw: Record<string, unknown>): ColumnInfo[] {
	const named: ColumnInfo[] = [];
	const unknown: string[] = [];

	for (const name of Object.keys(raw)) {
		const column = columns.get(name);
		if (column) named.push(column); else unknown.push(name);
	}

	if (unknown.length) throw new HttpError(400, `unknown column(s): ${unknown.join(', ')}`);

	return named;
}

/** A value the client sent, once its column's type handler has had a look at it. */
export type Checked = { ok: true; value: unknown } | { ok: false; error: string };

/** One value against one column's own type handler — the single place a wire value is judged,
 * shared by writes (`checkedValues`) and by filters (`filterConditions`).
 *
 * `given` is `undefined` when the caller never named the column at all: that reads as null just
 * like an explicit one, and only changes the wording of the refusal.
 *
 * @param required whether to refuse null for a non-nullable column — true for writes, false for
 * filters, where a null asks `is null` and asserts nothing about nullability. */
export function checkedValue(c: ColumnInfo, given: unknown, required: boolean): Checked {
	if (given === undefined || given === null) {
		if (required && !c.nullable)
			return { ok: false, error: `${c.name} ${given === null ? 'cannot be null' : 'is required'}` };

		return { ok: true, value: null };
	}

	const checked = c.type.check(given);

	return checked.ok
		? { ok: true, value: checked.value }
		: { ok: false, error: `${c.name} must be ${c.type.expected}` };
}

/** Every refusal a request collected, reported together rather than one at a time. */
export function refuseAll(errors: string[], fields?: FieldErrors): void {
	if (errors.length) throw new HttpError(400, errors.join('; '), fields);
}

/** For each column, check the value against that column's type handler.
 * Throws 400 with a message listing every offending column if any fail.
 *
 * @param cols the schema columns to check against
 * @param raw the values the client sent, keyed by column name
 * @param required whether to refuse null for non-nullable columns, usually true for writes and false for filters.
 *
 * @returns the values to bind, keyed by column name */
export function checkedValues(
	cols: ColumnInfo[],
	raw: Record<string, unknown>,
	required: boolean,
): Record<string, unknown> {
	const values: Record<string, unknown> = {};
	const failed: [string, string][] = [];

	for (const c of cols) {
		const checked = checkedValue(c, raw[c.name], required);

		if (checked.ok) values[c.name] = checked.value;
		else failed.push([c.name, checked.error]);
	}

	refuseAll(failed.map(([, message]) => message), Object.fromEntries(failed));

	return values;
}

/** Required on insert = not nullable AND without a default. */
const requiredOnInsert = (c: ColumnInfo) => !c.nullable && c.defaultSql === null;

/** Checks new row before an insert into the database.
 *
 * @param raw the row's values, keyed by column name; an absent key leaves the column to its default
 *
 * @returns the columns to insert, in table order, and their values to bind */
export function inserted(t: TableInfo, raw: Record<string, unknown>): { given: ColumnInfo[]; values: Record<string, unknown> } {
	namedColumns(t.byName, raw);

	const given = t.columns.filter(c => c.name in raw || requiredOnInsert(c));

	if (!given.length) throw new HttpError(400, 'no columns provided');

	return { given, values: checkedValues(given, raw, true) };
}

/** A row as the database returned it -> the values to send on the wire.
 * e.g. "7" -> 7, "t" -> true, "2026-02-28" -> "2026-02-28".
 *
 * Throws a generic Error (=> 500) when a stored value doesn't match the column type,
 * indicating a schema/database mismatch.
 *
 * @param cols the schema columns the row was selected with
 * @param row the row, keyed by column name */
export function rowValues(cols: ColumnInfo[], row: Record<string, unknown>): Record<string, unknown> {
	const values: Record<string, unknown> = {};

	for (const c of cols) {
		const stored = row[c.name] ?? null;

		if (stored === null) { values[c.name] = null; continue; }

		const checked = c.type.check(stored);

		if (!checked.ok)
			throw new Error(`${c.name} holds ${JSON.stringify(stored)}, which is not ${c.type.expected}`);

		values[c.name] = checked.value;
	}

	return values;
}

export function asRecord(body: unknown): Record<string, unknown> {
	if (body === null || typeof body !== 'object' || Array.isArray(body))
		throw new HttpError(400, 'body must be a JSON object');

	return body as Record<string, unknown>;
}
