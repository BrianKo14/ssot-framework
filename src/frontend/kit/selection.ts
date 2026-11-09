// Picking a rectangle of cells on a sheet, and copying from / pasting onto it.
// It knows cells by position only; what a cell holds is the sheet's, handed in as a `Selectable`.

import { cells, table, tsv, type Grid } from './clipboard.js';

/** The cells picked, inclusive. `top`/`bottom` count the body's lines (blank ones included),
 * `left`/`right` count data columns (the leading one isn't one). */
export interface Range {
	top: number;
	left: number;
	bottom: number;
	right: number;
}

/** What a sheet's body answers the clipboard with. */
export interface Selectable {
	copy(range: Range): Grid;
	/** Writes a block whose top-left cell lands on `at`. */
	paste(at: Pick<Range, 'top' | 'left'>, block: Grid): void;
}

export interface Selection {
	/** Lets a body be picked from: drag across, or Shift+click to stretch. Once per body. */
	selectable(body: HTMLElement, sheet: Selectable): void;
	/** Lets go of the cells. Given a body, only if they are on that one. */
	clear(body?: HTMLElement): void;
}

interface At {
	row: number;
	column: number;
}

const rangeOf = ({ anchor, focus }: { anchor: At; focus: At }): Range => ({
	top: Math.min(anchor.row, focus.row),
	left: Math.min(anchor.column, focus.column),
	bottom: Math.max(anchor.row, focus.row),
	right: Math.max(anchor.column, focus.column),
});

/** The cell under the pointer, if it can be picked: a data cell of this body that isn't being
 * edited, and not a button inside one. */
const cellAt = (body: HTMLElement, target: EventTarget | null): At | null => {
	if (!(target instanceof Element) || target.closest('button, input')) return null;

	const td = target.closest('td');
	const tr = td?.parentElement;

	if (!td || !(tr instanceof HTMLTableRowElement) || tr.parentElement !== body) return null;
	if (td.classList.contains('lead') || td.classList.contains('editing')) return null;

	return { row: tr.sectionRowIndex, column: td.cellIndex - 1 };
};

/** What an arrow key does to a cell's position. */
const STEPS: Record<string, At> = {
	ArrowUp: { row: -1, column: 0 },
	ArrowDown: { row: 1, column: 0 },
	ArrowLeft: { row: 0, column: -1 },
	ArrowRight: { row: 0, column: 1 },
};

/** The nearest ancestor that scrolls. */
const scrollerOf = (node: HTMLElement): HTMLElement | null => {
	for (let up = node.parentElement; up; up = up.parentElement)
		if (/auto|scroll/.test(getComputedStyle(up).overflow)) return up;

	return null;
};

/** Scrolls the cell into view, clear of the sticky header and leading column that would cover it. */
const reveal = (td: HTMLElement) => {
	const frame = scrollerOf(td);

	if (!frame) return;

	const view = frame.getBoundingClientRect();
	const cell = td.getBoundingClientRect();
	const head = td.closest('table')?.tHead?.offsetHeight ?? 0;
	const lead = td.parentElement?.firstElementChild?.getBoundingClientRect().width ?? 0;
	const clear = (from: number, to: number, start: number, end: number) =>
		from < start ? from - start : to > end ? to - end : 0;

	frame.scrollTop += clear(cell.top, cell.bottom, view.top + head, view.bottom);
	frame.scrollLeft += clear(cell.left, cell.right, view.left + lead, view.right);
};

/** One value pasted over several cells fills them all, as in a spreadsheet. */
const shaped = (range: Range, block: Grid): Grid => {
	const one = block.length === 1 && block[0].length === 1;

	if (!one) return block;

	return Array.from({ length: range.bottom - range.top + 1 },
		() => Array.from({ length: range.right - range.left + 1 }, () => block[0][0]));
};

