// Checking values on their way into the database.

import { HttpError } from './http.js';
import type { ColumnInfo } from './schema.js';

/** The schema's columns, by name, to pass to `namedColumns`. */
export type Columns = ReadonlyMap<string, ColumnInfo>;

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
	const errors: string[] = [];

	for (const c of cols) {
		const given = raw[c.name] ?? null;

		if (given === null) {
			if (required && !c.nullable) errors.push(`${c.name} ${c.name in raw ? 'cannot be null' : 'is required'}`);
			else values[c.name] = null;
			continue;
		}

		const checked = c.type.check(given);

		if (checked.ok) values[c.name] = checked.value;
		else errors.push(`${c.name} must be ${c.type.expected}`);
	}

	if (errors.length) throw new HttpError(400, errors.join('; '));

	return values;
}

export function asRecord(body: unknown): Record<string, unknown> {
	if (body === null || typeof body !== 'object' || Array.isArray(body))
		throw new HttpError(400, 'body must be a JSON object');

	return body as Record<string, unknown>;
}
