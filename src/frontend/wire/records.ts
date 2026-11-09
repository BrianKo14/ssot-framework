// Reading and writing one record. Every request on a record goes through here.

import type { SystemMeta, TableMeta, Undoable } from '../../shared/api.js';
import { type Listing, listPath, rowPath } from '../model/query.js';
import { key, type Row } from '../model/rows.js';
import { api, ApiError, sending } from './api.js';

/** 412: the row changed since it was read. */
export const stale = (err: unknown) => err instanceof ApiError && err.status === 412;

/** 423: somebody else holds the record. */
export const held = (err: unknown) => err instanceof ApiError && err.status === 423;

/** Refused because of the record, not the values typed. Both are answered the same way:
 * reload the row and say why. */
export const refused = (err: unknown) => stale(err) || held(err);

/** What a latch sends to take or let go of a claim. */
export type Verb = 'LOCK' | 'UNLOCK';

export interface Records {
	/** The row again, with these ancestor columns beside its own. */
	read(t: TableMeta, row: Row, reached: string[]): Promise<Row>;
	insert(t: TableMeta, given: Row): Promise<Row>;
	/** Only if the row is still the version that was read. */
	patch(t: TableMeta, row: Row, body: Row): Promise<Row>;
	/** Puts back the row's last save; the server reads which one off its log.
	 * @param field one column, or `null` for the whole save */
	undo(t: TableMeta, row: Row, field: string | null): Promise<Row>;
	remove(t: TableMeta, row: Row): Promise<void>;
	/** @returns the record as it now stands, or `null` if this role can't read it */
	claim(t: TableMeta, row: Row, verb: Verb): Promise<Row | null>;
	/** What the row's last writes overwrote, by column. */
	changes(row: Row): Undoable;
	/** The version the row was read at. */
	version(row: Row): unknown;
}

/** `_meta` names the version and undo keys, so the browser never writes them itself. */
export function recordsOf(meta: SystemMeta): Records {
	const at = (t: TableMeta, row: Row, listing?: Listing) => rowPath(t.entity, key(t, row), listing);
	const version = (row: Row) => row[meta.stamp];

	const undoAt = (t: TableMeta, row: Row, field: string | null) =>
		`${at(t, row)}/${encodeURIComponent(meta.undo)}` + (field === null ? '' : `?field=${encodeURIComponent(field)}`);

	return {
		read: (t, row, reached) => api<Row>(at(t, row, { reached })),
		insert: (t, given) => api<Row>(listPath(t.entity), sending('POST', given)),
		patch: (t, row, body) => api<Row>(at(t, row), sending('PATCH', body, version(row))),
		undo: (t, row, field) => api<Row>(undoAt(t, row, field), sending('PATCH', undefined, version(row))),
		remove: (t, row) => api<void>(at(t, row), sending('DELETE', undefined, version(row))),
		claim: (t, row, verb) => api<Row | null>(at(t, row), sending(verb)),
		changes: row => (row[meta.undo] ?? {}) as Undoable,
		version,
	};
}
