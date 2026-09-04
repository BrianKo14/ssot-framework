// Saving the list as a file.
//
// There is no separate export endpoint: the list on screen and the file are the same request,
// under the same filter and the same permission, asked for in another format (see SCOPE 1c).
// So this only takes the address the screen already reads from and hands the answer to the
// browser. Where the file lands — a folder it always uses, or a "save as" dialog — is the
// browser's own setting; the page neither knows nor chooses it.

import { fetched } from './api.js';
import { el } from './dom.js';

/** The file name out of `Content-Disposition`, so the server stays the one that names it. */
const named = (res: Response): string | undefined =>
	/filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1];

/**
 * @param path the list's address, with `?format=` on it
 * @param fallback what to call the file if the response did not
 */
export async function download(path: string, fallback: string): Promise<void> {
	const res = await fetched(path);
	const url = URL.createObjectURL(await res.blob());
	const a = el('a');

	a.href = url;
	a.download = named(res) ?? fallback;
	a.hidden = true;

	// in the document, then out: a detached link's click is ignored by some browsers
	document.body.append(a);
	a.click();
	a.remove();

	// after the click has been taken, not during it — revoking too early cancels the save
	setTimeout(() => { URL.revokeObjectURL(url); });
}
