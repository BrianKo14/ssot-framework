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
}

let ids = 0;	// unique per instance, so a controller's aria-controls never collides

/**
 * @param controller the input or button it hangs from; its `aria-expanded` follows the dropdown
 * @param within the box both sit in — a press outside it closes the dropdown
 */
export function menu(controller: HTMLElement, within: HTMLElement): Menu {
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

	// Capture phase: picking a line rebuilds the list before this listener sees the click, so a
	// bubbling check ("is the target still inside?") would wrongly answer no and close it again.
	addEventListener('mousedown', e => {
		if (e.target instanceof Node && !within.contains(e.target)) close();
	}, true);

	return { element, isOpen, open, close, step, current: () => (isOpen() ? showing[active] : undefined) };
}
