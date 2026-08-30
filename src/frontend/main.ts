import type { ColumnMeta, SystemMeta, TableMeta } from '../api-meta.js';

type Row = Record<string, unknown>;


// --- DOM ---

const byId = (id: string): HTMLElement => {
	const node = document.getElementById(id);

	if (!node) throw new Error(`missing element #${id}`);

	return node;
};

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, ...children: (string | Node)[]) => {
	const node = document.createElement(tag);
	node.append(...children);
	return node;
};

const 	nav = byId('entities'),
	heading = byId('title'),
	statusLine = byId('status'),
	grid = byId('grid'),
	gridHead = byId('head'),
	gridRows = byId('rows'),
	emptyNote = byId('empty');

const say = (message: string, state: 'ready' | 'busy' | 'error' = 'ready') => {
	statusLine.textContent = message;
	statusLine.dataset.state = state;
};

/** Hides the grid when no table is selected */
const blank = () => { grid.hidden = true; emptyNote.hidden = true; };


// --- API ---

async function api<T>(path: string): Promise<T> {
	const res = await fetch(path);
	const body = await res.json();

	if (!res.ok) throw new Error(typeof body?.error === 'string' ? body.error : res.statusText);

	return body as T;
}


// --- Rendering ---

const header = (t: TableMeta) => (c: ColumnMeta) => {
	const th = el('th', c.name, el('small', c.type));

	th.title = `${c.type} — ${c.expected}`;
	th.classList.toggle('pk', t.pk.includes(c.name));
	th.classList.toggle('required', !c.nullable);

	return th;
};

const cell = (row: Row) => (c: ColumnMeta) => {
	const value = row[c.name];
	const td = el('td', value === null ? 'null' : String(value));

	td.classList.toggle('null', value === null);

	return td;
};

const gutter = (tag: 'th' | 'td', label: string) => {
	const node = el(tag, label);

	node.className = 'gutter';

	return node;
};

const renderGrid = (t: TableMeta, data: Row[]) => {
	gridHead.replaceChildren(gutter('th', ''), ...t.columns.map(header(t)));
	gridRows.replaceChildren(...data.map((row, i) =>
		el('tr', gutter('td', String(i + 1)), ...t.columns.map(cell(row)))));

	grid.hidden = false;			// show header even with no rows under it
	emptyNote.hidden = data.length > 0;
};

const link = (t: TableMeta) => {
	const a = el('a', t.table);

	a.href = `#${encodeURIComponent(t.table)}`;
	a.dataset.table = t.table;

	return a;
};


// --- Screens ---

let tables: TableMeta[] = [];

/** The hash names the screen being viewed, so the URL survives a copy into another tab */
const current = () => decodeURIComponent(location.hash.slice(1));

async function show(name: string): Promise<void> {
	const t = tables.find(x => x.table === name);

	if (!t) { location.hash = encodeURIComponent(tables[0].table); return; }

	for (const a of nav.querySelectorAll('a'))
		a.setAttribute('aria-current', String(a.dataset.table === t.table));

	heading.textContent = t.table;
	blank();
	say('Cargando…', 'busy');

	const data = await api<Row[]>(`/api/${encodeURIComponent(t.table)}`);

	renderGrid(t, data);
	say(`${data.length} registro(s) · ${t.columns.length} campo(s)`);
}

const route = () => void show(current()).catch((err: Error) => {
	blank();
	say(err.message, 'error');
});


async function main(): Promise<void> {
	try {
		({ tables } = await api<SystemMeta>('/api/_meta'));
	} catch (err) {
		say(`No se pudo leer el esquema: ${(err as Error).message}`, 'error');
		return;
	}

	if (!tables.length) { say('El esquema no define ninguna entidad.'); return; }

	nav.replaceChildren(...tables.map(link));
	addEventListener('hashchange', route);
	route();
}

void main();
