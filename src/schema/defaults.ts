// What a field's default becomes in SQL, resolved once at boot

import type { DefaultDef } from 'system-definition';
import type { TypeHandler } from '../types/handler.js';

/** The generators a default may name -> SQL. */
const GENERATORS: ReadonlyMap<string, string> = new Map([
	['today', 'current_date'],
	['now', 'current_timestamp'],
]);

/** A checked value as an SQL literal. */
function sqlLiteral(value: unknown, where: string): string {
	if (value === null) return 'null';
	if (typeof value === 'boolean') return value ? 'true' : 'false';

	if (typeof value === 'number') {
		if (!Number.isFinite(value)) throw new Error(`${where}: ${value} is not a value a column can default to`);

		return String(value);
	}

	if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`;

	throw new Error(`${where}: a default of type ${typeof value} cannot be written as SQL`);
}

/** A field's `defaultValue` -> the SQL expression the column defaults to, or null for no default. */
export function defaultSqlOf(
	def: DefaultDef<unknown> | null,
	type: TypeHandler<any>,
	nullable: boolean,
	where: string,
): string | null {
	if (def === null) return null;

	if (def.fn !== undefined) {
		const sql = GENERATORS.get(def.fn);

		if (sql === undefined)
			throw new Error(`${where}: unknown default generator "${def.fn}"; `
				+ `the ones this framework resolves are ${[...GENERATORS.keys()].join(', ')}`);

		return sql;
	}

	if (def.value === null) {
		if (!nullable) throw new Error(`${where}: a column that admits no null cannot default to one`);

		return 'null';
	}

	const checked = type.check(def.value);

	if (!checked.ok) throw new Error(`${where}: the default must be ${type.expected}`);

	return sqlLiteral(checked.value, where);
}
