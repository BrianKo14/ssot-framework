// Writing one row (whether or not it is already there)

import type { ColumnInfo, TableInfo } from '../schema/model.js';
import { columnList, q, tableRef } from './identifier.js';

/** INSERT INTO table (given..., now...) VALUES ($1, $2, ..., now(), ...) ON CONFLICT (key) DO UPDATE SET ...
 *
 * @param key the columns that make up the primary key
 * @param given the columns bound as parameters, `$1...$n` in this order
 * @param now the columns set to the database's clock rather than to a value
 * @returns the statement; the caller binds `given`'s values, in the same order */
export function upsert(t: TableInfo, key: ColumnInfo[], given: ColumnInfo[], now: ColumnInfo[] = []): string {
	const written = [...given, ...now];
	const values = [...given.map((_, i) => `$${i + 1}`), ...now.map(() => 'now()')];
	const rest = written.filter(c => !key.includes(c));

	const onConflict = rest.length
		? `do update set ${rest.map(c => `${q(c.name)} = excluded.${q(c.name)}`).join(', ')}`
		: 'do nothing';

	return `insert into ${tableRef(t)} (${columnList(written)}) values (${values.join(', ')})`
		+ ` on conflict (${columnList(key)}) ${onConflict}`;
}
