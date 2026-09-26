import type {
	Capability, ColumnMeta, FormatMeta, Lock, ReferenceMeta, SystemMeta, TableMeta, Viewer,
} from '../shared/api.js';
import { actionMenu, type Action, type ActionMenu } from './actions.js';
import { ancestryPicker, type AncestryPicker } from './ancestry.js';
import { api, ApiError, sending } from './api.js';
import { authenticated, sessionEnded, type Session } from './auth.js';
import { byId, classed, el } from './dom.js';
import { download } from './export.js';
import { filterBar, type FilterBar } from './filters.js';
import {
	type Ancestor, type Detail, detailsOf, keyThrough, kinshipOf, ownColumns, type Reachable,
	reachedColumn, reachedName, referencesOf, targetOf, valuesFrom, valuesOf,
} from './fk.js';
import { picker, type Picker } from './picker.js';
import { watching, type Watch } from './presence.js';
import { filterQuery, type Listing, listPath, rowPath } from './query.js';
import { router, same, type Router, type View } from './route.js';

type Row = Record<string, unknown>;


// --- DOM ---

const 	nav = byId('entities'),
	toolbar = byId('toolbar'),
	headerEnd = byId('header-end'),
	heading = byId('title'),
	statusLine = byId('status'),
	grid = byId('grid'),
	gridHead = byId('head'),
	gridRows = byId('rows'),
	emptyNote = byId('empty'),
	peek = byId('peek'),
	peekEntity = byId('peek-entity'),
	peekTitle = byId('peek-title'),
	peekForm = byId('peek-form'),
	peekFields = byId('peek-fields'),
	peekActions = byId('peek-actions'),
	peekDelete = byId('peek-delete') as HTMLButtonElement,
	peekCancel = byId('peek-cancel') as HTMLButtonElement,
	peekSave = byId('peek-save') as HTMLButtonElement,
	peekClose = byId('peek-close'),
	peekDetails = byId('peek-details'),
	peekTabbar = byId('peek-tabbar'),
	peekTabs = byId('peek-tabs'),
	peekDetailGrid = byId('peek-detail-grid'),
	peekDetailHead = byId('peek-detail-head'),
	peekDetailRows = byId('peek-detail-rows'),
	peekDetailEmpty = byId('peek-detail-empty');

const say = (message: string, state: 'ready' | 'busy' | 'error' = 'ready') => {
	statusLine.textContent = message;
	statusLine.dataset.state = state;
};

/** Clears the screen, calling off any edit or peek on it. */
const blank = () => { grid.hidden = true; emptyNote.hidden = true; editing?.cancel(); closePeek(); };


// --- Foreign keys ---

/** A column's fk plus the table it points at. */
interface Fk {
	ref: ReferenceMeta;
	target: TableMeta;
}

/** Each table's fks, indexed by the columns that carry them; built once from `_meta`. */
let fks = new Map<TableMeta, ReadonlyMap<string, ReferenceMeta>>();

/** The fk a column carries, if any (or none this caller may read). */
const fkOf = (t: TableMeta, c: ColumnMeta): Fk | undefined => {
	const ref = fks.get(t)?.get(c.name);
	const target = ref && targetOf(tables, ref);

	return ref && target ? { ref, target } : undefined;
};


// --- API ---

/** A row's pk values, in declaration order. */
const key = (t: TableMeta, row: Row) => valuesOf(t.pk, row);

/** Where a row of `t` is read and written: `rowPath` addressed by the row's own key. */
const rowAt = (t: TableMeta, row: Row, listing?: Listing) => rowPath(t.entity, key(t, row), listing);

/** What the server answers a write with when the row it addresses is no longer the row that was
    read (SCOPE 6f). It is the one refusal that is about *when* the write was made, not about
    what it said, so it is the one the screen answers by reloading rather than by marking a field. */
const stale = (err: unknown) => err instanceof ApiError && err.status === 412;

/** What it answers with when somebody else is holding the record (SCOPE 6e). Like a late write
    it is a refusal about the record rather than about what was typed, so the screen answers it
    the same way: put back what is there, and say why. */
const held = (err: unknown) => err instanceof ApiError && err.status === 423;

/** The two refusals that are about the record rather than about the values. Asked as one,
    because they are answered as one — so neither can grow a site the other does not have. */
const refused = (err: unknown) => stale(err) || held(err);

const CHANGED = 'El registro cambió; se recargó con los valores actuales.';

/** A record's address, as the line carries it and the poll answers it. */
const addressOf = (t: TableMeta, row: Row) => key(t, row).join('/');

/** Reads the row again into the object the screen is holding. When the server has refused a
    write for being late, showing what is actually there is the whole of the answer. */
const reread = async (s: Sheet, row: Row): Promise<void> => {
	Object.assign(row, await api<Row>(rowAt(s.t, row, { reached: reached(s.columns) })));
};


// --- Rendering ---

/** A constant the form can show. A `{fn}` default is one only the database can produce, and a
    browser must not guess it — that would be a second clock — so it shows as empty. */
const constantDefault = (c: ColumnMeta) =>
	c.defaultValue !== null && 'value' in c.defaultValue ? c.defaultValue.value : null;

/** `crud.ts`'s `requiredOnInsert`, decided here the same way: a column the database can fill is
    one an insert may leave empty, even when it is not nullable. An update is not the same
    question — blanking such a column is still refused — so only a draft asks this one. */
const requiredOnInsert = (c: ColumnMeta) => !c.nullable && c.defaultValue === null;

/** A column's tooltip and markers, shared by the grid header and the peek's label.
    @param required whether the field being labelled will be refused empty; the grid header
    speaks about the column itself, a panel about what it is doing to it. */
const named = <N extends HTMLElement>(node: N, t: TableMeta, c: ColumnMeta, required: boolean): N => {
	const fk = fkOf(t, c);

	node.title = `${c.type} — ${c.expected}${fk ? ` → ${fk.target.entity}` : ''}`;
	node.classList.toggle('pk', t.pk.includes(c.name));
	node.classList.toggle('required', required);
	node.classList.toggle('fk', fk !== undefined);

	return node;
};

/** A value, in a grid cell or a peek field.
    @param link the row it addresses, when it addresses one — see `fkLink`. */
const shown = <K extends 'td' | 'dd'>(tag: K, value: unknown, link?: HTMLAnchorElement) => {
	const node = el(tag, link ?? (value === null ? 'null' : String(value)));

	node.classList.toggle('null', value === null);

	return node;
};

/** An fk value drawn as a real link to the row it addresses — Back and new-tab both work.
    Nothing is fetched; it uses the value already on screen. */
const fkLink = (fk: Fk, row: Row, value: unknown): HTMLAnchorElement | undefined => {
	const addressed = keyThrough(fk.ref, fk.target, row);

	if (!addressed) return undefined;	// an fk onto a unique key, or a null: no row is named

	const a = classed('a', 'ref', String(value));

	a.href = route.href({ screen: fk.target.entity, key: addressed, conditions: [] });
	a.title = `Ver ${fk.target.entity}`;

	return a;
};

/** What has to be asked of the server beside the table's own columns, for these to be drawn. */
const reached = (columns: Reachable[]) => columns.filter(sh => sh.via.length > 0).map(sh => sh.name);

