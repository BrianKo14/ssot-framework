// What the screen says about itself — the pill in the header — and what is wrong on it.
//
// The pill holds one line and is read at a glance, so it only ever says one thing: the counts,
// or what was just done. A problem takes it over for a moment, in red, as it happens, and then
// gives it back. What is wrong *now* is listed beside it, under a warning mark, for exactly as
// long as it is true: each part of the screen says what is wrong with it, and says so again —
// with less, or with nothing — when that changes. Nothing is listed because it once happened.

import { classed } from './dom.js';

/** How long a problem holds the pill before it goes back to what it was saying. */
const SHOWN_MS = 4000;

/** One thing that is wrong, and where — so the list can say *where* once, in its own place, and
    fold the same problem on several lines into one entry. */
export interface Problem {
	/** What is wrong, as the server or the screen worded it. */
	what: string;
	/** What it is about beyond the screen's own table: a subtable's name, a record in the panel. */
	table?: string;
	/** The line on screen, counted from one, when it is about one. */
	line?: number;
	/** The column, when it is about one. */
	field?: string;
}

export interface Status {
	/** Says what stays said: the counts, or what was just done. Said while a problem is holding
	 * the pill, it is what the pill goes back to — a problem is not cut short by the summary that
	 * follows it. */
	say(message: string): void;
	/** Says what is in flight, with a spinner. It does take the pill from a problem: something
	 * new has started. */
	busy(message: string): void;
	/** Problems that just appeared: the pill shows the one — or that there are several — for a
	 * moment. Whether they are listed is `standing`'s to say: a problem is listed while it is one. */
	fail(...problems: (Problem | string)[]): void;
	/** What is wrong about one part of the screen (a sheet, an editor, the panel), replacing what
	 * that part said before. Said with nothing, it is that part having nothing wrong any more. */
	standing(of: object, problems: Problem[]): void;
}

const problem = (p: Problem | string): Problem => (typeof p === 'string' ? { what: p } : p);

/** "Fila 3", "Filas 1, 2, 3", "Filas 1, 2, 3, 4 y 6 más". */
const linesOf = (lines: number[]) => {
	const shown = lines.slice(0, 4).join(', ');
	const more = lines.length - 4;

	return lines.length === 1 ? `Fila ${shown}` : `Filas ${shown}${more > 0 ? ` y ${more} más` : ''}`;
};

/** Where a problem is, as its entry's first line: table, lines, column — whichever it has. */
const whereOf = (p: Problem, lines: number[]) =>
	[p.table, lines.length ? linesOf(lines) : undefined, p.field].filter(Boolean).join(' · ');

/** The same problem on several lines is one entry: same table, same column, same words. */
interface Entry {
	problem: Problem;
	lines: number[];
}

const entries = (problems: Problem[]): Entry[] => {
	const byKey = new Map<string, Entry>();

	for (const p of problems) {
		const key = JSON.stringify([p.table, p.field, p.what]);
		const entry = byKey.get(key) ?? { problem: p, lines: [] };

		if (p.line !== undefined && !entry.lines.includes(p.line)) entry.lines.push(p.line);

		byKey.set(key, entry);
	}

	// by where they are on screen, so the list reads down the way the grid does
	return [...byKey.values()]
		.map(e => ({ ...e, lines: e.lines.sort((a, b) => a - b) }))
		.sort((a, b) => (a.lines[0] ?? 0) - (b.lines[0] ?? 0));
};

const item = ({ problem: p, lines }: Entry) =>
	classed('li', 'issue',
		classed('div', 'issue-where', whereOf(p, lines) || 'Pantalla'),
		classed('div', 'issue-what', p.what));

/** @param pill the header's status line; the warning mark is placed just before it. */
export function statusOf(pill: HTMLElement): Status {
	let resting = pill.textContent ?? '';
	let timer: ReturnType<typeof setTimeout> | undefined;
	const standing = new Map<object, Problem[]>();

	const mark = classed('button', 'issues-mark');
	const list = classed('ul', 'issues-list');
	const box = classed('div', 'issues', mark, list);

	mark.type = 'button';
	box.hidden = true;
	pill.before(box);

	const show = (text: string, state: 'ready' | 'busy' | 'error') => {
		pill.textContent = text;
		pill.title = text;			// the pill cuts a long line short; this is all of it
		pill.dataset.state = state;
	};

	const settle = () => {
		clearTimeout(timer);
		timer = undefined;
	};

	const draw = () => {
		const shown = entries([...standing.values()].flat());

		box.hidden = shown.length === 0;
		mark.textContent = String(shown.length);
		mark.setAttribute('aria-label', `${shown.length} ${shown.length === 1 ? 'problema' : 'problemas'}`);
		list.replaceChildren(...shown.map(item));
	};

	return {
		say(message) {
			resting = message;

			if (timer === undefined) show(message, 'ready');
		},
		busy(message) {
			settle();
			show(message, 'busy');
		},
		fail(...problems) {
			if (!problems.length) return;

			const one = problem(problems[0]);
			const where = whereOf(one, one.line === undefined ? [] : [one.line]);

			settle();
			show(problems.length === 1 ? (where ? `${where}: ${one.what}` : one.what) : 'Varios errores', 'error');
			timer = setTimeout(() => { timer = undefined; show(resting, 'ready'); }, SHOWN_MS);
		},
		standing(of, problems) {
			if (problems.length) standing.set(of, problems);
			else standing.delete(of);

			draw();
		},
	};
}
