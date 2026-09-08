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

/** What is asked of a list beside the rows themselves. */
export interface Listing {
	filter?: string;
	/** A `FormatMeta.name` to be handed the list as a file instead; exporting is reading, so it
	 * is this same address with one more thing asked of it. */
	format?: string;
	/** Columns of the tables this one points at, each named by the path that reaches it — see
	 * `ancestryOf` in `fk.ts`. The answer holds them beside the table's own (SCOPE 7a). */
	reached?: string[];
}

/** Everything a read asks for, written once, so a list and a single record ask the same way. */
const asked = (listing: Listing): string => {
	const parts = [
		...(listing.filter === undefined ? [] : [`filter=${encodeURIComponent(listing.filter)}`]),
		...(listing.format === undefined ? [] : [`format=${encodeURIComponent(listing.format)}`]),
		...(listing.reached?.length
			? [`with=${encodeURIComponent(JSON.stringify(listing.reached))}`] : []),
	];

	return parts.length ? `?${parts.join('&')}` : '';
};

/** Where a table's rows are read from. The entity is the only thing the path names. */
export const listPath = (entity: string, listing: Listing = {}): string =>
	`/api/${encodeURIComponent(entity)}${asked(listing)}`;

/** The `/:pk0[/:pk1…]` route `crudRouter` mounts: one row, addressed by its key. */
export const rowPath = (entity: string, key: string[], listing: Listing = {}): string =>
	[`/api/${encodeURIComponent(entity)}`, ...key.map(encodeURIComponent)].join('/') + asked(listing);
