import path from 'node:path';
import express, { type ErrorRequestHandler } from 'express';
import type { Db } from '../db/postgres.js';
import { crudRouter, detailPath, isNestable } from './crud.js';
import { HttpError } from '../errors.js';
import { META, metaRouter } from './meta.js';
import type { TableInfo } from '../schema/model.js';

/** The static files directory for the frontend. */
const PUBLIC_DIR = path.join(import.meta.dirname, '..', '..', 'public');

/** Error handling middleware */
const onError: ErrorRequestHandler = (err, _req, res, _next) => {
	console.error(err);

	const status = err instanceof HttpError ? err.status : 500;
	res.status(status).json({ error: status === 500 ? 'internal error' : err.message });
};



/* --- APP --- */

/** Takes a database connection and a list of tables.
 * @returns An Express app with a CRUD router for each table, and error handling middleware. */
export function buildApp(db: Db, tables: TableInfo[]) {
	const app = express();
	app.use(express.json());

	// --> Health
	app.get('/health', (_req, res) => { res.json({ ok: true }); });

	// --> Schema metadata
	app.use(`/api/${META}`, metaRouter(tables));				

	// --> CRUD routers
	for (const t of tables) {						// per table CRUD router at /api/<table>
		app.use(`/api/${t.table}`, crudRouter(db, t));

		// ...and mount each of its details' collections under it, at /api/<master>/<master key>/<detail>.
		for (const ref of t.details.filter(isNestable))
			app.use(`/api/${t.table}${detailPath(ref)}`, crudRouter(db, ref.from, ref));
	}
	
	// --> Frontend
	app.use(express.static(PUBLIC_DIR));					// must go after /api

	// --> Error handling
	app.use(onError);							// must go last

	return app;
}
