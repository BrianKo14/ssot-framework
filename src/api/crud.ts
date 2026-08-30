import { Router, type Request, type RequestHandler } from 'express';
import type { Db } from '../db/postgres.js';
import { equalities, filterConditions, parseFilter, where } from '../sql/filter.js';
import { HttpError } from '../errors.js';
import type { ColumnInfo, ReferenceInfo, TableInfo } from '../schema/model.js';
import { q } from '../sql/identifier.js';
import { asRecord, checkedValues, namedColumns, rowValues } from '../schema/values.js';

/** Wraps route handler to reroute errors to the error handling middleware instead of crashing the process.
 * Technically, Express 5 will handle this. Keeping it to make control flow explicit. */
const wrap = (h: RequestHandler): RequestHandler =>
	(req, res, next) => { void Promise.resolve(h(req, res, next)).catch(next); };



// --- Master / Details ---

/** Returns a list of path parameter names for a composite key.
 * e.g. `keyParams('pk', [colA, colB])` -> `['pk0', 'pk1']` */
const keyParams = (prefix: string, key: ColumnInfo[]) => key.map((_, i) => `${prefix}${i}`);

/** e.g. `segments(['pk0', 'pk1'])` -> `':pk0/:pk1'` */
const segments = (params: string[]) => params.map(p => `/:${p}`).join('');

/** e.g. `masterParams(ref)` -> `['mpk0', 'mpk1']` */
const masterParams = (ref: ReferenceInfo) => keyParams('mpk', ref.to.pk);


/** e.g. `detailPath(ref)` -> `'/api/cursos/2026-1/algebra'` */
export const detailPath = (ref: ReferenceInfo) => `${segments(masterParams(ref))}/${ref.from.table}`;

/** True iff the detail can be nested under its master's URL.
 * Only if its fk matches the master's *primary* key. */
export const isNestable = (ref: ReferenceInfo) =>
	ref.targetColumns.length === ref.to.pk.length && ref.targetColumns.every(c => ref.to.pk.includes(c));



/** Generic CRUD router factory.
 * @param master when this table is mounted as a detail, the reference it was mounted through. */
export function crudRouter(db: Db, t: TableInfo, master?: ReferenceInfo): Router {
	const r = Router({ mergeParams: true });		// `mergeParams` lets the detail's router see the master's path parameters

	const cols = t.columns.map(c => q(c.name)).join(', ');
	const table = q(t.table);
	const pkCols = t.pk.map(c => q(c.name)).join(', ');

	const pkParams = keyParams('pk', t.pk);
	const byPk = segments(pkParams);

	const fromMaster: [string, string][] = [];

	if (master) {
		const mParams = masterParams(master);

		for (const [i, c] of master.columns.entries())
			fromMaster.push([c.name, mParams[master.to.pk.indexOf(master.targetColumns[i])]]);
	}

	/** Required on insert = not nullable AND wihtout a default.
	 * But TODO: FieldDef has no default/generated at the moment. */
	const requiredOnInsert = (c: ColumnInfo) => !c.nullable;

	/** The row a request addresses. Path params are always strings. */
	const addressedRow = (req: Request): Record<string, unknown> =>
		checkedValues(t.pk, Object.fromEntries(t.pk.map((c, i) => [c.name, req.params[pkParams[i]]])), true);

	const withInherited = (req: Request, given: Record<string, unknown>): Record<string, unknown> => {
		const repeated = fromMaster.filter(([name]) => name in given).map(([name]) => name);

		if (repeated.length) throw new HttpError(400, `column(s) already set by the URL: ${repeated.join(', ')}`);

		return { ...given, ...Object.fromEntries(fromMaster.map(([name, param]) => [name, req.params[param]])) };
	};

	/** This is the conversation step that would usually happen inside Postgres, moved to where the type definitions live. See `db/postgres.ts` for the default override.
	 * It walks the row's columns and asks each column's own type handler to read its text. */	
	const wire = (row: Record<string, unknown>) => rowValues(t.columns, row);



	/** --- ENDPOINTS --- **/

	// GET /[?filter={"col":value,"col2":{"op":"ge","value":…},...}]
	// SELECT cols FROM table [WHERE col = $1 AND col2 >= $2 ...] ORDER BY pk_col1, pk_col2, ...
	r.get('/', wrap(async (req, res) => {
		const raw = withInherited(req, parseFilter(req.query.filter)); 			// under a master, its key comes from the path

		const params: unknown[] = [];
		const filtered = where(filterConditions(t.byName, raw, params));

		const rows = await db.query(
			`select ${cols} from ${table}${filtered} order by ${pkCols}`, params);	// sort by primary key

		res.json(rows.map(wire));
	}));

	// GET /:pk0[/:pk1...]
	// SELECT cols FROM table WHERE pk_col1 = $1 AND pk_col2 = $2 ...
	r.get(byPk, wrap(async (req, res) => {
		const params: unknown[] = [];
		const addressed = where(equalities(addressedRow(req), params));

		const rows = await db.query(`select ${cols} from ${table}${addressed}`, params);

		if (!rows.length) { res.status(404).json({ error: 'not found' }); return; }

		res.json(wire(rows[0]));
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
			`insert into ${table} (${given.map(c => q(c.name)).join(', ')}) values (${ph}) returning ${cols}`,
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

			const params: unknown[] = [];
			const sets = given.map(c => `${q(c.name)} = $${params.push(values[c.name])}`).join(', ');
			const addressed = where(equalities(addressedRow(req), params));

			const rows = await db.query(
				`update ${table} set ${sets}${addressed} returning ${cols}`, params);

			if (!rows.length) { res.status(404).json({ error: 'not found' }); return; }

			res.json(wire(rows[0]));
		});

	// PUT /:pk0[/:pk1...] — full update, omitted columns set to null
	r.put(byPk, update(() => updatable));

	// PATCH /:pk0[/:pk1...] — partial update
	r.patch(byPk, update(body => updatable.filter(c => c.name in body)));

	// DELETE /:pk0[/:pk1...]
	// DELETE FROM table WHERE pk_col1 = $1 AND pk_col2 = $2 ...
	r.delete(byPk, wrap(async (req, res) => {
		const params: unknown[] = [];
		const addressed = where(equalities(addressedRow(req), params));

		const rows = await db.query(
			`delete from ${table}${addressed} returning ${pkCols}`, params);

		res.status(rows.length ? 204 : 404).end();
	}));



	return r;
}