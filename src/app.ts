import express, { type ErrorRequestHandler } from 'express';
import type { Db } from './db.js';
import { crudRouter } from './crud.js';
import type { TableInfo } from './schema.js';

/** Error handling middleware */
const onError: ErrorRequestHandler = (err, _req, res, _next) => {
	console.error(err);
	res.status(500).json({ error: 'internal error' });
};

/** Takes a database connection and a list of tables.
 * @returns An Express app with a CRUD router for each table, and error handling middleware. */
export function buildApp(db: Db, tables: TableInfo[]) {
	const app = express();
	app.use(express.json());

	app.get('/health', (_req, res) => { res.json({ ok: true }); });		// health check endpoint

	// For each table, mount a CRUD router at /api/<table_name>
	for (const t of tables) {
		app.use(`/api/${t.table}`, crudRouter(db, t));
	}

	app.use(onError);							// error handling middleware must be last
	return app;
}