/** The header cell. An own column carries its table's marks; a borrowed one carries where it
    came from instead — an FK badge over a value that links nowhere, or a "required" over a
    column a left join can leave null, would each be saying something untrue about it. */
const header = (t: TableMeta) => (sh: Reachable) => {
	const { column } = sh;

	if (!sh.via.length)
		return named(el('th', column.name, el('small', column.type)), t, column, !column.nullable);

	const th = classed('th', 'borrowed', column.name,
		el('small', `${kinshipOf(sh.via)} · ${sh.owner.entity}`));

	th.title = `${sh.name} — ${column.type}, de ${sh.owner.entity}`;

	return th;
};

/** Shared by the grid's cell and the peek's field, so the two can't disagree on what's editable. */
const writable = (t: TableMeta, c: ColumnMeta) => !t.pk.includes(c.name) && t.capabilities.includes('update');

/** A table drawn on screen: the screen's own grid, or a subtable under the row panel. A row is
    written the same way on both — only where it is drawn, and what its leading cell holds,
    differ — so neither can end up reading its own way. */
interface Sheet {
	t: TableMeta;
	/** The columns it draws, in order: the table's own, then whatever it borrows. */
	columns: Reachable[];
	head: HTMLElement;
	body: HTMLElement;
	table: HTMLElement;
	/** Shown in place of the rows when there are none. */
	empty: HTMLElement;
	/** The fewest rows to draw. Short of that, empty ones make up the difference. */
	leastRows: number;
	/** What the row's leading cell holds: see `opener` and `jump`. More than one on the screen's
	 * own grid, where the record is also claimed; the column follows what it is given rather
	 * than being told a second time which sheet it is on. */
	handle(row: Row): Node[];
}

/** A borrowed cell is read-only and links nowhere: the row it came off is not on the wire, only
    that one value of it, so there is neither a row to address nor a row to write back to. */
const cell = (s: Sheet, row: Row) => (sh: Reachable) => {
	const { column } = sh;
	const value = row[sh.name] ?? null;			// a column the answer did not carry reads as null
	const fk = sh.via.length ? undefined : fkOf(s.t, column);
	const td = shown('td', value, fk && fkLink(fk, row, value));

	if (sh.via.length) { td.classList.add('borrowed'); return td; }

	if (!writable(s.t, column)) return td;

	td.classList.add('editable');
	td.addEventListener('dblclick', () => void enter(s, row, column, td));

	return td;
};

/** Shows (or clears) an error message under a field. */
const note = (input: HTMLInputElement, message?: string) => {
	input.classList.toggle('bad', message !== undefined);
	input.parentElement?.querySelector('.bad-note')?.remove();
	input.removeAttribute('aria-describedby');

	if (message === undefined) return;

	const said = classed('p', 'bad-note', message);

	said.id = `bad-${input.name}`;			// named, so the input it is about can point at it
	said.setAttribute('role', 'alert');
	input.setAttribute('aria-describedby', said.id);
	input.after(said);
};

/** The lists the panel's fk fields are offering; dropped when those fields are rebuilt. */
const pickers: Picker[] = [];

const dropPickers = () => pickers.splice(0).forEach(one => one.destroy());

/** Marks a box as changed, the one way, wherever the change came from. */
const touched = (input: HTMLInputElement) => {
	note(input);					// clear any refusal — it was about the old value
	input.classList.toggle('dirty', input.value !== input.dataset.original);
	syncPeekActions();
};

/** What picking from an fk's list writes: every column of that fk, since it's one value
    across several columns. `savePeek` carries them all in the one PATCH it already sends. */
const pickInto = (values: Row) => {
	for (const [name, value] of Object.entries(values)) {
		const box = peekFields.querySelector<HTMLInputElement>(`input[name="${CSS.escape(name)}"]`);

		if (!box) continue;			// a column of the fk this panel does not write

		box.value = value === null ? '' : String(value);
		touched(box);
	}
};

/** A field's editor in the side panel.
    @param into the field's own box, which the fk list (if any) hangs inside. */
const peekInput = (c: ColumnMeta, p: Peeked, into: HTMLElement): HTMLInputElement => {
	const input = el('input');
	const before = p.row[c.name] === null ? '' : String(p.row[c.name]);
	const fk = fkOf(p.t, c);

	input.type = 'text';
	input.name = c.name;
	input.value = before;
	input.dataset.original = before;
	input.placeholder = c.expected;
	input.title = `${c.name}: ${c.type} — ${c.expected}`;

	const list = fk && picker(input, into, fk.ref, fk.target, pickInto);

	if (list) {
		pickers.push(list);
		input.addEventListener('keydown', e => { list.handled(e); });
	}

	input.addEventListener('input', () => { touched(input); list?.refresh(); });

	return input;
};

const field = (p: Peeked) => (c: ColumnMeta) => {
	const label = named(el('dt', c.name), p.t, c, p.required(c));
	const fk = fkOf(p.t, c);

	if (!p.writable(c)) return [label, shown('dd', p.row[c.name], fk && fkLink(fk, p.row, p.row[c.name]))];

	const box = el('dd');			// built first: it is what the fk's list hangs inside

	box.append(peekInput(c, p, box));

	return [label, box];
};

/** The grid's sticky leading column. */
const lead = (tag: 'th' | 'td', ...children: Node[]) => {
	const node = el(tag, ...children);

	node.className = 'lead';

	return node;
};

/** The screen's leading cell: the handle that opens the row in the side panel, which is where
    the screen already is, and beside it the latch that holds the record (SCOPE 6e). */
const opener = (s: Sheet, row: Row): Node[] => {
	const button = classed('button', 'handle');

	button.type = 'button';
	button.title = 'Ver registro';
	button.setAttribute('aria-label', 'Ver registro');
	button.addEventListener('click', () => show(record(s, row, button)));

	return [button, latch(s, row)];
};

/** A subtable's handle: a real link to the row's own screen, for the same reason an fk value is
    one. The panel it sits under is another record's, so this row is read somewhere else — and
    claimed there too: a latch belongs on the screen that owns the record. Writing it is still
    refused here, because the refusal is the server's and the screens share it. */
const jump = (t: TableMeta, row: Row): Node[] => {
	const a = classed('a', 'handle');

	a.href = route.href({ screen: t.entity, key: key(t, row), conditions: [] });
	a.title = `Ver ${t.entity}`;
	a.setAttribute('aria-label', `Ver ${t.entity}`);

	return [a];
};

/** The record's claim, taken and let go by the one button, because a latch is one thing in one
    of three positions rather than three buttons. Forcing somebody else's open is the same verb
    sent by a role allowed to send it — the server decides that, and `delete` is what the button
    believed when it offered the press.

    Built empty and kept, like the handle beside it: what it *says* is written by `relatch`. */
const latch = (s: Sheet, row: Row) => {
	const button = classed('button', 'latch');

	button.type = 'button';
	button.addEventListener('click', () => void hold(s, row, button));

	return button;
};

/** What the latch on a line says: which position the claim is in, who has it, and whether this
    role may move it.

    Drawn from the poll rather than from the row, because that is where a claim is answered —
    so it is written where the viewers' marks are written, not in `fill`. A sheet that draws no
    latch (a subtable) simply has none to write. */
