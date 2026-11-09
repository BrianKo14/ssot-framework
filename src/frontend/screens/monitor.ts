// The monitor screen: who is signed in, listed like a table. A line opens a
// panel with the tables that user has open and everything they did, newest first, each action
// unfolding into the SQL it ran.
//
// One of the framework's own screens: it lists no table of the schema and edits nothing, but it
// borrows the grid's look so it reads as one more screen.

import type { Activity, Monitored, MonitorMeta, Online, OperatorMeta, Viewer } from '../../shared/api.js';
import { type FilterBar, filterBar } from '../controls/filters.js';
import { button, byId, classed, el, lead } from '../kit/dom.js';
import type { Status } from '../kit/status.js';
import { count, toSecond } from '../kit/text.js';
import { api, ApiError } from '../wire/api.js';
import { restarted } from '../wire/auth.js';

/** The screen's address and the endpoint's, as `api/monitor.ts` mounts it. */
export const MONITOR = '_monitor';

export interface Monitor {
	/** Shows it with `picked`'s panel open, or none, and polls until `stop`. */
	show(picked: string | null): void;
	stop(): void;
	/** The list's filter bar, for the toolbar; shown while the monitor is. */
	readonly bar: HTMLElement;
}

export interface MonitorOptions {
	meta: MonitorMeta;
	operators: OperatorMeta[];
	seconds: number;
	/** For the counts, and what a filter got wrong. */
	status: Status;
	/** The monitor's address with one user picked. */
	hrefOf(user: string): string;
	/** Letting go of the pick: back to the monitor's own address. */
	close(): void;
	/** This tab's presence name, so the answer leaves it out. */
	tab(): string | null;
	/** Every open tab, after each answer that changed: for the rail. */
	seen(tabs: Viewer[]): void;
}

const USER_HEADINGS = ['Usuario', 'Rol', 'Última actividad', 'Pantalla'];
const ACTION_HEADINGS = ['Cuándo', 'Pantalla', 'Request'];

/** The request as typed: a filter reads as JSON, not `%7B%22...`. */
const readable = (request: string) => {
	try { return decodeURIComponent(request); } catch { return request; }
};

/** A table with its headings, and the body its rows go into.
 * @param leading whether it has the grid's leading column */
export const table = (headings: string[], leading: boolean) => {
	const body = el('tbody');
	const head = el('tr', ...(leading ? [lead('th')] : []), ...headings.map(h => el('th', h)));

	return { table: el('table', el('thead', head), body), body };
};

/** A line, and under it its SQL, folded until asked for. The whole line unfolds it on a click;
 * the leading button is there for the keyboard.
 * @param unfolded the keys of the open lines, kept up to date so a re-read doesn't fold them
 * @param cells the line's own, after the leading column */
export const foldingLine = (unfolded: Set<string>, key: string, cells: HTMLElement[], sql: string): HTMLTableRowElement[] => {
	const control = button('fold', 'Ver el SQL');
	const line = classed('tr', 'monitor-action', lead('td', control), ...cells);
	const code = classed('td', 'monitor-code', classed('pre', 'monitor-sql', sql));
	// the fold keeps a leading cell too, so the SQL sits under the cells, not under the handle
	const fold = classed('tr', 'monitor-fold open', lead('td'), code);

	code.colSpan = cells.length;

	const set = (open: boolean) => {
		control.setAttribute('aria-expanded', String(open));
		line.classList.toggle('open', open);
		fold.hidden = !open;

		if (open) unfolded.add(key); else unfolded.delete(key);
	};

	line.addEventListener('click', () => set(!line.classList.contains('open')));
	set(unfolded.has(key));

	return [line, fold];
};

/** A titled part of the panel, like the record panel's "Detalles". */
const part = (heading: HTMLElement, ...content: HTMLElement[]) =>
	classed('section', 'watch-part', heading, ...content);

/** One tab: the screen it is on, and the records it has open there. */
const tabChip = (tab: Viewer) =>
	classed('li', 'monitor-tab',
		classed('b', 'monitor-screen', tab.entity),
		...tab.records.map(record => classed('span', 'monitor-record', record)));

/** A list's address, with its filter bar's filter and anything else asked. */
const asking = (path: string, bar: FilterBar, more: Record<string, string | null> = {}) => {
	const query = new URLSearchParams();

	for (const [name, value] of Object.entries({ filter: bar.query() ?? null, ...more }))
		if (value !== null) query.set(name, value);

	const said = query.toString();

	return said ? `${path}?${said}` : path;
};

