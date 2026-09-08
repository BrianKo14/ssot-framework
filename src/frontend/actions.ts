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
	const button = el('button');
	const element = classed('div', 'actions', button);
	const list = menu(button, element);

	let table: TableMeta | null = null;

	if (look.className) element.classList.add(look.className);

	element.append(list.element);
	element.hidden = true;					// until a screen says what it allows
	button.type = 'button';
	button.setAttribute('aria-haspopup', 'listbox');

	const allowed = (t: TableMeta) => actions.filter(a => t.capabilities.includes(a.needs));

	/** What the button is called. A menu offering one thing is named by that thing; a menu
	    offering several, by what they have in common. So a role allowed only some of them is
	    never handed a button promising the rest — the label follows the list, as the list
	    already follows the role. */
	const call = (offered: Action[]) => {
		const name = offered.length === 1 ? offered[0].text : label;

		if (look.iconOnly) {				// nothing is written on it, so it says its own name
			button.title = name;
			button.setAttribute('aria-label', name);
		} else button.replaceChildren(name);
	};

	call(actions);						// until a screen says which of them it allows

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
		const offered = allowed(t);

		table = t;

		list.close();					// what it was offering was the last screen's
		call(offered);
		element.hidden = offered.length === 0;
	};

	return { element, button, reset };
}
