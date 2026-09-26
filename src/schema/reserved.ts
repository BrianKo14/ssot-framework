// Row versions, for concurrency control + locks

import { integer, text } from '../types/builtin.js';
import { defaultSqlOf } from './defaults.js';
import type { ColumnInfo, TableInfo } from './model.js';

const STORAGE = 'bigint';
export const VERSION_RANGE = { kind: 'range', min: 0, max: Number.MAX_SAFE_INTEGER } as const;

const counter: ColumnInfo['type'] = {
	...integer(VERSION_RANGE.min, VERSION_RANGE.max),
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

/** Who is holding the record, or null if nobody. */
export const LOCK: ColumnInfo = {
	name: '_lockedBy',
	typeName: 'text',
	nullable: true,
	isName: false,
	type: { ...text(), expected: 'a user name' },
	defaultValue: null,
	defaultSql: null,
};

/** Add the columns the framework reserves to the definition. */
export const stored = (t: TableInfo): ColumnInfo[] => [...t.columns, STAMP, LOCK];
