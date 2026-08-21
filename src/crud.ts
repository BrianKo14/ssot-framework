import { Router, type RequestHandler } from 'express';
import type { Db } from './db.js';

// Following the SSOT pattern, the source of truth for the table structure comes in from the schema, not the database.
export interface TableInfo {
	table: string;
	pk: string;
	columns: string[];		// columns we're allowed to read/write
}

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
	const pk = q(t.pk);


	// GET /
	// SELECT * FROM table ORDER BY primary_key
	r.get('/', wrap(async (req, res) => {
		const rows = await db.query(`select ${cols} from ${table} order by ${pk}`);	// sort by primary key
		res.json(rows);
	}));

	// GET /:id
	// SELECT * FROM table WHERE primary_key = $1
	r.get('/:id', wrap(async (req, res) => {
		const rows = await db.query(
			`select ${cols} from ${table} where ${pk} = $1`, [req.params.id]);
		
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

	// PATCH /:id
	// UPDATE table SET col1 = $1, col2 = $2, ... WHERE primary_key = $N RETURNING *
	r.patch('/:id', wrap(async (req, res) => {
		const body = req.body as Record<string, unknown>;

		const given = t.columns.filter(c => c in body && c !== t.pk);  		// only allow columns that are in the schema & don't update the primary key

		if (!given.length) { res.status(400).json({ error: 'no updatable columns provided' }); return; }

		const sets = given.map((c, i) => `${q(c)} = $${i + 1}`).join(', ');	// build "col1 = $1, col2 = $2, ..." for the query
		
		const rows = await db.query(
			`update ${table} set ${sets} where ${pk} = $${given.length + 1} returning ${cols}`,
			[...given.map(c => body[c]), req.params.id]
		);

		if (!rows.length) { res.status(404).json({ error: 'not found' }); return; }

		res.json(rows[0]);
	}));

	// DELETE /:id
	// DELETE FROM table WHERE primary_key = $1
	r.delete('/:id', wrap(async (req, res) => {
		const rows = await db.query(
			`delete from ${table} where ${pk} = $1 returning ${pk}`, [req.params.id]
		);

		res.status(rows.length ? 204 : 404).end();
	}));



	return r;
}