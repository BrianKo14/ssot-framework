// The controls in a record's leading cell: its claim, or latch (SCOPE 6e), and its undo
// (SCOPE 6g). Plus the undo on a single cell that was written over.

import type { Capability, Change, TableMeta } from '../../shared/api.js';
import { button } from '../kit/dom.js';
import { count, toMinute } from '../kit/text.js';
import { addressOf, type Row } from '../model/rows.js';
import { restarted } from '../wire/auth.js';
import { refused, type Verb } from '../wire/records.js';
import type { Held } from './refusals.js';
import type { Env, Sheet } from './sheet.js';

export interface Lead {
	/** Built empty and kept across redraws; `relatch` writes what it says. */
	latch(s: Sheet, row: Row): HTMLButtonElement;
	/** Built empty and kept across redraws; `reundo` writes what it says. */
	undo(s: Sheet, row: Row): HTMLButtonElement;
	/** The undo for one column of the last save. */
	cellUndo(s: Sheet, row: Row, back: Change): HTMLButtonElement;
	/** Writes the line's latch. Called from the poll, since that's where claims are answered. */
	relatch(tr: HTMLElement, t: TableMeta): void;
	/** Writes the line's undo. Called when the line is filled, since a change arrives with the row. */
	reundo(tr: HTMLElement, t: TableMeta, row: Row): void;
}

/** The latch in each position: what pressing it needs, sends, and is called. Taking a claim off
 * somebody else needs `delete`, the same gate the server uses for breaking one. */
const LATCH: Record<Held, { needs: Capability; verb: Verb; label: (who: string) => string }> = {
	free: { needs: 'lock', verb: 'LOCK', label: () => 'Lockear el registro' },
	mine: { needs: 'lock', verb: 'UNLOCK', label: () => 'Liberar el lockeo' },
	theirs: { needs: 'delete', verb: 'UNLOCK', label: who => `Lockeado por ${who} — forzar la liberación` },
};

/** e.g. "Deshacer 2 cambios de ada (2026-10-26 14:05)" */
const undoLabel = (changes: Change[]) =>
	changes.length === 0
		? 'Sin cambios para deshacer'
		: `Deshacer ${count(changes.length, 'cambio')} de ${changes[0].by} (${toMinute(changes[0].at)})`;

export function leadOf({ status, records, refusals }: Env): Lead {
	const { busy, fail, say } = status;

	/** What one press of the row's undo puts back: every column of the newest save in the log.
	 * Versions are compared as numbers: they're `bigint`s written as text, and `"10" > "9"` is false. */
	const lastSave = (row: Row): Change[] => {
		const changes = Object.values(records.changes(row));
		const newest = changes.reduce((n, c) => Math.max(n, Number(c.version)), 0);

		return changes.filter(c => Number(c.version) === newest);
	};

	/** @param field one column, or `null` for the row's whole last save */
	const undoing = async (s: Sheet, row: Row, field: string | null, pressed: HTMLButtonElement): Promise<void> => {
		const at = addressOf(s.t, row);

		pressed.disabled = true;			// no second press while the first is in flight
		busy('Deshaciendo…');

		try {
			await s.undo(row, field);
			say(s.summary());
		} catch (err) {
			if (restarted(err)) return;

			fail(refused(err) ? refusals.refusal(err, at) : (err as Error).message);
		} finally {
			s.redraw(row);				// either way, the row now holds what the server holds
		}
	};

	/** Takes the claim or lets it go, whichever the latch shows. The answer is the record as it
	 * now stands, so the line is put right too; the poll draws the latch, so ask it at once. */
	const hold = async (s: Sheet, row: Row, pressed: HTMLButtonElement): Promise<void> => {
		const at = addressOf(s.t, row);
		const { verb } = LATCH[refusals.heldness(at)];

		pressed.disabled = true;
		busy(verb === 'LOCK' ? 'Lockeando…' : 'Liberando…');

		try {
			const now = await records.claim(s.t, row, verb);

			if (now) {
				Object.assign(row, now);
				s.redraw(row);
			}

			say(s.summary());
		} catch (err) {
			if (restarted(err)) return;

			fail(refused(err) ? refusals.refusal(err, at) : (err as Error).message);
		} finally {
			s.held?.();
		}
	};

	const latch = (s: Sheet, row: Row) => {
		const x = button('latch');

		x.addEventListener('click', () => void hold(s, row, x));

		return x;
	};

	const undo = (s: Sheet, row: Row) => {
		const x = button('undo');

		// names no save: the newest one is whatever the log holds at the press
		x.addEventListener('click', () => void undoing(s, row, null, x));

		return x;
	};

	/** Stops its clicks reaching the cell, so pressing it never opens an editor. */
	const cellUndo = (s: Sheet, row: Row, back: Change) => {
		const x = button('undo', undoLabel([back]));

		x.setAttribute('aria-label', `${back.field}: ${x.title}`);
		x.addEventListener('click', e => { e.stopPropagation(); void undoing(s, row, back.field, x); });
		x.addEventListener('dblclick', e => e.stopPropagation());

		return x;
	};

	const relatch = (tr: HTMLElement, t: TableMeta) => {
		const x = tr.querySelector<HTMLButtonElement>('.latch');

		if (!x) return;					// a subtable draws none

		const at = String(tr.dataset.at);
		const state = refusals.heldness(at);
		const who = refusals.holderOf(at);

		x.dataset.held = state;
		x.disabled = !t.capabilities.includes(LATCH[state].needs);
		x.setAttribute('aria-label', LATCH[state].label(who ?? ''));

		if (who === null) delete x.dataset.name;
		else x.dataset.name = who;
	};

	const reundo = (tr: HTMLElement, t: TableMeta, row: Row) => {
		const x = tr.querySelector<HTMLButtonElement>('.lead .undo');	// not a cell's undo

		if (!x) return;					// a subtable draws none

		const changes = lastSave(row);
		const label = undoLabel(changes);

		x.disabled = changes.length === 0 || !t.capabilities.includes('update');
		x.title = label;
		x.setAttribute('aria-label', label);
	};

	return { latch, undo, cellUndo, relatch, reundo };
}
