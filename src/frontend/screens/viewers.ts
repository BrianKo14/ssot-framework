// Who else is here (SCOPE 6c, 6d), and the rail of screens on the left.
//
// Each tab gets one colour, used three times: a circle beside the counts, an outline on the line
// its cursor is on, and a circle beside its screen in the rail.

import type { TableMeta, Viewer } from '../../shared/api.js';
import { byId, classed, el } from '../kit/dom.js';
import { type Router, screenOf } from '../model/route.js';

/** What the screen shows, as far as viewers go. They can differ mid-draw: the screen changes
 * before its grid has loaded. */
export interface Where {
	entity?: string;
	grid?: TableMeta;
}

export interface Viewers {
	/** The header's circles. */
	readonly element: HTMLElement;
	/** Takes a poll's answer and draws it.
	 * @returns the records somebody's cursor left since the last answer */
	show(viewers: Viewer[]): string[];
	/** Draws the last answer again, e.g. on lines just drawn. */
	draw(): void;
	/** A table's line in the rail, with its circles. */
	link(t: TableMeta): HTMLAnchorElement;
}

export interface ViewersOptions {
	route: Router;
	/** The grid's header row and body. */
	head: HTMLElement;
	rows: HTMLElement;
	/** Writes a line's latch, which the same answer is about. */
	relatch(tr: HTMLElement, t: TableMeta): void;
	where(): Where;
}

/** How many colours the stylesheet has. */
const COLOURS = 8;

const hashed = (s: string) => [...s].reduce((n, ch) => (n * 31 + ch.charCodeAt(0)) >>> 0, 0);

/** A colour per tab, all different (up to eight, then they share).
 * Each tab asks for the colour its name hashes to, so it doesn't change as others come and go,
 * and takes the next free one if that's taken. Sorted, so the same set always gets the same. */
const coloured = (viewers: Viewer[]): Map<string, number> => {
	const taken = new Set<number>();
	const colours = new Map<string, number>();

	for (const { id } of [...viewers].sort((a, b) => a.id.localeCompare(b.id))) {
		let slot = hashed(id) % COLOURS;

		while (taken.size < COLOURS && taken.has(slot)) slot = (slot + 1) % COLOURS;

		taken.add(slot);
		colours.set(id, slot);
	}

	return colours;
};

/** A box of circles, one per tab. Circles still wanted are kept, not rebuilt, so they don't
 * blink every poll (nor the name showing under the pointer). */
const stackOf = (box: HTMLElement) => {
	const kept = new Map<string, HTMLElement>();

	return (viewers: Viewer[], colours: Map<string, number>) => {
		box.hidden = viewers.length === 0;

		for (const [id, dot] of kept)
			if (!viewers.some(v => v.id === id)) { dot.remove(); kept.delete(id); }

		viewers.forEach((v, i) => {
			// one circle per tab: the same user in two tabs is two circles
			const dot = kept.get(v.id) ?? classed('span', 'viewer', v.user.slice(0, 1));

			dot.dataset.colour = String(colours.get(v.id));
			dot.dataset.name = v.user;		// who; *where* is the outlined line
			dot.setAttribute('aria-label', v.user);
			dot.tabIndex = 0;			// so the name can be reached without a pointer

			kept.set(v.id, dot);

			// only if it moved: re-appending a child restarts its fade and drops the hover
			const there = box.children[i];

			if (there !== dot) box.insertBefore(dot, there ?? null);
		});
	};
};

export function viewersOf({ route, head, rows, relatch, where }: ViewersOptions): Viewers {
	const element = classed('div', 'watchers');
	const inHeader = stackOf(element);

	/** One stack per screen in the rail. */
	const rails = new Map<string, ReturnType<typeof stackOf>>();

	/** The others, as the last poll answered. Kept because the grid redraws more often. */
	let seen: Viewer[] = [];

	/** The records somebody's cursor is on, on this screen. */
	const holdings = (viewers: Viewer[]): Set<string> =>
		new Set(viewers.flatMap(v => v.entity === where().entity ? v.records : []));

	const draw = () => {
		const { entity, grid } = where();
		const colours = coloured(seen);			// across every screen: one colour per tab everywhere
		const here = seen.filter(v => v.entity === entity);

		inHeader(here, colours);

		for (const [name, box] of rails)
			box(seen.filter(v => v.entity === name), colours);

		const cursors = new Map<string, Viewer[]>();

		for (const v of here)
			for (const at of v.records) cursors.set(at, [...cursors.get(at) ?? [], v]);

		for (const tr of rows.querySelectorAll<HTMLTableRowElement>('tr[data-at]')) {
			const who = cursors.get(String(tr.dataset.at)) ?? [];
			const mark = tr.querySelector<HTMLElement>('.watcher');

			if (grid) relatch(tr, grid);

			tr.classList.toggle('watched', who.length > 0);

			if (!who.length) {
				mark?.remove();
				delete tr.dataset.colour;
				continue;
			}

			// the line takes the first one's colour; its mark says how many when several
			tr.dataset.colour = String(colours.get(who[0].id));

			// one letter in the narrow leading column: an initial, or a count. Kept, not
			// rebuilt, so a fade under the pointer doesn't restart.
			const letter = who.length === 1 ? who[0].user.slice(0, 1) : String(who.length);

			if (mark) mark.textContent = letter;
			else tr.querySelector('.lead')?.append(classed('span', 'watcher', letter));
		}

		// Grid lines are each cell's bottom border, so a watched row's *top* edge belongs to the
		// line above it (or the header), which is told which colour to draw it in.
		const lines = [head, ...rows.children] as HTMLElement[];

		lines.forEach((above, i) => {
			const below = lines[i + 1];
			const edge = below?.classList.contains('watched') === true && !above.classList.contains('watched');

			above.classList.toggle('above-watched', edge);

			if (edge) above.dataset.colour = String(below.dataset.colour);
			else if (!above.classList.contains('watched')) delete above.dataset.colour;
		});
	};

	const show = (viewers: Viewer[]) => {
		const was = holdings(seen);

		seen = viewers;
		draw();

		const still = holdings(viewers);

		return [...was].filter(at => !still.has(at));
	};

	/** The name is what gets cut short when the rail is narrow, not the circles. */
	const link = (t: TableMeta) => {
		const box = classed('span', 'watchers');
		const a = el('a', classed('span', 'name', t.entity), box);

		a.href = route.href(screenOf(t.entity));
		a.dataset.entity = t.entity;
		rails.set(t.entity, stackOf(box));

		return a;
	};

	return { element, show, draw, link };
}



// --- The rail ---

/** A line for one of the framework's own screens, under its own heading. */
export const toolLink = (route: Router, name: string, label: string) => {
	const a = el('a', classed('span', 'name', label));

	a.href = route.href(screenOf(name));
	a.dataset.entity = name;

	return a;
};

/** Marks the rail's line for the screen being drawn, and only that one. */
export const current = (name: string) => {
	for (const a of [...byId('entities').querySelectorAll('a'), ...byId('tools').querySelectorAll('a')])
		a.setAttribute('aria-current', String(a.dataset.entity === name));
};
