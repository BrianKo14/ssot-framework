// Writing one new row

import type { ColumnInfo, TableInfo } from '../schema/model.js';
import { columnList, tableRef } from './identifier.js';

/** INSERT INTO table (given...) VALUES ($1, $2, ...)
 *
 * @param given the columns bound as parameters, `$1...$n` in this order
 * @returns the statement; the caller binds `given`'s values, in the same order */
export const insertSql = (t: TableInfo, given: ColumnInfo[]): string =>
	`insert into ${tableRef(t)} (${columnList(given)}) values (${given.map((_, i) => `$${i + 1}`).join(', ')})`;
