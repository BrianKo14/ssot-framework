// The record panel beside the grid: one record's fields to read or edit, its subtables and its
// history. A new row being inserted opens in it too.

import type { Capability, ColumnMeta, TableMeta } from '../../shared/api.js';
import { picker, type Picker } from '../controls/picker.js';
import { byId, classed, el } from '../kit/dom.js';
import { same } from '../kit/text.js';
import { constantDefault, key, requiredOnInsert, type Row, textOf, typed, writable } from '../model/rows.js';
import { ApiError } from '../wire/api.js';
import { restarted } from '../wire/auth.js';
import { refused } from '../wire/records.js';
import { shown } from '../sheet/cells.js';
import { unprefixed } from '../sheet/refusals.js';
import type { Env, NewRow, Sheet, Sheets } from '../sheet/sheet.js';
import { historyOf } from './history.js';
import { subtablesOf } from './subtables.js';

/** What the panel shows: a record, or a new row. Same panel; only these differ. */
export interface Peeked {
	t: TableMeta;
	row: Row;
	/** Empty for a new row: it isn't a record until saved. */
	key: string[];
	/** The grid button that opened it, so its line stays marked. None for a new row. */
	button?: HTMLButtonElement;
	/** Where the focus goes back to on close. */
	from: HTMLElement;
	title: string;
	needs: Capability;
	writable(c: ColumnMeta): boolean;
	/** Whether the field is refused empty; see `requiredOnInsert`. */
	required(c: ColumnMeta): boolean;
	/** Where the focus goes on open: a record is there to be read, a new row to be written. */
	landing(): HTMLElement;
	save(typed: Row): Promise<void>;
	/** None on a new row: there's nothing to delete yet. */
	remove?(): Promise<void>;
}

/** A new row. Inserting is apart from saving because only the panel moves on after one; a
 * paste inserts several and stays put. */
export interface Draft extends Peeked, NewRow {}

/** Moves the address to a record on the screen showing. */
export interface Address {
	go(key: string[]): void;
	/** Without redrawing, for a move the screen already shows. */
	mark(key: string[]): void;
}

export interface PanelDeps {
	env: Env;
	sheets: Sheets;
	tables: TableMeta[];
	defaultOp: string;
	address: Address;
	/** This tab's cursor may have moved. */
	moved(): void;
	/** The table whose screen is showing. */
	screen(): TableMeta | null;
}

export interface Panel {
	show(what: Peeked): void;
	/** @param restore a close the user asked for: the focus goes back, and the address says so */
	close(restore?: boolean): void;
	/** Redraws the panel if it shows this row and has no unsaved edit. */
	refresh(t: TableMeta, row: Row): void;
	/** A record drawn on a sheet. Its pk addresses it, so the pk is read-only here too. */
	record(s: Sheet, row: Row, button: HTMLButtonElement): Peeked;
	/** A new row: every column writable, pk included, all in one POST. */
	draft(t: TableMeta, from: HTMLElement): Draft;
	/** The record it shows; empty for a new row or none. */
	key(): string[];
	/** Whether a field has an unsaved change. */
	dirty(): boolean;
}

