// The screen says where it is, and asks who else is there (SCOPE 6d).

import type { Lock, Viewer, Watching } from '../shared/api.js';
import { api } from './api.js';
import { sessionEnded } from './auth.js';
import { watchPath } from './query.js';
import { same } from './route.js';

/** Where this tab is: a screen, the record it has a cell open on, and the one its panel is
 * showing. Two records, because it can be on both at once and each should be marked. */
interface Where {
	entity: string;
	record: string[];
	opened: string[];
}

export interface Watch {
	/** Says where this tab is now, and asks at once rather than waiting for the next round —
	 * a screen that has just been opened should not look empty for a poll.
	 * @param entity null when there is no screen; then nothing is announced at all. */
	at(entity: string | null, record: string[], opened: string[]): void;

	/** Asks again at once, without having moved. For when this tab has just changed something
	 * the answer reports — a claim taken or let go — and should not wait a round to see it. */
	now(): void;

	/** This tab's name, once the server has minted it: for another poll that must leave it out. */
	tab(): string | null;
}

/** @param seconds what `_meta` published, which is also what the server counts a tab present
 * within — one number, so the two cannot drift.
 * @param drawn called with the others every time an answer comes back. */
/** Is this the same place as that one? Two announcements of the same position say nothing new,
 * and a tab that says nothing new should not ask again. */
const alike = (a: Where | null, b: Where | null): boolean =>
	a === b || (a !== null && b !== null && a.entity === b.entity
		&& same(a.record, b.record) && same(a.opened, b.opened));

/** Where a tab's name is kept so that refreshing the page does not make it a different tab.
 *
 * `sessionStorage` is the browser's own idea of a tab: it survives a reload, it dies when the
 * tab dies, and no other tab can see it — which is exactly the thing being counted. Held only
 * in a variable, a refresh minted a new name and left the old row standing for the length of
 * the window, so a page refreshed a few times showed up as several people.
 *
 * It is not a credential and none of the reasoning about the session cookie applies to it: it
 * authenticates nothing, and the row it names is rewritten with the caller's own identity on
 * every poll, so the worst it can be used for is to move a marker the user could move anyway.
 * A browser that refuses storage at all simply goes back to leaving a ghost per refresh. */
const KEPT = 'presence-tab';

const remembered = (): string | null => {
	try { return sessionStorage.getItem(KEPT); } catch { return null; }
};

const remember = (name: string): void => {
	try { sessionStorage.setItem(KEPT, name); } catch { /* private window, or storage refused */ }
};

export function watching(seconds: number, drawn: (viewers: Viewer[], locks: Lock[]) => void): Watch {
	/** Minted by the server on the first ask, and kept for as long as this browser tab lives —
	 * across a reload included, which is what `remembered` is for. */
	let tab: string | null = remembered();
	let where: Where | null = null;
	let asking = false;
	let again = false;

	const ask = async (): Promise<void> => {
		if (where === null) return;

		// One question at a time, but a move made while one is in the air is not dropped: it is
		// asked the moment that one lands. Without this a click during a round trip would wait
		// for the next round, which is most of what made this feel slow.
		if (asking) { again = true; return; }

		const asked = where;

		asking = true;

		try {
			const seen = await api<Watching>(watchPath(asked.entity, asked.record, asked.opened, tab));

			if (seen.tab !== tab) { tab = seen.tab; remember(tab); }	// only what a new name costs

			// Drawn as long as it is still the same screen. Where *this* tab's own cursor has
			// moved to meanwhile does not make the answer wrong — it is about everybody else,
			// and the follow-up ask is already queued.
			if (where !== null && where.entity === asked.entity) drawn(seen.viewers, seen.locks);
		} catch (err) {
			// A poll that fails says nothing and the next one tries again — it must never be what
			// takes a screen down. A session that ended is the one thing worth acting on.
			if (sessionEnded(err)) location.reload();
		} finally {
			asking = false;

			if (again) { again = false; void ask(); }
		}
	};

	setInterval(() => void ask(), seconds * 1000);

	// A tab that is not on screen is still a tab with a record open, which is the whole thing
	// presence is asked about — so it keeps answering. It only asks *sooner* on coming back,
	// so that whoever arrived while it was away shows up at once rather than a round later.
	addEventListener('visibilitychange', () => { if (!document.hidden) void ask(); });

	return {
		at(entity, record, opened) {
			const moved = entity === null ? null : { entity, record, opened };

			if (alike(where, moved)) return;		// nothing new to say

			const elsewhere = where?.entity !== moved?.entity;

			where = moved;

			// A new screen starts with nobody on it rather than with the last screen's people,
			// who are not here. The answer fills it back in within one round trip.
			if (elsewhere) drawn([], []);

			void ask();
		},

		now() { void ask(); },

		tab: () => tab,
	};
}
