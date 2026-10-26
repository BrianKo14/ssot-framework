// A toolbar button with a dropdown of actions, each shown only where the role may run it.

import type { Capability, TableMeta } from '../../shared/api.js';
import { classed, el } from '../kit/dom.js';
import { menu, type Option } from '../kit/menu.js';

/** One thing the toolbar can do to the screen showing. */
export interface Action {
	text: string;
	/** Hidden unless `_meta` grants this on the screen's table. */
	needs: Capability;
	run(t: TableMeta): void;
}

export interface ActionMenu {
	readonly element: HTMLElement;
	/** Focus target for whatever an action opens. */
	readonly button: HTMLButtonElement;
	reset(t: TableMeta): void;
}

/** How the button is drawn; the stylesheet does the rest. */
export interface Look {
	/** Added beside `actions` on the box. */
	className?: string;
	/** Only the mark is drawn; the label becomes its name and tooltip. */
	iconOnly?: boolean;
}

/**
 * @param label the button's name when it offers several actions
 * @param actions everything it may offer, in order
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

	/** One action: named by it. Several: by `label`. So a role is never promised what it can't do. */
	const call = (offered: Action[]) => {
		const name = offered.length === 1 ? offered[0].text : label;

		if (look.iconOnly) {
			button.title = name;
			button.setAttribute('aria-label', name);
		} else button.replaceChildren(name);
	};

	call(actions);

	const line = (t: TableMeta) => (a: Action): Option =>
		({ text: a.text, pick: () => { list.close(); a.run(t); } });

	const show = () => { if (table) list.open(undefined, allowed(table).map(line(table))); };

	const move = (by: number) => { if (list.isOpen()) list.step(by); else show(); };

	const keys = new Map<string, (e: KeyboardEvent) => void>([
		['ArrowDown', e => { e.preventDefault(); move(1); }],
		['ArrowUp', e => { e.preventDefault(); move(-1); }],
		// a native Enter would also fire click, and close the list
		['Enter', e => { const one = list.current(); if (one) { e.preventDefault(); one.pick(); } }],
		['Escape', e => { e.stopPropagation(); list.close(); }],	// don't close the panel too
	]);

	button.addEventListener('click', () => { if (list.isOpen()) list.close(); else show(); });
	button.addEventListener('keydown', e => keys.get(e.key)?.(e));

	const reset = (t: TableMeta) => {
		const offered = allowed(t);

		table = t;

		list.close();
		call(offered);
		element.hidden = offered.length === 0;
	};

	return { element, button, reset };
}
