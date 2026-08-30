// The filter bar.

import type { ColumnMeta, FilterCondition, OperatorMeta, TableMeta } from '../api-meta.js';
import { classed, el } from './dom.js';


/** One committed condition. */
interface Applied {
	column: ColumnMeta;
	operator: OperatorMeta;
	value: string | null;
}

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
	/** Point the bar at a screen, dropping whatever was being asked of the previous one. */
	reset(t: TableMeta): void;
	/** What is being asked for now, as `?filter=` takes it; `undefined` when nothing is. */
	query(): string | undefined;
}

/** 
 * @param operators the comparisons the backend offers, straight from `_meta`
 * @param apply called when the answer to `query()` has changed */
export function filterBar(operators: OperatorMeta[], apply: () => void): FilterBar {
	const entry = el('input');
	const draft = classed('span', 'chip draft');
	const chips = classed('div', 'chips');
	const menu = classed('ul', 'menu');
	const element = classed('div', 'filters', chips, menu);

	element.hidden = true;					// until a screen points the bar at its columns
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
	let applied: Applied[] = [];
	let being: Draft = {};

	let showing: Choice[] = [];
	let lines: HTMLElement[] = [];
	let active = 0;						// the highlighted line
	let restoring = false;					// a redraw putting the caret back, not the user arriving


	// --- What the dropdown offers ---

	/** What there is to choose at this step: a column, then a comparison, then nothing. */
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

	/** Draws the dropdown, closing it once there is nothing left to choose. */
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

	/** A comparison that takes no value leaves nothing to ask, so it is committed here. */
	const choose = (choice: Choice) => {
		choice.take();
		entry.value = '';				// what found the choice is not the next answer

		if (being.operator && !being.operator.takesValue) commit();
		else { redraw(); openMenu(); }			// the next step, or closed when a value comes next

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

	const remove = (a: Applied) => () => {
		applied = applied.filter(x => x !== a);

		redraw();
		apply();
	};

	/** No operand where the comparison is the whole question: `notas is null`, not `… null null`. */
	const operand = (a: Applied) => {
		if (!a.operator.takesValue) return [];

		const value = el('span', a.value === null ? 'null' : a.value);

		value.classList.toggle('null', a.value === null);	// the grid's own mark for an absent value

		return [value];
	};

	const chip = (a: Applied) => classed('span', 'chip',
		el('b', a.column.name), el('i', a.operator.symbol), ...operand(a),
		remover(`Quitar filtro ${a.column.name}`, remove(a)));

	/** What the box is asking for; on the value step, the column's own `expected` string. */
	const placeholder = (): string => {
		if (being.column && being.operator) return being.column.expected;
		if (being.column) return 'comparación…';
		if (applied.length) return 'Agregar otro filtro…';

		return `Filtrar por ${table?.columns.slice(0, 3).map(c => c.name).join(', ') ?? ''}…`;
	};

	/** As wide as what is in it, or as what it is asking for while empty. The floor is the spare
	 *  width that shows a chip is missing parts; the ceiling keeps it from crowding its neighbours. */
	const resize = () => {
		entry.size = Math.min(Math.max((entry.value || entry.placeholder).length + 1, 6), 28);
	};

	/** Rewrites the chips. `replaceChildren` detaches the box, so the caret is put back — and only
	 *  when it was there to begin with. */
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

	/** The condition joins the chips, and the box is ready for the next. */
	const commit = () => {
		if (!being.column || !being.operator) return;

		applied = [...applied, {
			column: being.column,
			operator: being.operator,
			// an empty box is null; one that takes no value has none whatever the box holds
			value: being.operator.takesValue && entry.value.trim() !== '' ? entry.value : null,
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

	/** Steps back out: the comparison, then the column, then the last committed condition. */
	const back = () => {
		if (being.operator) being = { column: being.column };
		else if (being.column) being = {};
		else if (applied.length) { applied = applied.slice(0, -1); redraw(); openMenu(); apply(); return; }
		else return;

		redraw();
		openMenu();
	};

	/** Down and up walk the open dropdown, and open it when it is closed. */
	const step = (by: number) => {
		if (menu.hidden) { openMenu(); return; }
		if (!lines.length) return;

		active = (active + by + lines.length) % lines.length;

		mark();
		lines[active].scrollIntoView({ block: 'nearest' });
	};

	/** A map rather than a chain of `if`s: another key is another entry, not another branch. */
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
			if (entry.value !== '') return;			// only an empty box steps back out

			e.preventDefault();
			back();
		}],
	]);

	entry.addEventListener('input', () => { active = 0; resize(); openMenu(); });
	entry.addEventListener('focus', () => { if (!restoring) openMenu(); });
	entry.addEventListener('keydown', e => keys.get(e.key)?.(e));

	// Clicking the bar's own background is clicking the box: the whole strip reads as one control.
	element.addEventListener('mousedown', e => {
		if (e.target === entry || !(e.target instanceof Element) || e.target.closest('button, li')) return;

		e.preventDefault();
		entry.focus();
		openMenu();
	});

	// Capture, not bubble: choosing a line rebuilds the dropdown and detaches the line that was
	// clicked, so asked afterwards "is the target inside the bar?" answers no and shuts what the
	// choice just opened.
	addEventListener('mousedown', e => {
		if (e.target instanceof Node && !element.contains(e.target)) closeMenu();
	}, true);


	// --- What the screen asks of it ---

	const reset = (t: TableMeta) => {
		table = t;
		applied = [];
		being = {};
		entry.value = '';

		closeMenu();
		redraw();
		element.hidden = false;
	};

	/** Several conditions on one column go as a list, which is how `filter.ts` reads them. A Map,
	 *  so a column named like an `Object` member is still a key. */
	const query = () => {
		if (!applied.length) return undefined;

		const filter = new Map<string, FilterCondition[]>();

		for (const a of applied)
			filter.set(a.column.name,
				[...filter.get(a.column.name) ?? [], { op: a.operator.name, value: a.value }]);

		return JSON.stringify(Object.fromEntries(filter));
	};

	redraw();

	return { element, reset, query };
}