const relatch = (tr: HTMLElement, t: TableMeta) => {
	const button = tr.querySelector<HTMLButtonElement>('.latch');

	if (!button) return;

	const at = String(tr.dataset.at);
	const state = heldness(at);
	const who = holderOf(at);

	button.dataset.held = state;
	button.disabled = !t.capabilities.includes(LATCH[state].needs);
	button.setAttribute('aria-label', LATCH[state].label(who ?? ''));

	if (who === null) delete button.dataset.name;	// nobody to name, and no name to draw
	else button.dataset.name = who;
};

/** Takes the record's claim or lets it go, whichever the latch is showing.
    The poll is what draws the answer, so all that is left is to ask it again at once rather
    than let someone wait a round to see their own press. */
async function hold(s: Sheet, row: Row, button: HTMLButtonElement): Promise<void> {
	const at = addressOf(s.t, row);
	const { verb } = LATCH[heldness(at)];

	button.disabled = true;				// no second press while the first is in the air
	say(verb === 'LOCK' ? 'Lockeando…' : 'Liberando…', 'busy');

	try {
		// The answer is the record as it now stands, so claiming one also puts the line right:
		// a claim is taken to hold what is on screen, and it is no good holding a line that has
		// moved on. A caller who may not read the record is answered nothing, and merges nothing.
		const now = await api<Row | null>(rowAt(s.t, row), sending(verb));

		if (now) {
			Object.assign(row, now);

			const tr = button.closest('tr');

			if (tr?.isConnected) fill(tr, s, row);

			refreshPeek(s.t, row);
		}

		say(summary(s));
	} catch (err) {
		if (sessionEnded(err)) { location.reload(); return; }

		say(refused(err) ? refusal(err, at) : (err as Error).message, 'error');
	} finally {
		watch.now();				// whatever it says now is what the latch should show
	}
}

/** The one place a row's cells are written. Keeps the lead cell rather than rebuilding it,
    so the peek's reference to its button (which marks the row open) survives — and with it any
    mark another viewer's cursor has left there.

    The row's key goes on the line as well. It is the one thing the DOM is told about a row's
    identity, and it is here because this is where a row is written: a viewer's cursor is
    answered as the address writes a key, so the two can be compared without asking again. */
const fill = (tr: HTMLTableRowElement, s: Sheet, row: Row) => {
	tr.dataset.at = key(s.t, row).join('/');
	tr.replaceChildren(tr.querySelector('.lead') ?? lead('td', ...s.handle(row)), ...s.columns.map(cell(s, row)));

	return tr;
};

/** The rows drawn past the data, so a short list still reads as a table rather than as a rule
    with a caption under it. They hold nothing and answer to nothing — no handle, no editable
    cell — and `summary` does not count them, because they are not records. */
const blanks = (s: Sheet, drawn: number) =>
	Array.from({ length: Math.max(0, s.leastRows - drawn) },
		() => classed('tr', 'blank', lead('td'), ...s.columns.map(() => el('td'))));

const renderSheet = (s: Sheet, data: Row[]) => {
	s.head.replaceChildren(lead('th'), ...s.columns.map(header(s.t)));
	s.body.replaceChildren(...data.map(row => fill(el('tr'), s, row)), ...blanks(s, data.length));

	s.table.hidden = false;			// show header even with no rows under it
	s.empty.hidden = data.length > 0;
};

/** "1 registro", "2 registros"; an irregular plural passes its own. */
const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Counted off the sheet itself, not off a second copy of the count kept beside it — the rows
    it drew to look like a table are not among them. */
const summary = (s: Sheet) =>
	`${count(s.body.querySelectorAll('tr:not(.blank)').length, 'registro')}`
	+ ` · ${count(s.columns.length, 'campo')}`;

/** What each capability is called on screen. `Record<Capability, …>` rather than a loose map:
    a verb the vocabulary adds is then a compile error here, not a raw name on the screen. */
const CAPABILITY_LABEL: Record<Capability, string> = {
	read: 'Leer',
	create: 'Insertar',
	update: 'Modificar',
	delete: 'Eliminar',
	lock: 'Lockear',
};

/** What a record's claim is, seen from this session. Three positions and no more, which is why
    it is a type rather than a pair of booleans. */
type Held = 'free' | 'mine' | 'theirs';

/** What the latch is in each position: the capability pressing it takes, the verb it sends, and
    what it is called. A `Record<Held, …>` for the reason `CAPABILITY_LABEL` is one — a position
    the model gains is a compile error here, not a blank button on the screen.

    Claiming a record and letting one go both ask for `lock`. Taking one off somebody else asks
    for `delete`: the strongest thing the policy says about a record, and strictly more than
    breaking a claim on it — which is what the server gates the same step on, so the button is
    offered exactly where it would be honoured. */
const LATCH: Record<Held, { needs: Capability; verb: string; label: (who: string) => string }> = {
	free: { needs: 'lock', verb: 'LOCK', label: () => 'Lockear el registro' },
	mine: { needs: 'lock', verb: 'UNLOCK', label: () => 'Liberar el lockeo' },
	theirs: { needs: 'delete', verb: 'UNLOCK', label: who => `Lockeado por ${who} — forzar la liberación` },
};

const heldness = (at: string): Held => {
	const who = holderOf(at);

	return who === null ? 'free' : who === me.username ? 'mine' : 'theirs';
};

/** What the signed-in role may do on this table, beside its name.
 *
 * Only what is granted, and in the order `_meta` sent it — which is the vocabulary's own
 * order, so the badges never reshuffle between screens. Drawing the denied ones greyed out
 * would read well, but it would take a copy of the whole capability set living in the
 * browser, and the frontend does not restate the model: it says what the schema told it. */
const grants = (t: TableMeta) => {
	const box = classed('span', 'grants',
		...t.capabilities.map(c => classed('span', 'grant', CAPABILITY_LABEL[c] ?? c)));

	box.title = `Lo que tu rol puede hacer en ${t.entity}`;

	return box;
};


// --- Who else is here (SCOPE 6c, 6d) ---

/** The others on this screen, as the last poll answered. Kept because the grid is redrawn far
    more often than the poll answers, and a redraw must not blank what is true. */
let seen: Viewer[] = [];

/** Who is holding what on this screen, record by record, as the last poll answered — kept
    beside `seen` and for the same reason.

    A claim travels in the poll rather than on the row, so a claim taken anywhere shows up here
    within a poll instead of waiting for the line to be read again. What it costs is that a
    fact which changes rarely is answered every round; what it buys is that the screen never
    shows a padlock that is no longer there. */
let claimed = new Map<string, string>();

/** Who is holding this record, if anybody. */
const holderOf = (at: string) => claimed.get(at) ?? null;

/** What the screen says about a record that is somebody else's. The server states its refusals
    in English; the browser is what speaks Spanish. Naming the holder is the half of SCOPE (6e)
    that is not a button. */
const heldBy = (at: string) => `${holderOf(at) ?? 'Otro usuario'} tiene el registro lockeado.`;

/** Which of the two refusals happened, worded. */
const refusal = (err: unknown, at: string) => (stale(err) ? CHANGED : heldBy(at));

/** One circle each, beside what the screen says about itself. */
const watchers = classed('div', 'watchers');

/** One stack per entity in the rail, filled in when the rail is built. */
const rails = new Map<string, (viewers: Viewer[], colours: Map<string, number>) => void>();

