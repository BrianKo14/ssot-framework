// Copying cells out of a sheet and pasting a block onto it (SCOPE 6h).

import type { ColumnMeta } from '../../shared/api.js';
import type { Grid } from '../kit/clipboard.js';
import type { Range, Selectable } from '../kit/selection.js';
import type { Problem } from '../kit/status.js';
import { count } from '../kit/text.js';
import { type Row, textOf, typed, writable } from '../model/rows.js';
import { restarted } from '../wire/auth.js';
import { placed, Unwritable } from './refusals.js';
import type { Env, Sheet } from './sheet.js';

/** What a pasted line did. */
interface Landed {
	saved?: boolean;
	created?: Row;
	kept?: Row;
}

/** What the `n`th line holds: a record, an unsaved line, or (a blank line) nothing. */
const holding = (s: Sheet, n: number): Row | undefined => s.rows.at(n) ?? s.pending.at(n - s.rows.length);

/** The text of the cells picked: what editing each would start from. */
const copied = (s: Sheet, { top, left, bottom, right }: Range): Grid =>
	Array.from({ length: bottom - top + 1 }, (_, i) =>
		Array.from({ length: right - left + 1 }, (_, j) =>
			textOf(holding(s, top + i)?.[s.columns[left + j].name])));

/** What one pasted line writes onto its row. A cell that already reads what's pasted is left
 * alone; one that differs is written if the row allows it, otherwise the line is refused.
 *
 * So rows copied out to a spreadsheet and pasted back where they came from just work, pk and
 * borrowed columns included, and a block pasted one row off is caught by its keys.
 *
 * @param holds what the row reads now (for a new row: its defaults and master key)
 * @param may whether the row lets a column be written */
const landing = (s: Sheet, left: number, texts: string[], holds: Row, may: (c: ColumnMeta) => boolean): Row => {
	const body: Row = {};

	texts.forEach((text, j) => {
		const sh = s.columns[left + j];

		if (text === textOf(holds[sh.name])) return;

		if (sh.via.length || !may(sh.column)) throw new Unwritable(sh.name);	// a borrowed column is the ancestor's

		body[sh.name] = typed(text);
	});

	return body;
};

/** Writes one pasted line as typing would have: onto the record there, or past the last one
 * onto a line that becomes a record once it has everything it needs. */
const pastedLine = async (s: Sheet, n: number, left: number, texts: string[]): Promise<Landed> => {
	const row = s.rows.at(n);

	if (row) {
		const body = landing(s, left, texts, row, c => writable(s.t, c));

		if (Object.keys(body).length) await s.patch(row, body);

		return { saved: Object.keys(body).length > 0 };
	}

	const fresh = s.draft();
	const values = s.pending.at(n - s.rows.length) ?? {};
	const body = landing(s, left, texts, { ...fresh.row, ...values }, fresh.writable);

	if (!Object.keys(body).length) return {};	// a blank line pasted onto a blank line

	const created = await s.keep(values, body);

	return created ? { created } : { kept: values };
};

/** @param on the sheet a body is showing now */
export function pasteOf({ status, refusals, failSoftly }: Env, on: (body: HTMLElement) => Sheet | undefined) {
	const { busy, fail, say } = status;

	/** Pastes a block with its top-left cell on `at`.
	 *
	 * What can't fit is refused before anything is sent. The rest goes one request per line, all
	 * at once: there is no batch, so a paste can land in part, and the status says which lines
	 * didn't and why. Each line is one save, so its row's undo takes that line back. */
	const pasting = async (s: Sheet, at: Pick<Range, 'top' | 'left'>, block: Grid): Promise<void> => {
		const past = at.left + Math.max(...block.map(line => line.length)) - s.columns.length;

		if (past > 0) { fail(`El pegado no entra: tiene ${count(past, 'columna')} de más.`); return; }

		if (at.top + block.length > s.rows.length && !s.t.capabilities.includes('create')) {
			fail('El pegado sigue después de la última fila, y tu rol no puede insertar.');
			return;
		}

		busy('Pegando…');

		const settled = await Promise.allSettled(block.map((texts, i) => pastedLine(s, at.top + i, at.left, texts)));

		if (settled.some(one => one.status === 'rejected' && restarted(one.reason))) return;

		const notes: Problem[] = [];
		const created: Row[] = [];
		const kept: Row[] = [];
		let saved = 0;

		settled.forEach((one, i) => {
			const n = at.top + i;

			if (one.status === 'rejected') {
				const row = s.rows.at(n);
				const found = refusals.problemsOf(s.t, one.reason, row);

				notes.push(...placed(s, n + 1, found));

				if (row) s.unpaste(row, found);		// listed by `extend` below
			}
			else if (one.value.created) created.push(one.value.created);
			else if (one.value.saved) saved++;
			else if (one.value.kept) kept.push(one.value.kept);
		});

		// every line landed on is redrawn; a refused one was read again
		s.rows.slice(at.top, at.top + block.length).forEach(row => s.redraw(row));
		s.extend(created);

		const done = [
			...(saved ? [count(saved, 'registro modificado', 'registros modificados')] : []),
			...(created.length ? [count(created.length, 'registro nuevo', 'registros nuevos')] : []),
			...(kept.length ? [count(kept.length, 'fila sin grabar', 'filas sin grabar')] : []),
		];

		say(`Pegado: ${(done.length ? done : ['nada cambió']).join(' · ')}`);
		fail(...notes, ...kept.flatMap(values => s.refusedInsert(values)));	// what this paste got wrong, once
	};

	return (body: HTMLElement): Selectable => ({
		copy: range => {
			const s = on(body);

			return s ? copied(s, range) : [];
		},
		paste: (at, block) => {
			const s = on(body);

			if (s) void pasting(s, at, block).catch(failSoftly);
		},
	});
}
