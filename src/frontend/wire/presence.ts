// The presence poll (SCOPE 6d): this tab says where it is, and asks who else is there.

import type { Lock, Viewer, Watching } from '../../shared/api.js';
import { same } from '../kit/text.js';
import { watchPath } from '../model/query.js';
import { api } from './api.js';
import { restarted } from './auth.js';

/** Where this tab is: a screen, the record with a cell open, and the one in its panel. */
interface Where {
	entity: string;
	record: string[];
	opened: string[];
}

export interface Watch {
	/** Says where this tab is now, and asks at once instead of waiting a round.
	 * @param entity `null` when on no table's screen; then nothing is announced */
	at(entity: string | null, record: string[], opened: string[]): void;
	/** Asks again at once, e.g. after taking or letting go of a claim. */
	now(): void;
	/** This tab's name, once the server has minted it. */
	tab(): string | null;
}

const alike = (a: Where | null, b: Where | null): boolean =>
	a === b || (a !== null && b !== null && a.entity === b.entity
		&& same(a.record, b.record) && same(a.opened, b.opened));

// The tab's name lives in `sessionStorage` so a reload is the same tab, not a new one (which
// left a ghost per refresh). It is not a credential: the server rewrites the row with the
// caller's own identity on every poll.
const KEPT = 'presence-tab';

const remembered = (): string | null => {
	try { return sessionStorage.getItem(KEPT); } catch { return null; }
};

const remember = (name: string): void => {
	try { sessionStorage.setItem(KEPT, name); } catch { /* private window, or storage refused */ }
};

/** @param seconds the poll period from `_meta`, also what the server counts a tab present within
 * @param drawn called with everybody else after every answer */
export function watching(seconds: number, drawn: (viewers: Viewer[], locks: Lock[]) => void): Watch {
	let tab: string | null = remembered();
	let where: Where | null = null;
	let asking = false;
	let again = false;

	const ask = async (): Promise<void> => {
		if (where === null) return;

		// one request at a time, but a move made meanwhile is asked as soon as it lands
		if (asking) { again = true; return; }

		const asked = where;

		asking = true;

		try {
			const seen = await api<Watching>(watchPath(asked.entity, asked.record, asked.opened, tab));

			if (seen.tab !== tab) { tab = seen.tab; remember(tab); }

			// drawn if still on the same screen; our own cursor moving meanwhile doesn't matter
			if (where !== null && where.entity === asked.entity) drawn(seen.viewers, seen.locks);
		} catch (err) {
			restarted(err);			// otherwise a failed poll says nothing; the next one tries again
		} finally {
			asking = false;

			if (again) { again = false; void ask(); }
		}
	};

	setInterval(() => void ask(), seconds * 1000);

	// a hidden tab keeps polling (it still has a record open); coming back it asks at once
	addEventListener('visibilitychange', () => { if (!document.hidden) void ask(); });

	return {
		at(entity, record, opened) {
			const moved = entity === null ? null : { entity, record, opened };

			if (alike(where, moved)) return;

			const elsewhere = where?.entity !== moved?.entity;

			where = moved;

			if (elsewhere) drawn([], []);		// a new screen starts empty, not with the last one's people

			void ask();
		},

		now() { void ask(); },

		tab: () => tab,
	};
}
