import type { Capability, ColumnMeta, SystemMeta, TableMeta } from '../shared/api.js';
import { actionMenu, type Action, type ActionMenu } from './actions.js';
import { api, ApiError, sending } from './api.js';
import { authenticated, sessionEnded } from './auth.js';
import { byId, classed, el } from './dom.js';
import { filterBar, type FilterBar } from './filters.js';
import { router, same, type Router, type View } from './route.js';

type Row = Record<string, unknown>;


// --- DOM ---

const 	nav = byId('entities'),
	toolbar = byId('toolbar'),
	heading = byId('title'),
	statusLine = byId('status'),
	grid = byId('grid'),
	gridHead = byId('head'),
	gridRows = byId('rows'),
	emptyNote = byId('empty'),
	peek = byId('peek'),
	peekEntity = byId('peek-entity'),
	peekTitle = byId('peek-title'),
	peekForm = byId('peek-form'),
	peekFields = byId('peek-fields'),
	peekActions = byId('peek-actions'),
	peekDelete = byId('peek-delete') as HTMLButtonElement,
	peekCancel = byId('peek-cancel') as HTMLButtonElement,
	peekSave = byId('peek-save') as HTMLButtonElement,
	peekClose = byId('peek-close');

const say = (message: string, state: 'ready' | 'busy' | 'error' = 'ready') => {
	statusLine.textContent = message;
	statusLine.dataset.state = state;
};

/** Clears the screen, calling off any edit or peek on it. */
const blank = () => { grid.hidden = true; emptyNote.hidden = true; editing?.cancel(); closePeek(); };


// --- API ---

/** A row's pk values, in declaration order. */
const key = (t: TableMeta, row: Row) => t.pk.map(k => String(row[k]));

/** The `/:pk0[/:pk1…]` route `crudRouter` mounts. */
const rowPath = (t: TableMeta, row: Row) =>
	[`/api/${encodeURIComponent(t.table)}`, ...key(t, row).map(encodeURIComponent)].join('/');


// --- Rendering ---

/** A column's tooltip and markers, shared by the grid header and the peek's label. */
const named = <N extends HTMLElement>(node: N, t: TableMeta, c: ColumnMeta): N => {
	node.title = `${c.type} — ${c.expected}`;
	node.classList.toggle('pk', t.pk.includes(c.name));
	node.classList.toggle('required', !c.nullable);

	return node;
};

/** A value, in a grid cell or a peek field. */
const shown = <K extends 'td' | 'dd'>(tag: K, value: unknown) => {
	const node = el(tag, value === null ? 'null' : String(value));

	node.classList.toggle('null', value === null);

	return node;
};

const header = (t: TableMeta) => (c: ColumnMeta) => named(el('th', c.name, el('small', c.type)), t, c);

/** Shared by the grid's cell and the peek's field, so the two can't disagree on what's editable. */
const writable = (t: TableMeta, c: ColumnMeta) => !t.pk.includes(c.name) && t.capabilities.includes('update');

const cell = (t: TableMeta, row: Row) => (c: ColumnMeta) => {
	const td = shown('td', row[c.name]);

	if (!writable(t, c)) return td;

	td.classList.add('editable');
	td.addEventListener('dblclick', () => edit(t, row, c, td));

	return td;
};

/** Shows (or clears) an error message under a field. */
const note = (input: HTMLInputElement, message?: string) => {
	input.classList.toggle('bad', message !== undefined);
	input.parentElement?.querySelector('.bad-note')?.remove();
	input.removeAttribute('aria-describedby');

	if (message === undefined) return;

	const said = classed('p', 'bad-note', message);

	said.id = `bad-${input.name}`;			// named, so the input it is about can point at it
	said.setAttribute('role', 'alert');
	input.setAttribute('aria-describedby', said.id);
	input.after(said);
};

