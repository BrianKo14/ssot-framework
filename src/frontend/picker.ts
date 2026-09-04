// The dropdown an fk field offers: rows of the table it points at, labeled by their `isName`
// columns. Hangs off the same text box the value is typed into — you can still type the key
// by hand, this just suggests into the same box.

import type { ReferenceMeta, TableMeta } from '../shared/api.js';
import { api } from './api.js';
import { labelOf, searchColumn, valuesFrom, valuesOf } from './fk.js';
import { menu } from './menu.js';
import { filterQuery, listPath } from './query.js';

type Row = Record<string, unknown>;

/** How long typing settles before the list is asked again. */
const SETTLE = 200;

export interface Picker {
	/** Offers the key to the list first. True when the list took it and the box must not act. */
	handled(e: KeyboardEvent): boolean;
	/** Re-asks for the list, after the box's text changed. */
	refresh(): void;
	close(): void;
	/** Called when the box it hangs from goes: see `Menu.destroy`. */
	destroy(): void;
}

/**
 * @param input the box the value is written in; the list hangs from it and writes into it
 * @param within the cell or field both sit in — a press outside it closes the list
 */
export function picker(
	input: HTMLInputElement,
	within: HTMLElement,
	ref: ReferenceMeta,
	target: TableMeta,
	onPick: (values: Row) => void,
): Picker {
	const list = menu(input, within, true);		// anchored: the box scrolls inside the grid or the panel

	within.append(list.element);

	let timer = 0;
	let wanted: string | null = null;		// the text the list on screen answers, if any
	let searching = false;				// the box opens holding a key, not a name: that is not a search

	/** Nothing until the box has actually been typed into — the value already there is the
	    fk's own key, and would match no name. */
	const term = () => (searching ? input.value.trim() : '');

	const line = (row: Row) => ({
		text: labelOf(target, row),
		hint: valuesOf(target.pk, row).join(' · '),
		pick: () => { list.close(); onPick(valuesFrom(ref, row)); },
	});

	/** A `contains` filter on the target's search column (casts to text server-side, so an
	    integer key is searchable too), or none when it has no such column. */
	const asked = (typed: string) => {
		const column = searchColumn(target);

		return typed && column ? filterQuery([{ column, op: 'contains', value: typed }]) : undefined;
	};

	const load = async (typed: string) => {
		try {
			const rows = await api<Row[]>(listPath(target.entity, asked(typed)));

			if (typed !== wanted) return;	// a later keystroke already asked for something else

			list.open(target.entity, rows.map(line));
		} catch {
			// unlistable is fine — the box still takes typed input, and save reports whatever
			// the server makes of it
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

			if (!one) return false;		// nothing highlighted: the box's own Enter stands

			e.preventDefault();
			one.pick();

			return true;
		}],
		['Escape', e => {
			if (!list.isOpen()) return false;	// nothing to close: the box's own Escape stands

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
