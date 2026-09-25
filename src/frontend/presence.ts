// The screen says where it is, and asks who else is there (SCOPE 6d).

import type { Viewer, Watching } from '../shared/api.js';
import { api } from './api.js';
import { sessionEnded } from './auth.js';
import { watchPath } from './query.js';

/** Where this tab is: a screen, and the record its cursor is on. */
interface Where {
	entity: string;
	record: string[];
}

export interface Watch {
	/** Says where this tab is now, and asks at once rather than waiting for the next round —
	 * a screen that has just been opened should not look empty for a poll.
	 * @param entity null when there is no screen; then nothing is announced at all. */
	at(entity: string | null, record: string[]): void;
}

/** @param seconds what `_meta` published, which is also what the server counts a tab present
 * within — one number, so the two cannot drift.
 * @param drawn called with the others every time an answer comes back. */
export function watching(seconds: number, drawn: (viewers: Viewer[]) => void): Watch {
	/** Minted by the server on the first ask. It lives in this closure and nowhere else: a tab
	 * is what it counts, and a tab is exactly as long-lived as this page. */
	let tab: string | null = null;
	let where: Where | null = null;
	let asking = false;

	const ask = async (): Promise<void> => {
		// A tab nobody is looking at is not watching anything, and says so by going quiet: the
		// server stops counting it a few polls later, without being told.
		if (asking || where === null || document.hidden) return;

		const asked = where;

		asking = true;

		try {
			const seen = await api<Watching>(watchPath(asked.entity, asked.record, tab));

			tab = seen.tab;

			if (where === asked) drawn(seen.viewers);	// a screen that has moved on draws its own answer
		} catch (err) {
			// A poll that fails says nothing and the next one tries again — it must never be what
			// takes a screen down. A session that ended is the one thing worth acting on.
			if (sessionEnded(err)) location.reload();
		} finally {
			asking = false;
		}
	};

	setInterval(() => void ask(), seconds * 1000);
	addEventListener('visibilitychange', () => void ask());		// back in view: say so now, not in a few seconds

	return {
		at(entity, record) {
			where = entity === null ? null : { entity, record };

			if (entity === null) drawn([]);
			else void ask();
		},
	};
}
