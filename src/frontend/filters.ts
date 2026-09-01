// The filter bar.

import type { ColumnMeta, FilterCondition, OperatorMeta, TableMeta } from '../shared/api.js';
import { classed, el } from './dom.js';
import { type Condition, operand } from './route.js';

/** The condition being written: a column, then a comparison, then a value. */
interface Draft {
	column?: ColumnMeta;
	operator?: OperatorMeta;
}

/** One line of the dropdown. `take` moves the draft on to the next step. */
interface Choice {
	text: string;
	hint: string;
	take: () => void;
}

export interface FilterBar {
	readonly element: HTMLElement;
	reset(t: TableMeta, seed?: Condition[]): void;
	/** @returns the conditions that have been applied to the filter bar. */
	conditions(): Condition[];
	/** @returns SQL WHERE clause. */
	query(): string | undefined;
}

/** 
 * @param operators the comparisons the backend offers, taken from `_meta`
 * @param apply called when the answer to `query()` has changed */
export function filterBar(operators: OperatorMeta[], apply: () => void): FilterBar {
	const entry = el('input');
	const draft = classed('span', 'chip draft');
	const chips = classed('div', 'chips');
	const menu = classed('ul', 'menu');
	const element = classed('div', 'filters', chips, menu);

	element.hidden = true;
	menu.hidden = true;
	menu.id = 'filter-menu';
	menu.setAttribute('role', 'listbox');
	entry.type = 'text';
	entry.autocomplete = 'off';
	entry.setAttribute('role', 'combobox');
	entry.setAttribute('aria-autocomplete', 'list');
	entry.setAttribute('aria-controls', menu.id);
	entry.setAttribute('aria-label', 'Filtrar');

	let table: TableMeta | null = null;
	let applied: Condition[] = [];
	let being: Draft = {};

	let showing: Choice[] = [];
	let lines: HTMLElement[] = [];
	let active = 0;						// the highlighted line
	let restoring = false;					// when the box is redrawn, keep focus on the entry


	// --- What the dropdown offers ---

	const choices = (): Choice[] => {
		if (!table) return [];

		if (!being.column)
			return table.columns.map(c =>
				({ text: c.name, hint: c.type, take: () => { being = { column: c }; } }));

		if (!being.operator)
			return operators.map(o =>
				({ text: o.label, hint: o.symbol, take: () => { being = { ...being, operator: o }; } }));

		return [];
	};

	const mark = () => lines.forEach((li, i) => li.setAttribute('aria-selected', String(i === active)));

	const line = (choice: Choice, i: number) => {
		const li = classed('li', 'option', el('span', choice.text), classed('span', 'hint', choice.hint));

		li.setAttribute('role', 'option');
		li.addEventListener('mousedown', e => { e.preventDefault(); choose(choice); });	// keeps the box focused
		li.addEventListener('mousemove', () => { active = i; mark(); });

		return li;
	};

	const openMenu = () => {
		const offered = choices();

		if (!offered.length) { closeMenu(); return; }

		const typed = entry.value.trim().toLowerCase();

		showing = offered.filter(o => !typed || `${o.text} ${o.hint}`.toLowerCase().includes(typed));
		lines = showing.map(line);

		if (active >= lines.length) active = 0;

		menu.replaceChildren(
			classed('li', 'head', being.column ? 'Comparación' : 'Columna'),
			...(lines.length ? lines : [classed('li', 'none', 'Sin coincidencias')]));

		menu.hidden = false;
		entry.setAttribute('aria-expanded', 'true');
		mark();
	};

	const closeMenu = () => {
		menu.hidden = true;
		entry.setAttribute('aria-expanded', 'false');
		showing = [];
		lines = [];
		active = 0;
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
		const button = classed('button', 'x');

		button.title = label;
		button.setAttribute('type', 'button');
		button.setAttribute('aria-label', label);
		button.addEventListener('click', () => { act(); entry.focus(); });

		return button;
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
		if (being.column && being.operator) return being.column.expected;
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
		closeMenu();
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

	const step = (by: number) => {
		if (menu.hidden) { openMenu(); return; }
		if (!lines.length) return;

		active = (active + by + lines.length) % lines.length;

		mark();
		lines[active].scrollIntoView({ block: 'nearest' });
	};

	const keys = new Map<string, (e: KeyboardEvent) => void>([
		['ArrowDown', e => { e.preventDefault(); step(1); }],
		['ArrowUp', e => { e.preventDefault(); step(-1); }],
		['Enter', e => { e.preventDefault(); if (menu.hidden || !showing[active]) commit(); else choose(showing[active]); }],
		['Escape', e => {
			e.stopPropagation();				// the peek's Escape must not fire too

			if (!menu.hidden) closeMenu();
			else if (being.column) discard();
		}],
		['Backspace', e => {
			if (entry.value !== '') return;	

			e.preventDefault();
			back();
		}],
	]);

	entry.addEventListener('input', () => { active = 0; resize(); openMenu(); });
	entry.addEventListener('focus', () => { if (!restoring) openMenu(); });
	entry.addEventListener('keydown', e => keys.get(e.key)?.(e));

	element.addEventListener('mousedown', e => {
		if (e.target === entry || !(e.target instanceof Element) || e.target.closest('button, li')) return;

		e.preventDefault();
		entry.focus();
		openMenu();
	});

	addEventListener('mousedown', e => {
		if (e.target instanceof Node && !element.contains(e.target)) closeMenu();
	}, true);


	// --- What the screen asks of it ---

	const encode = (list: Condition[]) => {
		if (!list.length) return undefined;

		const filter = new Map<string, FilterCondition[]>();

		for (const a of list)
			filter.set(a.column.name,
				[...filter.get(a.column.name) ?? [], { op: a.operator.name, value: a.value }]);

		return JSON.stringify(Object.fromEntries(filter));
	};

	const query = () => encode(applied);

	const reset = (t: TableMeta, seed: Condition[] = []) => {
		if (table === t && encode(seed) === query()) return;

		table = t;
		applied = [...seed];
		being = {};
		entry.value = '';

		closeMenu();
		redraw();
		element.hidden = false;
	};

	redraw();

	return { element, reset, conditions: () => applied, query };
}
