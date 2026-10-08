// The monitor screen (SCOPE 8a, 8b): who is signed in, as a list drawn like any table's, whose
// lines open a panel the way a record's do. The panel holds the tables that user has open and
// everything they did, newest first, each action unfolding into the SQL it ran. The list and the
// actions each have the filter bar every screen has, on the columns `_meta` describes them by.
//
// A screen of the framework's own, like the login: what it lists is not a table of the schema,
// so it is not drawn by the grid, and it never edits anything. It does borrow the grid's look —
// the leading column and its expand control, the panel's frame — so it reads as one more screen.

import type { Activity, Monitored, MonitorMeta, Online, OperatorMeta, Viewer } from '../shared/api.js';
import { api, ApiError } from './api.js';
import { sessionEnded } from './auth.js';
import { byId, classed, el, lead } from './dom.js';
import { type FilterBar, filterBar } from './filters.js';
import type { Status } from './status.js';

/** The monitor's name: the screen's address and the endpoint's, as `api/monitor.ts` mounts it. */
export const MONITOR = '_monitor';

export interface Monitor {
	/** Shows the monitor with `picked`'s panel open, or none; asks now and every round after,
	 * drawing each answer, until `stop`. Said again with another user, it moves the pick. */
	show(picked: string | null): void;
	stop(): void;
	/** The list's filter bar, for the screen's toolbar; shown while the monitor is. */
	readonly bar: HTMLElement;
}

export interface MonitorOptions {
	meta: MonitorMeta;
	operators: OperatorMeta[];
	seconds: number;
	/** The counts go in its pill; what a filter got wrong is listed beside it, as on any screen. */
	status: Status;
	/** The monitor's address with one user picked. */
	hrefOf(user: string): string;
	/** What letting go of the pick is: going back to the monitor's own address. */
	close(): void;
	/** This browser tab's presence name, so the answer leaves it out as every screen's does. */
	tab(): string | null;
	/** Called with every open tab after each answer that changed: what the rail draws. */
	seen(tabs: Viewer[]): void;
}

const USER_HEADINGS = ['Usuario', 'Rol', 'Última actividad', 'Pantalla'];
const ACTION_HEADINGS = ['Cuándo', 'Pantalla', 'Request'];

/** "2026-09-30 15:37:08", without the fraction the database adds. */
export const when = (at: string) => at.slice(0, 19);

/** The request as it would be typed: a filter reads as the JSON it is, not as `%7B%22…`. */
const readable = (request: string) => {
	try { return decodeURIComponent(request); } catch { return request; }
};

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** A table with its headings, and the body its rows go into.
 * @param leading whether it has the grid's leading column, for the control that opens a line */
export const table = (headings: string[], leading: boolean) => {
	const body = el('tbody');
	const head = el('tr', ...(leading ? [lead('th')] : []), ...headings.map(h => el('th', h)));

	return { table: el('table', el('thead', head), body), body };
};

/** A line, and under it the SQL it is about, folded until asked for. The leading column holds the
 * control that unfolds it, as every grid's holds the one that opens a record; the whole line answers
 * a click too, since it has nothing else to do with one. The control is a button, so the keyboard
 * gets there and Enter on it is a click that reaches the line like any other.
 * @param unfolded the keys of the lines open now, kept up to date, so reading the list again does
 * not fold them back
 * @param cells the line's own, after the leading column */
