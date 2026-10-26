// The filter bar: conditions written as column, then comparison, then value.

import type { OperatorMeta, TableMeta } from '../../shared/api.js';
import { button, classed, el } from '../kit/dom.js';
import { menu, type Option } from '../kit/menu.js';
import { kinshipOf, type Reachable, reachableFrom } from '../model/fk.js';
import { filterQuery } from '../model/query.js';
import { type Condition, operand } from '../model/route.js';

/** The condition being written: a column, then a comparison, then a value. */
interface Draft {
	column?: Reachable;
	operator?: OperatorMeta;
}

/** One thing the dropdown offers. `take` moves the draft to the next step. */
interface Choice {
	text: string;
	hint: string;
	take: () => void;
}

export interface FilterBar {
	readonly element: HTMLElement;
	reset(t: TableMeta, seed?: Condition[]): void;
	conditions(): Condition[];
	/** The `?filter=` value, or `undefined` when there is none. */
	query(): string | undefined;
}

/**
 * @param tables every table in `_meta`, to also offer the ancestors' columns (SCOPE 6b)
 * @param operators the comparisons in `_meta`
 * @param apply called whenever `query()` changes
 */
export function filterBar(tables: TableMeta[], operators: OperatorMeta[], apply: () => void): FilterBar {
	const entry = el('input');
	const draft = classed('span', 'chip draft');
	const chips = classed('div', 'chips');
	const element = classed('div', 'filters', chips);
	const list = menu(entry, element);

	element.append(list.element);
	element.hidden = true;
	entry.type = 'text';
	entry.autocomplete = 'off';
	entry.setAttribute('role', 'combobox');
	entry.setAttribute('aria-autocomplete', 'list');
	entry.setAttribute('aria-label', 'Filtrar');

	let table: TableMeta | null = null;
	let named: Reachable[] = [];				// what this screen can filter by, own and reached
	let applied: Condition[] = [];
	let being: Draft = {};

	let restoring = false;					// a redraw keeps the focus on the entry


	// --- What the dropdown offers ---

	/** e.g. `varchar · padre` for an ancestor's column, `varchar` for an own one. */
	const about = (c: Reachable) =>
		c.via.length ? `${c.column.type} · ${kinshipOf(c.via)}` : c.column.type;

	const choices = (): Choice[] => {
		if (!table) return [];

		if (!being.column)
			return named.map(c =>
				({ text: c.name, hint: about(c), take: () => { being = { column: c }; } }));

		if (!being.operator)
			return operators.map(o =>
				({ text: o.label, hint: o.symbol, take: () => { being = { ...being, operator: o }; } }));

		return [];
	};

	const line = (choice: Choice): Option =>
		({ text: choice.text, hint: choice.hint, pick: () => choose(choice) });

	const openMenu = () => {
		const offered = choices();

		if (!offered.length) { list.close(); return; }

		const typed = entry.value.trim().toLowerCase();

		list.open(being.column ? 'Comparación' : 'Columna',
			offered.filter(o => !typed || `${o.text} ${o.hint}`.toLowerCase().includes(typed)).map(line));
	};

	const choose = (choice: Choice) => {
		choice.take();
		entry.value = '';

		if (being.operator && !being.operator.takesValue) commit();
		else { redraw(); openMenu(); }

		entry.focus();
	};


	// --- What is on screen ---

	const remover = (label: string, act: () => void) => {
		const x = button('x', label);

		x.addEventListener('click', () => { act(); entry.focus(); });

		return x;
	};

	const remove = (a: Condition) => () => {
		applied = applied.filter(x => x !== a);

		redraw();
		apply();
	};

	const shownOperand = (a: Condition) => {
		if (!a.operator.takesValue) return [];

		const value = el('span', a.value === null ? 'null' : a.value);

		value.classList.toggle('null', a.value === null);

		return [value];
	};

	const chip = (a: Condition) => classed('span', 'chip',
		el('b', a.column.name), el('i', a.operator.symbol), ...shownOperand(a),
		remover(`Quitar filtro ${a.column.name}`, remove(a)));

	const placeholder = (): string => {
		if (being.column && being.operator) return being.column.column.expected;
		if (being.column) return 'comparación…';
		if (applied.length) return 'Agregar otro filtro…';

		return `Filtrar por ${table?.columns.slice(0, 3).map(c => c.name).join(', ') ?? ''}…`;
	};

	const resize = () => {
		entry.size = Math.min(Math.max((entry.value || entry.placeholder).length + 1, 6), 28);
	};

	const redraw = () => {
		const focused = document.activeElement === entry;

		draft.replaceChildren(
			...(being.column ? [el('b', being.column.name)] : []),
			...(being.operator ? [el('i', being.operator.symbol)] : []),
			entry,
			...(being.column ? [remover('Descartar filtro', discard)] : []));

		draft.classList.toggle('started', being.column !== undefined);
		chips.replaceChildren(...applied.map(chip), draft);

		entry.placeholder = placeholder();
		resize();

		if (focused) { restoring = true; entry.focus(); restoring = false; }
	};


	// --- Writing one condition ---

	const commit = () => {
		if (!being.column || !being.operator) return;

		applied = [...applied, {
			column: being.column,
			operator: being.operator,
			value: operand(being.operator, entry.value),
		}];

		being = {};
		entry.value = '';

		redraw();
		list.close();
		apply();
	};

	const discard = () => {
		being = {};
		entry.value = '';

		redraw();
		openMenu();
	};

	const back = () => {
		if (being.operator) being = { column: being.column };
		else if (being.column) being = {};
		else if (applied.length) { applied = applied.slice(0, -1); redraw(); openMenu(); apply(); return; }
		else return;

		redraw();
		openMenu();
	};

	const step = (by: number) => { if (list.isOpen()) list.step(by); else openMenu(); };

	const keys = new Map<string, (e: KeyboardEvent) => void>([
		['ArrowDown', e => { e.preventDefault(); step(1); }],
		['ArrowUp', e => { e.preventDefault(); step(-1); }],
		['Enter', e => { e.preventDefault(); const one = list.current(); if (one) one.pick(); else commit(); }],
		['Escape', e => {
			e.stopPropagation();				// don't close the panel too

			if (list.isOpen()) list.close();
			else if (being.column) discard();
		}],
		['Backspace', e => {
			if (entry.value !== '') return;

			e.preventDefault();
			back();
		}],
	]);

	entry.addEventListener('input', () => { resize(); openMenu(); });
	entry.addEventListener('focus', () => { if (!restoring) openMenu(); });
	entry.addEventListener('keydown', e => keys.get(e.key)?.(e));

	element.addEventListener('mousedown', e => {
		if (e.target === entry || !(e.target instanceof Element) || e.target.closest('button, li')) return;

		e.preventDefault();
		entry.focus();
		openMenu();
	});


	// --- What the screen asks of it ---

	const encode = (all: Condition[]) =>
		filterQuery(all.map(a => ({ column: a.column.name, op: a.operator.name, value: a.value })));

	const query = () => encode(applied);

	const reset = (t: TableMeta, seed: Condition[] = []) => {
		if (table === t && encode(seed) === query()) return;

		table = t;
		named = reachableFrom(tables, t);
		applied = [...seed];
		being = {};
		entry.value = '';

		list.close();
		redraw();
		element.hidden = false;
	};

	redraw();

	return { element, reset, conditions: () => applied, query };
}
