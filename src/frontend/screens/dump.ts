// The SQL screen (SCOPE 7d): the statements that took effect, newest first, only about tables
// this role may read. Behind the monitor's grant, and drawn like its actions.
//
// It doesn't poll: each read sends the whole (growing) file to be judged. It reads when opened,
// when its filter changes, and when asked again.

import type { Dumped, DumpRead, OperatorMeta, TableMeta } from '../../shared/api.js';
import { type FilterBar, filterBar } from '../controls/filters.js';
import { button, byId, classed, el } from '../kit/dom.js';
import type { Status } from '../kit/status.js';
import { count, toSecond } from '../kit/text.js';
import { api, ApiError } from '../wire/api.js';
import { restarted } from '../wire/auth.js';
import { foldingLine, table as listTable } from './monitor.js';

/** The screen's address and the endpoint's, as `api/monitor.ts` mounts it. */
export const DUMP = '_dump';

export interface DumpScreen {
	/** Shows the screen and reads the dump. */
	show(): void;
	stop(): void;
	/** The filter bar, for the toolbar; shown while the screen is. */
	readonly bar: HTMLElement;
	/** The "read again" button, for the header; shown while the screen is. */
	readonly refresh: HTMLElement;
}

export interface DumpOptions {
	meta: TableMeta;
	operators: OperatorMeta[];
	/** For the counts, and what a filter got wrong. */
	status: Status;
}

const HEADINGS = ['Cuándo', 'Sentencia'];

export function dumpScreen({ meta, operators, status }: DumpOptions): DumpScreen {
	const box = byId('dump');
	const { table, body } = listTable(HEADINGS, true);
	const none = classed('p', 'watch-empty');
	const again = button('', 'Actualizar');
	const refresh = classed('div', 'actions refresh', again);

	const bar: FilterBar = filterBar([meta], operators, () => void read());

	bar.reset(meta);
	bar.element.hidden = true;
	refresh.hidden = true;
	box.replaceChildren(table, none);

	again.addEventListener('click', () => void read());

	let shown = false;

	/** Which statements are unfolded, so a re-read doesn't fold them back. */
	const unfolded = new Set<string>();

	const lines = ({ at, statements }: Dumped) =>
		foldingLine(unfolded, `${at} ${statements}`,
			[el('td', toSecond(at)), el('td', classed('span', 'monitor-request dump-statement', statements))], statements);

	const read = async (): Promise<void> => {
		status.busy('Cargando…');

		const filter = bar.query();
		let answer: DumpRead;

		try {
			answer = await api<DumpRead>(filter === undefined ? `/api/${DUMP}` : `/api/${DUMP}?${new URLSearchParams({ filter })}`);
		} catch (err) {
			if (restarted(err)) return;
			if (err instanceof ApiError && err.status === 400) status.standing(bar, [{ what: err.message }]);
			else status.fail((err as Error).message);
			return;
		}

		status.standing(bar, []);

		if (!shown) return;				// left meanwhile

		const { total, entries } = answer;

		body.replaceChildren(...entries.flatMap(lines));
		table.hidden = !entries.length;
		none.hidden = entries.length > 0;
		none.textContent = filter === undefined ? 'Sin sentencias.' : 'Ninguna sentencia cumple el filtro.';
		status.say(entries.length < total ? `${entries.length} de ${count(total, 'sentencia')}` : count(total, 'sentencia'));
	};

	return {
		bar: bar.element,
		refresh,

		show() {
			shown = true;
			box.hidden = false;
			bar.element.hidden = false;
			refresh.hidden = false;
			void read();
		},

		stop() {
			shown = false;
			box.hidden = true;
			bar.element.hidden = true;
			refresh.hidden = true;
			status.standing(bar, []);			// not wrong anywhere else
		},
	};
}