/** A field's editor in the side panel. */
const peekInput = (c: ColumnMeta, row: Row): HTMLInputElement => {
	const input = el('input');
	const before = row[c.name] === null ? '' : String(row[c.name]);

	input.type = 'text';
	input.name = c.name;
	input.value = before;
	input.dataset.original = before;
	input.placeholder = c.expected;
	input.title = `${c.name}: ${c.type} — ${c.expected}`;
	input.addEventListener('input', () => {
		note(input);				// clear any refusal — it was about the old value
		input.classList.toggle('dirty', input.value !== input.dataset.original);
		syncPeekActions();
	});

	return input;
};

const field = (p: Peeked) => (c: ColumnMeta) =>
	[named(el('dt', c.name), p.t, c),
		p.writable(c) ? el('dd', peekInput(c, p.row)) : shown('dd', p.row[c.name])];

/** The grid's sticky leading column. */
const lead = (tag: 'th' | 'td', ...children: Node[]) => {
	const node = el(tag, ...children);

	node.className = 'lead';

	return node;
};

const opener = (t: TableMeta, row: Row) => {
	const button = el('button');

	button.type = 'button';
	button.title = 'Ver registro';
	button.setAttribute('aria-label', 'Ver registro');
	button.addEventListener('click', () => show(record(t, row, button)));

	return lead('td', button);
};

/** The one place a row's cells are written. The lead cell is kept, not rebuilt — a fresh one
    would drop the peek's reference to the button that marks this row open. */
const fill = (tr: HTMLTableRowElement, t: TableMeta, row: Row) => {
	tr.replaceChildren(tr.querySelector('.lead') ?? opener(t, row), ...t.columns.map(cell(t, row)));

	return tr;
};

const renderGrid = (t: TableMeta, data: Row[]) => {
	gridHead.replaceChildren(lead('th'), ...t.columns.map(header(t)));
	gridRows.replaceChildren(...data.map(row => fill(el('tr'), t, row)));

	grid.hidden = false;			// show header even with no rows under it
	emptyNote.hidden = data.length > 0;
};

/** "1 registro", "2 registros"; an irregular plural passes its own. */
const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Counted off the grid, not off a second copy of the count kept beside it. */
const summary = (t: TableMeta) =>
	`${count(gridRows.childElementCount, 'registro')} · ${count(t.columns.length, 'campo')}`;


// --- Row peek ---

/** What the side panel is showing: a record the grid drew, or a row being drafted for insert.
    Same panel either way — only these differ. */
interface Peeked {
	t: TableMeta;
	row: Row;
	/** Empty for a draft: it is not a record until it has been saved. */
	key: string[];
	/** The grid button that opened it, so its row stays marked. None for a draft. */
	button?: HTMLButtonElement;
	/** Focus target on close. */
	from: HTMLElement;
	title: string;
	needs: Capability;
	writable(c: ColumnMeta): boolean;
	/** Focus target on open: a record is there to be read, a draft to be written. */
	landing(): HTMLElement;
	save(typed: Row): Promise<void>;
	/** Absent on a draft: there is nothing there yet to delete. */
	remove?(): Promise<void>;
}

/** The panel's one occupant. */
let opened: Peeked | null = null;

/** @param restore whether this is a user-initiated close, vs. one the screen did on its way
    to redrawing (in which case the address should not change). */
const closePeek = (restore = false) => {
	opened?.button?.closest('tr')?.classList.remove('open');

	if (restore) opened?.from.focus();

	const was = opened !== null;

	opened = null;
	peek.hidden = true;

	if (restore && was) route.mark(here());
};

const dismissPeek = () => closePeek(true);

