// A record's history in the panel: what each column was, what it became, and who
// wrote it, newest first. Folded on every record until asked for.

import type { Logged, TableMeta } from '../../shared/api.js';
import { byId, classed } from '../kit/dom.js';
import { toMinute } from '../kit/text.js';
import { changesPath } from '../model/query.js';
import { api } from '../wire/api.js';

export interface History {
	/** Another record: folded, and nothing counted yet. */
	reset(): void;
	/** The panel closed. */
	close(): void;
	/** Reads it again; a draft (empty key) has none.
	 * @param current whether the panel still shows this record when the answer arrives */
	load(t: TableMeta, key: string[], current: () => boolean): Promise<void>;
}

/** A value, drawn as a null is drawn everywhere else. */
const value = (v: string | null) => {
	const span = classed('span', 'change-value', v === null ? 'null' : v);

	span.classList.toggle('null', v === null);

	return span;
};

/** One write over one column: field, was → became, who and when. */
const historyLine = (one: Logged) =>
	classed('li', 'change',
		classed('span', 'change-field', one.field),
		value(one.was),
		classed('span', 'change-arrow', '→'),
		value(one.became),
		classed('span', 'change-who', `${one.by} · ${toMinute(one.at)}`));

export function historyOf(): History {
	const box = byId('peek-changes');
	const title = byId('peek-changes-title') as HTMLButtonElement;
	const counted = byId('peek-changes-count');
	const list = byId('peek-changes-list');

	const fold = (open: boolean) => {
		title.setAttribute('aria-expanded', String(open));
		list.hidden = !open;
	};

	title.addEventListener('click', () => fold(title.getAttribute('aria-expanded') !== 'true'));

	return {
		reset() {
			fold(false);
			counted.textContent = '';
		},

		close() {
			box.hidden = true;
			list.replaceChildren();
		},

		async load(t, key, current) {
			box.hidden = !key.length;

			if (!key.length) { list.replaceChildren(); return; }

			const history = await api<Logged[]>(changesPath(t.entity, key));

			if (!current()) return;				// the panel moved on meanwhile

			// the count goes on the heading, so it's known before opening
			list.replaceChildren(...history.map(historyLine));
			counted.textContent = history.length ? String(history.length) : 'ninguno';
			title.disabled = history.length === 0;

			if (!history.length) fold(false);
		},
	};
}
