// The cell editor: one text box for every type, plus the fk's list where there is one
// (`picker.ts`). One cell at a time, across every sheet.

import type { ColumnMeta } from '../../shared/api.js';
import { picker, type Picker } from '../controls/picker.js';
import { el } from '../kit/dom.js';
import { addressOf, textOf, type Row, typed } from '../model/rows.js';
import { restarted } from '../wire/auth.js';
import { refused } from '../wire/records.js';
import { CHANGED, placed } from './refusals.js';
import type { Env, Sheet } from './sheet.js';

/** What an editor writes into: a record, or a line that isn't a record yet. */
export interface Line {
	/** What the line holds now; the editor starts from it. */
	row: Row;
	/** Where this tab's cursor is while a cell of it is open. */
	at: string[];
	save(body: Row): Promise<void>;
	/** Puts the line back the way `row` says. */
	redraw(): void;
}

export interface Editor {
	/** Opens a record's cell, unless the row changed or was claimed since it was read. */
	enter(s: Sheet, row: Row, c: ColumnMeta, td: HTMLTableCellElement): Promise<void>;
	edit(s: Sheet, c: ColumnMeta, td: HTMLTableCellElement, line: Line): void;
	/** Where the open cell puts this tab's cursor; empty when none. */
	at(): string[];
	/** Closes the open cell without writing. */
	cancel(): void;
}

export function editorOf({ status, records, refusals, fkOf, failSoftly }: Env): Editor {
	const { busy, fail, say } = status;

	let editing: { td: HTMLTableCellElement; cancel: () => void; at: string[] } | null = null;

	/** Editing a record's cell is being on that record, but only on the screen's own grid. */
	const recordLine = (s: Sheet, row: Row): Line => ({
		row,
		at: s.at(row),
		save: body => s.patch(row, body),
		redraw: () => s.refill(row),
	});

	// One read before anything is typed: a record that moved on never opens, it redraws.
	// From here on it's left alone until the editor closes.
	const enter = async (s: Sheet, row: Row, c: ColumnMeta, td: HTMLTableCellElement): Promise<void> => {
		if (editing?.td === td) return;			// a double-click inside the editor selects a word

		const read = records.version(row);

		try {
			await s.reread(row);
		} catch (err) {
			failSoftly(err);
			return;
		}

		const at = addressOf(s.t, row);
		const taken = refusals.heldness(at) === 'theirs';

		if (read === records.version(row) && !taken) { edit(s, c, td, recordLine(s, row)); return; }

		s.redraw(row);
		fail(taken ? refusals.heldBy(at) : CHANGED);
	};

	const edit = (s: Sheet, c: ColumnMeta, td: HTMLTableCellElement, line: Line): void => {
		if (editing?.td === td) return;

		editing?.cancel();

		const { t } = s;
		const { row } = line;
		const before = textOf(row[c.name]);
		const input = el('input');
		const fk = fkOf(t, c);

		input.type = 'text';
		input.value = before;
		input.placeholder = c.expected;
		input.title = `${c.name}: ${c.type} — ${c.expected}`;

		let list: Picker | undefined;			// built once the box is in the cell
		let settled = false;

		/** Closing, either way: whatever it was refused isn't on screen anymore. */
		const closing = () => {
			settled = true;
			editing = null;
			list?.destroy();
			status.standing(td, []);
		};

		/** Puts the cell back the way the row says. */
		const restore = () => {
			closing();
			line.redraw();
			s.moved();				// let go of the row, so everyone else sees it
		};

		/** @param written every column of a picked fk; by default, the one typed column */
		const commit = async (written?: Row) => {
			if (settled || !td.isConnected) return;	// Enter blurs the input right after; so does leaving

			if (written === undefined && input.value === before) { restore(); return; }

			const body = written ?? { [c.name]: typed(input.value) };

			settled = true;
			input.disabled = true;
			list?.close();
			td.classList.remove('bad');
			busy('Guardando…');

			try {
				await line.save(body);

				closing();
				line.redraw();
				s.changed(row);
				s.moved();
				say(s.summary());
			} catch (err) {
				if (restarted(err)) return;

				// Late or claimed: what's typed answers values that are gone. The row now holds
				// what the server has, so close and redraw.
				if (refused(err)) { restore(); s.changed(row); fail(refusals.refusal(err, addressOf(t, row))); return; }

				// otherwise stay open to be fixed, and listed while it is wrong
				const found = placed(s, s.rows.indexOf(row) + 1, refusals.problemsOf(t, err, row));

				settled = false;
				input.disabled = false;
				input.focus();
				td.classList.add('bad');
				status.standing(td, found);
				fail(...found);
			}
		};

		input.addEventListener('keydown', e => {
			if (list?.handled(e)) return;					// the list takes its keys first

			if (e.key === 'Enter') void commit();
			else if (e.key === 'Escape') { e.stopPropagation(); restore(); }	// don't close the panel too
		});
		input.addEventListener('input', () => list?.refresh());

		// Leaving the cell is a decision; losing the window (another app or tab) isn't. Then the
		// box stays open with what's half typed, and gets the caret back when the window does.
		input.addEventListener('blur', () => {
			if (document.hasFocus()) { void commit(); return; }

			addEventListener('focus', () => { if (!settled && td.isConnected) input.focus(); }, { once: true });
		});

		td.classList.add('editing');
		td.replaceChildren(input);

		// after the box is in the cell, so the list isn't swept out with what was there
		if (fk) list = picker(input, td, fk.ref, fk.target, values => void commit(values));

		input.focus();
		input.select();

		editing = { td, cancel: restore, at: line.at };

		s.moved();
	};

	return {
		enter, edit,
		at: () => editing?.at ?? [],
		cancel: () => editing?.cancel(),
	};
}
