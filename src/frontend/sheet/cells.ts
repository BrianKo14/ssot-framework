// How a column and a value are drawn, the same in a grid cell and in a panel field.

import type { ColumnMeta, TableMeta } from '../../shared/api.js';
import { classed, el } from '../kit/dom.js';
import { type Fk, type FkOf, keyThrough, kinshipOf, type Reachable } from '../model/fk.js';
import { type Router, screenOf } from '../model/route.js';
import type { Row } from '../model/rows.js';

export interface Cells {
	/** A column's tooltip and marks (pk, fk, required), on a grid header or a panel label.
	 * @param required whether this field will be refused empty, which depends on what is being done */
	named<N extends HTMLElement>(node: N, t: TableMeta, c: ColumnMeta, required: boolean): N;
	/** An fk value as a link to the row it points at, so Back and new tab both work.
	 * Nothing is fetched: it uses the value on screen. */
	fkLink(fk: Fk, row: Row, value: unknown): HTMLAnchorElement | undefined;
	/** A grid's header cell. A borrowed column says where it came from instead of its table's
	 * marks, which would be untrue of it (it links nowhere, and a left join can leave it null). */
	header(t: TableMeta): (sh: Reachable) => HTMLTableCellElement;
}

/** A value, in a grid cell or a panel field.
 * @param link the row it points at, if any (see `fkLink`) */
export const shown = <K extends 'td' | 'dd'>(tag: K, value: unknown, link?: HTMLAnchorElement) => {
	const node = el(tag, link ?? (value === null ? 'null' : String(value)));

	node.classList.toggle('null', value === null);

	return node;
};

export function cellsOf(fkOf: FkOf, route: Router): Cells {
	const named = <N extends HTMLElement>(node: N, t: TableMeta, c: ColumnMeta, required: boolean): N => {
		const fk = fkOf(t, c);

		node.title = `${c.type} — ${c.expected}${fk ? ` → ${fk.target.entity}` : ''}`;
		node.classList.toggle('pk', t.pk.includes(c.name));
		node.classList.toggle('required', required);
		node.classList.toggle('fk', fk !== undefined);

		return node;
	};

	const fkLink = (fk: Fk, row: Row, value: unknown): HTMLAnchorElement | undefined => {
		const addressed = keyThrough(fk.ref, fk.target, row);

		if (!addressed) return undefined;	// an fk onto a unique key, or a null: no row is named

		const a = classed('a', 'ref', String(value));

		a.href = route.href(screenOf(fk.target.entity, addressed));
		a.title = `Ver ${fk.target.entity}`;

		return a;
	};

	const header = (t: TableMeta) => (sh: Reachable) => {
		const { column } = sh;

		if (!sh.via.length)
			return named(el('th', column.name, el('small', column.type)), t, column, !column.nullable);

		const th = classed('th', 'borrowed', column.name,
			el('small', `${kinshipOf(sh.via)} · ${sh.owner.entity}`));

		th.title = `${sh.name} — ${column.type}, de ${sh.owner.entity}`;

		return th;
	};

	return { named, fkLink, header };
}
