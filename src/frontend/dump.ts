// The SQL screen (SCOPE 7d): the statements that took effect, newest first, as the dump wrote
// them down — only those about tables this role may read. A screen of the framework's own, like
// the monitor, and behind the same grant; each line is drawn as an action of the monitor's is:
// the start of the statement, unfolding into the whole of it.
//
// It does not poll: every read sends the whole file to be judged, and the file grows with every
// tab's presence poll. It reads when it is opened, when its filter changes, and when asked again.

import type { Dumped, DumpRead, OperatorMeta, TableMeta } from '../shared/api.js';
import { api, ApiError } from './api.js';
import { sessionEnded } from './auth.js';
import { byId, classed, el } from './dom.js';
import { type FilterBar, filterBar } from './filters.js';
import { foldingLine, table as listTable, when } from './monitor.js';
import type { Status } from './status.js';

/** The screen's name: its address and the endpoint's, as `api/monitor.ts` mounts it. */
export const DUMP = '_dump';

export interface DumpScreen {
	/** Shows the screen and reads the dump. */
	show(): void;
	stop(): void;
	/** The filter bar, for the screen's toolbar; shown while the screen is. */
	readonly bar: HTMLElement;
	/** Reading it again, for the header; shown while the screen is. */
	readonly refresh: HTMLElement;
}

export interface DumpOptions {
	meta: TableMeta;
	operators: OperatorMeta[];
	/** The counts go in its pill; what a filter got wrong is listed beside it, as on any screen. */
	status: Status;
}

const HEADINGS = ['Cuándo', 'Sentencia'];

const count = (n: number) => `${n} ${n === 1 ? 'sentencia' : 'sentencias'}`;

export function dumpScreen({ meta, operators, status }: DumpOptions): DumpScreen {
	const box = byId('dump');
	const { table, body } = listTable(HEADINGS, true);
	const none = classed('p', 'watch-empty');
	const again = el('button');
	const refresh = classed('div', 'actions refresh', again);

	const bar: FilterBar = filterBar([meta], operators, () => void read());

	bar.reset(meta);
	bar.element.hidden = true;
	refresh.hidden = true;
	box.replaceChildren(table, none);

	again.type = 'button';
	again.title = 'Actualizar';
	again.setAttribute('aria-label', 'Actualizar');
	again.addEventListener('click', () => void read());

	let shown = false;

	/** Which statements are unfolded, so that reading the dump again does not fold them back. */
	const unfolded = new Set<string>();

	const lines = ({ at, statements }: Dumped) =>
		foldingLine(unfolded, `${at} ${statements}`,
			[el('td', when(at)), el('td', classed('span', 'monitor-request dump-statement', statements))], statements);

	const read = async (): Promise<void> => {
		status.busy('Cargando…');

		const filter = bar.query();
		let answer: DumpRead;

		try {
			answer = await api<DumpRead>(filter === undefined ? `/api/${DUMP}` : `/api/${DUMP}?${new URLSearchParams({ filter })}`);
		} catch (err) {
			if (sessionEnded(err)) location.reload();
			else if (err instanceof ApiError && err.status === 400) status.standing(bar, [{ what: err.message }]);
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
		status.say(entries.length < total ? `${entries.length} de ${count(total)}` : count(total));
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
			status.standing(bar, []);			// what is wrong with this screen is not wrong elsewhere
		},
	};
}
