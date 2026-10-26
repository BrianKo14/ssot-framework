// A table's screen: its grid, the record panel beside it, its toolbar (filters, insert, export,
// ancestor columns), and who else is on it.

import type { Capability, ColumnMeta, FormatMeta, Lock, SystemMeta, TableMeta, Viewer } from '../../shared/api.js';
import { type Action, actionMenu } from '../controls/actions.js';
import { ancestryPicker } from '../controls/ancestry.js';
import { filterBar } from '../controls/filters.js';
import { button, byId, classed } from '../kit/dom.js';
import type { Problem } from '../kit/status.js';
import { type Ancestor, ownColumns, type Reachable, reachedColumn, reachedName } from '../model/fk.js';
import { listPath } from '../model/query.js';
import type { View } from '../model/route.js';
import { addressOf, key, reached, type Row } from '../model/rows.js';
import { same } from '../kit/text.js';
import { restarted } from '../wire/auth.js';
import { download } from '../wire/export.js';
import { watching } from '../wire/presence.js';
import { api } from '../wire/api.js';
import { panelOf } from '../panel/panel.js';
import { type Env, type Sheet, sheetsOf } from '../sheet/sheet.js';
import { current, viewersOf } from './viewers.js';

export interface TableScreen {
	draw(t: TableMeta, view: View, unresolved: string[]): Promise<void>;
	/** Leaving for one of the framework's own screens, which nobody is *on* as presence counts. */
	leave(): void;
	/** Drawing failed: nothing on screen can be trusted, so it is cleared. */
	broke(err: unknown): void;
	/** This tab's presence name, for the monitor. */
	tab(): string | null;
	/** Viewers from somewhere else (the monitor), for the rail. */
	seen(viewers: Viewer[]): void;
}

/** What each capability is called on screen. A verb the vocabulary adds is a compile error here. */
const CAPABILITY_LABEL: Record<Capability, string> = {
	read: 'Leer',
	create: 'Insertar',
	update: 'Modificar',
	delete: 'Eliminar',
	lock: 'Lockear',
};

/** What the role may do on this table, beside its name, in `_meta`'s order. */
const grants = (t: TableMeta) => {
	const box = classed('span', 'grants',
		...t.capabilities.map(c => classed('span', 'grant', CAPABILITY_LABEL[c] ?? c)));

	box.title = `Lo que tu rol puede hacer en ${t.entity}`;

	return box;
};

