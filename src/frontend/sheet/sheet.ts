// A table drawn on screen: the screen's own grid, or a subtable under the record panel.
// A row is drawn and written the same way on both; what differs is said by its owner, in the
// `SheetSpec`.

import type { ColumnMeta, TableMeta } from '../../shared/api.js';
import { button, classed, el, lead as leading } from '../kit/dom.js';
import type { Selectable, Selection } from '../kit/selection.js';
import type { Problem, Status } from '../kit/status.js';
import { count } from '../kit/text.js';
import type { FkOf, Reachable } from '../model/fk.js';
import type { Router } from '../model/route.js';
import { addressOf, reached, requiredOnInsert, type Row, writable } from '../model/rows.js';
import { ApiError } from '../wire/api.js';
import { sessionEnded } from '../wire/auth.js';
import { type Records, refused } from '../wire/records.js';
import { type Cells, shown } from './cells.js';
import { type Editor, editorOf, type Line } from './editor.js';
import { type Lead, leadOf } from './lead.js';
import { pasteOf } from './paste.js';
import { placed, type Refusals, worded } from './refusals.js';

/** What every sheet needs, built once in `main`. */
export interface Env {
	status: Status;
	records: Records;
	refusals: Refusals;
	cells: Cells;
	fkOf: FkOf;
	route: Router;
	selection: Selection;
	/** For what failed beside the screen: says so on the pill, or reloads on a 401. */
	failSoftly(err: unknown): void;
}

/** A row that isn't a record yet: the panel's insert, or a line typed past the last row. */
export interface NewRow {
	/** What it holds before anything is typed: the defaults, a subtable's master key. */
	row: Row;
	writable(c: ColumnMeta): boolean;
	insert(given: Row): Promise<Row>;
}

/** How a sheet differs, as its owner says. */
export interface SheetSpec {
	t: TableMeta;
	/** The table's own columns, then whatever it borrows from its ancestors. */
	columns: Reachable[];
	head: HTMLElement;
	body: HTMLElement;
	table: HTMLElement;
	/** Shown instead of the rows when there are none. */
	empty: HTMLElement;
	/** The fewest lines to draw; blank ones make up the difference. */
	leastRows: number;
	draft(): NewRow;
	/** What the row's leading cell holds. */
	handle(row: Row): Node[];
	/** A row was redrawn after it changed; the panel may be showing it. */
	changed(row: Row): void;
	/** This tab's cursor may have moved. */
	moved(): void;
	/** Where this tab's cursor is while a cell of `row` is open. */
	at(row: Row): string[];
	/** Whether this is the screen's own grid. */
	own(): boolean;
	/** A claim was taken or let go. */
	held?(): void;
	/** Lines were added. */
	drawn?(): void;
}

export interface Sheet extends SheetSpec {
	/** The records drawn, in order. */
	rows: Row[];
	/** Lines typed into past the last row that aren't records yet, drawn after `rows`. */
	pending: Row[];
	render(data: Row[]): void;
	/** Draws more records after the ones drawn, leaving those (and the marks on them) as they are. */
	extend(more: Row[]): void;
	/** Redraws a row's line, if still on screen. */
	refill(row: Row): void;
	/** `refill`, and tells the owner the row changed. */
	redraw(row: Row): void;
	/** Reads the row again into the same object, with the columns this sheet borrows. */
	reread(row: Row): Promise<void>;
	/** Writes typed values onto a record. */
	patch(row: Row, body: Row): Promise<void>;
	/** Puts back the record's last save, or one column of it. */
	undo(row: Row, field: string | null): Promise<void>;
	/** Writes onto a line that isn't a record yet, inserting it once nothing is missing.
	 * @returns the record it became, if it became one */
	keep(values: Row, body: Row): Promise<Row | undefined>;
	/** Keeps what a paste couldn't write on the row, listed until the row is written again. */
	unpaste(row: Row, found: Problem[]): void;
	/** Why the line's insert was refused, if it was. */
	refusedInsert(values: Row): Problem[];
	/** e.g. "3 registros · 5 campos" */
	summary(): string;
}

export interface Sheets {
	sheet(spec: SheetSpec): Sheet;
	/** The one cell editor, shared by every sheet. */
	editor: Editor;
	lead: Lead;
	/** What a body answers the clipboard with, asked of whichever sheet it is showing now. */
	clipboardOf(body: HTMLElement): Selectable;
}

