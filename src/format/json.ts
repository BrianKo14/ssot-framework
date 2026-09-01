// The default representation: the rows as they are, what the API always answered with.

import { type Format, type Sheet, textStream } from './format.js';

export const json: Format = {
	label: 'JSON',
	contentType: 'application/json; charset=utf-8',
	// No extension: this one is read, not downloaded.
	render: (sheet: Sheet) => textStream(JSON.stringify(sheet.rows)),
};