export const foldingLine = (unfolded: Set<string>, key: string, cells: HTMLElement[], sql: string): HTMLTableRowElement[] => {
	const control = classed('button', 'fold');
	const line = classed('tr', 'monitor-action', lead('td', control), ...cells);
	const code = classed('td', 'monitor-code', classed('pre', 'monitor-sql', sql));
	// The fold keeps the leading column, marked as the open line's is, so the column runs on
	// unbroken and the SQL sits under the cells it belongs to rather than across the handle.
	const fold = classed('tr', 'monitor-fold open', lead('td'), code);

	control.type = 'button';
	control.title = 'Ver el SQL';
	control.setAttribute('aria-label', 'Ver el SQL');
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

/** A list's address, with whatever its filter bar asks, and anything else it is asked with. */
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

	// One bar per list, each on the columns `_meta` describes that list by. Not in the address: both
	// lists have an `at` and a `screen`, and the address has one place to say each.
	const userBar = filterBar([meta.users], operators, () => { drawn = ''; void ask(); });
	const actionBar = filterBar([meta.actions], operators, () => { if (picked !== null) void readActions(picked); });

	userBar.reset(meta.users);
	actionBar.reset(meta.actions);
	userBar.element.hidden = true;			// shown with the monitor

	// The actions are drawn the way the record panel draws its subtables: a raised region with its
	// heading, a strip (the filter bar, where a subtable has its tabs), and the grid's own `.sheet`.
	box.replaceChildren(users.table);
	byId('watch-body').replaceChildren(
		part(tabsHeading, tabList, noTabs),
		classed('section', 'watch-log', actionsHeading,
			classed('div', 'watch-strip', actionBar.element),
			classed('div', 'sheet', actions.table, noActions)));

	byId('watch-close').addEventListener('click', close);
	addEventListener('keydown', e => { if (e.key === 'Escape' && !panel.hidden) close(); });

	let picked: string | null = null;

	/** The picked user's newest action, as the list said it last, and as it said it when their
	 * actions were last read: a round in which the two agree has nothing new to read. Compared on
	 * the list's word rather than on the newest action drawn, since with a filter on, those can
	 * differ for good. */
	let newest: string | undefined;
	let readAt: string | undefined;

	/** Which actions are unfolded, so that reading the list again does not fold them back. */
	const unfolded = new Set<string>();

	/** A list that answered has nothing wrong with its filter any more. */
	const answered = (bar: FilterBar) => status.standing(bar, []);

	/** A list that did not answer: a filter it cannot ask stays listed until it is changed, a
	 * session that ended reloads, and anything else says nothing — the next round tries again.
	 * @param table where the problem is, when it is not the screen's own list: as a subtable says it */
	const refused = (bar: FilterBar, err: unknown, table?: string) => {
		if (sessionEnded(err)) location.reload();
		else if (err instanceof ApiError && err.status === 400) status.standing(bar, [{ what: err.message, table }]);
	};

	/** The control that opens a user's panel: the expand mark every grid's lines carry, as a link,
	 * since what it opens is an address. */
	const opener = (user: string) => {
		const a = classed('a', 'handle');

		a.href = hrefOf(user);
		a.title = `Ver a ${user}`;
		a.setAttribute('aria-label', `Ver a ${user}`);

		return a;
	};

	const userLine = (one: Online): HTMLTableRowElement => {
		const line = el('tr', lead('td', opener(one.user)), el('td', one.user), el('td', one.role),
			el('td', one.last === null ? '' : when(one.last.at)), el('td', one.last?.screen ?? ''));

		line.classList.toggle('open', one.user === picked);

		return line;
	};

	/** An action, and under it the SQL it ran. */
	const actionLines = (user: string) => (a: Activity): HTMLTableRowElement[] => {
		const request = classed('span', 'monitor-request', readable(a.request));

		request.title = readable(a.request);

		return foldingLine(unfolded, `${user} ${a.at}`,
			[el('td', when(a.at)), el('td', a.screen ?? ''), el('td', request)], a.statements);
	};

	const drawTabs = (tabs: Viewer[]) => {
		tabList.replaceChildren(...tabs.map(tabChip));
		tabList.hidden = !tabs.length;
		noTabs.hidden = tabs.length > 0;
	};

	/** Reads the picked user's actions again, under the panel's filter, and draws them — unless the
	 * pick moved meanwhile. */
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

	/** The panel as it opens on a user, before anything about them has arrived. */
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

	/** What was drawn last, so that a round that says the same thing redraws nothing. */
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

		// The actions are read again only when the picked user has done something since: their
		// newest action is in the list already, so this costs no request of its own.
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
				drawn = '';					// the list lights the pick, so it is drawn again
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
			status.standing(userBar, []);			// what is wrong with the monitor is not wrong elsewhere
			status.standing(actionBar, []);
		},
	};
}
