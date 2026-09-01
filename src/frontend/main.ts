import type { ColumnMeta, SystemMeta, TableMeta } from '../shared/api.js';
import { api, sending } from './api.js';
import { authenticated, sessionEnded } from './auth.js';
import { byId, el } from './dom.js';
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
	peekFields = byId('peek-fields'),
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

const cell = (t: TableMeta, row: Row) => (c: ColumnMeta) => {
	const td = shown('td', row[c.name]);

	// If this cell is a pk, or user doesn't have update rights, it is not editable.
	if (t.pk.includes(c.name) || !t.capabilities.includes('update')) return td;

	td.classList.add('editable');
	td.addEventListener('dblclick', () => edit(t, row, c, td));

	return td;
};

const field = (t: TableMeta, row: Row) => (c: ColumnMeta) =>
	[named(el('dt', c.name), t, c), shown('dd', row[c.name])];

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
	button.addEventListener('click', () => openPeek(t, row, button));

	return lead('td', button);
};

/** The one place a row's cells are written. The lead cell is kept, not rebuilt: the peek holds
    that button, and a fresh one would leave the row it marked unmarkable. */
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

/** The open row: the button that opened it, so the row stays marked, and its key, so the
    address can name it and a redraw can find it again. */
let opened: { button: HTMLButtonElement; t: TableMeta; row: Row; key: string[] } | null = null;

/** @param restore give the focus back to the row — for a close the user asked for, not for one
    the screen did on its way to replacing that row anyway. */
const closePeek = (restore = false) => {
	opened?.button.closest('tr')?.classList.remove('open');

	if (restore) opened?.button.focus();

	const was = opened !== null;

	opened = null;
	peek.hidden = true;

	// A close the user asked for is a move, so the address stops naming the record. A close the
	// screen did is not: it is on its way to drawing whatever the address already says.
	if (restore && was) route.mark(here());
};

const dismissPeek = () => closePeek(true);

/** Writes the panel from what the row holds now. */
const fillPeek = () => {
	if (!opened) return;

	const { t, row } = opened;

	peekEntity.textContent = t.table;
	peekTitle.textContent = key(t, row).join(' · ') || 'Registro';
	peekFields.replaceChildren(...t.columns.flatMap(field(t, row)));
};

/** Matched by key, not by identity: a row the grid has just drawn again is the same record. */
const refreshPeek = (row: Row) => {
	if (!opened || !same(opened.key, key(opened.t, row))) return;

	opened.row = row;
	fillPeek();
};

function openPeek(t: TableMeta, row: Row, button: HTMLButtonElement): void {
	opened?.button.closest('tr')?.classList.remove('open');
	opened = { button, t, row, key: key(t, row) };
	button.closest('tr')?.classList.add('open');

	fillPeek();

	peek.hidden = false;
	peekClose.focus();

	route.mark(here(opened.key));		// the screen already shows it; the address only says so
}


// --- Editing ---

/** The cell being edited — one at a time, so opening another can call it off. */
let editing: { td: HTMLTableCellElement; cancel: () => void } | null = null;

/** A cell opens into the one editor the framework has: a text box.
 *
 * Every type handler already reads its own value out of text, so the screen sends what was typed
 * and the column's handler is the only thing that judges it. A widget chosen per type would be a
 * second place that knows what a `date` is. An empty box is `null`, for every type. */
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

			// What lands on screen is the row as the database now holds it, not the typed text.
			// Assigned into the same object the row and the peek hold.
			Object.assign(row, saved);
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
let route!: Router;

/** The address for what is on screen now. Assembled from the screen and the bar themselves,
    never from a second copy of what they hold. */
const here = (record: string[] = []): View =>
	({ screen: screen?.table ?? '', key: record, conditions: filters.conditions() });

/** The rows the screen is asking for now. The filter is read off the bar rather than handed in,
    so arriving at a screen and changing its filter ask the same question. */
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

/** Opens the record the address names, when the grid drew it. Rows and their `tr`s are in step,
    so the row that matched names the button that marks it. */
const reopen = (t: TableMeta, wanted: string[], data: Row[]): boolean => {
	const i = data.findIndex(row => same(key(t, row), wanted));
	const button = gridRows.children[i]?.querySelector('button');

	if (!(button instanceof HTMLButtonElement)) return false;

	openPeek(t, data[i], button);

	return true;
};

/** Draws what the address says. Every move — a link, the filter bar, Back — ends here, so what
    is on screen and what the address says cannot come apart. */
async function draw(): Promise<void> {
	const { view, unresolved } = route.read();
	const t = tables.find(x => x.table === view.screen);

	// An address naming no screen this user has is not a place to be: rewritten, not added to.
	if (!t) { route.go({ screen: tables[0].table, key: [], conditions: [] }, true); return; }

	for (const a of nav.querySelectorAll('a'))
		a.setAttribute('aria-current', String(a.dataset.table === t.table));

	heading.textContent = t.table;
	screen = t;
	filters.reset(t, view.conditions);	// a filter names columns, so it belongs to the screen that has them

	const data = await load(t);

	// What the address asked for and did not get is said, not silently dropped.
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

// A filter change is a move like any other: it names a new address, and drawing it reloads.
// The record open on the old filter is not carried over — it may not be in the new answer.
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
	route = router(meta);

	nav.replaceChildren(...tables.map(link));
	toolbar.append(filters.element);
	peekClose.addEventListener('click', dismissPeek);
	addEventListener('keydown', e => { if (e.key === 'Escape') dismissPeek(); });
	route.onNavigate(render);
	render();
}

void main();
