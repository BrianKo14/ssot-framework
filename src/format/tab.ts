// Tab-separated text.

import { generateTab } from 'tab-plus';
import { type Format, headings, rowFields, type Sheet, textStream } from './format.js';

export const tab: Format = {
	label: 'Texto',
	contentType: 'text/plain; charset=utf-8',
	extension: 'txt',
	render: (sheet: Sheet) => textStream(generateTab({
		fields: headings(sheet.columns),
		rows: sheet.rows.map(row => rowFields(sheet.columns, row)),
	})),
};
