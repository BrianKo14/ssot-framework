// The list an fk field offers: rows of the table it points at, labeled by their `isName`
// columns. It suggests into the same box the key can still be typed into by hand.

import type { ReferenceMeta, TableMeta } from '../../shared/api.js';
import { menu } from '../kit/menu.js';
import { labelOf, searchColumn, valuesFrom, valuesOf } from '../model/fk.js';
import { filterQuery, listPath } from '../model/query.js';
import type { Row } from '../model/rows.js';
import { api } from '../wire/api.js';

/** How long typing settles before the list is asked again. */
const SETTLE = 200;

export interface Picker {
	/** Offers the key to the list first. True if the list took it, and the box must not act. */
	handled(e: KeyboardEvent): boolean;
	/** Asks for the list again, after the box's text changed. */
	refresh(): void;
	close(): void;
	/** For when the box it hangs from goes: see `Menu.destroy`. */
	destroy(): void;
}

/**
 * @param input the box the value is written in; the list hangs from it
 * @param within the cell or field both sit in; a press outside it closes the list
 */
export function picker(
	input: HTMLInputElement,
	within: HTMLElement,
	ref: ReferenceMeta,
	target: TableMeta,
	onPick: (values: Row) => void,
): Picker {
	const list = menu(input, within, true);		// anchored: the box scrolls inside the grid or panel

	within.append(list.element);

	let timer = 0;
	let wanted: string | null = null;		// the text the list on screen answers, if any
	let searching = false;				// the box opens holding a key, not a name to search for

	/** Nothing until the box is typed into: what's there is the key, which matches no name. */
	const term = () => (searching ? input.value.trim() : '');

	const line = (row: Row) => ({
		text: labelOf(target, row),
		hint: valuesOf(target.pk, row).join(' · '),
		pick: () => { list.close(); onPick(valuesFrom(ref, row)); },
	});

	/** `contains` on the target's search column (the server casts to text, so an integer key
	 * works too), or no filter if it has none. */
	const asked = (typed: string) => {
		const column = searchColumn(target);

		return typed && column ? filterQuery([{ column, op: 'contains', value: typed }]) : undefined;
	};

	const load = async (typed: string) => {
		try {
			const rows = await api<Row[]>(listPath(target.entity, { filter: asked(typed) }));

			if (typed !== wanted) return;	// a later keystroke asked for something else

			list.open(target.entity, rows.map(line));
		} catch {
			// fine: the box still takes typed input, and saving reports what the server says
			close();
		}
	};

	const ask = () => {
		wanted = term();

		clearTimeout(timer);
		timer = setTimeout(() => void load(wanted ?? ''), SETTLE);
	};

	const close = () => {
		wanted = null;

		clearTimeout(timer);
		list.close();
	};

	const step = (by: number) => { if (list.isOpen()) list.step(by); else ask(); };

	const keys = new Map<string, (e: KeyboardEvent) => boolean>([
		['ArrowDown', e => { e.preventDefault(); step(1); return true; }],
		['ArrowUp', e => { e.preventDefault(); step(-1); return true; }],
		['Enter', e => {
			const one = list.current();

			if (!one) return false;		// nothing highlighted: the box's own Enter applies

			e.preventDefault();
			one.pick();

			return true;
		}],
		['Escape', e => {
			if (!list.isOpen()) return false;	// nothing to close: the box's own Escape applies

			e.stopPropagation();
			close();

			return true;
		}],
	]);

	input.addEventListener('focus', ask);

	return {
		handled: e => keys.get(e.key)?.(e) ?? false,
		refresh: () => { searching = true; ask(); },
		close,
		destroy: () => { clearTimeout(timer); list.destroy(); },
	};
}