export function tableScreen(meta: SystemMeta, env: Env): TableScreen {
	const { status, route, refusals, selection, failSoftly } = env;
	const { tables } = meta;
	const { busy, fail, say } = status;

	const grid = byId('grid');
	const head = byId('head');
	const rows = byId('rows');
	const empty = byId('empty');
	const heading = byId('title');

	const sheets = sheetsOf(env);
	const { editor, lead } = sheets;

	/** The screen showing, and its grid with the rows it drew. */
	let screen: TableMeta | null = null;
	let sheet: Sheet | null = null;

	/** The address for what's on screen now. */
	const here = (record: string[] = []): View =>
		({ screen: screen?.entity ?? '', key: record, conditions: filters.conditions() });

	/** Where this tab is: the cell being edited and the record in the panel. They can be two
	 * different records, and then both are marked for everybody else. */
	const cursor = () => {
		if (screen) watch.at(screen.entity, editor.at(), panel.key());
	};

	const panel = panelOf({
		env, sheets, tables,
		defaultOp: meta.defaultOperator,
		address: { go: k => route.go(here(k)), mark: k => route.mark(here(k)) },
		moved: () => cursor(),
		screen: () => screen,
	});

	const viewers = viewersOf({
		route, head, rows,
		relatch: lead.relatch,
		where: () => ({ entity: screen?.entity, grid: sheet?.t }),
	});

	const watch = watching(meta.pollSeconds, (list, locks) => showViewers(list, locks));

	const filters = filterBar(tables, meta.operators, () => { if (screen) route.go(here()); });


	// --- Who else is here (SCOPE 6c, 6d, 6e) ---

	/** Rows this tab is in the middle of changing. Reading one again would move its version
	 * under the write about to be sent with it; the refusal at save time speaks instead. */
	const busyWith = (at: string): boolean =>
		editor.at().join('/') === at || (panel.key().join('/') === at && panel.dirty());

	/** Reads a row again after somebody let go of it: letting go is very likely right after
	 * a change. Rows nobody held (an insert, a write from outside) wait for the next list read. */
	const refresh = async (at: string): Promise<void> => {
		const s = sheet;

		if (!s || busyWith(at)) return;

		const row = s.rows.find(r => addressOf(s.t, r) === at);

		if (!row) return;

		try {
			await s.reread(row);
		} catch {
			return;				// gone, or no longer readable: the next list read says so
		}

		s.redraw(row);
	};

	const showViewers = (list: Viewer[], locks: Lock[]) => {
		refusals.claimed(locks);

		for (const at of viewers.show(list)) void refresh(at);
	};


	// --- Ancestor columns (SCOPE 6b) ---

	/** What each screen borrows from its ancestors. Not in the address and not stored: it lasts
	 * as long as the page, and survives stepping to another screen and back. */
	const borrowed = new Map<TableMeta, Reachable[]>();

	const showing = (t: TableMeta) => borrowed.get(t) ?? [];

	/** Adds or drops one, and redraws. The open record comes along. */
	const borrow = (t: TableMeta, a: Ancestor, c: ColumnMeta, on: boolean) => {
		const name = reachedName(a, c);
		const kept = showing(t).filter(sh => sh.name !== name);

		borrowed.set(t, on ? [...kept, reachedColumn(a, c)] : kept);
		route.go(here(panel.key()));
	};

	const ancestry = ancestryPicker(tables, borrow);


	// --- The toolbar ---

	const insertRow: Action = {
		text: 'Insertar fila',
		needs: 'create',
		run: t => panel.show(panel.draft(t, inserts.button)),
	};

	/** It only offers what `_meta` says this screen points at. */
	const ancestorField: Action = {
		text: 'Campo ancestro',
		needs: 'read',
		run: t => ancestry.open(t, showing(t).map(sh => sh.name)),
	};

	/** One per format `_meta` publishes. The list on screen, as a file: same filter, same columns. */
	const saveAs = (f: FormatMeta): Action => ({
		text: f.label,
		needs: 'read',
		run: t => void download(
			listPath(t.entity, { filter: filters.query(), format: f.name, reached: reached(showing(t)) }),
			`${t.entity}.${f.extension}`).catch(failSoftly),
	});

	const inserts = actionMenu('Insertar', [insertRow, ancestorField]);
	const exports = actionMenu('Exportar', meta.formats.map(saveAs), { className: 'exports', iconOnly: true });

	byId('entities').replaceChildren(...tables.map(viewers.link));
	byId('toolbar').append(filters.element, inserts.element);
	byId('header-end').prepend(viewers.element);		// ahead of the counts: who is here, then what
	byId('header-end').append(exports.element);
	selection.selectable(rows, sheets.clipboardOf(rows));


	// --- The grid ---

	/** Clears the screen, calling off any edit or open record on it. */
	const blank = () => { grid.hidden = true; empty.hidden = true; editor.cancel(); panel.close(); };

	/** The grid's leading cell: the handle that opens the record in the panel, its latch and its undo. */
	const opener = (s: Sheet, row: Row): Node[] => {
		const open = button('handle', 'Ver registro');

		open.addEventListener('click', () => panel.show(panel.record(s, row, open)));

		return [open, lead.latch(s, row), lead.undo(s, row)];
	};

	const gridSheet = (t: TableMeta): Sheet => {
		const s: Sheet = sheets.sheet({
			t, columns: [...ownColumns(t), ...showing(t)],
			head, body: rows, table: grid, empty,
			leastRows: 0,			// as long as the list
			draft: () => panel.draft(t, inserts.button),
			handle: row => opener(s, row),
			changed: row => panel.refresh(t, row),
			moved: () => cursor(),
			at: row => (t === screen ? key(t, row) : []),
			own: () => sheet === s,
			held: () => watch.now(),
			drawn: () => viewers.draw(),
		});

		return s;
	};

	/** Reads the rows under the filter bar's conditions, and draws them. */
	const load = async (s: Sheet): Promise<Row[]> => {
		blank();
		busy('Cargando…');

		const data = await api<Row[]>(
			listPath(s.t.entity, { filter: filters.query(), reached: reached(s.columns) }));

		sheet = s;				// where a row read again on its own is drawn back into

		selection.clear(rows);			// the cells picked were the last list's
		s.render(data);
		say(s.summary());

		return data;
	};

	/** Opens the record the address names, if the grid drew it. */
	const reopen = (s: Sheet, wanted: string[], data: Row[]): boolean => {
		const i = data.findIndex(row => same(key(s.t, row), wanted));
		const handle = s.body.children[i]?.querySelector('button');

		if (!(handle instanceof HTMLButtonElement)) return false;

		panel.show(panel.record(s, data[i], handle));

		return true;
	};

	const draw = async (t: TableMeta, view: View, unresolved: string[]): Promise<void> => {
		// what was wrong with the last address, or the last draw, isn't now
		status.standing(route, []);
		status.standing(grid, []);

		current(t.entity);

		heading.replaceChildren(t.entity, grants(t));
		screen = t;
		watch.at(t.entity, [], []);		// an open record says so itself when it opens
		filters.reset(t, view.conditions);
		inserts.reset(t);
		exports.reset(t);

		const s = gridSheet(t);
		const data = await load(s);

		// say what the address asked for and wasn't found, for as long as it's the address
		const notes: Problem[] = [
			...unresolved.map(name => ({ field: name, what: 'filtro ignorado' })),
			...(view.key.length && !reopen(s, view.key, data)
				? [{ what: `el registro ${view.key.join(' · ')} no está en la lista` }] : []),
		];

		status.standing(route, notes);
		fail(...notes);
	};

	return {
		draw,

		leave() {
			status.standing(grid, []);
			blank();
			for (const part of [filters.element, inserts.element, exports.element]) part.hidden = true;
			screen = null;
			sheet = null;
			watch.at(null, [], []);
		},

		broke(err) {
			if (restarted(err)) return;

			blank();
			status.standing(grid, [{ what: (err as Error).message }]);
			fail((err as Error).message);
		},

		tab: () => watch.tab(),
		seen: list => showViewers(list, []),
	};
}
