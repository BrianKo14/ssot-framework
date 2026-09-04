// The dropdown. Opened by the filter bar (its steps) and by the toolbar (its actions).

import { classed, el } from './dom.js';

/** One line of a dropdown. */
export interface Option {
	text: string;
	/** Shown beside the text — e.g. a column's type or an operator's symbol. */
	hint?: string;
	pick(): void;
}

export interface Menu {
	readonly element: HTMLElement;
	isOpen(): boolean;
	/** @param head the group's caption; omit when the list needs none. */
	open(head: string | undefined, options: Option[]): void;
	close(): void;
	step(by: number): void;
	/** The highlighted line, if the dropdown is open. */
	current(): Option | undefined;
	/** Removes the dropdown and its listeners — call for a per-edit dropdown so a long session
	    doesn't accumulate them; a screen-long one never needs it. */
	destroy(): void;
}

let ids = 0;	// unique per instance, so a controller's aria-controls never collides

/**
 * @param controller the input or button it hangs from; its `aria-expanded` follows the dropdown
 * @param within the box both sit in — a press outside it closes the dropdown
 * @param anchored position it against the controller by hand, for use inside a scrolling box
 * (a CSS-positioned dropdown would get clipped there)
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

	/** Against the controller's box, in viewport coordinates, so no ancestor's overflow cuts it. */
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

	// Abortable, so a dropdown built per edit can take its listeners with it when it goes.
	const listeners = new AbortController();
	const { signal } = listeners;

	// Capture phase: a pick rebuilds the list before this sees the click, so a bubble-phase
	// "still inside?" check would wrongly say no and close it again.
	addEventListener('mousedown', e => {
		if (e.target instanceof Node && !within.contains(e.target)) close();
	}, { capture: true, signal });

	if (anchored) {
		// placed once on opening, and kept there: what it hangs from moves with the box it scrolls in
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
