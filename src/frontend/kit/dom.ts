// The helpers every screen is built from.

export const byId = (id: string): HTMLElement => {
	const node = document.getElementById(id);

	if (!node) throw new Error(`missing element #${id}`);

	return node;
};

/** An element builder. */
export const el = <K extends keyof HTMLElementTagNameMap>(tag: K, ...children: (string | Node)[]) => {
	const node = document.createElement(tag);
	node.append(...children);
	return node;
};

/** An element with a class. */
export const classed = <K extends keyof HTMLElementTagNameMap>(
	tag: K, className: string, ...children: (string | Node)[]
) => {
	const node = el(tag, ...children);
	node.className = className;
	return node;
};

/** A plain (non-submit) button.
 * @param label its tooltip and accessible name, for a button drawn as an icon */
export const button = (className: string, label?: string) => {
	const node = classed('button', className);

	node.type = 'button';

	if (label !== undefined) {
		node.title = label;
		node.setAttribute('aria-label', label);
	}

	return node;
};

/** The grid's sticky leading column.
 * `--slots` counts its controls, so the stylesheet can place a cursor's mark after them. */
export const lead = (tag: 'th' | 'td', ...children: Node[]) => {
	const node = el(tag, ...children);

	node.className = 'lead';
	node.style.setProperty('--slots', String(children.length));

	return node;
};
