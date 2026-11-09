// The subtables under the record panel: one tab per table that is a detail of the
// record's, each a sheet of the detail's rows under that record.

import type { TableMeta } from '../../shared/api.js';
import { type Action, actionMenu } from '../controls/actions.js';
import { byId, classed, el } from '../kit/dom.js';
import { type Detail, detailsOf, ownColumns, valuesFrom } from '../model/fk.js';
import { filterQuery, listPath } from '../model/query.js';
import { screenOf } from '../model/route.js';
import { key, type Row } from '../model/rows.js';
import { api } from '../wire/api.js';
import type { Sheet } from '../sheet/sheet.js';
import type { Draft, PanelDeps, Peeked } from './panel.js';

export interface Subtables {
	/** Rebuilds the tabs for the record the panel shows now. */
	fill(): void;
	/** The panel closed. */
	close(): void;
}

export interface SubtablesDeps extends PanelDeps {
	/** The record the panel shows, if any. */
	master(): Peeked | null;
	show(p: Peeked): void;
	draft(t: TableMeta, from: HTMLElement): Draft;
	refresh(t: TableMeta, row: Row): void;
}

export function subtablesOf(deps: SubtablesDeps): Subtables {
	const { env, sheets, tables, master, address } = deps;
	const { route, selection, failSoftly } = env;

	const box = byId('peek-details');
	const strip = byId('peek-tabs');
	const grid = byId('peek-detail-grid');
	const head = byId('peek-detail-head');
	const body = byId('peek-detail-rows');
	const empty = byId('peek-detail-empty');

	/** The open record's subtables, and which tab is open. */
	let subtables: Detail[] = [];
	let subtable: Detail | null = null;
	let tabs: HTMLButtonElement[] = [];

	/** A detail's handle is a link to the row's own screen, where it is claimed and undone. */
	const jump = (t: TableMeta, row: Row): Node[] => {
		const a = classed('a', 'handle');

		a.href = route.href(screenOf(t.entity, key(t, row)));
		a.title = `Ver ${t.entity}`;
		a.setAttribute('aria-label', `Ver ${t.entity}`);

		return [a];
	};

	/** A new row of the open subtable. The master's key is already written in its fk columns,
	 * and not editable: the fk *is* the master's key. Saving goes back to the master. */
	const detailDraft = (sub: Detail, of: Peeked, from: HTMLElement): Draft => {
		const inherited = valuesFrom(sub.ref, of.row);
		const base = deps.draft(sub.table, from);
		const insert = (given: Row) => base.insert({ ...inherited, ...given });

		return {
			...base,
			row: { ...base.row, ...inherited },
			title: `Nuevo registro de ${of.title}`,
			writable: c => !sub.ref.columns.includes(c.name),
			insert,
			save: async given => {
				await insert(given);

				address.go(of.key);		// drawing the master lists the new row in
			},
		};
	};

	const insertDetailRow: Action = {
		text: 'Insertar fila',
		needs: 'create',
		run: () => {
			const of = master();

			if (of && subtable) deps.show(detailDraft(subtable, of, inserts.button));
		},
	};

	const inserts = actionMenu('Insertar fila', [insertDetailRow], { className: 'tab-insert', iconOnly: true });

	byId('peek-tabbar').append(inserts.element);	// outside the tabs' scroll box, so its list can escape it
	selection.selectable(body, sheets.clipboardOf(body));

	const detailSheet = (sub: Detail, of: Peeked): Sheet => sheets.sheet({
		t: sub.table,
		columns: ownColumns(sub.table),		// ancestor columns belong to a screen, not a table
		head, body, table: grid, empty,
		leastRows: 3,				// so a detail with one row still reads as a table
		draft: () => detailDraft(sub, of, inserts.button),
		handle: row => jump(sub.table, row),
		changed: row => deps.refresh(sub.table, row),
		moved: () => deps.moved(),
		at: row => (sub.table === deps.screen() ? key(sub.table, row) : []),
		own: () => false,
	});

	/** A subtable is the detail's own list, filtered by the master's key in the fk's columns. */
	const under = (sub: Detail, of: Row) =>
		filterQuery(Object.entries(valuesFrom(sub.ref, of))
			.map(([column, value]) => ({ column, op: deps.defaultOp, value })));

	/** Draws the open tab's rows, unless the record or the tab changed while it was in flight. */
	const load = async (): Promise<void> => {
		const of = master(), sub = subtable;

		if (!of || !sub) return;

		selection.clear(body);
		head.replaceChildren();
		body.replaceChildren();
		grid.hidden = true;
		empty.hidden = true;

		const data = await api<Row[]>(listPath(sub.table.entity, { filter: under(sub, of.row) }));

		if (master() !== of || subtable !== sub) return;

		detailSheet(sub, of).render(data);
	};

	const open = (at: number) => {
		subtable = subtables[at] ?? null;
		tabs.forEach((tab, i) => tab.setAttribute('aria-selected', String(i === at)));

		if (!subtable) return;

		inserts.reset(subtable.table);
		void load().catch(failSoftly);
	};

	const tab = (sub: Detail, at: number) => {
		const x = el('button', sub.table.entity);

		x.type = 'button';
		x.setAttribute('role', 'tab');
		x.addEventListener('click', () => open(at));

		return x;
	};

	return {
		// A draft has no tabs: nothing belongs to a row not saved yet. The open tab stays on the
		// same fk while it's still offered, so stepping through records keeps it.
		fill() {
			const of = master();

			subtables = of?.key.length ? detailsOf(tables, of.t) : [];
			tabs = subtables.map(tab);

			box.hidden = subtables.length === 0;
			strip.replaceChildren(...tabs);

			const at = subtables.findIndex(one => one.ref === subtable?.ref);

			open(at < 0 ? 0 : at);
		},

		close() {
			box.hidden = true;
			selection.clear(body);
			body.replaceChildren();			// so reopening never flashes the last record's rows
			env.status.standing(body, []);		// its unsaved lines went with it
		},
	};
}
