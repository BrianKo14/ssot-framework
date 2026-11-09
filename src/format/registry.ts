// Formats for the API to hand back a file + metadata about them.
// Essentially a lookup table for the `?format=` parameter.

import { HttpError, located } from '../errors.js';
import type { FormatMeta } from '../shared/api.js';
import type { Format, Parsed, Reading } from './format.js';
import { json } from './json.js';
import { tab } from './tab.js';
import { xlsx } from './xlsx.js';

export type { Format, Parsed, Reading, Sheet } from './format.js';

/** The registry of available formats. */
const formats: ReadonlyMap<string, Format> = new Map<string, Format>([
	['json', json],
	['xlsx', xlsx],
	['txt', tab],
]);

const DEFAULT_FORMAT: Format = json;

/** Raw format parameter -> Resolved format. */
export function formatNamed(raw: unknown): Format {
	if (raw === undefined) return DEFAULT_FORMAT;
	if (typeof raw !== 'string') throw new HttpError(400, 'format must be given once');

	const format = formats.get(raw);

	if (!format) throw new HttpError(400, `unknown format: ${raw}; try ${[...formats.keys()].join(', ')}`);

	return format;
}

/** Raw format parameter -> Resolved format. */
export function formatReading(raw: unknown): Reading {
	const format = formatNamed(raw);

	if (!format.read) throw new HttpError(400, `${String(raw)} cannot be imported; try ${
		[...formats].filter(([, f]) => f.read).map(([name]) => name).join(', ')}`);

	return format as Reading;
}

/** A file's rows, as `format` reads them. */
export function fileRows(format: Reading, name: string, text: string): Parsed {
	try { return format.read(text); } catch (err) { throw located(`${name}, `, err); }
}

export const formatMeta: FormatMeta[] = [...formats].flatMap(([name, f]) =>
	f.extension === undefined ? [] : [{ name, label: f.label, extension: f.extension, imports: f.read !== undefined }]);
