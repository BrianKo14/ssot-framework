// Who holds which record (SCOPE 6e), and why a write was refused, worded for the screen.
// The server words its refusals in English; the screen speaks Spanish.

import type { FieldErrors, Lock, TableMeta } from '../../shared/api.js';
import type { Problem } from '../kit/status.js';
import { addressOf, type Row } from '../model/rows.js';
import { ApiError } from '../wire/api.js';
import { refused, stale } from '../wire/records.js';
import type { Sheet } from './sheet.js';

export const CHANGED = 'El registro cambió; se recargó con los valores actuales.';

/** Where a record's claim is, seen from this session. */
export type Held = 'free' | 'mine' | 'theirs';

export interface Refusals {
	/** Who holds what, as the last poll answered. A claim belongs to a user, not to a tab. */
	claimed(locks: Lock[]): void;
	holderOf(at: string): string | null;
	heldness(at: string): Held;
	/** e.g. "ada tiene el registro lockeado." */
	heldBy(at: string): string;
	/** A 412 or a 423, worded. */
	refusal(err: unknown, at: string): string;
	/** Why a line wasn't written: the record's refusal, each field the server named, or its message. */
	problemsOf(t: TableMeta, err: unknown, row: Row | undefined): Problem[];
}

/** @param me who is signed in */
export function refusalsOf(me: string): Refusals {
	let claims = new Map<string, string>();

	const holderOf = (at: string) => claims.get(at) ?? null;

	const heldness = (at: string): Held => {
		const who = holderOf(at);

		return who === null ? 'free' : who === me ? 'mine' : 'theirs';
	};

	const heldBy = (at: string) => `${holderOf(at) ?? 'Otro usuario'} tiene el registro lockeado.`;

	const refusal = (err: unknown, at: string) => (stale(err) ? CHANGED : heldBy(at));

	const problemsOf = (t: TableMeta, err: unknown, row: Row | undefined): Problem[] => {
		if (refused(err) && row) return [{ what: refusal(err, addressOf(t, row)) }];

		const fields = err instanceof ApiError || err instanceof Unwritable ? err.fields : undefined;

		return fields
			? Object.entries(fields).map(([field, said]) => ({ field, what: unprefixed(field, said) }))
			: [{ what: (err as Error).message }];
	};

	return {
		claimed: locks => { claims = new Map(locks.map(l => [l.record, l.holder])); },
		holderOf, heldness, heldBy, refusal, problemsOf,
	};
}

/** A cell a paste may not write, refused before anything is sent. It carries its field like a
 * 400 does, so both are reported the same way. */
export class Unwritable extends Error {
	readonly fields: FieldErrors;

	constructor(field: string) {
		super(`${field} no se puede escribir`);
		this.fields = { [field]: 'no se puede escribir' };
	}
}

/** The server starts a field's refusal with the field's name; a problem already names it.
 * e.g. `unprefixed('edad', 'edad must be a number')` -> "must be a number" */
export const unprefixed = (field: string, said: string) => (said.startsWith(`${field} `) ? said.slice(field.length + 1) : said);

/** A problem in one line of text, e.g. for a tooltip. */
export const worded = (p: Problem) => (p.field ? `${p.field}: ${p.what}` : p.what);

/** Problems placed on a line of a sheet. Only a subtable names its table; the screen's own grid
 * is the one being looked at. */
export const placed = (s: Sheet, line: number, found: Problem[]): Problem[] =>
	found.map(p => ({ ...p, line, ...(s.own() ? {} : { table: s.t.entity }) }));