/** Redraws the panel from what it is showing now; rebuilding the fields clears any unsaved edit. */
const fillPeek = () => {
	if (!opened) return;

	const { t } = opened;

	// each button, and the footer, shown only where its own action is allowed
	const writes = t.capabilities.includes(opened.needs);
	const removes = opened.remove !== undefined && t.capabilities.includes('delete');

	peekEntity.textContent = t.table;
	peekTitle.textContent = opened.title;
	peekFields.replaceChildren(...t.columns.flatMap(field(opened)));
	peekCancel.hidden = peekSave.hidden = !writes;
	peekDelete.hidden = !removes;
	peekActions.hidden = !writes && !removes;
	disarmDelete();
	syncPeekActions();
};

/** Updates the shown row after the grid redraws it — unless the panel has unsaved edits, or
    isn't showing this record at all (a draft never matches: it has no key). */
const refreshPeek = (row: Row) => {
	if (!opened?.key.length || !same(opened.key, key(opened.t, row))) return;

	opened.row = row;
	if (!peekFields.querySelector('input.dirty')) fillPeek();
};

/** Opens the panel on what it is given, closing whatever it held. */
function show(what: Peeked): void {
	opened?.button?.closest('tr')?.classList.remove('open');
	opened = what;
	what.button?.closest('tr')?.classList.add('open');

	fillPeek();

	peek.hidden = false;
	what.landing().focus();

	route.mark(here(what.key));		// the screen already shows it; the address only says so
}

/** Save and Cancel are enabled only while the panel disagrees with the row it is showing. */
const syncPeekActions = () => {
	const dirty = peekFields.querySelector('input.dirty') !== null;

	peekSave.disabled = !dirty;
	peekCancel.disabled = !dirty;
};

/** Sends every changed field in one request — an untouched one is never sent at all. */
async function savePeek(): Promise<void> {
	if (!opened) return;

	const dirty = [...peekFields.querySelectorAll<HTMLInputElement>('input.dirty')];

	if (!dirty.length) return;

	const typed: Row = {};

	for (const input of dirty) typed[input.name] = input.value.trim() === '' ? null : input.value;

	peekSave.disabled = true;
	peekCancel.disabled = true;
	dirty.forEach(input => { input.disabled = true; });
	say('Guardando…', 'busy');

	try {
		await opened.save(typed);
	} catch (err) {
		if (sessionEnded(err)) { location.reload(); return; }

		const failed = err instanceof ApiError ? err.fields : undefined;

		dirty.forEach(input => { input.disabled = false; });

		// every field the refusal names, not just the ones sent — a required field left empty
		// is never sent, so its own "is required" can only be shown by checking all of them
		for (const input of peekFields.querySelectorAll<HTMLInputElement>('input'))
			note(input, failed?.[input.name]);

		syncPeekActions();
		say((err as Error).message, 'error');
	}
}

/** Puts the panel back the way the row says it is — the same rebuild a save ends with. */
const cancelPeek = () => fillPeek();

/** Arms the button; the next press is the one that deletes. */
const armDelete = () => {
	peekDelete.dataset.armed = 'true';
	peekDelete.textContent = '¿Eliminar?';
};

/** Resets the button to ask again before it acts. */
const disarmDelete = () => {
	peekDelete.disabled = false;
	peekDelete.dataset.armed = 'false';
	peekDelete.textContent = 'Eliminar';
};

async function removePeek(): Promise<void> {
	const removing = opened?.remove;

	if (!removing) return;

	peekDelete.disabled = true;
	say('Eliminando…', 'busy');

	try {
		await removing();
	} catch (err) {
		if (sessionEnded(err)) { location.reload(); return; }

		// e.g. a row a detail still points at — names no field, so it goes on the status line
		disarmDelete();
		say((err as Error).message, 'error');
	}
}

