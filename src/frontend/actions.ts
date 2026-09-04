// The toolbar's action button.

import type { Capability, TableMeta } from '../shared/api.js';
import { classed, el } from './dom.js';
import { menu, type Option } from './menu.js';

/** One thing the toolbar can do to the screen showing. */
export interface Action {
	text: string;
	/** Required capability — hidden unless `_meta` grants it for this screen. */
	needs: Capability;
	run(t: TableMeta): void;
}

export interface ActionMenu {
	readonly element: HTMLElement;
	/** Focus target for whatever an action opens. */
	readonly button: HTMLButtonElement;
	reset(t: TableMeta): void;
}

/** How the button is drawn. What it *does* is the same either way — only the shape differs,
    so the stylesheet is told which one and nothing here knows what a mark looks like. */
export interface Look {
	/** Added beside `actions` on the box, for the stylesheet to hang the shape and mark on. */
	className?: string;
	/** Draw the mark alone: the label is then the button's name and its tooltip, not its text. */
	iconOnly?: boolean;
}

/**
 * @param label what the button is called
 * @param actions everything the toolbar may offer, in order
 * @param look how it is drawn; written on the button by default
 */
export function actionMenu(label: string, actions: Action[], look: Look = {}): ActionMenu {
	const button = el('button', ...(look.iconOnly ? [] : [label]));
	const element = classed('div', 'actions', button);
	const list = menu(button, element);

	let table: TableMeta | null = null;

	if (look.className) element.classList.add(look.className);

	if (look.iconOnly) {					// nothing is written on it, so it says its own name
		button.title = label;
		button.setAttribute('aria-label', label);
	}

	element.append(list.element);
	element.hidden = true;					// until a screen says what it allows
	button.type = 'button';
	button.setAttribute('aria-haspopup', 'listbox');

	const allowed = (t: TableMeta) => actions.filter(a => t.capabilities.includes(a.needs));

	const line = (t: TableMeta) => (a: Action): Option =>
		({ text: a.text, pick: () => { list.close(); a.run(t); } });

	const show = () => { if (table) list.open(undefined, allowed(table).map(line(table))); };

	const move = (by: number) => { if (list.isOpen()) list.step(by); else show(); };

	const keys = new Map<string, (e: KeyboardEvent) => void>([
		['ArrowDown', e => { e.preventDefault(); move(1); }],
		['ArrowUp', e => { e.preventDefault(); move(-1); }],
		// a native Enter on the button would also fire click and close the list
		['Enter', e => { const one = list.current(); if (one) { e.preventDefault(); one.pick(); } }],
		['Escape', e => { e.stopPropagation(); list.close(); }],	// the peek's Escape must not fire too
	]);

	button.addEventListener('click', () => { if (list.isOpen()) list.close(); else show(); });
	button.addEventListener('keydown', e => keys.get(e.key)?.(e));

	const reset = (t: TableMeta) => {
		table = t;

		list.close();					// what it was offering was the last screen's
		element.hidden = allowed(t).length === 0;
	};

	return { element, button, reset };
}