/** How many colours the stylesheet holds. */
const COLOURS = 8;

const hashed = (s: string) => [...s].reduce((n, ch) => (n * 31 + ch.charCodeAt(0)) >>> 0, 0);

/** A colour per tab, all of them different.
 *
 * Each tab asks for the colour its own name hashes to, and takes the next free one when that is
 * already spoken for. Asking first is what keeps a colour still: it does not depend on how many
 * others are here, so an unrelated tab arriving or leaving does not repaint everybody. Walking
 * on when it is taken is what keeps them apart — up to the eight the stylesheet has, after
 * which two do share, which is better than either leaving a tab uncoloured or inventing a
 * colour the stylesheet has never seen. Sorted first, so the same set always assigns the same. */
const coloured = (viewers: Viewer[]): Map<string, number> => {
	const taken = new Set<number>();
	const colours = new Map<string, number>();

	for (const { id } of [...viewers].sort((a, b) => a.id.localeCompare(b.id))) {
		let slot = hashed(id) % COLOURS;

		while (taken.size < COLOURS && taken.has(slot)) slot = (slot + 1) % COLOURS;

		taken.add(slot);
		colours.set(id, slot);
	}

	return colours;
};

/** A box that holds circles and keeps the ones that are still wanted.
 *
 * Kept and matched by tab rather than thrown away and built again on every answer: an answer
 * arrives every poll and almost always says the same thing, and a circle that is still here is
 * the *same* circle — so it does not blink, and the name it is showing under the pointer does
 * not blink with it. Used twice, for the header and for each line of the rail. */
const stackOf = (box: HTMLElement) => {
	const kept = new Map<string, HTMLElement>();

	return (viewers: Viewer[], colours: Map<string, number>) => {
		box.hidden = viewers.length === 0;

		for (const [id, dot] of kept)
			if (!viewers.some(v => v.id === id)) { dot.remove(); kept.delete(id); }

		viewers.forEach((v, i) => {
			// one tab, one circle — the same user looking twice is two of them, in two colours
			const dot = kept.get(v.id) ?? classed('span', 'viewer', v.user.slice(0, 1));

			dot.dataset.colour = String(colours.get(v.id));

			// A circle answers who, and only who. Where they are is already drawn, on the line their
			// cursor is on and in this same colour — spelling the pk out here said it a second time,
			// in a form nobody reads a record by, and left the name looking like it had a suffix.
			dot.dataset.name = v.user;
			dot.setAttribute('aria-label', v.user);
			dot.tabIndex = 0;		// so the name can be reached without a pointer

			kept.set(v.id, dot);

			// Only when it is not already in that place. Appending a node that is *already* a
			// child moves it — a removal and an insertion — and that restarts the fade and drops
			// the hover under the pointer. A circle that has not moved is not touched at all.
			const there = box.children[i];

			if (there !== dot) box.insertBefore(dot, there ?? null);
		});
	};
};

const inHeader = stackOf(watchers);

/** Draws them three times over: a circle each beside the counts, the line their cursor is on
    outlined in that same colour, and — for every screen, not just this one — a circle beside
    that screen's name in the rail. The circles alone would say something is going on without
    saying where; the outline is what makes it answerable on this screen and the rail is what
    makes it answerable about the others. The shared colour ties all three together without any
    of them having to name the other. */
const drawViewers = () => {
	const colours = coloured(seen);			// across every screen, so a tab is one colour everywhere
	const here = seen.filter(v => v.entity === screen?.entity);

	inHeader(here, colours);

	for (const [entity, box] of rails)
		box(seen.filter(v => v.entity === entity), colours);

	const cursors = new Map<string, Viewer[]>();

	for (const v of here)
		for (const at of v.records) cursors.set(at, [...cursors.get(at) ?? [], v]);

	for (const tr of gridRows.querySelectorAll<HTMLTableRowElement>('tr[data-at]')) {
		const who = cursors.get(String(tr.dataset.at)) ?? [];
		const mark = tr.querySelector<HTMLElement>('.watcher');

		// The other thing the same answer carries about this line: who is holding the record
		// (SCOPE 6e). A cursor and a claim are drawn side by side in the leading cell and share
		// nothing else — one says who is looking, the other says who may write.
		if (sheet) relatch(tr, sheet.t);

		tr.classList.toggle('watched', who.length > 0);

		if (!who.length) {
			mark?.remove();
			delete tr.dataset.colour;
			continue;
		}

		// The line takes the colour of the first of them, which is the one the stylesheet can
		// draw; the mark on its handle says how many there are when it is more than one.
		tr.dataset.colour = String(colours.get(who[0].id));

		// The leading column is 2.25rem wide and sticky, so the mark says who in the space of a
		// letter — one initial, or how many when there are several. It names nobody: the name is
		// the circle's to give. Kept rather than remade, for the same reason the circles are:
		// a mark that is fading under the pointer must not be restarted every few seconds.
		const letter = who.length === 1 ? who[0].user.slice(0, 1) : String(who.length);

		if (mark) mark.textContent = letter;
		else tr.querySelector('.lead')?.append(classed('span', 'watcher', letter));
	}

	// The grid draws its lines as each cell's own bottom border, so a row's *top* edge belongs to
	// whatever is above it — the row before, or the header. That element is told which colour to
	// draw it in, because it has no way to read it off the row below; a row already wearing a
	// colour of its own keeps it, since its edge and that colour are the same line.
	const lines = [gridHead, ...gridRows.children] as HTMLElement[];

	lines.forEach((above, i) => {
		const below = lines[i + 1];
		const edge = below?.classList.contains('watched') === true && !above.classList.contains('watched');

		above.classList.toggle('above-watched', edge);

		if (edge) above.dataset.colour = String(below.dataset.colour);
		else if (!above.classList.contains('watched')) delete above.dataset.colour;
	});
};

/** The records somebody's cursor is on, on the screen being looked at. */
const holdings = (viewers: Viewer[]): Set<string> =>
	new Set(viewers.flatMap(v => v.entity === screen?.entity ? v.records : []));

/** Rows this tab is in the middle of changing.
 *
 * Reading one again would move its version out from under what is about to be written with that
 * version — and that version is the only thing standing between the write and quietly landing on
 * top of whatever just changed. So these are left exactly as they are, and the refusal at save
 * time is what speaks instead. */
const busyWith = (at: string): boolean =>
	editing?.at.join('/') === at
	|| (opened?.key.join('/') === at && peekFields.querySelector('input.dirty') !== null);

/** Reads one row again and puts it back, after somebody else let go of it.
 *
 * Enter both saves and releases, so a row that was just let go of is very likely a row that was
 * just changed — and the moment it is let go of is the moment to show what it says now, rather
 * than whenever whoever is looking at it happens to navigate. Nothing new is on the wire for
 * this: who is holding what was already being answered every poll, and this reads the *end* of
 * a hold out of it. What it does not catch is a row nobody was holding — an insert, a delete,
 * or a write from outside a browser — which still waits for the next time the list is asked for. */
const refresh = async (at: string): Promise<void> => {
	const s = sheet;

	if (!s || busyWith(at)) return;

	const row = listed.find(r => key(s.t, r).join('/') === at);
	const tr = gridRows.querySelector<HTMLTableRowElement>(`tr[data-at="${CSS.escape(at)}"]`);

	if (!row || !tr) return;

	try {
		await reread(s, row);
	} catch {
		return;				// gone, or no longer readable: the next read of the list will say so
	}

	if (tr.isConnected) fill(tr, s, row);

	refreshPeek(s.t, row);			// and in the panel, if that is the record it is showing
};

