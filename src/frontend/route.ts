// The address bar (URL grammar)

import type { ColumnMeta, OperatorMeta, SystemMeta, TableMeta } from '../shared/api.js';


/** One committed filter condition. */
export interface Condition {
	column: ColumnMeta;
	operator: OperatorMeta;
	value: string | null;
}

/** What is on screen, per the address. */
export interface View {
	/** `''` when the address names no screen. */
	screen: string;
	/** The open record's pk values, in order; empty when no record is open. */
	key: string[];
	conditions: Condition[];
}

export interface Reading {
	view: View;
	/** Query params that named no known column or operator. */
	unresolved: string[];
}

export interface Router {
	read(): Reading;
	href(view: View): string;
	go(view: View, replace?: boolean): void;
	/** Updates the address without redrawing — for moves the screen already reflects. */
	mark(view: View, replace?: boolean): void;
	onNavigate(draw: () => void): void;
}

/** Separates a column from the comparison asked of it: `edad.ge=30`. */
const OP = '.';

export const operand = (o: OperatorMeta, raw: string): string | null =>
	o.takesValue && raw.trim() !== '' ? raw : null;

const decoded = (raw: string): string => {
	try { return decodeURIComponent(raw); } catch { return raw; }
};

export const same = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i]);


// --- The router ---

export function router(meta: SystemMeta): Router {
	const operator = (name: string) => meta.operators.find(o => o.name === name);
	const fallback = operator(meta.defaultOperator);

	const condition = (t: TableMeta, key: string, raw: string): Condition | undefined => {
		const whole = t.columns.find(c => c.name === key);

		if (whole && fallback) return { column: whole, operator: fallback, value: operand(fallback, raw) };

		const cut = key.lastIndexOf(OP);

		if (cut < 0) return undefined;

		const column = t.columns.find(c => c.name === key.slice(0, cut));
		const asked = operator(key.slice(cut + 1));

		return column && asked ? { column, operator: asked, value: operand(asked, raw) } : undefined;
	};

	const read = (): Reading => {
		const [screen = '', ...key] = location.pathname.split('/').filter(s => s !== '').map(decoded);
		const t = meta.tables.find(x => x.table === screen);
		const conditions: Condition[] = [];
		const unresolved: string[] = [];

		if (t)
			for (const [name, raw] of new URLSearchParams(location.search)) {
				const one = condition(t, name, raw);

				if (one) conditions.push(one); else unresolved.push(name);
			}

		return { view: { screen, key, conditions }, unresolved };
	};

	const named = (c: Condition) =>
		c.operator.name === meta.defaultOperator ? c.column.name : c.column.name + OP + c.operator.name;

	const href = (view: View): string => {
		const params = new URLSearchParams();

		for (const c of view.conditions) params.append(named(c), c.value ?? '');

		const path = [view.screen, ...view.key].map(encodeURIComponent).join('/');
		const search = params.toString();

		return `/${path}${search ? `?${search}` : ''}`;
	};

	let draw: (() => void) | undefined;

	const mark = (view: View, replace = false) => {
		const url = href(view);
		const stay = replace || url === location.pathname + location.search;

		history[stay ? 'replaceState' : 'pushState'](null, '', url);	// only push when the address actually changes
	};

	const go = (view: View, replace = false) => { mark(view, replace); draw?.(); };

	const intercept = (e: MouseEvent) => {
		if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

		const a = e.target instanceof Element ? e.target.closest('a[href]') : null;

		if (!(a instanceof HTMLAnchorElement) || a.target || a.hasAttribute('download')) return;
		if (a.origin !== location.origin) return;

		e.preventDefault();

		if (a.pathname !== location.pathname || a.search !== location.search) {
			history.pushState(null, '', a.pathname + a.search);
			draw?.();
		}
	};

	const onNavigate = (redraw: () => void) => {
		draw = redraw;

		addEventListener('popstate', redraw);
		document.addEventListener('click', intercept);
	};

	return { read, href, go, mark, onNavigate };
}
