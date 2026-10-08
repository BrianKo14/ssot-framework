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

/** The grid's sticky leading column.

    How many controls it was given is written on the cell, because the mark a cursor leaves has to
    find the first of them and only this cell knows how many there are. It is counted off the
    children rather than declared, so it follows what `Sheet.handle` (`main.ts`) gave it and no sheet is asked
    a second time which one it is. */
export const lead = (tag: 'th' | 'td', ...children: Node[]) => {
	const node = el(tag, ...children);

	node.className = 'lead';
	node.style.setProperty('--slots', String(children.length));

	return node;
};