const showViewers = (viewers: Viewer[], locks: Lock[]) => {
	const was = holdings(seen);

	seen = viewers;
	claimed = new Map(locks.map(l => [l.record, l.holder]));
	drawViewers();

	const still = holdings(viewers);

	for (const at of was) if (!still.has(at)) void refresh(at);
};


// --- Row peek ---

/** What the side panel is showing: a record the grid drew, or a row being drafted for insert.
    Same panel either way — only these differ. */
interface Peeked {
	t: TableMeta;
	row: Row;
	/** Empty for a draft: it is not a record until it has been saved. */
	key: string[];
	/** The grid button that opened it, so its row stays marked. None for a draft. */
	button?: HTMLButtonElement;
	/** Focus target on close. */
	from: HTMLElement;
	title: string;
	needs: Capability;
	writable(c: ColumnMeta): boolean;
	/** Whether this panel will be refused the field empty — see `requiredOnInsert`. */
	required(c: ColumnMeta): boolean;
	/** Focus target on open: a record is there to be read, a draft to be written. */
	landing(): HTMLElement;
	save(typed: Row): Promise<void>;
	/** Absent on a draft: there is nothing there yet to delete. */
	remove?(): Promise<void>;
}

/** The panel's one occupant. */
let opened: Peeked | null = null;

/** @param restore whether this is a user-initiated close, vs. one the screen did on its way
    to redrawing (in which case the address should not change). */
const closePeek = (restore = false) => {
	opened?.button?.closest('tr')?.classList.remove('open');

	if (restore) opened?.from.focus();

	const was = opened !== null;

	opened = null;
	peek.hidden = true;
	peekDetails.hidden = true;
	peekDetailRows.replaceChildren();	// so reopening never flashes the last record's rows
	dropPickers();

	cursor();				// the panel is closed: whatever the cursor is now, it is not this record

	if (restore && was) route.mark(here());
};

const dismissPeek = () => closePeek(true);

/** Redraws the panel from what it is showing now; rebuilding the fields clears any unsaved edit. */
const fillPeek = () => {
	if (!opened) return;

	const { t } = opened;

	// each button, and the footer, shown only where its own action is allowed
	const writes = t.capabilities.includes(opened.needs);
	const removes = opened.remove !== undefined && t.capabilities.includes('delete');

	peekEntity.textContent = t.entity;
	peekTitle.textContent = opened.title;
	dropPickers();					// the ones the fields about to be replaced were offering
	peekFields.replaceChildren(...t.columns.flatMap(field(opened)));
	peekCancel.hidden = peekSave.hidden = !writes;
	peekDelete.hidden = !removes;
	peekActions.hidden = !writes && !removes;
	disarmDelete();
	syncPeekActions();
	fillDetails();
};

/** Updates the shown row after a sheet redraw, unless there are unsaved edits or this isn't
    the record showing (a draft never matches — it has no key).
    The table is asked first: a detail row carries its master's key columns, so keys alone would
    let a subtable's row pass for the very record the panel is showing. */
const refreshPeek = (t: TableMeta, row: Row) => {
	if (opened?.t !== t || !opened.key.length || !same(opened.key, key(t, row))) return;

	opened.row = row;
	if (!peekFields.querySelector('input.dirty')) fillPeek();
};

/** Opens the panel on what it is given, closing whatever it held. */
function show(what: Peeked): void {
	opened?.button?.closest('tr')?.classList.remove('open');
	opened = what;
	what.button?.closest('tr')?.classList.add('open');

	fillPeek();

	peek.hidden = false;
	what.landing().focus();

	route.mark(here(what.key));		// the screen already shows it; the address only says so
	cursor();				// an open record is where this tab's cursor is
}

/** Save and Cancel are enabled only while the panel disagrees with the row it is showing. */
const syncPeekActions = () => {
	const dirty = peekFields.querySelector('input.dirty') !== null;

	peekSave.disabled = !dirty;
	peekCancel.disabled = !dirty;
};

/** Sends every changed field in one request — an untouched one is never sent at all. */
async function savePeek(): Promise<void> {
	if (!opened) return;

	const dirty = [...peekFields.querySelectorAll<HTMLInputElement>('input.dirty')];

	if (!dirty.length) return;

	const at = opened.key.join('/');		// held before the await, so the refusal can name a holder
	const typed: Row = {};

	for (const input of dirty) typed[input.name] = input.value.trim() === '' ? null : input.value;

	peekSave.disabled = true;
	peekCancel.disabled = true;
	dirty.forEach(input => { input.disabled = true; });
	say('Guardando…', 'busy');

	try {
		await opened.save(typed);
	} catch (err) {
		if (sessionEnded(err)) { location.reload(); return; }

		// the row was re-read on the way here, so rebuilding the fields shows what is there now —
		// and it is a rebuild, not a note under a box: nothing the user typed was wrong
		if (refused(err)) { fillPeek(); say(refusal(err, at), 'error'); return; }

		const failed = err instanceof ApiError ? err.fields : undefined;

		dirty.forEach(input => { input.disabled = false; });

		// check every field, not just the sent ones — a required field left empty is never
		// sent, so its "is required" can only show up this way
		for (const input of peekFields.querySelectorAll<HTMLInputElement>('input'))
			note(input, failed?.[input.name]);

		syncPeekActions();
		say((err as Error).message, 'error');
	}
}

/** Puts the panel back the way the row says it is — the same rebuild a save ends with. */
const cancelPeek = () => fillPeek();

/** Arms the button; the next press is the one that deletes. */
const armDelete = () => {
	peekDelete.dataset.armed = 'true';
	peekDelete.textContent = '¿Eliminar?';
};

/** Resets the button to ask again before it acts. */
const disarmDelete = () => {
	peekDelete.disabled = false;
	peekDelete.dataset.armed = 'false';
	peekDelete.textContent = 'Eliminar';
};

async function removePeek(): Promise<void> {
	const removing = opened?.remove;

	if (!removing || !opened) return;

	const at = opened.key.join('/');		// held before the await, so the refusal can name a holder

	peekDelete.disabled = true;
	say('Eliminando…', 'busy');

	try {
		await removing();
	} catch (err) {
		if (sessionEnded(err)) { location.reload(); return; }

		// e.g. a row a detail still points at — names no field, so it goes on the status line.
		// A late delete has already put the panel right on its way here; only the wording is left.
		disarmDelete();
		say(refused(err) ? refusal(err, at) : (err as Error).message, 'error');
	}
}

