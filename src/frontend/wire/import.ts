// Sending a file of rows to the table: the inverse of saving the list as a file.
//
// There is no import endpoint either: the file is a POST to the list, in a format.

import type { Imported } from '../../shared/api.js';
import { el } from '../kit/dom.js';
import { api } from './api.js';

/** Asks for one file with the browser's own picker.
 * @param extension the one it offers, e.g. `txt`
 * @returns the file, or null if the picker was dismissed */
export function chosenFile(extension: string): Promise<File | null> {
	const input = el('input');

	input.type = 'file';
	input.accept = `.${extension}`;

	return new Promise(resolve => {
		input.addEventListener('change', () => { resolve(input.files?.[0] ?? null); });
		input.addEventListener('cancel', () => { resolve(null); });
		input.click();
	});
}

/** @param path the list's address, with `?format=` on it */
export const upload = async (path: string, file: File): Promise<Imported> =>
	api<Imported>(path, {
		method: 'POST',
		headers: { 'content-type': 'text/plain; charset=utf-8' },
		body: await file.text(),
	});