/** A record already in the grid — its pk addresses it, so the pk is read-only here too. */
const record = (t: TableMeta, row: Row, button: HTMLButtonElement): Peeked => {
	const id = key(t, row);

	return {
		t, row, button,
		from: button,
		key: id,
		title: id.join(' · ') || 'Registro',
		needs: 'update',
		writable: c => writable(t, c),
		landing: () => peekClose,
		save: async typed => {
			const saved = await api<Row>(rowPath(t, row), sending('PATCH', typed));

			Object.assign(row, saved);		// keep what the server returned, not the typed text

			const tr = button.closest('tr');
			if (tr?.isConnected) fill(tr, t, row);

			fillPeek();
			say(summary(t));
		},
		remove: async () => {
			await api<void>(rowPath(t, row), sending('DELETE'));

			// back to the list; drawing it again is what stops the address naming a gone row
			closePeek();
			route.go(here());
		},
	};
};

/** A new row being inserted. Every column is writable — the pk included, since an insert sets
    it — and the whole thing goes in one POST to the entity's collection. */
const draft = (t: TableMeta, from: HTMLElement): Peeked => ({
	t,
	row: Object.fromEntries(t.columns.map(c => [c.name, null])),	// an all-null row
	key: [],
	from,
	title: 'Nuevo registro',
	needs: 'create',
	writable: () => true,
	landing: () => peekFields.querySelector('input') ?? peekClose,
	save: async typed => {
		const created = await api<Row>(`/api/${encodeURIComponent(t.table)}`, sending('POST', typed));

		route.go(here(key(t, created)));	// go to the new record; drawing it lists it in
	},
});

/** The one action the toolbar offers so far. */
const insertRow: Action = {
	text: 'Insertar fila',
	needs: 'create',
	run: t => show(draft(t, inserts.button)),
};


// --- Editing ---

/** The cell being edited — one at a time, so opening another can call it off. */
let editing: { td: HTMLTableCellElement; cancel: () => void } | null = null;

/** A cell opens into one text box, for every type: the column's own handler reads it back, so
    the screen never needs a per-type widget. An empty box is `null`. */
function edit(t: TableMeta, row: Row, c: ColumnMeta, td: HTMLTableCellElement): void {
	if (editing?.td === td) return;			// a double-click *inside* the open editor selects a word

	editing?.cancel();

	const tr = td.closest('tr');
	const before = row[c.name] === null ? '' : String(row[c.name]);
	const input = el('input');

	input.type = 'text';
	input.value = before;
	input.placeholder = c.expected;
	input.title = `${c.name}: ${c.type} — ${c.expected}`;

	let settled = false;

	/** Puts the cell back the way the row says it is. */
	const restore = () => {
		settled = true;
		editing = null;

		if (tr?.isConnected) fill(tr, t, row);
	};

	const commit = async () => {
		if (settled || !td.isConnected) return;	// Enter blurs the input straight after; so does leaving the screen

		if (input.value === before) { restore(); return; }

		settled = true;
		input.disabled = true;
		td.classList.remove('bad');
		say('Guardando…', 'busy');

		try {
			const saved = await api<Row>(rowPath(t, row),
				sending('PATCH', { [c.name]: input.value.trim() === '' ? null : input.value }));

			Object.assign(row, saved);		// keep what the server returned, not the typed text
			editing = null;

			if (tr?.isConnected) fill(tr, t, row);

			refreshPeek(row);
			say(summary(t));
		} catch (err) {
			if (sessionEnded(err)) { location.reload(); return; }

			settled = false;		// still on screen and still refused: let it be fixed
			input.disabled = false;
			input.focus();
			td.classList.add('bad');
			say((err as Error).message, 'error');
		}
	};

	input.addEventListener('keydown', e => {
		if (e.key === 'Enter') void commit();
		else if (e.key === 'Escape') { e.stopPropagation(); restore(); }	// the peek's Escape must not fire too
	});
	input.addEventListener('blur', () => void commit());

	td.classList.add('editing');
	td.replaceChildren(input);
	input.focus();
	input.select();

	editing = { td, cancel: restore };
}

const link = (t: TableMeta) => {
	const a = el('a', t.table);

	a.href = route.href({ screen: t.table, key: [], conditions: [] });
	a.dataset.table = t.table;

	return a;
};


