// Row versions, for concurrency control + locks

import { q } from '../sql/identifier.js';
import { integer, text } from '../types/builtin.js';
import { defaultSqlOf } from './defaults.js';
import type { ColumnInfo, RoutineInfo, TableInfo, TriggerInfo } from './model.js';

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

/** The part of a row that doesn't include the reserved columns (`_version` and `_lockedBy`). */
const data = (row: 'new' | 'old'): string => `(to_jsonb(${row}) - '${STAMP.name}' - '${LOCK.name}')`;

/** Trigger code that keeps the version updated. */
const KEEPING = `
begin
	new.${q(STAMP.name)} := old.${q(STAMP.name)}
		+ (new.${q(LOCK.name)} is not distinct from old.${q(LOCK.name)}
			or ${data('new')} is distinct from ${data('old')})::integer;
	return new;
end
`;

/** Map of schemas -> version triggers (keepers). */
const keepers = new Map<string, RoutineInfo>();

/** Returns a schema's version trigger (keeper). */
const keeper = (schema: string): RoutineInfo => {
	let routine = keepers.get(schema);

	if (!routine) keepers.set(schema, routine = {
		routine: `${schema}.${STAMP.name}`, schema, name: STAMP.name,
		kind: 'trigger', params: [], returns: null, language: 'plpgsql', body: KEEPING,
	});

	return routine;
};

/** Adds the version trigger to a table's triggers. */
export const fired = (t: TableInfo): TriggerInfo[] => [...t.triggers, {
	name: STAMP.name, table: t, timing: 'before', events: ['update'], level: 'row', routine: keeper(t.schema),
}];
