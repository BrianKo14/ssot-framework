// Reading a filter off the wire

import type { FilterCondition, OperatorMeta } from '../shared/api.js';
import { HttpError } from '../errors.js';
import type { ColumnInfo, Columns } from '../schema/model.js';
import { q } from './identifier.js';
import { type Checked, checkedValue, namedColumns, refuseAll } from '../schema/values.js';


// --- The comparisons ---

interface Operator {
	symbol: string;		// how it is written, e.g. ">="
	label: string;		// what it is called on screen

	/** 
	 * @param col the column name, quoted for SQL
	 * @param param the parameter placeholder, e.g. `$1`, or `null` if there is no operand
	 * @returns the SQL fragment for this comparison, or `undefined` if it can't be express with the given operand (e.g. `> null`)
	 */
	sql(col: string, param: string | null): string | undefined;

	/** Optional. For when the operator is used with a string that should be treated as a pattern (i.e. `contains`). */
	pattern?(raw: string): string;
}

/** `=` / `is null`, and also how a row is addressed by its own pk. */
export const equality = (col: string, param: string | null) =>
	param === null ? `${col} is null` : `${col} = ${param}`;

/** A comparison with no meaning without an operand: `> null` is refused. */
const needsValue = (write: (col: string, param: string) => string) =>
	(col: string, param: string | null) => param === null ? undefined : write(col, param);

/** When an operator takes no value, e.g. `is null`. */
const takesNoValue = (write: (col: string) => string) =>
	(col: string, param: string | null) => param === null ? write(col) : undefined;

/** Escape a string's special characters (like `%` and `_`) for use in a LIKE pattern. */
const escapeLike = (raw: string) => raw.replace(/[\\%_]/g, m => `\\${m}`);

const operators = {
	eq: { symbol: '=', label: 'Es igual a', sql: equality },

	ne: { symbol: '<>', label: 'No es igual a',
		sql: (col, param) => param === null ? `${col} is not null` : `${col} <> ${param}` },

	gt: { symbol: '>', label: 'Es mayor que', sql: needsValue((c, p) => `${c} > ${p}`) },
	lt: { symbol: '<', label: 'Es menor que', sql: needsValue((c, p) => `${c} < ${p}`) },
	ge: { symbol: '>=', label: 'Es mayor o igual que', sql: needsValue((c, p) => `${c} >= ${p}`) },
	le: { symbol: '<=', label: 'Es menor o igual que', sql: needsValue((c, p) => `${c} <= ${p}`) },

	contains: { symbol: '~', label: 'Contiene',
		sql: needsValue((c, p) => `${c}::text ilike ${p} escape '\\'`), 			// cast to text
		pattern: raw => `%${escapeLike(raw)}%` },

	isnull: { symbol: 'is null', label: 'Es null', sql: takesNoValue(c => `${c} is null`) },	// also reachable as `eq` with a null operand
} satisfies Record<string, Operator>;

/** Operator names -> their definitions. */
const byName: ReadonlyMap<string, Operator> = new Map(Object.entries(operators));

/** When no operator is specified. */
const DEFAULT_OP = 'eq';

/** The metadata for each operator, for the frontend to use. */
export const operatorMeta: OperatorMeta[] = [...byName].map(([name, o]) =>
	({ name, symbol: o.symbol, label: o.label, takesValue: o.sql('x', '$1') !== undefined }));


// --- Reading the query parameter ---

export function parseFilter(raw: unknown): Record<string, unknown> {
	if (raw === undefined) return {};
	if (typeof raw !== 'string') throw new HttpError(400, 'filter must be given once');

	let parsed: unknown;
	try { parsed = JSON.parse(raw); }
	catch { throw new HttpError(400, 'filter is not valid JSON'); }

	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
		throw new HttpError(400, 'filter must be a JSON object');

	return parsed as Record<string, unknown>;
}

/** Normalize a filter entry into a list of conditions. */
const asConditions = (name: string, entry: unknown): FilterCondition[] =>
	Array.isArray(entry) ? entry.map(e => asCondition(name, e)) : [asCondition(name, entry)];

const asCondition = (name: string, entry: unknown): FilterCondition => {
	if (entry === null || typeof entry !== 'object') return { op: DEFAULT_OP, value: entry ?? null };

	const { op, value } = entry as Record<string, unknown>;

	if (typeof op !== 'string') throw new HttpError(400, `${name}: a filter condition needs an "op"`);

	return { op, value: value ?? null };
};


// --- Writing the WHERE ---

type Written = { ok: true; sql: string } | { ok: false; error: string };

/** Prepare value for use as an operand in a SQL query. */
const bindable = (c: ColumnInfo, o: Operator, value: unknown): Checked => {
	if (value === null) return { ok: true, value: null };
	if (!o.pattern) return checkedValue(c, value, false);

	return typeof value === 'string'
		? { ok: true, value: o.pattern(value) }
		: { ok: false, error: `${c.name} ${o.symbol} must be text` };
};

/** Write a filter condition as a SQL fragment. */
const written = (c: ColumnInfo, o: Operator, value: unknown, params: unknown[]): Written => {
	const operand = bindable(c, o, value);

	if (!operand.ok) return operand;

	const sql = o.sql(q(c.name), operand.value === null ? null : `$${params.push(operand.value)}`);

	return sql === undefined
		? { ok: false, error: `${c.name} ${o.symbol} ${operand.value === null ? 'needs a value' : 'takes no value'}` }
		: { ok: true, sql };
};

export function filterConditions(columns: Columns, raw: Record<string, unknown>, params: unknown[]): string[] {
	const conditions: string[] = [];
	const errors: string[] = [];

	for (const c of namedColumns(columns, raw))		// refuse names the schema does not declare
		for (const { op, value } of asConditions(c.name, raw[c.name])) {
			const operator = byName.get(op);

			if (!operator) { errors.push(`${c.name}: unknown operator "${op}"`); continue; }

			const one = written(c, operator, value, params);

			if (one.ok) conditions.push(one.sql); else errors.push(one.error);
		}

	refuseAll(errors);					// mistakes are collected and refused together

	return conditions;
}

/** How a request addresses rows by value alone: a row's own pk, and an inherited master key. */
export const equalities = (values: Record<string, unknown>, params: unknown[]): string[] =>
	Object.entries(values).map(([col, value]) =>
		equality(q(col), value === null ? null : `$${params.push(value)}`));

/** WHERE clause builder */
export const where = (conds: string[]) => conds.length ? ` where ${conds.join(' and ')}` : '';
