// A block of cells, as a spreadsheet puts it on the clipboard and back (SCOPE 6h).
//
// We only read `text/plain`: tab-separated, and written the same way by Excel, Google Sheets
// and LibreOffice.
//   - cells split by TAB, every row ends in CRLF (the last one too);
//   - a cell is quoted only if it holds a TAB, CR or LF, and quotes inside it are doubled.
// We also write `text/html`, because it can mark a cell as text, so Excel doesn't guess its
// type in the reader's locale (`007` -> 7).
//
// Sources (read, not tested against a real Excel):
//   https://learn.microsoft.com/en-us/windows/win32/dataxchg/html-clipboard-format
//   https://docs.sheetjs.com/docs/demos/local/clipboard
//   https://learn.microsoft.com/en-us/answers/questions/5052307/why-is-excel-adding-quotes-when-i-copy-a-cell-with
// `tab-plus` (the text export's library) and `xlsx-now` (workbooks) don't write this format.

/** A block of cells, row by row. */
export type Grid = string[][];

const TAB = '\t';
const ROW_END = '\r\n';

/** What forces a cell to be quoted. Excel doesn't quote a lone `"`; we do, it reads back the same. */
const SPECIAL = /[\t\r\n"]/;

const quoted = (cell: string) => (SPECIAL.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell);

/** The block as tab-separated text, the way Excel writes it. */
export const tsv = (grid: Grid): string => grid.map(row => row.map(quoted).join(TAB) + ROW_END).join('');

/** Where a quoted cell ends: the quote followed by a TAB, a line break or the end, skipping
 * doubled ones. `-1` if none: the cell only *starts* with a quote (`"hola" dijo`), so it's bare. */
const closing = (text: string, from: number): number => {
	for (let i = from; i < text.length; i++) {
		if (text[i] !== '"') continue;
		if (text[i + 1] === '"') { i++; continue; }

		return /^(?:[\t\r\n]|$)/.test(text.slice(i + 1, i + 2)) ? i : -1;
	}

	return -1;
};

/** Tab-separated text back into a block. A line break is CRLF, LF or a lone CR. */
export const cells = (text: string): Grid => {
	if (text === '') return [];

	const grid: Grid = [];
	let row: string[] = [];
	let i = 0;

	while (i <= text.length) {
		const end = text[i] === '"' ? closing(text, i + 1) : -1;
		let cell: string;

		if (end >= 0) {
			cell = text.slice(i + 1, end).replaceAll('""', '"');
			i = end + 1;
		} else {
			const stop = text.slice(i).search(/[\t\r\n]/);

			cell = stop < 0 ? text.slice(i) : text.slice(i, i + stop);
			i = stop < 0 ? text.length : i + stop;
		}

		row.push(cell);

		if (text[i] === TAB) { i++; continue; }

		grid.push(row);
		row = [];

		if (i >= text.length) break;

		i += text.startsWith(ROW_END, i) ? 2 : 1;

		if (i >= text.length) break;	// the break after the last row
	}

	return grid;
};

/** Excel's "this cell is text" (number format `@`). Set with `setAttribute`: `style.setProperty`
 * drops properties the browser doesn't know. */
const AS_TEXT = "mso-number-format:'\\@'";

/** Keeps a line break inside its cell instead of starting a new row. */
const SAME_CELL = 'mso-data-placement:same-cell';

const htmlCell = (text: string) => {
	const td = document.createElement('td');

	td.setAttribute('style', AS_TEXT);

	text.split(/\r\n|\r|\n/).forEach((line, i) => {
		if (i > 0) {
			const br = document.createElement('br');

			br.setAttribute('style', SAME_CELL);
			td.append(br);
		}

		td.append(line);
	});

	return td;
};

/** The block as an HTML table, every cell marked as text.
 * Built with the DOM, not strings, so the browser does the escaping (Requisito 2). */
export const table = (grid: Grid): string => {
	const node = document.createElement('table');

	for (const row of grid) node.insertRow().append(...row.map(htmlCell));

	return node.outerHTML;
};
