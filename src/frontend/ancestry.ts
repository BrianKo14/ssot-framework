// The picker for ancestor columns (SCOPE 6b): the fields of the tables the screen points at,
// and of the tables *those* point at, offered as a list you turn on and off.
//
// Not a `menu`: that is a list you pick one thing from and it closes, and it closes on the very
// press that a box being ticked is made of. This is a list you tick several things in, so it is
// a dialog — the browser's own, which brings Escape, the focus trap and the backdrop with it.

import type { ColumnMeta, TableMeta } from '../shared/api.js';
import { byId, classed, el } from './dom.js';
import { type Ancestor, ancestorsOf, kinshipOf, reachedName } from './fk.js';

export interface AncestryPicker {
	/** Opens it on a screen. @param showing the reached names already on that screen. */
	open(t: TableMeta, showing: string[]): void;
}

const dialog = byId('ancestry') as HTMLDialogElement;
const groups = byId('ancestry-groups');
const none = byId('ancestry-none');
const close = byId('ancestry-close');

/**
 * @param tables every table `_meta` published — an fk onto one it did not is not walked, so a
 * role is never offered the fields of a table it may not read
 * @param toggle what ticking a box does; the screen redraws itself
 */
export function ancestryPicker(
	tables: TableMeta[],
	toggle: (t: TableMeta, a: Ancestor, c: ColumnMeta, on: boolean) => void,
): AncestryPicker {

	/** One field, ticked when the screen is already showing it. */
	const field = (t: TableMeta, a: Ancestor, showing: string[]) => (c: ColumnMeta) => {
		const box = el('input');

		box.type = 'checkbox';
		box.checked = showing.includes(reachedName(a, c));
		box.addEventListener('change', () => toggle(t, a, c, box.checked));

		return el('li', classed('label', 'field', box, el('span', c.name), el('small', c.type)));
	};

	/** One ancestor: what it is called, which fk reaches it, and what it holds. */
	const group = (t: TableMeta, showing: string[]) => (a: Ancestor) => {
		const path = a.via.map(r => r.name).join(' · ');

		return el('section',
			el('h3', classed('span', 'kin', kinshipOf(a.via)), el('span', path),
				classed('small', 'of', a.table.entity)),
			el('ul', ...a.table.columns.map(field(t, a, showing))));
	};

	const open = (t: TableMeta, showing: string[]) => {
		const ancestors = ancestorsOf(tables, t);

		groups.replaceChildren(...ancestors.map(group(t, showing)));
		none.hidden = ancestors.length > 0;
		dialog.showModal();
	};

	// the dialog closes itself on Escape; what it must not do is let the press through to the
	// window, where it would close the record panel behind it as well
	dialog.addEventListener('keydown', e => { if (e.key === 'Escape') e.stopPropagation(); });

	// a press on the backdrop is a press on the dialog itself, and reads as "done"
	dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close(); });

	close.addEventListener('click', () => { dialog.close(); });

	return { open };
}