/** A record already drawn on a sheet — its pk addresses it, so the pk is read-only here too. */
const record = (s: Sheet, row: Row, button: HTMLButtonElement): Peeked => {
	const { t } = s;
	const id = key(t, row);

	/** The row's line on the grid behind the panel, put back the way the row now reads. */
	const redraw = () => {
		const tr = button.closest('tr');

		if (tr?.isConnected) fill(tr, s, row);
	};

	return {
		t, row, button,
		from: button,
		key: id,
		title: id.join(' · ') || 'Registro',
		needs: 'update',
		writable: c => writable(t, c),
		required: c => !c.nullable,		// a default fills what an insert omits, not what an update blanks
		landing: () => peekClose,
		save: async typed => {
			// whatever the answer was, the row object now holds what the server holds — either
			// what it wrote or, when it refused a late write, what it had. So the line is redrawn
			// either way and neither outcome needs its own copy of this.
			try {
				await patched(s, row, typed);
			} finally {
				redraw();
			}

			fillPeek();
			say(summary(s));
		},
		remove: async () => {
			try {
				await api<void>(rowAt(t, row), sending('DELETE', undefined, row[stamp]));
			} catch (err) {
				if (!refused(err)) throw err;

				await reread(s, row).catch(() => undefined);	// deleting what someone else changed is refused too
				redraw();
				fillPeek();

				throw err;
			}

			// back to the list; drawing it again is what stops the address naming a gone row
			closePeek();
			route.go(here());
		},
	};
};

/** What a row is after a write: what the server answered, and — when the sheet is drawing
    columns borrowed from an ancestor — that same row read again with them. Writing an fk moves
    the row under a different ancestor, so what was borrowed beside it is the old one's until it
    is asked for again. That second read is the `GET` of a record with reached columns (7a).
    The one place a written row is put back, so a cell edit and the panel cannot disagree. */
async function patched(s: Sheet, row: Row, body: Row): Promise<void> {
	const { t } = s;
	let saved: Row;

	try {
		// the version the row was read at goes with it, so a row that moved on in between
		// refuses the write instead of taking it (SCOPE 7c)
		saved = await api<Row>(rowAt(t, row), sending('PATCH', body, row[stamp]));
	} catch (err) {
		// the refusal is the news; a re-read that also fails must not replace it
		if (refused(err)) await reread(s, row).catch(() => undefined);

		throw err;
	}

	Object.assign(row, saved);			// keep what the server returned, not the typed text

	const borrowing = reached(s.columns);

	if (borrowing.length) Object.assign(row, await api<Row>(rowAt(t, row, { reached: borrowing })));
}

/** A new row being inserted. Every column is writable, pk included, and it all goes in one
    POST to the entity's collection. */
const draft = (t: TableMeta, from: HTMLElement): Peeked => ({
	t,
	// what the row will be if nothing is typed: the constants the definition declares, null
	// elsewhere. Shown but not dirty, so an untouched one is never sent and the database is
	// the one that applies it — the value on screen and the value stored have one source.
	row: Object.fromEntries(t.columns.map(c => [c.name, constantDefault(c)])),
	key: [],
	from,
	title: 'Nuevo registro',
	needs: 'create',
	writable: () => true,
	required: requiredOnInsert,
	landing: () => peekFields.querySelector('input') ?? peekClose,
	save: async typed => {
		const created = await api<Row>(`/api/${encodeURIComponent(t.entity)}`, sending('POST', typed));

		route.go(here(key(t, created)));	// go to the new record; drawing it lists it in
	},
});

/** What the toolbar's menu does when the role may insert. */
const insertRow: Action = {
	text: 'Insertar fila',
	needs: 'create',
	run: t => show(draft(t, inserts.button)),
};

// --- Ancestor columns (SCOPE 6b) ---

/** What each screen is borrowing from its ancestors. Not in the address and not stored: it is a
    way of looking at a list, not a setting the list has, so it lasts exactly as long as the page
    does. Keyed by the table, so stepping to another screen and back finds it still there. */
const borrowed = new Map<TableMeta, Reachable[]>();

const showing = (t: TableMeta) => borrowed.get(t) ?? [];

/** Adds or drops one ancestor column and redraws: the column has to be asked of the server, and
    every move on this screen goes through the address. The open record comes along — adding a
    column, unlike changing a filter, can never leave it out of the list. */
const borrow = (t: TableMeta, a: Ancestor, c: ColumnMeta, on: boolean) => {
	const name = reachedName(a, c);
	const kept = showing(t).filter(sh => sh.name !== name);

	borrowed.set(t, on ? [...kept, reachedColumn(a, c)] : kept);
	route.go(here(opened?.key ?? []));
};

/** The one way in: it opens on the screen showing, and what it offers is what `_meta` says that
    screen points at — so a role that cannot read a table is never offered its fields. */
const ancestorField: Action = {
	text: 'Campo ancestro',
	needs: 'read',
	run: t => ancestry.open(t, showing(t).map(sh => sh.name)),
};

/** Taking the list away as a file — one action per format `_meta` publishes, so a format the
    backend gains is a line here without a word of it being written in the frontend.
    It is the list on screen that leaves: same filter, and `read` because exporting is reading.
    Nothing changed on screen, so a success says nothing either — only a failure does. */
const saveAs = (f: FormatMeta): Action => ({
	text: f.label,
	needs: 'read',
	run: t => void download(
		listPath(t.entity, { filter: filters.query(), format: f.name, reached: reached(showing(t)) }),
		`${t.entity}.${f.extension}`).catch(failSoftly),
});


// --- Subtables (SCOPE 6a) ---

/** The subtables of the record the panel is showing, and which one its tab strip has open. */
let subtables: Detail[] = [];
let subtable: Detail | null = null;
let tabs: HTMLButtonElement[] = [];

/** Built in `main`, like the toolbar's own menus. */
let details!: ActionMenu;

const detailSheet = (sub: Detail): Sheet => ({
	t: sub.table,
	columns: ownColumns(sub.table),		// ancestor columns belong to a screen, not to a table

	head: peekDetailHead,
	body: peekDetailRows,
	table: peekDetailGrid,
	empty: peekDetailEmpty,
	leastRows: 3,				// enough that a detail with one row still reads as a table
	handle: row => jump(sub.table, row),
});

/** What a subtable's rows are asked for: the master's key, written in the columns of the fk that
    carries it — the same mapping picking from that fk's list writes. So a subtable is the
    detail's own list under a filter, and there is no second way to address one. */
const under = (sub: Detail, master: Row) =>
	filterQuery(Object.entries(valuesFrom(sub.ref, master))
		.map(([column, value]) => ({ column, op: defaultOp, value })));

/** Draws the open tab's rows. Both the record and the tab are asked again once the answer is
    back, so a tab switched while one was in flight is not drawn over by the older answer. */
async function loadDetail(): Promise<void> {
	const master = opened, sub = subtable;

	if (!master || !sub) return;

	peekDetailHead.replaceChildren();
	peekDetailRows.replaceChildren();
	peekDetailGrid.hidden = true;
	peekDetailEmpty.hidden = true;

	const data = await api<Row[]>(listPath(sub.table.entity, { filter: under(sub, master.row) }));

	if (opened !== master || subtable !== sub) return;

	renderSheet(detailSheet(sub), data);
}

/** Opens one tab: marks it, points the insert menu at the table it now offers, and loads it. */
const openTab = (at: number) => {
	subtable = subtables[at] ?? null;
	tabs.forEach((button, i) => button.setAttribute('aria-selected', String(i === at)));

	if (!subtable) return;

	details.reset(subtable.table);
	void loadDetail().catch(failSoftly);
};

const tab = (sub: Detail, at: number) => {
	const button = el('button', sub.table.entity);

	button.type = 'button';
	button.setAttribute('role', 'tab');
	button.addEventListener('click', () => openTab(at));

	return button;
};

