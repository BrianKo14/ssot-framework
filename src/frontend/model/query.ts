// The paths the frontend asks the server for, and the `?filter=` wire format.

import type { FilterCondition } from '../../shared/api.js';

/** One filter condition: column + comparison + value. */
export interface Asked extends FilterCondition {
	column: string;
}

/** The `filter` param, or `undefined` when there's nothing to ask.
 * Grouped by column, since the backend reads a list per column. */
export function filterQuery(asked: Asked[]): string | undefined {
	if (!asked.length) return undefined;

	const filter = new Map<string, FilterCondition[]>();

	for (const { column, op, value } of asked)
		filter.set(column, [...filter.get(column) ?? [], { op, value }]);

	return JSON.stringify(Object.fromEntries(filter));
}

/** What a read asks for besides the rows. */
export interface Listing {
	filter?: string;
	/** A `FormatMeta.name`, to get the list as a file. */
	format?: string;
	/** Ancestor columns, by the path that reaches them. */
	reached?: string[];
}

/** The query string, written once so a list and a single record ask the same way. */
const asked = (listing: Listing): string => {
	const parts = [
		...(listing.filter === undefined ? [] : [`filter=${encodeURIComponent(listing.filter)}`]),
		...(listing.format === undefined ? [] : [`format=${encodeURIComponent(listing.format)}`]),
		...(listing.reached?.length
			? [`with=${encodeURIComponent(JSON.stringify(listing.reached))}`] : []),
	];

	return parts.length ? `?${parts.join('&')}` : '';
};

/** A table's rows, e.g. `/api/cliente?filter=...`. */
export const listPath = (entity: string, listing: Listing = {}): string =>
	`/api/${encodeURIComponent(entity)}${asked(listing)}`;

/** One row by its key, as `crudRouter` mounts it, e.g. `/api/reserva/2026-10-26/7`. */
export const rowPath = (entity: string, key: string[], listing: Listing = {}): string =>
	[`/api/${encodeURIComponent(entity)}`, ...key.map(encodeURIComponent)].join('/') + asked(listing);

/** The presence poll: says where this tab is and asks who else is here.
 * A tab can be on two records: the one with a cell open (`key`) and the one in its panel (`opened`).
 * @param tab this tab's name; `null` on the first ask, when the server mints one */
export const watchPath = (entity: string, key: string[], opened: string[], tab: string | null): string => {
	const asking = [
		...(tab === null ? [] : [`tab=${encodeURIComponent(tab)}`]),
		...(opened.length ? [`opened=${encodeURIComponent(opened.join('/'))}`] : []),
	];

	return `${rowPath(entity, key)}/_viewers${asking.length ? `?${asking.join('&')}` : ''}`;
};

/** A record's history.
 * @param field one column's history instead of the record's */
export const changesPath = (entity: string, key: string[], field?: string): string =>
	`${rowPath(entity, key)}/_changes${field === undefined ? '' : `?field=${encodeURIComponent(field)}`}`;
