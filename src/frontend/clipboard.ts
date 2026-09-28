// A block of cells as a spreadsheet puts it on the clipboard, and back (SCOPE 6h).
//
// Excel writes about ten formats at once, but a page is only shown two: `text/plain` and
// `text/html`. The plain one is tab-separated text, and it is the one every spreadsheet writes
// the same way — Excel, Google Sheets and LibreOffice alike — so it is the only one read here:
//   - cells are split by TAB, and every row ends in CRLF, the last one included;
//   - a cell is wrapped in quotes only when it holds a TAB, a CR or an LF, and a quote inside a
//     wrapped cell is doubled. A cell holding a quote and nothing else special goes out bare.
// The HTML one is what Excel *prefers* when it pastes, and it is written here because it can say
// what the plain one cannot: that a cell is text, so Excel keeps it as sent instead of guessing
// its type in the reader's locale (`007` → 7, `8900.50` misread where the decimal mark is a comma).
//
// Sources, read rather than observed — there was no Excel to hand:
//   https://learn.microsoft.com/en-us/windows/win32/dataxchg/html-clipboard-format
//   https://docs.sheetjs.com/docs/demos/local/clipboard
//   https://learn.microsoft.com/en-us/answers/questions/5052307/why-is-excel-adding-quotes-when-i-copy-a-cell-with
// `tab-plus`, the text export's library, is a different format (pipes, backslash escapes), and
// `xlsx-now` writes workbooks, not clipboards — so neither is a connection this could go through.

/** A block of cells, row by row. */
export type Grid = string[][];

const TAB = '\t';
const ROW_END = '\r\n';

/** What makes a cell have to be quoted: something that would otherwise end it, or a quote that
    would otherwise start a quoted one. Excel leaves the last out; quoting it too costs nothing,
    because a quoted cell is read back the same by everybody. */
const SPECIAL = /[\t\r\n"]/;

const quoted = (cell: string) => (SPECIAL.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell);

/** The block as tab-separated text, the way Excel writes it. */
export const tsv = (grid: Grid): string => grid.map(row => row.map(quoted).join(TAB) + ROW_END).join('');

/** Where a quoted cell ends: at the quote that is followed by the end of the cell — a TAB, a line
    break or the end of the text — skipping doubled ones. `-1` when there is none, which is a cell
    that merely *starts* with a quote: Excel writes `"hola" dijo` bare, so it is read bare. */
const closing = (text: string, from: number): number => {
	for (let i = from; i < text.length; i++) {
		if (text[i] !== '"') continue;
		if (text[i + 1] === '"') { i++; continue; }

		return /^(?:[\t\r\n]|$)/.test(text.slice(i + 1, i + 2)) ? i : -1;
	}

	return -1;
};

/** Tab-separated text read back into a block. A line break is CRLF, LF or a lone CR, because each
    of them is some spreadsheet's; the empty line after the last row's break is not a row. */
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

		if (i >= text.length) break;	// the break that ends the last row
	}

	return grid;
};

/** Excel's own name for "this cell is text": its number format `@`, written the way its own
    clipboard writes it. Set with `setAttribute`, because `style.setProperty` drops a property the
    browser does not know. */
const AS_TEXT = "mso-number-format:'\\@'";

/** What keeps a line break inside its cell instead of starting a new row there. */
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

/** The block as an HTML table, every cell marked as text. Built with the DOM and not by joining
    strings: the escaping is then the browser's, the same stance the text export takes by leaving
    it to its library (Requisito 2). */
export const table = (grid: Grid): string => {
	const node = document.createElement('table');

	for (const row of grid) node.insertRow().append(...row.map(htmlCell));

	return node.outerHTML;
};