export function panelOf(deps: PanelDeps): Panel {
	const { env, address } = deps;
	const { status, records, cells, fkOf } = env;
	const { busy, fail, say } = status;

	const peek = byId('peek');
	const entity = byId('peek-entity');
	const heading = byId('peek-title');
	const fields = byId('peek-fields');
	const actions = byId('peek-actions');
	const remover = byId('peek-delete') as HTMLButtonElement;
	const canceller = byId('peek-cancel') as HTMLButtonElement;
	const saver = byId('peek-save') as HTMLButtonElement;
	const closer = byId('peek-close');

	/** The panel's one occupant. */
	let opened: Peeked | null = null;

	const history = historyOf();
	const subtables = subtablesOf({
		...deps,
		master: () => opened,
		show: what => show(what),
		draft: (t, from) => draft(t, from),
		refresh: (t, row) => refresh(t, row),
	});

	const isDirty = () => fields.querySelector('input.dirty') !== null;



	// --- Fields ---

	/** The fk lists the fields offer; dropped when the fields are rebuilt. */
	const pickers: Picker[] = [];

	const dropPickers = () => pickers.splice(0).forEach(one => one.destroy());

	/** Lists the panel's problems, read off the notes under its fields. */
	const listPanel = () => status.standing(fields,
		[...fields.querySelectorAll<HTMLInputElement>('input.bad')].map(input => ({
			table: opened ? `${opened.t.entity} ${opened.title}` : undefined,
			field: input.name,
			what: unprefixed(input.name, document.getElementById(`bad-${input.name}`)?.textContent ?? ''),
		})));

	/** Shows (or clears) the refusal under a field. */
	const note = (input: HTMLInputElement, message?: string) => {
		input.classList.toggle('bad', message !== undefined);
		input.parentElement?.querySelector('.bad-note')?.remove();
		input.removeAttribute('aria-describedby');

		if (message !== undefined) {
			const said = classed('p', 'bad-note', message);

			said.id = `bad-${input.name}`;
			said.setAttribute('role', 'alert');
			input.setAttribute('aria-describedby', said.id);
			input.after(said);
		}

		listPanel();
	};

	/** Save and Cancel only while the fields differ from the row. */
	const syncActions = () => {
		const dirty = isDirty();

		saver.disabled = !dirty;
		canceller.disabled = !dirty;
	};

	/** Marks a box as changed, wherever the change came from. */
	const touched = (input: HTMLInputElement) => {
		note(input);					// the refusal was about the old value
		input.classList.toggle('dirty', input.value !== input.dataset.original);
		syncActions();
	};

	/** Picking from an fk's list writes every column of the fk (sent in the one PATCH). */
	const pickInto = (values: Row) => {
		for (const [name, value] of Object.entries(values)) {
			const box = fields.querySelector<HTMLInputElement>(`input[name="${CSS.escape(name)}"]`);

			if (!box) continue;			// a column of the fk this panel doesn't write

			box.value = textOf(value);
			touched(box);
		}
	};

	/** @param into the field's box, which an fk's list hangs inside */
	const input = (c: ColumnMeta, p: Peeked, into: HTMLElement): HTMLInputElement => {
		const box = el('input');
		const before = textOf(p.row[c.name]);
		const fk = fkOf(p.t, c);

		box.type = 'text';
		box.name = c.name;
		box.value = before;
		box.dataset.original = before;
		box.placeholder = c.expected;
		box.title = `${c.name}: ${c.type} — ${c.expected}`;

		const list = fk && picker(box, into, fk.ref, fk.target, pickInto);

		if (list) {
			pickers.push(list);
			box.addEventListener('keydown', e => { list.handled(e); });
		}

		box.addEventListener('input', () => { touched(box); list?.refresh(); });

		return box;
	};

	const field = (p: Peeked) => (c: ColumnMeta) => {
		const label = cells.named(el('dt', c.name), p.t, c, p.required(c));
		const fk = fkOf(p.t, c);

		if (!p.writable(c)) return [label, shown('dd', p.row[c.name], fk && cells.fkLink(fk, p.row, p.row[c.name]))];

		const box = el('dd');			// first: an fk's list hangs inside it

		box.append(input(c, p, box));

		return [label, box];
	};



	// --- Showing a record ---

	const close = (restore = false) => {
		opened?.button?.closest('tr')?.classList.remove('open');

		if (restore) opened?.from.focus();

		const was = opened !== null;

		opened = null;
		peek.hidden = true;
		subtables.close();
		history.close();
		dropPickers();
		status.standing(fields, []);

		deps.moved();				// whatever the cursor is on now, it isn't this record

		if (restore && was) address.mark([]);
	};

	/** Asks before it deletes: the next press does. */
	const armDelete = () => {
		remover.dataset.armed = 'true';
		remover.textContent = '¿Eliminar?';
	};

	const disarmDelete = () => {
		remover.disabled = false;
		remover.dataset.armed = 'false';
		remover.textContent = 'Eliminar';
	};

	/** Redraws from what it shows; rebuilding the fields drops any unsaved edit. */
	const fill = () => {
		if (!opened) return;

		const p = opened;
		const { t } = p;
		const writes = t.capabilities.includes(p.needs);
		const removes = p.remove !== undefined && t.capabilities.includes('delete');

		entity.textContent = t.entity;
		heading.textContent = p.title;
		dropPickers();
		fields.replaceChildren(...t.columns.flatMap(field(p)));
		listPanel();					// rebuilt fields carry no refusal
		canceller.hidden = saver.hidden = !writes;
		remover.hidden = !removes;
		actions.hidden = !writes && !removes;
		disarmDelete();
		syncActions();
		subtables.fill();
		void history.load(t, p.key, () => opened === p).catch(env.failSoftly);
	};

	/** The table is asked first: a detail row carries its master's key columns, so the key alone
	 * would let a subtable's row pass for the record shown. A new row never matches (no key). */
	const refresh = (t: TableMeta, row: Row) => {
		if (opened?.t !== t || !opened.key.length || !same(opened.key, key(t, row))) return;

		opened.row = row;
		if (!isDirty()) fill();
	};

	function show(what: Peeked): void {
		opened?.button?.closest('tr')?.classList.remove('open');
		opened = what;
		what.button?.closest('tr')?.classList.add('open');

		history.reset();
		fill();

		peek.hidden = false;
		what.landing().focus();

		address.mark(what.key);			// the screen already shows it
		deps.moved();
	}



	// --- Saving and deleting ---

	/** Sends every changed field in one request; an untouched one is never sent. */
	const save = async (): Promise<void> => {
		if (!opened) return;

		const dirty = [...fields.querySelectorAll<HTMLInputElement>('input.dirty')];

		if (!dirty.length) return;

		const at = opened.key.join('/');		// before the await, so a refusal can name the holder
		const given: Row = {};

		for (const box of dirty) given[box.name] = typed(box.value);

		saver.disabled = true;
		canceller.disabled = true;
		dirty.forEach(box => { box.disabled = true; });
		busy('Guardando…');

		try {
			await opened.save(given);
		} catch (err) {
			if (restarted(err)) return;

			// the row was read again on the way here, so the rebuild shows what's there now
			if (refused(err)) { fill(); fail(env.refusals.refusal(err, at)); return; }

			const failed = err instanceof ApiError ? err.fields : undefined;

			dirty.forEach(box => { box.disabled = false; });

			// every field, not just the sent ones: a required field left empty is never sent
			for (const box of fields.querySelectorAll<HTMLInputElement>('input'))
				note(box, failed?.[box.name]);

			syncActions();
			fail((err as Error).message);
		}
	};

	const remove = async (): Promise<void> => {
		const removing = opened?.remove;

		if (!removing || !opened) return;

		const at = opened.key.join('/');

		remover.disabled = true;
		busy('Eliminando…');

		try {
			await removing();
		} catch (err) {
			if (restarted(err)) return;

			// e.g. a detail still points at it: no field to mark, so it goes on the pill
			disarmDelete();
			fail(refused(err) ? env.refusals.refusal(err, at) : (err as Error).message);
		}
	};

	closer.addEventListener('click', () => close(true));
	byId('peek-form').addEventListener('submit', e => { e.preventDefault(); void save(); });
	canceller.addEventListener('click', () => fill());
	remover.addEventListener('click', () => { if (remover.dataset.armed === 'true') void remove(); else armDelete(); });
	addEventListener('keydown', e => { if (e.key === 'Escape') close(true); });



	// --- What it can show ---

	const record = (s: Sheet, row: Row, button: HTMLButtonElement): Peeked => {
		const { t } = s;
		const id = key(t, row);

		return {
			t, row, button,
			from: button,
			key: id,
			title: id.join(' · ') || 'Registro',
			needs: 'update',
			writable: c => writable(t, c),
			required: c => !c.nullable,		// a default fills an insert, not a blanked update
			landing: () => closer,
			save: async given => {
				// either way the row now holds what the server holds, so redraw either way
				try {
					await s.patch(row, given);
				} finally {
					s.refill(row);
				}

				fill();
				say(s.summary());
			},
			remove: async () => {
				try {
					await records.remove(t, row);
				} catch (err) {
					if (!refused(err)) throw err;

					await s.reread(row).catch(() => undefined);	// show what the other write left
					s.refill(row);
					fill();

					throw err;
				}

				// back to the list; drawing it again stops the address naming a gone row
				close();
				address.go([]);
			},
		};
	};

	const draft = (t: TableMeta, from: HTMLElement): Draft => ({
		t,
		// the declared constants, shown but not dirty: an untouched one isn't sent, and the
		// database applies it
		row: Object.fromEntries(t.columns.map(c => [c.name, constantDefault(c)])),
		key: [],
		from,
		title: 'Nuevo registro',
		needs: 'create',
		writable: () => true,
		required: requiredOnInsert,
		landing: () => fields.querySelector('input') ?? closer,
		insert: given => records.insert(t, given),
		save: async given => {
			const created = await records.insert(t, given);

			address.go(key(t, created));		// drawing it lists the new record in
		},
	});

	return {
		show, close, refresh, record, draft,
		key: () => opened?.key ?? [],
		dirty: isDirty,
	};
}
