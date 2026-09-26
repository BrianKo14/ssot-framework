import { Router, type Request, type RequestHandler } from 'express';
import type { Presence } from '../auth/presence.js';
import type { Db } from '../db/postgres.js';
import { equalities, filterConditions, parseFilter, where } from '../sql/filter.js';
import { HttpError } from '../errors.js';
import type { ColumnInfo, ReferenceInfo, TableInfo } from '../schema/model.js';
import type { Lock, Watching } from '../shared/api.js';
import { LOCK, STAMP, stored } from '../schema/reserved.js';
import { columnList, q, tableRef } from '../sql/identifier.js';
import { atBase, parseReached, reading } from '../sql/reach.js';
import { asRecord, checkedValues, namedColumns, rowValues } from '../schema/values.js';
import { formatNamed } from '../format/registry.js';
import { sendAs, wrap } from './handler.js';
import { deletableBy, permit, readableBy } from './permission.js';



// --- MASTER / DETAILS ---

/** Returns a list of path parameter names for a composite key.
 * e.g. `keyParams('pk', [colA, colB])` -> `['pk0', 'pk1']` */
const keyParams = (prefix: string, key: ColumnInfo[]) => key.map((_, i) => `${prefix}${i}`);

/** e.g. `segments(['pk0', 'pk1'])` -> `':pk0/:pk1'` */
const segments = (params: string[]) => params.map(p => `/:${p}`).join('');

/** e.g. `masterParams(ref)` -> `['mpk0', 'mpk1']` */
const masterParams = (ref: ReferenceInfo) => keyParams('mpk', ref.to.pk);


/** e.g. `detailPath(ref)` -> `'/api/cursos/2026-1/algebra'` */
const detailPath = (ref: ReferenceInfo) => `${segments(masterParams(ref))}/${ref.from.entity}`;

/** True iff the detail can be nested under its master's URL.
 * Only if its fk matches the master's *primary* key. */
const isNestable = (ref: ReferenceInfo) =>
	ref.targetColumns.length === ref.to.pk.length && ref.targetColumns.every(c => ref.to.pk.includes(c));



/** What the poll of a table is called, under that table's own path. */
const VIEWERS = '_viewers';

/** Presence + the set of entities the caller may be told about. */
export interface Seeing {
	see: Presence['see'];
	readable(req: Request): string[];
}

/** Generic CRUD router factory.
 * @param master when this table is mounted as a detail, the reference it was mounted through. */