/** The panel's tab strip, rebuilt with the panel. A draft has no tabs: nothing can belong to a
    row that has not been saved. Neither has a table nothing is a detail of — `cliente` is
    pointed at twice and gets none, because neither fk lies inside its own table's pk.
    The strip stays on the same fk while that fk is still offered, so stepping through the
    records of a screen does not send it back to the first tab. */
const fillDetails = () => {
	subtables = opened?.key.length ? detailsOf(tables, opened.t) : [];
	tabs = subtables.map(tab);

	peekDetails.hidden = subtables.length === 0;
	peekTabs.replaceChildren(...tabs);

	const at = subtables.findIndex(one => one.ref === subtable?.ref);

	openTab(at < 0 ? 0 : at);
};

/** A row being inserted into the open subtable. The columns the master fixes are written already
    and are not writable — the fk *is* the master's key, seen from the detail — and they go in
    the POST whether or not they were typed. Saving comes back to the master, and drawing it
    lists the new row into the tab. */
const detailDraft = (sub: Detail, master: Peeked, from: HTMLElement): Peeked => {
	const inherited = valuesFrom(sub.ref, master.row);
	const base = draft(sub.table, from);

	return {
		...base,
		row: { ...base.row, ...inherited },
		title: `Nuevo registro de ${master.title}`,
		writable: c => !sub.ref.columns.includes(c.name),
		save: async typed => {
			await api<Row>(`/api/${encodeURIComponent(sub.table.entity)}`,
				sending('POST', { ...inherited, ...typed }));

			route.go(here(master.key));	// back to the master; drawing it lists the new row in
		},
	};
};

/** The one action a tab offers. `details.reset` has already hidden it unless the role may insert
    into the table the open tab is showing. */
const insertDetailRow: Action = {
	text: 'Insertar fila',
	needs: 'create',
	run: () => { if (opened && subtable) show(detailDraft(subtable, opened, details.button)); },
};


// --- Editing ---

/** The cell being edited — one at a time, so opening another can call it off. */
let editing: { td: HTMLTableCellElement; cancel: () => void; at: string[] } | null = null;

/** Where this tab is, as the screen itself says: the row being edited, *and* the record the
    panel holds. Both, because they can be two different records — a panel stays open while a
    cell is opened on another line — and then this tab really is in two places, so both should
    be marked on everybody else's screen. Either may be nowhere.

    Read here rather than announced by each thing that moves it. Every one of them — opening a
    record, closing it, opening a cell, closing a cell — then says the same sentence, and none
    of them has to know what the others are doing. Letting go of a row is the case that was
    missing: an editor announced itself on the way in and nothing on the way out, so to everyone
    else the row stayed held until its owner happened to open something else. */
const cursor = () => {
	if (screen) watch.at(screen.entity, editing?.at ?? [], opened?.key ?? []);
};

/** Opening an editor is the last moment before something is typed over a row, so it is where the
    row is asked whether it is still the row that was read (SCOPE 6c). It costs one read and it
    buys a refusal that lands before anything is typed rather than after: a record that moved on
    never opens, it redraws. Past this point the row is left alone until the editor closes —
    a value replaced under someone mid-word is worse than a stale one. */
async function enter(s: Sheet, row: Row, c: ColumnMeta, td: HTMLTableCellElement): Promise<void> {
	if (editing?.td === td) return;			// a double-click *inside* the open editor selects a word

	const read = row[stamp];

	try {
		await reread(s, row);
	} catch (err) {
		failSoftly(err as Error);		// no answer about the row is no ground to write over it
		return;
	}

	// A record somebody else is holding is refused here for the same reason a record that moved
	// on is: the read has already happened, and this is the last moment before something is
	// typed over it. Cheaper to say so now than to let it be typed and refused at the end.
	const taken = heldness(addressOf(s.t, row)) === 'theirs';

	if (read === row[stamp] && !taken) { edit(s, row, c, td); return; }

	const tr = td.closest('tr');

	if (tr?.isConnected) fill(tr, s, row);

	refreshPeek(s.t, row);
	say(taken ? heldBy(addressOf(s.t, row)) : CHANGED, 'error');
}

/** A cell opens into one text box for every type — no per-type widget needed. Empty is `null`;
    an fk column gets the same box plus a list beside it, see `picker.ts`. */
function edit(s: Sheet, row: Row, c: ColumnMeta, td: HTMLTableCellElement): void {
	if (editing?.td === td) return;			// a double-click *inside* the open editor selects a word

	editing?.cancel();

	const { t } = s;
	const tr = td.closest('tr');
	const before = row[c.name] === null ? '' : String(row[c.name]);
	const input = el('input');
	const fk = fkOf(t, c);

	input.type = 'text';
	input.value = before;
	input.placeholder = c.expected;
	input.title = `${c.name}: ${c.type} — ${c.expected}`;

	let list: Picker | undefined;			// built below, once the box is in the cell
	let settled = false;

	/** Puts the cell back the way the row says it is. */
	const restore = () => {
		settled = true;
		editing = null;
		list?.destroy();

		if (tr?.isConnected) fill(tr, s, row);

		cursor();			// let go of the row, so everyone else sees it let go
	};

	/** @param written what to send: the single typed column by default, or every column of a
	    picked fk instead — one value across several columns, taken all at once. */
	const commit = async (written?: Row) => {
		if (settled || !td.isConnected) return;	// Enter blurs the input straight after; so does leaving the screen

		if (written === undefined && input.value === before) { restore(); return; }

		const body = written ?? { [c.name]: input.value.trim() === '' ? null : input.value };

		settled = true;
		input.disabled = true;
		list?.close();
		td.classList.remove('bad');
		say('Guardando…', 'busy');

		try {
			await patched(s, row, body);

			editing = null;
			list?.destroy();

			if (tr?.isConnected) fill(tr, s, row);

			refreshPeek(t, row);
			cursor();			// the cell is closed: the row is no longer being held
			say(summary(s));
		} catch (err) {
			if (sessionEnded(err)) { location.reload(); return; }

			// A late write is the one refusal the editor does not stay open for: what is in the
			// box is an answer to values that are gone. `restore` is already "put the cell back
			// the way the row says it is", and `patched` has just made the row say what the
			// server says — so the editor closes and the line redraws, and neither is new code.
			if (refused(err)) { restore(); refreshPeek(t, row); say(refusal(err, addressOf(t, row)), 'error'); return; }

			settled = false;		// still on screen and still refused: let it be fixed
			input.disabled = false;
			input.focus();
			td.classList.add('bad');
			say((err as Error).message, 'error');
		}
	};

	input.addEventListener('keydown', e => {
		if (list?.handled(e)) return;					// the list answers its own keys first

		if (e.key === 'Enter') void commit();
		else if (e.key === 'Escape') { e.stopPropagation(); restore(); }	// the peek's Escape must not fire too
	});
	input.addEventListener('input', () => list?.refresh());

	// Leaving the cell is a decision; losing the window is not one. A blur while the document
	// itself still has focus is the user having gone somewhere else on this page, and the value
	// is written. A blur with the window gone — another application, another browser tab — is
	// nobody having decided anything, so the box stays open with what is half typed still in it,
	// and takes the caret back when the window comes back. Whoever returns to this page by
	// clicking something else in it lands on the second blur, which is the decision.
	input.addEventListener('blur', () => {
		if (document.hasFocus()) { void commit(); return; }

		addEventListener('focus', () => { if (!settled && td.isConnected) input.focus(); }, { once: true });
	});

	td.classList.add('editing');
	td.replaceChildren(input);

	// after the cell holds the box, so the list is not swept out with what the cell held before
	if (fk) list = picker(input, td, fk.ref, fk.target, values => void commit(values));

	input.focus();
	input.select();

	// editing a cell is being on that record, which is what a cursor is — but only on the screen's
	// own grid: a subtable's row belongs to another screen, and its master is where this tab
	// still is, which is what `cursor` falls back to
	editing = { td, cancel: restore, at: s.t === screen ? key(s.t, row) : [] };

	cursor();
}

