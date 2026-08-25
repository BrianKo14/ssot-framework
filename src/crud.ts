import { Router, type Request, type RequestHandler } from 'express';
import type { Db } from './db.js';
import { HttpError } from './http.js';
import type { TableInfo } from './schema.js';

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

const where = (conds: string[]) => conds.length ? ` where ${conds.join(' and ')}` : '';

/** Checks whether a filter value is simple and not a complex object. */
const isScalar = (v: unknown) => v === null || ['string', 'number', 'boolean'].includes(typeof v);



/** Generic CRUD router factory */
export function crudRouter(db: Db, t: TableInfo): Router {
	const r = Router();

	const cols = t.columns.map(q).join(', ');
	const table = q(t.table);
	const pkCols = t.pk.map(q).join(', ');

	// One path segment per primary key column, so a composite key addresses a row as /api/cursos/2026-1/algebra
	const pkParams = t.pk.map((_, i) => `pk${i}`);
	const byPk = '/' + pkParams.map(p => `:${p}`).join('/');

	/** Request -> Primary key filter */
	const pkFilter = (req: Request): Filter =>
		Object.fromEntries(t.pk.map((c, i) => [c, req.params[pkParams[i]]]));

	/** Reads the basic filter off the querystring: one JSON object, `{"col": value}` */
	const parseFilter = (raw: unknown): Filter => {
		if (raw === undefined) return {};
		if (typeof raw !== 'string') throw new HttpError(400, 'filter must be given once');

		let parsed: unknown;
		try { parsed = JSON.parse(raw); }
		catch { throw new HttpError(400, 'filter is not valid JSON'); }

		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
			throw new HttpError(400, 'filter must be a JSON object');

		const filter = parsed as Filter;

		// The column names are the schema's, never the caller's: unknown keys are refused.
		const unknown = Object.keys(filter).filter(c => !t.columns.includes(c));
		if (unknown.length) throw new HttpError(400, `unknown filter column(s): ${unknown.join(', ')}`);

		const complex = Object.keys(filter).filter(c => !isScalar(filter[c]));
		if (complex.length) throw new HttpError(400, `filter value must be a scalar: ${complex.join(', ')}`);

		return filter;
	};



	/** --- ENDPOINTS --- **/

	// GET /[?filter={"col":value,...}]
	// SELECT cols FROM table [WHERE col = $1 AND col2 IS NULL ...] ORDER BY pk_col1, pk_col2, ...
	r.get('/', wrap(async (req, res) => {
		const params: unknown[] = [];
		const filtered = where(conditions(parseFilter(req.query.filter), params));	// fills params

		const rows = await db.query(
			`select ${cols} from ${table}${filtered} order by ${pkCols}`, params);	// sort by primary key

		res.json(rows);
	}));

	// GET /:pk0[/:pk1...]
	// SELECT cols FROM table WHERE pk_col1 = $1 AND pk_col2 = $2 ...
	r.get(byPk, wrap(async (req, res) => {
		const params: unknown[] = [];
		const addressed = where(conditions(pkFilter(req), params));

		const rows = await db.query(`select ${cols} from ${table}${addressed}`, params);

		if (!rows.length) { res.status(404).json({ error: 'not found' }); return; }

		res.json(rows[0]);
	}));

	// POST /
	// INSERT INTO table (col1, col2, ...) VALUES ($1, $2, ...) RETURNING *
	r.post('/', wrap(async (req, res) => {
		const body = req.body as Record<string, unknown>;

		const given = t.columns.filter(c => c in body);  		// only allow columns that are in the schema
		const ph = given.map((_, i) => `$${i + 1}`).join(', '); 	// build "$1, $2, ..." placeholders for the query

		const rows = await db.query(
			`insert into ${table} (${given.map(q).join(', ')}) values (${ph}) returning ${cols}`,
			given.map(c => body[c])
		);

		res.status(201).json(rows[0]);					// return the newly created row, including the primary key
	}));

	/** The columns an update may write. The pk addresses the row, so it is never one of them */
	const updatable = t.columns.filter(c => !t.pk.includes(c));

	/** UPDATE table SET col1 = $1, col2 = $2, ... WHERE pk_col1 = $N ... RETURNING cols
	* @param columnsToSet PATCH picks, which of the updatable columns to write */
	const update = (columnsToSet: (body: Record<string, unknown>) => string[]): RequestHandler =>
		wrap(async (req, res) => {
			const body = req.body as Record<string, unknown>;
			const given = columnsToSet(body);

			if (!given.length) { res.status(400).json({ error: 'no updatable columns provided' }); return; }

			const params: unknown[] = [];
			// Build "col1 = $1, col2 = $2, ..."; a column the body leaves out is written as null
			const sets = given.map(c => `${q(c)} = $${params.push(body[c] ?? null)}`).join(', ');
			const addressed = where(conditions(pkFilter(req), params));

			const rows = await db.query(
				`update ${table} set ${sets}${addressed} returning ${cols}`, params);

			if (!rows.length) { res.status(404).json({ error: 'not found' }); return; }

			res.json(rows[0]);
		});

	// PUT /:pk0[/:pk1...] — full update, omitted columns set to null
	r.put(byPk, update(() => updatable));

	// PATCH /:pk0[/:pk1...] — partial update
	r.patch(byPk, update(body => updatable.filter(c => c in body)));

	// DELETE /:pk0[/:pk1...]
	// DELETE FROM table WHERE pk_col1 = $1 AND pk_col2 = $2 ...
	r.delete(byPk, wrap(async (req, res) => {
		const params: unknown[] = [];
		const addressed = where(conditions(pkFilter(req), params));

		const rows = await db.query(
			`delete from ${table}${addressed} returning ${pkCols}`, params);

		res.status(rows.length ? 204 : 404).end();
	}));



	return r;
}