/** One per page: one selection at a time, like one cell being edited. */
export function selectionOf(): Selection {
	let picked: { body: HTMLElement; anchor: At; focus: At } | null = null;
	let dragging = false;

	const sheets = new Map<HTMLElement, Selectable>();


	// --- Drawing it ---

	// Drawn with rules keyed by position rather than a class per cell, so it survives every
	// redraw of a line. Only integers are ever written into it.
	const tint = new CSSStyleSheet();

	document.adoptedStyleSheets = [...document.adoptedStyleSheets, tint];

	const paint = () => {
		for (const body of sheets.keys()) body.toggleAttribute('data-selecting', picked?.body === body);

		if (!picked) { tint.replaceSync(''); return; }

		// `nth-child` counts from one, and a line's first cell is the leading one
		const { top, left, bottom, right } = rangeOf(picked);
		const lines = (from: number, to = from) => `[data-selecting] > tr:nth-child(n+${from + 1}):nth-child(-n+${to + 1})`;
		const columns = (from: number, to = from) => ` > td:nth-child(n+${from + 2}):nth-child(-n+${to + 2})`;

		// the cells, then which of them are on each edge (the stylesheet draws the stroke)
		tint.replaceSync([
			`${lines(top, bottom)}${columns(left, right)} { background: var(--selected); }`,
			`${lines(top)}${columns(left, right)} { --edge-top: var(--selected-stroke); }`,
			`${lines(bottom)}${columns(left, right)} { --edge-bottom: var(--selected-stroke); }`,
			`${lines(top, bottom)}${columns(left)} { --edge-left: var(--selected-stroke); }`,
			`${lines(top, bottom)}${columns(right)} { --edge-right: var(--selected-stroke); }`,
		].join('\n'));
	};


	// --- The clipboard ---

	// Copy and paste are events on whatever has the focus, and Safari fires no `copy` on a page
	// with nothing selected. So this box takes the focus, holds a selected character, and gets
	// both events in every browser. Taking the focus also closes a cell being edited.
	const proxy = document.createElement('textarea');

	proxy.className = 'clipboard';
	proxy.setAttribute('aria-label', 'Celdas seleccionadas: copiar o pegar');
	proxy.tabIndex = -1;
	document.body.append(proxy);

	const hold = () => {
		proxy.value = ' ';
		proxy.focus({ preventScroll: true });
		proxy.select();
	};

	const clear = (body?: HTMLElement) => {
		if (body && picked?.body !== body) return;

		picked = null;
		paint();

		if (document.activeElement === proxy) proxy.blur();
	};

	proxy.addEventListener('copy', e => {
		const sheet = picked && sheets.get(picked.body);

		if (!picked || !sheet || !e.clipboardData) return;

		const grid = sheet.copy(rangeOf(picked));

		e.preventDefault();
		e.clipboardData.setData('text/plain', tsv(grid));
		e.clipboardData.setData('text/html', table(grid));
	});

	proxy.addEventListener('paste', e => {
		const sheet = picked && sheets.get(picked.body);

		e.preventDefault();				// nothing is ever typed into the box itself

		if (!picked || !sheet || !e.clipboardData) return;

		const block = cells(e.clipboardData.getData('text/plain'));
		const range = rangeOf(picked);

		if (block.length) sheet.paste(range, shaped(range, block));
	});

	proxy.addEventListener('cut', e => e.preventDefault());
	proxy.addEventListener('input', hold);		// typing while cells are picked writes nothing
	proxy.addEventListener('keydown', e => {
		if (e.key === 'Escape') {
			e.stopPropagation();			// lets go of the cells, not of the panel
			clear();
		} else if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
			e.preventDefault();
			open();
		} else if (STEPS[e.key] && !e.ctrlKey && !e.metaKey && !e.altKey) {
			e.preventDefault();			// not the page scrolling, nor a caret in the box
			move(STEPS[e.key], e.shiftKey);
		}
	});

	// Like the cell editor: leaving is a decision, losing the window isn't. Going to Excel to
	// copy something is exactly when the cells must still be picked on the way back.
	proxy.addEventListener('blur', () => {
		if (document.hasFocus()) { clear(); return; }

		addEventListener('focus', () => { if (picked) hold(); }, { once: true });
	});


	// --- Moving it ---

	/** Steps the picked cell by one, staying inside the body: Shift keeps the anchor, stretching
	 * the range as Shift+click does; without it the range is the one cell it lands on. */
	const move = (by: At, stretch: boolean) => {
		if (!picked) return;

		const lines = picked.body.children;
		const row = Math.min(Math.max(picked.focus.row + by.row, 0), lines.length - 1);
		const columns = (lines[row]?.children.length ?? 1) - 1;		// the leading cell isn't one
		const column = Math.min(Math.max(picked.focus.column + by.column, 0), columns - 1);

		if (columns < 1) return;

		picked.focus = { row, column };

		if (!stretch) picked.anchor = picked.focus;

		paint();
		reveal(lines[row].children[column + 1] as HTMLElement);
	};


	/** Opens the cell the range ends on, the way a double-click does: the cell's own handler is the
	 * one way in, and knows whether it may be written. A cell with none does nothing. The cell
	 * editor taking the focus is what lets go of the range. */
	const open = () => {
		if (!picked) return;

		const { row, column } = picked.focus;

		picked.body.children[row]?.children[column + 1]?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
	};


	// --- Picking ---

	addEventListener('mouseup', () => { dragging = false; });

	const selectable = (body: HTMLElement, sheet: Selectable) => {
		sheets.set(body, sheet);

		body.addEventListener('mousedown', e => {
			const at = e.button === 0 ? cellAt(body, e.target) : null;

			if (!at) return;

			e.preventDefault();			// no text selection or link drag competing with it

			if (e.shiftKey && picked?.body === body) picked.focus = at;
			else picked = { body, anchor: at, focus: at };

			dragging = true;
			paint();
			hold();
		});

		body.addEventListener('mouseover', e => {
			const at = dragging && picked?.body === body ? cellAt(body, e.target) : null;

			if (!at || !picked) return;

			picked.focus = at;
			paint();
		});
	};

	return { selectable, clear };
}