/** A screen's line in the rail: its name, and who is on it — which is the same question the
    header answers about the screen being looked at, asked of all the others at once. The name
    is wrapped so that *it* is what gets cut short when the rail is too narrow, rather than the
    line hiding what overflows it, which would take the circles with it. */
const link = (t: TableMeta) => {
	const a = el('a', classed('span', 'name', t.entity), classed('span', 'watchers'));

	a.href = route.href({ screen: t.entity, key: [], conditions: [] });
	a.dataset.entity = t.entity;

	rails.set(t.entity, stackOf(a.querySelector('.watchers') as HTMLElement));

	return a;
};


// --- Screens ---

let tables: TableMeta[] = [];

/** The screen being viewed, so the address can be written from what is on it. */
let screen: TableMeta | null = null;

/** The screen's own sheet and the rows it drew, so that one row can be read again and put back
    without redrawing the list around it. */
let sheet: Sheet | null = null;
let listed: Row[] = [];

/** Who is signed in. A claim belongs to a user and not to a tab — which is the whole of what
    makes it different from a cursor — so the latch compares a holder against this. */
let me!: Session;

/** Built in `main`, once `_meta` has answered. */
let defaultOp!: string;
let stamp!: string;
let watch!: Watch;
let filters!: FilterBar;
let inserts!: ActionMenu;
let exports!: ActionMenu;
let ancestry!: AncestryPicker;
let route!: Router;

/** The address for what is on screen now, assembled from the screen and the bar themselves. */
const here = (record: string[] = []): View =>
	({ screen: screen?.entity ?? '', key: record, conditions: filters.conditions() });

/** The screen's own grid. It is named inside its own handle, so a row opened from it knows
    which sheet it came off. */
const gridSheet = (t: TableMeta): Sheet => {
	const s: Sheet = {
		t, columns: [...ownColumns(t), ...showing(t)],
		head: gridHead, body: gridRows, table: grid, empty: emptyNote,
		leastRows: 0,			// the screen is as long as the list; nothing is held open for it
		handle: row => opener(s, row),
	};

	return s;
};

/** Fetches rows for the screen, under whatever filter the bar currently holds. */
async function load(s: Sheet): Promise<Row[]> {
	blank();
	say('Cargando…', 'busy');

	const data = await api<Row[]>(
		listPath(s.t.entity, { filter: filters.query(), reached: reached(s.columns) }));

	sheet = s;				// what a row read again on its own has to be drawn back into
	listed = data;

	renderSheet(s, data);
	drawViewers();				// the lines are new; who is on them is not
	say(summary(s));

	return data;
}

/** Opens the record the address names, if the grid drew it. */
const reopen = (s: Sheet, wanted: string[], data: Row[]): boolean => {
	const i = data.findIndex(row => same(key(s.t, row), wanted));
	const button = s.body.children[i]?.querySelector('button');

	if (!(button instanceof HTMLButtonElement)) return false;

	show(record(s, data[i], button));

	return true;
};

/** Draws what the address says. Every move — a link, the filter bar, Back — ends here, so what
    is on screen and the address can't come apart. */
async function draw(): Promise<void> {
	const { view, unresolved } = route.read();
	const t = tables.find(x => x.entity === view.screen);

	if (!t) { route.go({ screen: tables[0].entity, key: [], conditions: [] }, true); return; }

	for (const a of nav.querySelectorAll('a'))
		a.setAttribute('aria-current', String(a.dataset.entity === t.entity));

	heading.replaceChildren(t.entity, grants(t));
	screen = t;
	watch.at(t.entity, [], []);		// a record the address names announces itself when it opens
	filters.reset(t, view.conditions);
	inserts.reset(t);
	exports.reset(t);

	const s = gridSheet(t);
	const data = await load(s);

	// report anything the address asked for that wasn't found, rather than dropping it silently
	const notes = [
		...unresolved.map(name => `filtro ignorado: ${name}`),
		...(view.key.length && !reopen(s, view.key, data)
			? [`el registro ${view.key.join(' · ')} no está en la lista`] : []),
	];

	if (notes.length) say(`${summary(s)} · ${notes.join(' · ')}`, 'error');
}

const fail = (err: Error) => {
	if (sessionEnded(err)) { location.reload(); return; }

	blank();
	say(err.message, 'error');
};

/** For what failed beside the screen rather than while drawing it — the grid still holds what
    it held, so only the status line changes. */
const failSoftly = (err: Error) => {
	if (sessionEnded(err)) { location.reload(); return; }

	say(err.message, 'error');
};

const render = () => void draw().catch(fail);

// a filter change is a move like any other: it names a new address, and drawing it reloads
const refilter = () => { if (screen) route.go(here()); };


async function main(): Promise<void> {
	me = await authenticated();		// nothing below this runs until there is a session

	let meta: SystemMeta;

	try {
		meta = await api<SystemMeta>('/api/_meta');
	} catch (err) {
		say(`No se pudo leer el esquema: ${(err as Error).message}`, 'error');
		return;
	}

	tables = meta.tables;
	fks = new Map(tables.map(t => [t, referencesOf(t)]));

	if (!tables.length) { say('No hay entidades disponibles para este usuario.'); return; }

	defaultOp = meta.defaultOperator;
	stamp = meta.stamp;
	watch = watching(meta.pollSeconds, showViewers);
	filters = filterBar(tables, meta.operators, refilter);
	inserts = actionMenu('Insertar', [insertRow, ancestorField]);
	exports = actionMenu('Exportar', meta.formats.map(saveAs), { className: 'exports', iconOnly: true });
	details = actionMenu('Insertar fila', [insertDetailRow], { className: 'tab-insert', iconOnly: true });
	ancestry = ancestryPicker(tables, borrow);
	route = router(meta);

	nav.replaceChildren(...tables.map(link));
	toolbar.append(filters.element, inserts.element);
	headerEnd.prepend(watchers);		// ahead of the counts: who is here, then what is here
	headerEnd.append(exports.element);
	peekTabbar.append(details.element);	// outside the tabs' scroll box, so its list can escape it
	peekClose.addEventListener('click', dismissPeek);
	peekForm.addEventListener('submit', e => { e.preventDefault(); void savePeek(); });
	peekCancel.addEventListener('click', cancelPeek);
	peekDelete.addEventListener('click',
		() => { if (peekDelete.dataset.armed === 'true') void removePeek(); else armDelete(); });
	addEventListener('keydown', e => { if (e.key === 'Escape') dismissPeek(); });
	route.onNavigate(render);
	render();
}

void main();
