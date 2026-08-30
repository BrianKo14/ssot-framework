import type { ColumnMeta, SystemMeta, TableMeta } from '../api-meta.js';
import { byId, el } from './dom.js';
import { filterBar, type FilterBar } from './filters.js';

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

async function api<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(path, init);
	const body = await res.json();

	if (!res.ok) throw new Error(typeof body?.error === 'string' ? body.error : res.statusText);

	return body as T;
}

const sending = (method: string, body: unknown): RequestInit =>
	({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

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

/** A pk cell is not editable: the pk addresses the row, which is why `crudRouter`'s `updatable`
    leaves it out too. Both sides read the same `pk`. */
const cell = (t: TableMeta, row: Row) => (c: ColumnMeta) => {
	const td = shown('td', row[c.name]);

	if (t.pk.includes(c.name)) return td;

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

/** The open row, and the button that opened it, so the row stays marked. */
let opened: { button: HTMLButtonElement; t: TableMeta; row: Row } | null = null;

/** @param restore give the focus back to the row — for a close the user asked for, not for one
    the screen did on its way to replacing that row anyway. */
const closePeek = (restore = false) => {
	opened?.button.closest('tr')?.classList.remove('open');

	if (restore) opened?.button.focus();

	opened = null;
	peek.hidden = true;
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

const refreshPeek = (row: Row) => { if (opened?.row === row) fillPeek(); };

function openPeek(t: TableMeta, row: Row, button: HTMLButtonElement): void {
	opened?.button.closest('tr')?.classList.remove('open');
	opened = { button, t, row };
	button.closest('tr')?.classList.add('open');

	fillPeek();

	peek.hidden = false;
	peekClose.focus();
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

	a.href = `#${encodeURIComponent(t.table)}`;
	a.dataset.table = t.table;

	return a;
};


// --- Screens ---

let tables: TableMeta[] = [];

/** The screen being viewed, so a filter change reloads it without re-routing. */
let screen: TableMeta | null = null;

/** Built in `main`, once `_meta` has answered. */
let filters!: FilterBar;

/** The hash names the screen, so the URL survives a copy into another tab. */
const current = () => decodeURIComponent(location.hash.slice(1));

/** The rows the screen is asking for now. The filter is read off the bar rather than handed in,
    so arriving at a screen and changing its filter ask the same question. */
async function load(t: TableMeta): Promise<void> {
	blank();
	say('Cargando…', 'busy');

	const filter = filters.query();
	const query = filter === undefined ? '' : `?filter=${encodeURIComponent(filter)}`;

	renderGrid(t, await api<Row[]>(`/api/${encodeURIComponent(t.table)}${query}`));
	say(summary(t));
}

async function show(name: string): Promise<void> {
	const t = tables.find(x => x.table === name);

	if (!t) { location.hash = encodeURIComponent(tables[0].table); return; }

	for (const a of nav.querySelectorAll('a'))
		a.setAttribute('aria-current', String(a.dataset.table === t.table));

	heading.textContent = t.table;
	screen = t;
	filters.reset(t);		// a filter names columns, so it belongs to the screen that has them

	await load(t);
}

const fail = (err: Error) => { blank(); say(err.message, 'error'); };

const route = () => void show(current()).catch(fail);
const refilter = () => { if (screen) void load(screen).catch(fail); };


async function main(): Promise<void> {
	let meta: SystemMeta;

	try {
		meta = await api<SystemMeta>('/api/_meta');
	} catch (err) {
		say(`No se pudo leer el esquema: ${(err as Error).message}`, 'error');
		return;
	}

	tables = meta.tables;

	if (!tables.length) { say('El esquema no define ninguna entidad.'); return; }

	filters = filterBar(meta.operators, refilter);

	nav.replaceChildren(...tables.map(link));
	toolbar.append(filters.element);
	peekClose.addEventListener('click', dismissPeek);
	addEventListener('keydown', e => { if (e.key === 'Escape') dismissPeek(); });
	addEventListener('hashchange', route);
	route();
}

void main();
