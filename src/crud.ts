import { Router, type Request, type RequestHandler } from 'express';
import type { Db } from './db.js';
import { HttpError } from './http.js';
import type { ColumnInfo, TableInfo } from './schema.js';
import { asRecord, checkedValues, namedColumns, rowValues } from './validate.js';

/** Quote an identifier for use in a SQL query; treat them as names, not commands */
const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;

/** Wraps route handler to reroute errors to the error handling middleware instead of crashing the process.
 * Technically, Express 5 will handle this. Keeping it to make control flow explicit. */
const wrap = (h: RequestHandler): RequestHandler =>
	(req, res, next) => { void Promise.resolve(h(req, res, next)).catch(next); };


// --- Filtering ---

type Filter = Record<string, unknown>;

/** Filter object -> SQL conditions.
 * If the value is null, it writes '"nombre" is null'. Otherwise, '"nombres" = $n' and pushes the value onto `params`. */
const conditions = (filter: Filter, params: unknown[]): string[] =>
	Object.entries(filter).map(([col, value]) =>
		value === null ? `${q(col)} is null` : `${q(col)} = $${params.push(value)}`);

/** WHERE clause builder */
const where = (conds: string[]) => conds.length ? ` where ${conds.join(' and ')}` : '';



/** Generic CRUD router factory */
export function crudRouter(db: Db, t: TableInfo): Router {
	const r = Router();

	/** Lookup table for columns in O(1) */
	const byName = new Map(t.columns.map(c => [c.name, c]));

	const cols = t.columns.map(c => q(c.name)).join(', ');
	const table = q(t.table);
	const pkCols = t.pk.map(c => q(c.name)).join(', ');

	// One path segment per primary key column, so a composite key addresses a row as /api/cursos/2026-1/algebra
	const pkParams = t.pk.map((_, i) => `pk${i}`);
	const byPk = '/' + pkParams.map(p => `:${p}`).join('/');

	const parseFilter = (raw: unknown): Filter => {
		if (raw === undefined) return {};
		if (typeof raw !== 'string') throw new HttpError(400, 'filter must be given once');

		let parsed: unknown;
		try { parsed = JSON.parse(raw); }
		catch { throw new HttpError(400, 'filter is not valid JSON'); }

		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
			throw new HttpError(400, 'filter must be a JSON object');

		return parsed as Filter;
	};

	/** Required on insert = not nullable AND wihtout a default.
	 * But TODO: FieldDef has no default/generated at the moment. */
	const requiredOnInsert = (c: ColumnInfo) => !c.nullable;

	/** The row a request addresses. Path params are always strings. */
	const addressedRow = (req: Request): Filter =>
		checkedValues(t.pk, Object.fromEntries(t.pk.map((c, i) => [c.name, req.params[pkParams[i]]])), true);

	/** This is the conversation step that would usually happen inside Postgres, moved to where the type definitions live. See `db.ts` for the default override.
	 * It walks the row's columns and asks each column's own type handler to read its text. */	
	const wire = (row: Record<string, unknown>) => rowValues(t.columns, row);



	/** --- ENDPOINTS --- **/

	// GET /[?filter={"col":value,...}]
	// SELECT cols FROM table [WHERE col = $1 AND col2 IS NULL ...] ORDER BY pk_col1, pk_col2, ...
	r.get('/', wrap(async (req, res) => {
		const raw = parseFilter(req.query.filter);
		// DEBUG: `required: false` — a null here asks `is null`, it does not assert the column is nullable.
		const filter = checkedValues(namedColumns(byName, raw), raw, false);

		const params: unknown[] = [];
		const filtered = where(conditions(filter, params));

		const rows = await db.query(
			`select ${cols} from ${table}${filtered} order by ${pkCols}`, params);	// sort by primary key

		res.json(rows.map(wire));
	}));

	// GET /:pk0[/:pk1...]
	// SELECT cols FROM table WHERE pk_col1 = $1 AND pk_col2 = $2 ...
	r.get(byPk, wrap(async (req, res) => {
		const params: unknown[] = [];
		const addressed = where(conditions(addressedRow(req), params));

		const rows = await db.query(`select ${cols} from ${table}${addressed}`, params);

		if (!rows.length) { res.status(404).json({ error: 'not found' }); return; }

		res.json(wire(rows[0]));
	}));

	// POST /
	// INSERT INTO table (col1, col2, ...) VALUES ($1, $2, ...) RETURNING *
	r.post('/', wrap(async (req, res) => {
		const body = asRecord(req.body);
		namedColumns(byName, body);						    // refuse columns the schema does not declare

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
			namedColumns(byName, body);				// refuse columns the schema does not declare

			const given = columnsToSet(body);

			if (!given.length) { res.status(400).json({ error: 'no updatable columns provided' }); return; }

			const values = checkedValues(given, body, true);

			const params: unknown[] = [];
			const sets = given.map(c => `${q(c.name)} = $${params.push(values[c.name])}`).join(', ');
			const addressed = where(conditions(addressedRow(req), params));

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
		const addressed = where(conditions(addressedRow(req), params));

		const rows = await db.query(
			`delete from ${table}${addressed} returning ${pkCols}`, params);

		res.status(rows.length ? 204 : 404).end();
	}));



	return r;
}