export function sheetsOf(env: Env): Sheets {
	const { status, records, refusals, cells, fkOf } = env;
	const editor = editorOf(env);
	const lead = leadOf(env);

	/** Which sheet each body is showing. */
	const showing = new Map<HTMLElement, Sheet>();

	const sheet = (spec: SheetSpec): Sheet => {
		const { t } = spec;

		/** Each row's line, as last drawn. */
		const lines = new WeakMap<Row, HTMLTableRowElement>();

		/** Why a line's insert was refused, until it is written into again. */
		const unsaved = new WeakMap<Row, unknown>();

		/** What a paste couldn't write onto a record, until something is written to it. */
		const unpasted = new WeakMap<Row, Problem[]>();


		// --- Records ---

		/** A borrowed cell is read-only and links nowhere: only its value is on the wire. */
		const cell = (row: Row) => (sh: Reachable) => {
			const { column } = sh;
			const value = row[sh.name] ?? null;			// a column the answer didn't carry reads as null
			const fk = sh.via.length ? undefined : fkOf(t, column);
			const td = shown('td', value, fk && cells.fkLink(fk, row, value));

			if (sh.via.length) { td.classList.add('borrowed'); return td; }

			if (!writable(t, column)) return td;

			td.classList.add('editable');
			td.addEventListener('dblclick', () => void editor.enter(s, row, column, td));

			const back = records.changes(row)[column.name];

			if (back) td.append(lead.cellUndo(s, row, back));	// a cell written over offers it back

			return td;
		};

		/** The one place a record's line is written. The leading cell is kept, not rebuilt, so
		 * the panel's mark on its button and other viewers' marks survive. */
		const fill = (tr: HTMLTableRowElement, row: Row) => {
			tr.dataset.at = addressOf(t, row);
			tr.replaceChildren(tr.querySelector('.lead') ?? leading('td', ...s.handle(row)), ...s.columns.map(cell(row)));
			lead.reundo(tr, t, row);			// the kept leading cell has to be told
			lines.set(row, tr);

			return tr;
		};

		const refill = (row: Row) => {
			const tr = lines.get(row);

			if (tr?.isConnected) fill(tr, row);
		};

		const redraw = (row: Row) => {
			refill(row);
			s.changed(row);
		};

		const reread = async (row: Row) => {
			Object.assign(row, await records.read(t, row, reached(s.columns)));
		};

		/** The one place a written row is put back: what the server answered, then (when this
		 * sheet borrows columns) the row read again with them, since writing an fk can move it
		 * under a different ancestor. */
		const write = async (row: Row, request: () => Promise<Row>): Promise<void> => {
			let saved: Row;

			try {
				saved = await request();
			} catch (err) {
				// the refusal is the news; a failed re-read must not replace it
				if (refused(err)) await reread(row).catch(() => undefined);

				throw err;
			}

			Object.assign(row, saved);			// what the server stored, not the typed text

			if (unpasted.delete(row)) status.standing(s.body, problems());

			const borrowing = reached(s.columns);

			if (borrowing.length) Object.assign(row, await records.read(t, row, borrowing));
		};


		// --- Lines that aren't records yet ---

		/** What a line still needs: every column its insert writes, refuses empty, and has nothing
		 * in. A subtable's master key and a column with a default are never among them. */
		const missing = (values: Row): string[] => {
			const d = s.draft();

			return t.columns
				.filter(c => d.writable(c) && requiredOnInsert(c) && (values[c.name] ?? null) === null)
				.map(c => c.name);
		};

		/** The refusal of the line's insert, or each field it lacks. */
		const waiting = (values: Row): Problem[] => {
			const refusal = unsaved.get(values);

			return refusal === undefined
				? missing(values).map(field => ({ field, what: 'obligatorio' }))
				: refusals.problemsOf(t, refusal, undefined);
		};

		/** Counted from one, after the records. */
		const lineOf = (values: Row) => s.rows.length + s.pending.indexOf(values) + 1;

		const pendingProblems = (values: Row) => placed(s, lineOf(values), waiting(values));

		/** What is wrong with the sheet now: records a paste couldn't write, and lines not saved yet.
		 * Placed when asked, so the line numbers are always current. */
		const problems = () => [
			...s.rows.flatMap((row, i) => placed(s, i + 1, unpasted.get(row) ?? [])),
			...s.pending.flatMap(pendingProblems),
		];

		/** Inserts the line once nothing is missing. Only what was typed goes; an empty cell is left
		 * to the database. A refusal stays on the line, and the next write to it asks again. */
		const settle = async (values: Row): Promise<Row | undefined> => {
			if (!s.pending.includes(values) || missing(values).length) return undefined;

			const given = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== null));
			const created: Row = {};

			try {
				await write(created, () => s.draft().insert(given));
			} catch (err) {
				if (sessionEnded(err)) throw err;

				unsaved.set(values, err);

				return undefined;
			}

			s.pending = s.pending.filter(one => one !== values);

			return created;
		};

		/** A line emptied again is gone, as before anything was typed. */
		const keep = async (values: Row, body: Row): Promise<Row | undefined> => {
			Object.assign(values, body);
			unsaved.delete(values);				// it was about what the line held before

			const empty = Object.values(values).every(v => v === null);

			if (empty) s.pending = s.pending.filter(one => one !== values);
			else if (!s.pending.includes(values)) s.pending.push(values);

			return settle(values);
		};

		/** Throws a line away, with what was typed into it. */
		const discard = (values: Row) => {
			const x = button('discard', 'Descartar la fila sin grabar');

			x.addEventListener('click', () => {
				s.pending = s.pending.filter(one => one !== values);
				extend([]);
				status.say(summary());
			});

			return x;
		};

		/** A line past the last record: typed into, or blank. Its cells take values through the
		 * same editor as a record's, but they're kept on the line until `settle` can insert it.
		 * Nothing is editable where the role may not insert. */
		const draftLine = (values: Row) => {
			const d = s.draft();
			const kept = s.pending.includes(values);
			const lacking = kept ? missing(values) : [];
			const refusal = unsaved.get(values);
			const fields = refusal instanceof ApiError ? refusal.fields : undefined;
			const inserts = t.capabilities.includes('create');
			const tr = classed('tr', kept ? 'pending' : 'blank', leading('td', ...(kept ? [discard(values)] : [])));
			const line: Line = {
				row: values,
				at: [],
				save: async body => {
					const created = await keep(values, body);

					extend(created ? [created] : []);

					// a refused insert is already listed; this only shows it
					if (unsaved.has(values)) status.fail(...pendingProblems(values));
				},
				redraw: () => extend([]),
			};

			if (kept) tr.title = `Sin grabar — ${waiting(values).map(worded).join(', ')}`;

			tr.append(...s.columns.map(sh => {
				const value = values[sh.name] ?? null;
				const td = el('td', value === null ? '' : String(value));

				if (sh.via.length || !inserts || !d.writable(sh.column)) return td;

				td.classList.add('editable');
				td.classList.toggle('missing', lacking.includes(sh.name));
				td.classList.toggle('bad', fields?.[sh.name] !== undefined);
				td.title = fields?.[sh.name] ?? (lacking.includes(sh.name) ? `${sh.name}: obligatorio` : '');
				td.addEventListener('dblclick', () => editor.edit(s, sh.column, td, line));

				return td;
			}));

			return tr;
		};

		/** Blank lines, so a short list still reads as a table, and (where the role may insert)
		 * so there is always one line to type a new record into. */
		const blanks = (drawn: number) =>
			Array.from({ length: Math.max(t.capabilities.includes('create') ? 1 : 0, s.leastRows - drawn) },
				() => draftLine({}));


		// --- Drawing ---

		const extend = (more: Row[]) => {
			s.body.querySelectorAll('tr.pending, tr.blank').forEach(tr => tr.remove());
			s.rows = [...s.rows, ...more];
			s.body.append(...more.map(row => fill(el('tr'), row)),
				...s.pending.map(draftLine), ...blanks(s.rows.length + s.pending.length));
			s.empty.hidden = s.rows.length > 0;
			status.standing(s.body, problems());	// every change to the unsaved lines passes here
			s.drawn?.();
		};

		const render = (data: Row[]) => {
			showing.set(s.body, s);
			s.head.replaceChildren(leading('th'), ...s.columns.map(cells.header(t)));
			s.body.replaceChildren();
			s.rows = [];
			extend(data);

			s.table.hidden = false;			// the header shows even with no rows
		};

		/** Counts the records drawn: not the blank lines, nor the unsaved ones (those are problems). */
		const summary = () =>
			`${count(s.body.querySelectorAll('tr[data-at]').length, 'registro')} · ${count(s.columns.length, 'campo')}`;

		const s: Sheet = {
			...spec,
			rows: [],
			pending: [],
			render, extend, refill, redraw, reread, keep, summary,
			patch: (row, body) => write(row, () => records.patch(t, row, body)),
			undo: (row, field) => write(row, () => records.undo(t, row, field)),
			unpaste: (row, found) => { unpasted.set(row, found); },
			refusedInsert: values => (unsaved.has(values) ? pendingProblems(values) : []),
		};

		return s;
	};

	return { sheet, editor, lead, clipboardOf: pasteOf(env, body => showing.get(body)) };
}