export function monitorScreen({ meta, operators, seconds, status, hrefOf, close, tab, seen }: MonitorOptions): Monitor {
	const box = byId('monitor');
	const panel = byId('watch');
	const title = byId('watch-title');

	const users = table(USER_HEADINGS, true);
	const actions = table(ACTION_HEADINGS, true);

	const tabsHeading = classed('h3', 'watch-heading', 'Tablas abiertas');
	const tabList = classed('ul', 'monitor-tab-list');
	const noTabs = classed('p', 'watch-none', 'Sin tablas abiertas.');
	const actionsHeading = classed('h3', 'watch-heading');
	const noActions = classed('p', 'watch-empty');

	// One bar per list, on the columns `_meta` describes it by. Not in the address: both lists
	// have an `at` and a `screen`, and the address has room for one of each.
	const userBar = filterBar([meta.users], operators, () => { drawn = ''; void ask(); });
	const actionBar = filterBar([meta.actions], operators, () => { if (picked !== null) void readActions(picked); });

	userBar.reset(meta.users);
	actionBar.reset(meta.actions);
	userBar.element.hidden = true;			// shown with the monitor

	// drawn like the record panel's subtables: heading, a strip (the filter bar), and a `.sheet`
	box.replaceChildren(users.table);
	byId('watch-body').replaceChildren(
		part(tabsHeading, tabList, noTabs),
		classed('section', 'watch-log', actionsHeading,
			classed('div', 'watch-strip', actionBar.element),
			classed('div', 'sheet', actions.table, noActions)));

	byId('watch-close').addEventListener('click', close);
	addEventListener('keydown', e => { if (e.key === 'Escape' && !panel.hidden) close(); });

	let picked: string | null = null;

	/** The picked user's newest action, as the list said it now and when their actions were
	 * last read. When they agree there's nothing new to read. */
	let newest: string | undefined;
	let readAt: string | undefined;

	/** Which actions are unfolded, so a re-read doesn't fold them back. */
	const unfolded = new Set<string>();

	/** A list that answered has nothing wrong with its filter any more. */
	const answered = (bar: FilterBar) => status.standing(bar, []);

	/** A bad filter stays listed until changed; anything else is left to the next round.
	 * @param table which list, when not the screen's own */
	const refused = (bar: FilterBar, err: unknown, table?: string) => {
		if (restarted(err)) return;
		if (err instanceof ApiError && err.status === 400) status.standing(bar, [{ what: err.message, table }]);
	};

	/** Opens a user's panel. A link, since what it opens is an address. */
	const opener = (user: string) => {
		const a = classed('a', 'handle');

		a.href = hrefOf(user);
		a.title = `Ver a ${user}`;
		a.setAttribute('aria-label', `Ver a ${user}`);

		return a;
	};

	const userLine = (one: Online): HTMLTableRowElement => {
		const line = el('tr', lead('td', opener(one.user)), el('td', one.user), el('td', one.role),
			el('td', one.last === null ? '' : toSecond(one.last.at)), el('td', one.last?.screen ?? ''));

		line.classList.toggle('open', one.user === picked);

		return line;
	};

	/** An action, and under it the SQL it ran. */
	const actionLines = (user: string) => (a: Activity): HTMLTableRowElement[] => {
		const request = classed('span', 'monitor-request', readable(a.request));

		request.title = readable(a.request);

		return foldingLine(unfolded, `${user} ${a.at}`,
			[el('td', toSecond(a.at)), el('td', a.screen ?? ''), el('td', request)], a.statements);
	};

	const drawTabs = (tabs: Viewer[]) => {
		tabList.replaceChildren(...tabs.map(tabChip));
		tabList.hidden = !tabs.length;
		noTabs.hidden = tabs.length > 0;
	};

	/** Reads the picked user's actions under the panel's filter, unless the pick moved meanwhile. */
	const readActions = async (user: string): Promise<void> => {
		readAt = newest;

		let done: Activity[];

		try {
			done = await api<Activity[]>(asking(`/api/${MONITOR}/${encodeURIComponent(user)}`, actionBar));
		} catch (err) {
			refused(actionBar, err, 'Actividad');
			return;
		}

		answered(actionBar);

		if (user !== picked) return;

		actions.body.replaceChildren(...done.flatMap(actionLines(user)));
		actionsHeading.textContent = `Actividad · ${count(done.length, 'acción', 'acciones')}`;
		actions.table.hidden = !done.length;
		noActions.hidden = done.length > 0;
		noActions.textContent = actionBar.query() === undefined ? 'Sin actividad registrada.' : 'Ninguna acción cumple el filtro.';
	};

	/** The panel opening on a user, before anything about them arrives. */
	const opened = (user: string) => {
		newest = undefined;
		title.textContent = user;
		actions.body.replaceChildren();
		actions.table.hidden = true;
		actionsHeading.textContent = 'Actividad';
		noActions.hidden = false;
		noActions.textContent = 'Cargando…';
		drawTabs([]);
	};

	/** What was drawn last, so a round that says the same redraws nothing. */
	let drawn = '';
	let timer: ReturnType<typeof setInterval> | undefined;

	const ask = async () => {
		let answer: Monitored;

		try {
			answer = await api<Monitored>(asking(`/api/${MONITOR}`, userBar, { tab: tab() }));
		} catch (err) {
			refused(userBar, err);
			return;
		}

		answered(userBar);

		if (timer === undefined) return;		// left meanwhile

		const { online, tabs } = answer;
		const text = JSON.stringify(answer);

		newest = online.find(one => one.user === picked)?.last?.at;

		if (text !== drawn) {
			drawn = text;
			users.body.replaceChildren(...online.map(userLine));
			drawTabs(tabs.filter(t => t.user === picked));
			seen(tabs);

			const listed = tabs.filter(t => online.some(one => one.user === t.user));

			status.say(`${count(online.length, 'usuario conectado', 'usuarios conectados')} · ${count(listed.length, 'tabla abierta', 'tablas abiertas')}`);
		}

		// read the actions again only if the user did something since (the list says so for free)
		if (picked !== null && newest !== undefined && newest !== readAt) await readActions(picked);
	};

	return {
		bar: userBar.element,

		show(user) {
			const moved = user !== picked;

			picked = user;
			box.hidden = false;
			panel.hidden = user === null;
			userBar.element.hidden = false;

			if (moved) {
				drawn = '';					// the list highlights the pick, so redraw it
				if (user !== null) {
					opened(user);
					void readActions(user);
				}
			}

			if (timer === undefined) timer = setInterval(() => void ask(), seconds * 1000);

			void ask();
		},

		stop() {
			clearInterval(timer);
			timer = undefined;
			drawn = '';
			picked = null;
			box.hidden = true;
			panel.hidden = true;
			userBar.element.hidden = true;
			status.standing(userBar, []);			// not wrong anywhere else
			status.standing(actionBar, []);
		},
	};
}
