// Saving the list as a file.
//
// There is no export endpoint: the file is the same list request, asked in another
// format. Where it lands is the browser's setting.

import { el } from '../kit/dom.js';
import { fetched } from './api.js';

/** The file name from `Content-Disposition`, so the server names it. */
const named = (res: Response): string | undefined =>
	/filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1];

/**
 * @param path the list's address, with `?format=` on it
 * @param fallback the file name if the response gives none
 */
export async function download(path: string, fallback: string): Promise<void> {
	const res = await fetched(path);
	const url = URL.createObjectURL(await res.blob());
	const a = el('a');

	a.href = url;
	a.download = named(res) ?? fallback;
	a.hidden = true;

	// some browsers ignore a click on a link outside the document
	document.body.append(a);
	a.click();
	a.remove();

	setTimeout(() => { URL.revokeObjectURL(url); });	// after the click is taken; earlier cancels the save
}
