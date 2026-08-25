import { Router, type Request, type RequestHandler } from 'express';
import type { Db } from './db.js';
import type { TableInfo } from './schema.js';

// Following the SSOT pattern, the source of truth for the table structure comes in from the schema, not the database.

/** Quote an identifier for use in a SQL query; treat them as names, not commands */
const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;

/** Wraps route handler to reroute errors to the error handling middleware instead of crashing the process.
 * Technically, Express 5 will handle this. Keeping it to make control flow explicit. */
const wrap = (h: RequestHandler): RequestHandler =>
	(req, res, next) => { void Promise.resolve(h(req, res, next)).catch(next); };



/** Generic CRUD router factory */
export function crudRouter(db: Db, t: TableInfo): Router {
	const r = Router();

	const cols = t.columns.map(q).join(', ');
	const table = q(t.table);
	const pkCols = t.pk.map(q).join(', ');

	// One path segment per primary key column, so a composite key addresses a row as /api/cursos/2026-1/algebra
	const pkParams = t.pk.map((_, i) => `pk${i}`);
	const byPk = '/' + pkParams.map(p => `:${p}`).join('/');

	/** Builds the "pk_col1 = $1 and pk_col2 = $2 ..." conjunction that addresses a single row.
	 * @param used how many placeholders the query already spent, so the numbering continues from there */
	const pkFilter = (used: number) => t.pk.map((c, i) => `${q(c)} = $${used + i + 1}`).join(' and ');

	/** Reads the primary key values out of the path, in the order the schema declares the columns */
	const pkValues = (req: Request) => pkParams.map(p => req.params[p]);



	/** --- ENDPOINTS --- **/

	// GET /
	// SELECT cols FROM table ORDER BY pk_col1, pk_col2, ...
	r.get('/', wrap(async (req, res) => {
		const rows = await db.query(`select ${cols} from ${table} order by ${pkCols}`);	// sort by primary key
		res.json(rows);
	}));

	// GET /:pk0[/:pk1...]
	// SELECT cols FROM table WHERE pk_col1 = $1 AND pk_col2 = $2 ...
	r.get(byPk, wrap(async (req, res) => {
		const rows = await db.query(
			`select ${cols} from ${table} where ${pkFilter(0)}`, pkValues(req));

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

			const sets = given.map((c, i) => `${q(c)} = $${i + 1}`).join(', ');	// build "col1 = $1, col2 = $2, ..." for the query

			const rows = await db.query(
				`update ${table} set ${sets} where ${pkFilter(given.length)} returning ${cols}`,
				[...given.map(c => body[c] ?? null), ...pkValues(req)]	// a column the body leaves out is written as null
			);

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
		const rows = await db.query(
			`delete from ${table} where ${pkFilter(0)} returning ${pkCols}`, pkValues(req)
		);

		res.status(rows.length ? 204 : 404).end();
	}));



	return r;
}