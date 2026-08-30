// The two helpers every screen is built from.

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
