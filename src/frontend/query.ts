// Builds the `?filter=` wire format. Shared by the filter bar and the fk picker.

import type { FilterCondition } from '../shared/api.js';

/** One filter condition: column + comparison + value. */
export interface Asked extends FilterCondition {
	column: string;
}

/** The `filter` param value, or `undefined` when there's nothing to ask.
 * Conditions on the same column are grouped, since the backend reads a list per column. */
export function filterQuery(asked: Asked[]): string | undefined {
	if (!asked.length) return undefined;

	const filter = new Map<string, FilterCondition[]>();

	for (const { column, op, value } of asked)
		filter.set(column, [...filter.get(column) ?? [], { op, value }]);

	return JSON.stringify(Object.fromEntries(filter));
}

/** Where a table's rows are read from. The entity is the only thing the path names.
 * @param format a `FormatMeta.name` to be handed the list as a file instead; exporting is
 * reading, so it is this same address with one more thing asked of it. */
export const listPath = (entity: string, filter?: string, format?: string): string => {
	const asked = [
		...(filter === undefined ? [] : [`filter=${encodeURIComponent(filter)}`]),
		...(format === undefined ? [] : [`format=${encodeURIComponent(format)}`]),
	];

	return `/api/${encodeURIComponent(entity)}${asked.length ? `?${asked.join('&')}` : ''}`;
};
