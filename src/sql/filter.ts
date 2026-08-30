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
	/** `col` arrives quoted; `param` is the `$n` the operand was bound to, or `null` when there
	 *  was none. `undefined` back means the comparison has no such form. */
	sql(col: string, param: string | null): string | undefined;
	/** Present means the operand is free text — a pattern, not a value of the column's own type. */
	pattern?(raw: string): string;
}

/** `=` / `is null`, and also how a row is addressed by its own pk: one definition. */
export const equality = (col: string, param: string | null) =>
	param === null ? `${col} is null` : `${col} = ${param}`;

/** A comparison with no meaning without an operand: `> null` is refused, not translated. */
const needsValue = (write: (col: string, param: string) => string) =>
	(col: string, param: string | null) => param === null ? undefined : write(col, param);

/** The mirror: a comparison that is the whole question, so an operand after it is refused too. */
const takesNoValue = (write: (col: string) => string) =>
	(col: string, param: string | null) => param === null ? write(col) : undefined;

/** `%` and `_` are LIKE's own wildcards; someone typing them into a filter means the characters. */
const escapeLike = (raw: string) => raw.replace(/[\\%_]/g, m => `\\${m}`);

const operators = {
	eq: { symbol: '=', label: 'Es igual a', sql: equality },

	ne: { symbol: '<>', label: 'No es igual a',
		sql: (col, param) => param === null ? `${col} is not null` : `${col} <> ${param}` },

	gt: { symbol: '>', label: 'Es mayor que', sql: needsValue((c, p) => `${c} > ${p}`) },
	lt: { symbol: '<', label: 'Es menor que', sql: needsValue((c, p) => `${c} < ${p}`) },
	ge: { symbol: '>=', label: 'Es mayor o igual que', sql: needsValue((c, p) => `${c} >= ${p}`) },
	le: { symbol: '<=', label: 'Es menor o igual que', sql: needsValue((c, p) => `${c} <= ${p}`) },

	// `::text` lets one entry cover every column: "contains" asks about the written form, which is
	// the same question for a number as for a name.
	contains: { symbol: '~', label: 'Contiene',
		sql: needsValue((c, p) => `${c}::text ilike ${p} escape '\\'`),
		pattern: raw => `%${escapeLike(raw)}%` },

	// Reachable through `eq` with a null value too, but only by knowing the rule; here it is on
	// the menu.
	isnull: { symbol: 'is null', label: 'Es null', sql: takesNoValue(c => `${c} is null`) },
} satisfies Record<string, Operator>;

/** A Map, not the object itself: `operators["constructor"]` would answer with something. */
const byName: ReadonlyMap<string, Operator> = new Map(Object.entries(operators));

/** What a bare value asks for, per Nota 1. */
const DEFAULT_OP = 'eq';

/** The descriptive half, for `/api/_meta`. `takesValue` is asked of `sql`, not declared beside
 * it: a comparison takes a value exactly when it has a form with one, and the same fact written
 * twice would be free to disagree. */
export const operatorMeta: OperatorMeta[] = [...byName].map(([name, o]) =>
	({ name, symbol: o.symbol, label: o.label, takesValue: o.sql('x', '$1') !== undefined }));


// --- Reading the query parameter ---

/** The `?filter=` parameter as it arrived: still untrusted, only known to be a JSON object. */
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

/** What one entry of the filter object asks of its column. */
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

/** The operand as it will be bound: a pattern reads free text, anything else reads a value of the
 * column's own type, through that column's own handler. */
const bindable = (c: ColumnInfo, o: Operator, value: unknown): Checked => {
	if (value === null) return { ok: true, value: null };
	if (!o.pattern) return checkedValue(c, value, false);

	return typeof value === 'string'
		? { ok: true, value: o.pattern(value) }
		: { ok: false, error: `${c.name} ${o.symbol} must be text` };
};

/** One column tested by one comparison, with its operand bound onto `params`. */
const written = (c: ColumnInfo, o: Operator, value: unknown, params: unknown[]): Written => {
	const operand = bindable(c, o, value);

	if (!operand.ok) return operand;

	const sql = o.sql(q(c.name), operand.value === null ? null : `$${params.push(operand.value)}`);

	// No form for the operand it got, and the operand says which way round to say so.
	return sql === undefined
		? { ok: false, error: `${c.name} ${o.symbol} ${operand.value === null ? 'needs a value' : 'takes no value'}` }
		: { ok: true, sql };
};

/** Every condition a list request asks for, with the operands bound onto `params`. Unusable ones
 * are collected and refused together; an unknown *column* still stops the request in
 * `namedColumns`, being a different mistake from asking a column the wrong question. */
export function filterConditions(columns: Columns, raw: Record<string, unknown>, params: unknown[]): string[] {
	const conditions: string[] = [];
	const errors: string[] = [];

	for (const c of namedColumns(columns, raw))				// refuse names the schema does not declare
		for (const { op, value } of asConditions(c.name, raw[c.name])) {
			const operator = byName.get(op);

			if (!operator) { errors.push(`${c.name}: unknown operator "${op}"`); continue; }

			const one = written(c, operator, value, params);

			if (one.ok) conditions.push(one.sql); else errors.push(one.error);
		}

	refuseAll(errors);

	return conditions;
}

/** How a request addresses rows by value alone: a row's own pk, and an inherited master key. */
export const equalities = (values: Record<string, unknown>, params: unknown[]): string[] =>
	Object.entries(values).map(([col, value]) =>
		equality(q(col), value === null ? null : `$${params.push(value)}`));

/** WHERE clause builder */
export const where = (conds: string[]) => conds.length ? ` where ${conds.join(' and ')}` : '';
