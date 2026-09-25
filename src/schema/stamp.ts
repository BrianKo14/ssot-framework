// The row version, for concurrency control

import { integer } from '../types/builtin.js';
import { defaultSqlOf } from './defaults.js';
import type { ColumnInfo, TableInfo } from './model.js';

const STORAGE = 'bigint';

const counter: ColumnInfo['type'] = {
	...integer(0, Number.MAX_SAFE_INTEGER),
	expected: 'a row version',
};

const FIRST = { value: 1 };

/** The version every row carries.
 * Owned by the framework rather than the schema author declaring it. */
export const STAMP: ColumnInfo = {
	name: '_version',
	typeName: STORAGE,
	nullable: false,
	isName: false,
	type: counter,
	defaultValue: FIRST,
	defaultSql: defaultSqlOf(FIRST, counter, false, 'the row version'),
};

/** Add the row version to a table's columns. */
export const stored = (t: TableInfo): ColumnInfo[] => [...t.columns, STAMP];
