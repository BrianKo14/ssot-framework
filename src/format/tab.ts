// Tab-separated text.

import { generateTab, parseTab } from 'tab-plus';
import { HttpError } from '../errors.js';
import { headings, type Parsed, type Reading, rowFields, type Sheet, textStream } from './format.js';

/** A field with nothing in it.
 * (An explicit null is written `\N`, and an empty string `\E`.) */
const OMITTED = Symbol('omitted');

/** The rows of a .tab text, paired with its header.
 * Reads plain rows rather than tab-plus's object rows, which drop a field beyond the header silently. */
function read(text: string): Parsed {
	const { fields, rows } = parseTab(text, { emptyField: OMITTED });

	const names = fields.map(name => {
		if (typeof name !== 'string' || !name) throw new HttpError(400, 'header: a column has no name');
		return name;
	});

	const repeated = names.find((name, i) => names.indexOf(name) !== i);

	if (repeated !== undefined) throw new HttpError(400, `header: names "${repeated}" twice`);

	return {
		names,
		rows: rows.map((row, i) => {
			if (row.length > names.length)
				throw new HttpError(400, `row ${i + 1}: ${row.length} fields, but the header names ${names.length}`);

			// A row shorter than the header leaves its last columns empty, as if they were written so
			return Object.fromEntries(names.flatMap((name, j) =>
				row[j] === undefined || row[j] === OMITTED ? [] : [[name, row[j]]]));
		}),
	};
}

export const tab: Reading = {
	label: 'Texto',
	contentType: 'text/plain; charset=utf-8',
	extension: 'txt',
	render: (sheet: Sheet) => textStream(generateTab({
		fields: headings(sheet.columns),
		rows: sheet.rows.map(row => rowFields(sheet.columns, row)),
	})),
	read,
};
