// The status pill in the header, and the list of what is wrong on screen.
//
// The pill says one thing: the counts, or what was just done. A new problem takes it over for a
// few seconds, in red. What is wrong *now* is listed beside it, for as long as it stays true.

import { classed } from './dom.js';

/** How long a problem holds the pill. */
const SHOWN_MS = 4000;

/** One thing that is wrong, and where. */
export interface Problem {
	what: string;
	/** Beyond the screen's own table: a subtable's name, a record in the panel. */
	table?: string;
	/** The line on screen, counted from one. */
	line?: number;
	field?: string;
}

export interface Status {
	/** What stays said: the counts, or what was just done. If a problem is showing, the pill
	 * goes back to this once it's over. */
	say(message: string): void;
	/** What is in flight, with a spinner. */
	busy(message: string): void;
	/** Problems that just happened: shown on the pill for a moment, not listed. */
	fail(...problems: (Problem | string)[]): void;
	/** What is wrong with one part of the screen (a sheet, an editor, the panel), replacing what
	 * that part said before. Empty means nothing is wrong with it anymore. */
	standing(of: object, problems: Problem[]): void;
}

const problem = (p: Problem | string): Problem => (typeof p === 'string' ? { what: p } : p);

/** e.g. "Fila 3", "Filas 1, 2, 3", "Filas 1, 2, 3, 4 y 6 más". */
const linesOf = (lines: number[]) => {
	const shown = lines.slice(0, 4).join(', ');
	const more = lines.length - 4;

	return lines.length === 1 ? `Fila ${shown}` : `Filas ${shown}${more > 0 ? ` y ${more} más` : ''}`;
};

/** e.g. "linea · Filas 1, 2 · cantidad" */
const whereOf = (p: Problem, lines: number[]) =>
	[p.table, lines.length ? linesOf(lines) : undefined, p.field].filter(Boolean).join(' · ');

/** The same problem on several lines (same table, column and words) is one entry. */
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

	// in screen order, top to bottom
	return [...byKey.values()]
		.map(e => ({ ...e, lines: e.lines.sort((a, b) => a - b) }))
		.sort((a, b) => (a.lines[0] ?? 0) - (b.lines[0] ?? 0));
};

const item = ({ problem: p, lines }: Entry) =>
	classed('li', 'issue',
		classed('div', 'issue-where', whereOf(p, lines) || 'Pantalla'),
		classed('div', 'issue-what', p.what));

/** @param pill the header's status line; the warning mark goes just before it. */
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
		pill.title = text;			// the pill cuts long lines short
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
