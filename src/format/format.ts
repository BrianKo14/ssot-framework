// Defines the interface for a format

import type { CellValue } from '../types/handler.js';
import type { ColumnInfo } from '../schema/model.js';

export type { CellValue };


/** Plain description of a table to be exported. */
export interface Sheet {
	name: string;
	columns: ColumnInfo[];
	/** The primary key's column names. */
	pk: string[];
	/** Keyed by column name, holding wire values. */
	rows: Record<string, unknown>[];
}

export interface Format {
	/** The human-readable name of the format, for menus and such. */
	readonly label: string;
	/** The MIME type of the format, for HTTP headers and the like. */
	readonly contentType: string;
	/** If present, it downloads with this extension. If absent, the format is shown inline. */
	readonly extension?: string;

	render(sheet: Sheet): ReadableStream<Uint8Array>;
}



// --- Value -> something writable in a cell ---

/** Make sure that a value is written as a cell value. */
function written(c: ColumnInfo, value: object): CellValue {
	if (!c.type.cell)
		throw new Error(`${c.name} holds an object; type "${c.typeName}" must say how it is written (cell)`);

	return c.type.cell(value);
}

/** Converts a wire value to a cell value. */
export function cellValue(c: ColumnInfo, value: unknown): CellValue {
	if (value === null || value === undefined) return null;

	return c.type.cell ? c.type.cell(value) : value as CellValue;
}

/** Converts a wire value to a text representation.
 * A value a cell holds outright is already written; anything else is what its type made of it. */
export function fieldText(c: ColumnInfo, value: unknown): string | null {
	if (value === null || value === undefined) return null;

	return String(typeof value === 'object' ? written(c, value) : value);
}

/** Converts a row of wire values to a row of cell values. */
export const rowCells = (columns: ColumnInfo[], row: Record<string, unknown>): CellValue[] =>
	columns.map(c => cellValue(c, row[c.name]));

/** Converts a row of wire values to a row of text representations. */
export const rowFields = (columns: ColumnInfo[], row: Record<string, unknown>): (string | null)[] =>
	columns.map(c => fieldText(c, row[c.name]));

export const headings = (columns: ColumnInfo[]): string[] => columns.map(c => c.name);

export function textStream(text: string): ReadableStream<Uint8Array> {
	const bytes = new TextEncoder().encode(text);

	return new ReadableStream({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		},
	});
}
