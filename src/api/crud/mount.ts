// One table's router

import { type Request, Router } from 'express';
import type { Send } from './children.js';
import { type Changes, UNDO } from '../../auth/changes.js';
import type { Db } from '../../db/postgres.js';
import { HttpError } from '../../errors.js';
import type { ColumnInfo, ReferenceInfo, TableInfo } from '../../schema/model.js';
import { LOCK, STAMP, stored } from '../../schema/reserved.js';
import { checkedValues, namedColumns, rowValues } from '../../schema/values.js';
import { equalities, where } from '../../sql/filter.js';
import { columnList, q, tableRef } from '../../sql/identifier.js';


type Row = Record<string, unknown>;

/** Every router of a table is one of these.
 * `mergeParams` lets a detail's routers see the master's path parameters. */
export const routes = () => Router({ mergeParams: true });



// --- MASTER / DETAILS ---

/** Returns a list of path parameter names for a composite key.
 * e.g. `keyParams('pk', [colA, colB])` -> `['pk0', 'pk1']` */
const keyParams = (prefix: string, key: ColumnInfo[]) => key.map((_, i) => `${prefix}${i}`);

/** e.g. `segments(['pk0', 'pk1'])` -> `':pk0/:pk1'` */
const segments = (params: string[]) => params.map(p => `/:${p}`).join('');

/** e.g. `masterParams(ref)` -> `['mpk0', 'mpk1']` */
const masterParams = (ref: ReferenceInfo) => keyParams('mpk', ref.to.pk);


/** e.g. `detailPath(ref)` -> `'/api/cursos/2026-1/algebra'` */
export const detailPath = (ref: ReferenceInfo) => `${segments(masterParams(ref))}/${ref.from.entity}`;

/** True iff the detail can be nested under its master's URL.
 * Only if its fk matches the master's *primary* key. */
export const isNestable = (ref: ReferenceInfo) =>
	ref.targetColumns.length === ref.to.pk.length && ref.targetColumns.every(c => ref.to.pk.includes(c));



// --- ROWS ON THE WIRE ---

/** A record's address, checked by the pk's handler. */
const addressIn = (t: TableInfo) => (row: Row) => t.pk.map(c => String(row[c.name])).join('/');

/** Stamped with the row's version. */
const stamped = (columns: ColumnInfo[], row: Row): Row =>
	({ ...rowValues(columns, row), [STAMP.name]: String(row[STAMP.name]) });

/** The rows of a table as they go out.
 * Columns + version + last overwrite. A child row goes out the same way (see `children.ts`). */
const sender = (changes: Changes): Send => async (t, columns, rows) => {
	const addressOf = addressIn(t);
	const undoable = await changes.newest(t.entity, rows.map(addressOf));

	return rows.map(row => ({ ...stamped(columns, row), [UNDO]: undoable.get(addressOf(row)) ?? {} }));
};



// --- THE MOUNT ---

/** One table, as mounted at one URL: its own, or under its master's. */
export interface Mount {
	db: Db;
	t: TableInfo;
	changes: Changes;
	/** The table, as SQL names it. */
	table: string;
	/** What a write hands back: the columns, and the version they are now at. */
	cols: string;
	pkCols: string;
	/** The path of one record, e.g. `/:pk0/:pk1`. */
	byPk: string;
	/** What a write may set: everything but the pk. */
	updatable: ColumnInfo[];
	addressOf(row: Row): string;
	/** The row a request addresses. Path params are always strings. */
	addressedRow(req: Request): Row;
	/** Under a master, its key comes from the path, and the body may not say it again. */
	withInherited(req: Request, given: Row): Row;
	/** `select <select> from <table> where <the addressed row>` */
	lookUp(req: Request, select: string): Promise<Row | undefined>;
	send: Send;
	sent(columns: ColumnInfo[], rows: Row[]): Promise<Row[]>;
	/** One row of the table's own columns, as it goes out. */
	wire(row: Row): Promise<Row>;
}