export function crudRouter(db: Db, t: TableInfo, presence: Seeing, master?: ReferenceInfo): Router {
	const r = Router({ mergeParams: true });	// `mergeParams` lets the detail's router see the master's path parameters

	r.use(permit(t));				// first thing: authorization gate

	const cols = columnList(stored(t));		// what a write hands back: the columns, and the version they are now at
	const table = tableRef(t);
	const pkCols = columnList(t.pk);

	const pkParams = keyParams('pk', t.pk);
	const byPk = segments(pkParams);

	const fromMaster: [string, string][] = [];

	if (master) {
		const mParams = masterParams(master);

		for (const [i, c] of master.columns.entries())
			fromMaster.push([c.name, mParams[master.to.pk.indexOf(master.targetColumns[i])]]);
	}

	/** Required on insert = not nullable AND without a default. */
	const requiredOnInsert = (c: ColumnInfo) => !c.nullable && c.defaultSql === null;

	/** The row a request addresses. Path params are always strings. */
	const addressedRow = (req: Request): Record<string, unknown> =>
		checkedValues(t.pk, Object.fromEntries(t.pk.map((c, i) => [c.name, req.params[pkParams[i]]])), true);

	const withInherited = (req: Request, given: Record<string, unknown>): Record<string, unknown> => {
		const repeated = fromMaster.filter(([name]) => name in given).map(([name]) => name);

		if (repeated.length) throw new HttpError(400, `column(s) already set by the URL: ${repeated.join(', ')}`);

		return { ...given, ...Object.fromEntries(fromMaster.map(([name, param]) => [name, req.params[param]])) };
	};

	/** Stamped with the row's version. */
	const stamped = (columns: ColumnInfo[], row: Record<string, unknown>): Record<string, unknown> =>
		({ ...rowValues(columns, row), [STAMP.name]: String(row[STAMP.name]) });
	const wire = (row: Record<string, unknown>) => stamped(t.columns, row);

	/** Gets `If-Match` header.
	 * @returns parsed version, or null if none was presented.
	 * @throws 400 if the header is present but invalid. */
	const presentedVersion = (req: Request): unknown => {
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
	const holder = (req: Request): string => req.principal!.username;

	/** Is this record held by someone else? */
	const unheld = (req: Request, params: unknown[]): string[] =>
		[`(${q(LOCK.name)} is null or ${q(LOCK.name)} = $${params.push(holder(req))})`];

	/** Decide the reason why a write failed to match any row. */
	const refuseUnmatched = async (req: Request, version: unknown): Promise<never> => {
		const params: unknown[] = [];
		const addressed = where(equalities(addressedRow(req), params));
		const [row] = await db.query(`select ${q(LOCK.name)} from ${table}${addressed}`, params);

		if (row === undefined) throw new HttpError(404, 'not found');

		const held = row[LOCK.name];

		if (held !== null && held !== holder(req)) throw new HttpError(423, `locked by ${String(held)}`);

		if (version === null) throw new HttpError(423, 'the record was locked');

		throw new HttpError(412, 'the record changed since it was read');
	};


	// --- ENDPOINTS ---

	/** SELECT cols FROM table [LEFT JOIN reached...] [WHERE ...] ORDER BY pk_col1, pk_col2, ... */
	const listRows = async (req: Request) => {
		const raw = withInherited(req, parseFilter(req.query.filter)); 			// under a master, its key comes from the path
		const asked = parseReached(req.query.with);
		const read = reading(t, [...asked, ...Object.keys(raw)], readableBy(req));
		const columns = read.shown(asked);

		const params: unknown[] = [];
		const filtered = where(filterConditions(read.byName, raw, params, read.at));

		const rows = await db.query(
			`${read.statement([...columns, STAMP], filtered)} order by ${read.order}`, params);	// sort by primary key

		return { columns, rows: rows.map(row => stamped(columns, row)) };
	};

	// GET /[?filter={"col":value,"col2":{"op":"ge","value":…},...}][&with=["fk.col",…]][&format=xlsx|txt]
	r.get('/', wrap(async (req, res) => {
		const format = formatNamed(req.query.format);					// before the query: a bad format costs no round trip
		const { columns, rows } = await listRows(req);

		await sendAs(res, format, {
			name: t.entity,
			columns,								// the table's own, plus whatever it reached: exporting is reading
			pk: t.pk.map(c => c.name),
			rows,
		});
	}));

	/** A list of all the records that are currently locked. */
	const claims = async (): Promise<Lock[]> => {
		const rows = await db.query(
			`select ${pkCols}, ${q(LOCK.name)} from ${table} where ${q(LOCK.name)} is not null`);

		return rows.map(row => ({
			record: t.pk.map(c => String(row[c.name])).join('/'),
			holder: String(row[LOCK.name]),
		}));
	};

	/** Who else has this table open, on which record + what is held.
	 * A GET request that also writes to refresh the caller's presence.
	 * Requires only view access. */
	const watching = (addressed: boolean): RequestHandler => wrap(async (req, res) => {
		const row = addressed ? addressedRow(req) : null;		     // validated elsewhere

		const [seen, locks] = await Promise.all([
			presence.see({
				tab: req.query.tab,
				user: req.principal!.username,
				entity: t.entity,
				record: row && t.pk.map(c => String(row[c.name])).join('/'), // PK from validated row data
				within: presence.readable(req),				     // every screen this role may open
			}),
			claims(),
		]);

		res.json({ ...seen, locks } satisfies Watching);
	});

	// GET /_viewers[?tab=…] — before `byPk`, so the name wins over a single-column key
	r.get(`/${VIEWERS}`, watching(false));

	// GET /:pk0[/:pk1...]/_viewers[?tab=…]
	r.get(`${byPk}/${VIEWERS}`, watching(true));

	// GET /:pk0[/:pk1...][?with=["fk.col",…]]
	// SELECT cols FROM table [LEFT JOIN reached...] WHERE pk_col1 = $1 AND pk_col2 = $2 ...
	r.get(byPk, wrap(async (req, res) => {
		const asked = parseReached(req.query.with);
		const read = reading(t, asked, readableBy(req));
		const columns = read.shown(asked);

		const params: unknown[] = [];
		const addressed = where(equalities(addressedRow(req), params, atBase));

		const rows = await db.query(read.statement([...columns, STAMP], addressed), params);

		if (!rows.length) { res.status(404).json({ error: 'not found' }); return; }

		res.json(stamped(columns, rows[0]));
	}));

	// POST /
	// INSERT INTO table (col1, col2, ...) VALUES ($1, $2, ...) RETURNING *
	r.post('/', wrap(async (req, res) => {
		const body = withInherited(req, asRecord(req.body));			    // under a master, its key comes from the path
		namedColumns(t.byName, body);						    // refuse columns the schema does not declare

		const given = t.columns.filter(c => c.name in body || requiredOnInsert(c)); // columns the body provided + required ones the body omitted

		if (!given.length) { res.status(400).json({ error: 'no columns provided' }); return; }

		const values = checkedValues(given, body, true);

		const ph = given.map((_, i) => `$${i + 1}`).join(', '); 	            // build "$1, $2, ..." placeholders for the query

		const rows = await db.query(
			`insert into ${table} (${columnList(given)}) values (${ph}) returning ${cols}`,
			given.map(c => values[c.name])
		);

		res.status(201).json(wire(rows[0]));				            // return the newly created row, including the primary key
	}));

	const updatable = t.columns.filter(c => !t.pk.includes(c));

	/** UPDATE table SET col1 = $1, col2 = $2, ... WHERE pk_col1 = $N ... RETURNING cols
	* @param columnsToSet PATCH picks, which of the updatable columns to write */
	const update = (columnsToSet: (body: Record<string, unknown>) => ColumnInfo[]): RequestHandler =>
		wrap(async (req, res) => {
			const body = asRecord(req.body);
			namedColumns(t.byName, body);				// refuse columns the schema does not declare

			const given = columnsToSet(body);

			if (!given.length) { res.status(400).json({ error: 'no updatable columns provided' }); return; }

			const values = checkedValues(given, body, true);
			const version = presentedVersion(req);

			const params: unknown[] = [];

			// Update the columns the body provided
			const sets = [
				...given.map(c => `${q(c.name)} = $${params.push(values[c.name])}`),
				`${q(STAMP.name)} = ${q(STAMP.name)} + 1`,	// updated on every write
			].join(', ');

			const addressed = where([
				...equalities(addressedRow(req), params),
				...unchanged(version, params),
				...unheld(req, params),
			]);

			const rows = await db.query(
				`update ${table} set ${sets}${addressed} returning ${cols}`, params);

			if (!rows.length) await refuseUnmatched(req, version);

			res.json(wire(rows[0]));
		});

	// PUT /:pk0[/:pk1...] — full update, omitted columns set to null
	r.put(byPk, update(() => updatable));

	// PATCH /:pk0[/:pk1...] — partial update
	r.patch(byPk, update(body => updatable.filter(c => c.name in body)));

	// DELETE /:pk0[/:pk1...]
	// DELETE FROM table WHERE pk_col1 = $1 AND pk_col2 = $2 ...
	r.delete(byPk, wrap(async (req, res) => {
		const version = presentedVersion(req);

		const params: unknown[] = [];
		const addressed = where([
			...equalities(addressedRow(req), params),
			...unchanged(version, params),
			...unheld(req, params),
		]);

		const rows = await db.query(
			`delete from ${table}${addressed} returning ${pkCols}`, params);

		if (!rows.length) await refuseUnmatched(req, version);

		res.status(204).end();
	}));

	const refuseUnclaimed = async (req: Request): Promise<never> => {
		const params: unknown[] = [];
		const addressed = where(equalities(addressedRow(req), params));
		const [row] = await db.query(`select 1 from ${table}${addressed}`, params);

		throw row === undefined
			? new HttpError(404, 'not found')
			: new HttpError(403, `not allowed to take somebody else's claim on ${t.entity}`);
	};

	// LOCK /:pk0[/:pk1...] — claim the record, so that nobody else may write it
	r.lock(byPk, wrap(async (req, res) => {
		const params: unknown[] = [];
		const set = `${q(LOCK.name)} = $${params.push(holder(req))}`;
		const addressed = where([...equalities(addressedRow(req), params), ...unheld(req, params)]);

		const rows = await db.query(
			`update ${table} set ${set}${addressed} returning ${pkCols}`, params);

		if (!rows.length) await refuseUnmatched(req, null);	// gone, or somebody else's

		res.status(204).end();
	}));

	// UNLOCK /:pk0[/:pk1...] — let the claim go.
	r.unlock(byPk, wrap(async (req, res) => {
		// Note: taking a claim off somebody else asks for `delete` on the record.
		const forcing = deletableBy(req)(t);

		const params: unknown[] = [];
		const addressed = where([
			...equalities(addressedRow(req), params),
			...(forcing ? [] : unheld(req, params)),
		]);

		const rows = await db.query(
			`update ${table} set ${q(LOCK.name)} = null${addressed} returning ${pkCols}`, params);

		if (!rows.length) await refuseUnclaimed(req);

		res.status(204).end();
	}));

	return r;
}


/** Gather all the CRUD routers for the given tables. Mounted whole at `/api`. */
export function entityRouter(db: Db, tables: TableInfo[], presence: Presence): Router {
	const r = Router();

	const seeing: Seeing = {
		see: presence.see,
		readable: req => tables.filter(readableBy(req)).map(t => t.entity),
	};

	for (const t of tables) {					// per table CRUD router at /api/<table>
		r.use(`/${t.entity}`, crudRouter(db, t, seeing));

		// ...and mount each of its details' collections under it, at /api/<master>/<master key>/<detail>.
		for (const ref of t.details.filter(isNestable))
			r.use(`/${t.entity}${detailPath(ref)}`, crudRouter(db, ref.from, seeing, ref));
	}

	return r;
}