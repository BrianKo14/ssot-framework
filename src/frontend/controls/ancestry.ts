// The picker for ancestor columns: the fields of the tables the screen points at,
// and of the ones *those* point at, ticked on and off.
//
// A `<dialog>`, not a `menu`: a menu closes on the press that ticks a box, and the browser's
// dialog brings Escape, the focus trap and the backdrop for free.

import type { ColumnMeta, TableMeta } from '../../shared/api.js';
import { byId, classed, el } from '../kit/dom.js';
import { type Ancestor, ancestorsOf, kinshipOf, reachedName } from '../model/fk.js';

export interface AncestryPicker {
	/** @param showing the reached names already on that screen */
	open(t: TableMeta, showing: string[]): void;
}

/**
 * @param tables every table in `_meta`, so a role is never offered a table it may not read
 * @param toggle what ticking a box does; the screen redraws itself
 */
export function ancestryPicker(
	tables: TableMeta[],
	toggle: (t: TableMeta, a: Ancestor, c: ColumnMeta, on: boolean) => void,
): AncestryPicker {
	const dialog = byId('ancestry') as HTMLDialogElement;
	const groups = byId('ancestry-groups');
	const none = byId('ancestry-none');

	/** One field, ticked if the screen already shows it. */
	const field = (t: TableMeta, a: Ancestor, showing: string[]) => (c: ColumnMeta) => {
		const box = el('input');

		box.type = 'checkbox';
		box.checked = showing.includes(reachedName(a, c));
		box.addEventListener('change', () => toggle(t, a, c, box.checked));

		return el('li', classed('label', 'field', box, el('span', c.name), el('small', c.type)));
	};

	/** One ancestor: its kinship, the fks that reach it, and its fields. */
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

	// the dialog closes itself on Escape; don't let it reach the window and close the panel too
	dialog.addEventListener('keydown', e => { if (e.key === 'Escape') e.stopPropagation(); });

	// a press on the backdrop is a press on the dialog itself: "done"
	dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close(); });

	byId('ancestry-close').addEventListener('click', () => { dialog.close(); });

	return { open };
}