/** @param master when this table is mounted as a detail, the reference it was mounted through. */
export function mounted(db: Db, t: TableInfo, changes: Changes, master?: ReferenceInfo): Mount {
	const table = tableRef(t);

	const pkParams = keyParams('pk', t.pk);

	/** Each column the master's path sets, with the parameter it comes in. */
	const fromMaster: [string, string][] = [];

	if (master) {
		const mParams = masterParams(master);

		for (const [i, c] of master.columns.entries())
			fromMaster.push([c.name, mParams[master.to.pk.indexOf(master.targetColumns[i])]]);
	}

	const addressedRow = (req: Request): Row =>
		checkedValues(t.pk, Object.fromEntries(t.pk.map((c, i) => [c.name, req.params[pkParams[i]]])), true);

	const send = sender(changes);
	const sent = (columns: ColumnInfo[], rows: Row[]) => send(t, columns, rows);

	return {
		db, t, changes, table, send, sent,
		cols: columnList(stored(t)),
		pkCols: columnList(t.pk),
		byPk: segments(pkParams),
		updatable: t.columns.filter(c => !t.pk.includes(c)),
		addressOf: addressIn(t),
		addressedRow,

		withInherited: (req, given) => {
			const repeated = fromMaster.filter(([name]) => name in given).map(([name]) => name);

			if (repeated.length) throw new HttpError(400, `column(s) already set by the URL: ${repeated.join(', ')}`);

			return { ...given, ...Object.fromEntries(fromMaster.map(([name, param]) => [name, req.params[param]])) };
		},

		lookUp: async (req, select) => {
			const params: unknown[] = [];
			const [row] = await db.query(`select ${select} from ${table}${where(equalities(addressedRow(req), params))}`, params);

			return row;
		},

		wire: async row => (await sent(t.columns, [row]))[0],
	};
}


/** What a record's history is called, under that record's own path. */
export const CHANGES = '_changes';

/** The column a history is about (when it's about one column and not a whole record). */
export const askedField = (t: TableInfo, raw: unknown): string | null => {
	if (raw === undefined) return null;

	if (typeof raw !== 'string') throw new HttpError(400, `${CHANGES}: field must name one column`);

	return namedColumns(t.byName, { [raw]: null })[0].name;
};



// --- PRECONDITIONS ---

/** Gets `If-Match` header.
 * @returns parsed version, or null if none was presented.
 * @throws 400 if the header is present but invalid. */
export const presentedVersion = (req: Request): unknown => {
	const raw = req.get('If-Match');

	if (raw === undefined) return null;

	const checked = STAMP.type.check(raw.replace(/^"(.*)"$/, '$1'));

	if (!checked.ok) throw new HttpError(400, `If-Match must be ${STAMP.type.expected}`);

	return checked.value;
};

/** Adds the version to the query parameters if it was given. */
const unchanged = (version: unknown, params: unknown[]): string[] =>
	version === null ? [] : equalities({ [STAMP.name]: version }, params);

/** Who the caller is, as a claim on a record records them. */
export const holder = (req: Request): string => req.principal!.username;

/** Is this record held by someone else? */
export const unheld = (req: Request, params: unknown[]): string[] =>
	[`(${q(LOCK.name)} is null or ${q(LOCK.name)} = $${params.push(holder(req))})`];

/** What a write to a record holds to: still at the version presented, and nobody else's claim.
 * Goes after the address, so the `$n` keep the order the params were pushed in. */
export const preconditions = (req: Request, version: unknown, params: unknown[]): string[] =>
	[...unchanged(version, params), ...unheld(req, params)];

/** Decide the reason why a write failed to match any row.
 * @param otherwise the reason to give when the record itself explains nothing — it is there,
 *        it is free, and it is at the version that was presented. A write that said something
 *        has none: all that is left is a race on the claim. */
export const refuseUnmatched = async (m: Mount, req: Request, version: unknown, otherwise?: HttpError): Promise<never> => {
	const row = await m.lookUp(req, q(LOCK.name));

	if (row === undefined) throw new HttpError(404, 'not found');

	const held = row[LOCK.name];

	if (held !== null && held !== holder(req)) throw new HttpError(423, `locked by ${String(held)}`);

	if (otherwise !== undefined) throw otherwise;

	if (version === null) throw new HttpError(423, 'the record was locked');

	throw new HttpError(412, 'the record changed since it was read');
};
