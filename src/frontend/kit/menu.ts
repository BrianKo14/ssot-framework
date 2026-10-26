// The dropdown. Used by the filter bar, the toolbar's actions and the fk picker.

import { classed, el } from './dom.js';

/** One line of a dropdown. */
export interface Option {
	text: string;
	/** Shown beside the text, e.g. a column's type or an operator's symbol. */
	hint?: string;
	pick(): void;
}

export interface Menu {
	readonly element: HTMLElement;
	isOpen(): boolean;
	/** @param head the group's caption, if any */
	open(head: string | undefined, options: Option[]): void;
	close(): void;
	step(by: number): void;
	/** The highlighted line, if open. */
	current(): Option | undefined;
	/** Removes it and its listeners. Needed for one built per edit; a screen-long one never is. */
	destroy(): void;
}

let ids = 0;	// so each menu's aria-controls id is unique on the page

/**
 * @param controller the input or button it hangs from; its `aria-expanded` follows the menu
 * @param within the box both sit in; a press outside it closes the menu
 * @param anchored place it by hand against the controller, for use inside a scrolling box
 * (a CSS-placed one would be clipped there)
 */
export function menu(controller: HTMLElement, within: HTMLElement, anchored = false): Menu {
	const element = classed('ul', 'menu');

	let showing: Option[] = [];
	let lines: HTMLElement[] = [];
	let active = 0;						// the highlighted line

	element.id = `menu-${++ids}`;
	element.hidden = true;
	element.setAttribute('role', 'listbox');
	controller.setAttribute('aria-controls', element.id);
	controller.setAttribute('aria-expanded', 'false');

	const isOpen = () => !element.hidden;

	/** In viewport coordinates, so no ancestor's overflow cuts it. */
	const place = () => {
		const box = controller.getBoundingClientRect();

		element.style.position = 'fixed';
		element.style.left = `${box.left}px`;
		element.style.top = `${box.bottom + 2}px`;
	};

	const mark = () => lines.forEach((li, i) => li.setAttribute('aria-selected', String(i === active)));

	const line = (option: Option, i: number) => {
		const li = classed('li', 'option', el('span', option.text),
			...(option.hint === undefined ? [] : [classed('span', 'hint', option.hint)]));

		li.setAttribute('role', 'option');
		li.addEventListener('mousedown', e => { e.preventDefault(); option.pick(); });	// keeps the controller focused
		li.addEventListener('mousemove', () => { active = i; mark(); });

		return li;
	};

	const open = (head: string | undefined, options: Option[]) => {
		showing = options;
		lines = options.map(line);
		active = 0;

		element.replaceChildren(
			...(head === undefined ? [] : [classed('li', 'head', head)]),
			...(lines.length ? lines : [classed('li', 'none', 'Sin coincidencias')]));

		element.hidden = false;
		controller.setAttribute('aria-expanded', 'true');

		if (anchored) place();

		mark();
	};

	const close = () => {
		element.hidden = true;
		controller.setAttribute('aria-expanded', 'false');
		showing = [];
		lines = [];
		active = 0;
	};

	const step = (by: number) => {
		if (!isOpen() || !lines.length) return;

		active = (active + by + lines.length) % lines.length;

		mark();
		lines[active].scrollIntoView({ block: 'nearest' });
	};

	// abortable, so `destroy` takes the listeners with it
	const listeners = new AbortController();
	const { signal } = listeners;

	// Capture phase: a pick rebuilds the list before a bubbling listener would see the click,
	// and the "still inside?" check would then wrongly close it.
	addEventListener('mousedown', e => {
		if (e.target instanceof Node && !within.contains(e.target)) close();
	}, { capture: true, signal });

	if (anchored) {
		addEventListener('scroll', () => { if (isOpen()) place(); }, { capture: true, signal });
		addEventListener('resize', () => { if (isOpen()) place(); }, { signal });
	}

	const destroy = () => {
		listeners.abort();
		element.remove();
	};

	return {
		element, isOpen, open, close, step, destroy,
		current: () => (isOpen() ? showing[active] : undefined),
	};
}
