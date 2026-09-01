// A styled worksheet, aka Excel.

import { createXlsxStream } from 'xlsx-now';
import { type Format, rowCells, type Sheet } from './format.js';

export const xlsx: Format = {
	label: 'Excel',
	contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	extension: 'xlsx',

	render(sheet: Sheet) {
		const pk = new Set(sheet.pk);

		return createXlsxStream({
			sheetName: sheet.name,
			columns: sheet.columns.map(c => ({ name: c.name, key: c.name, pk: pk.has(c.name) })), // Marks pk columns
			rows: sheet.rows.map(row => rowCells(sheet.columns, row)),
			autoWidthMax: 60,
		});
	},
};
