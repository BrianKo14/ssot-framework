// A rectangle of cells picked on a sheet, and the clipboard it copies to and pastes from
// (SCOPE 6h). It knows cells by position and nothing about rows: what a cell *holds*, and what
// writing one means, is the sheet's — handed in as a `Selectable`.

import { cells, table, tsv, type Grid } from './clipboard.js';

/** The cells picked, by position: `row` counts the body's lines, drawn blanks included, and
    `column` counts the data columns, so the leading one is not among them. Inclusive. */
export interface Range {
	top: number;
	left: number;
	bottom: number;
	right: number;
}

/** What a sheet's body answers the clipboard with. */
export interface Selectable {
	/** The text of every cell in the range. */
	copy(range: Range): Grid;
	/** Writes a block whose top-left cell lands on `at`. */
	paste(at: Pick<Range, 'top' | 'left'>, block: Grid): void;
}

interface At {
	row: number;
	column: number;
}

/** One selection on the page at a time, the way there is one cell being edited. */
let picked: { body: HTMLElement; anchor: At; focus: At } | null = null;
let dragging = false;

const sheets = new Map<HTMLElement, Selectable>();

const rangeOf = ({ anchor, focus }: { anchor: At; focus: At }): Range => ({
	top: Math.min(anchor.row, focus.row),
	left: Math.min(anchor.column, focus.column),
	bottom: Math.max(anchor.row, focus.row),
	right: Math.max(anchor.column, focus.column),
});

/** The tint and its outline, drawn by rules that name positions rather than by a class on each cell. A line
    is redrawn on every write, every undo and every poll that reads it again, and a rule keyed by
    position survives all of them without the drawing knowing a selection exists. Only integers
    are ever written into it. */
const tint = new CSSStyleSheet();

document.adoptedStyleSheets = [...document.adoptedStyleSheets, tint];

/** Where the keyboard is while cells are picked. Copying and pasting are events on whatever has
    the focus, and Safari fires no `copy` at all on a page with nothing selected — so this box
    takes the focus, holds a selected character, and is where both events arrive, in every
    browser. Taking the focus is also what closes a cell being edited, down its usual path. */
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

const paint = () => {
	for (const body of sheets.keys()) body.toggleAttribute('data-selecting', picked?.body === body);

	if (!picked) { tint.replaceSync(''); return; }

	// `nth-child` counts from one, and a line's first cell is its leading one
	const { top, left, bottom, right } = rangeOf(picked);
	const lines = (from: number, to = from) => `[data-selecting] > tr:nth-child(n+${from + 1}):nth-child(-n+${to + 1})`;
	const columns = (from: number, to = from) => ` > td:nth-child(n+${from + 2}):nth-child(-n+${to + 2})`;

	// the cells, and then which of them lie on each edge of the range: the stylesheet draws the
	// stroke from those, so what is written here is only *where*
	tint.replaceSync([
		`${lines(top, bottom)}${columns(left, right)} { background: var(--selected); }`,
		`${lines(top)}${columns(left, right)} { --edge-top: var(--selected-stroke); }`,
		`${lines(bottom)}${columns(left, right)} { --edge-bottom: var(--selected-stroke); }`,
		`${lines(top, bottom)}${columns(left)} { --edge-left: var(--selected-stroke); }`,
		`${lines(top, bottom)}${columns(right)} { --edge-right: var(--selected-stroke); }`,
	].join('\n'));
};

/** Lets go of the cells, and of the keyboard with them. Given a body, only when they are on that
    one — which is what a body about to be drawn with another list asks. */
export const clear = (body?: HTMLElement) => {
	if (body && picked?.body !== body) return;

	picked = null;
	paint();

	if (document.activeElement === proxy) proxy.blur();
};

/** The cell under the pointer, when it is one that can be picked: a data cell of this body, not
    the leading one, not one being edited, and not a button inside one. */
const cellAt = (body: HTMLElement, target: EventTarget | null): At | null => {
	if (!(target instanceof Element) || target.closest('button, input')) return null;

	const td = target.closest('td');
	const tr = td?.parentElement;

	if (!td || !(tr instanceof HTMLTableRowElement) || tr.parentElement !== body) return null;
	if (td.classList.contains('lead') || td.classList.contains('editing')) return null;

	return { row: tr.sectionRowIndex, column: td.cellIndex - 1 };
};

/** A single value pasted over several cells fills all of them, as a spreadsheet does; anything
    else lands with its top-left cell on the range's. */
const shaped = (range: Range, block: Grid): Grid => {
	const one = block.length === 1 && block[0].length === 1;

	if (!one) return block;

	return Array.from({ length: range.bottom - range.top + 1 },
		() => Array.from({ length: range.right - range.left + 1 }, () => block[0][0]));
};

/** Lets a sheet's body be picked from with the pointer — drag across, or Shift+click to stretch —
    and answer the clipboard. Wired once per body: the body outlives the sheets drawn into it. */
export const selectable = (body: HTMLElement, sheet: Selectable) => {
	sheets.set(body, sheet);

	body.addEventListener('mousedown', e => {
		const at = e.button === 0 ? cellAt(body, e.target) : null;

		if (!at) return;

		e.preventDefault();			// no text selection competing with this one, no link drag

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

addEventListener('mouseup', () => { dragging = false; });

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
proxy.addEventListener('input', hold);		// a key typed while cells are picked writes nothing
proxy.addEventListener('keydown', e => {
	if (e.key !== 'Escape') return;

	e.stopPropagation();				// the cells are let go of; the panel stays
	clear();
});

// Leaving the cells is a decision; losing the window is not one — the editor's rule, for the
// same reason. Going to Excel to copy something is exactly when the cells must still be picked
// on the way back.
proxy.addEventListener('blur', () => {
	if (document.hasFocus()) { clear(); return; }

	addEventListener('focus', () => { if (picked) hold(); }, { once: true });
});