// --- Screens ---

let tables: TableMeta[] = [];

/** The screen being viewed, so the address can be written from what is on it. */
let screen: TableMeta | null = null;

/** Built in `main`, once `_meta` has answered. */
let filters!: FilterBar;
let inserts!: ActionMenu;
let route!: Router;

/** The address for what is on screen now, assembled from the screen and the bar themselves. */
const here = (record: string[] = []): View =>
	({ screen: screen?.table ?? '', key: record, conditions: filters.conditions() });

/** Fetches rows for the screen, under whatever filter the bar currently holds. */
async function load(t: TableMeta): Promise<Row[]> {
	blank();
	say('Cargando…', 'busy');

	const filter = filters.query();
	const query = filter === undefined ? '' : `?filter=${encodeURIComponent(filter)}`;
	const data = await api<Row[]>(`/api/${encodeURIComponent(t.table)}${query}`);

	renderGrid(t, data);
	say(summary(t));

	return data;
}

/** Opens the record the address names, if the grid drew it. */
const reopen = (t: TableMeta, wanted: string[], data: Row[]): boolean => {
	const i = data.findIndex(row => same(key(t, row), wanted));
	const button = gridRows.children[i]?.querySelector('button');

	if (!(button instanceof HTMLButtonElement)) return false;

	show(record(t, data[i], button));

	return true;
};

/** Draws what the address says. Every move — a link, the filter bar, Back — ends here, so what
    is on screen and the address can't come apart. */
async function draw(): Promise<void> {
	const { view, unresolved } = route.read();
	const t = tables.find(x => x.table === view.screen);

	if (!t) { route.go({ screen: tables[0].table, key: [], conditions: [] }, true); return; }

	for (const a of nav.querySelectorAll('a'))
		a.setAttribute('aria-current', String(a.dataset.table === t.table));

	heading.textContent = t.table;
	screen = t;
	filters.reset(t, view.conditions);
	inserts.reset(t);

	const data = await load(t);

	// report anything the address asked for that wasn't found, rather than dropping it silently
	const notes = [
		...unresolved.map(name => `filtro ignorado: ${name}`),
		...(view.key.length && !reopen(t, view.key, data)
			? [`el registro ${view.key.join(' · ')} no está en la lista`] : []),
	];

	if (notes.length) say(`${summary(t)} · ${notes.join(' · ')}`, 'error');
}

const fail = (err: Error) => {
	if (sessionEnded(err)) { location.reload(); return; }

	blank();
	say(err.message, 'error');
};

const render = () => void draw().catch(fail);

// a filter change is a move like any other: it names a new address, and drawing it reloads
const refilter = () => { if (screen) route.go(here()); };


async function main(): Promise<void> {
	await authenticated();			// nothing below this runs until there is a session

	let meta: SystemMeta;

	try {
		meta = await api<SystemMeta>('/api/_meta');
	} catch (err) {
		say(`No se pudo leer el esquema: ${(err as Error).message}`, 'error');
		return;
	}

	tables = meta.tables;

	if (!tables.length) { say('No hay entidades disponibles para este usuario.'); return; }

	filters = filterBar(meta.operators, refilter);
	inserts = actionMenu('Insertar', [insertRow]);
	route = router(meta);

	nav.replaceChildren(...tables.map(link));
	toolbar.append(filters.element, inserts.element);
	peekClose.addEventListener('click', dismissPeek);
	peekForm.addEventListener('submit', e => { e.preventDefault(); void savePeek(); });
	peekCancel.addEventListener('click', cancelPeek);
	peekDelete.addEventListener('click',
		() => { if (peekDelete.dataset.armed === 'true') void removePeek(); else armDelete(); });
	addEventListener('keydown', e => { if (e.key === 'Escape') dismissPeek(); });
	route.onNavigate(render);
	render();
}

void main();
