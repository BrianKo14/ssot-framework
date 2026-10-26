// A row and its columns, as `_meta` describes its table.

import type { ColumnMeta, TableMeta } from '../../shared/api.js';
import { type Reachable, valuesOf } from './fk.js';

export type Row = Record<string, unknown>;

/** A row's pk values, in declaration order. */
export const key = (t: TableMeta, row: Row) => valuesOf(t.pk, row);

/** A row's key as one string, as the presence poll and a line's `data-at` write it.
 * e.g. reserva `['2026-10-26', '7']` -> "2026-10-26/7" */
export const addressOf = (t: TableMeta, row: Row) => key(t, row).join('/');

/** Whether a record's column can be edited. Shared by the grid's cell and the panel's field. */
export const writable = (t: TableMeta, c: ColumnMeta) => !t.pk.includes(c.name) && t.capabilities.includes('update');

/** `requiredOnInsert` in `api/crud/write.ts`: an insert may leave out a column the database can fill.
 * Only a new row asks this; blanking such a column in an update is still refused. */
export const requiredOnInsert = (c: ColumnMeta) => !c.nullable && c.defaultValue === null;

/** A default the form can show. A `{fn}` default is the database's to compute, so it shows empty. */
export const constantDefault = (c: ColumnMeta) =>
	c.defaultValue !== null && 'value' in c.defaultValue ? c.defaultValue.value : null;

/** A value as the edit box holds it, and as a copied cell holds it. */
export const textOf = (value: unknown) => (value === null || value === undefined ? '' : String(value));

/** What typed text is sent as: blank -> `null`, anything else as typed (the server parses it). */
export const typed = (text: string) => (text.trim() === '' ? null : text);

/** The borrowed columns among these, by the names the server is asked for them. */
export const reached = (columns: Reachable[]) => columns.filter(sh => sh.via.length > 0).map(sh => sh.name);
