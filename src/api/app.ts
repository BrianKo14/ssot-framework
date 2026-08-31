import path from 'node:path';
import express, { type ErrorRequestHandler } from 'express';
import { authTables } from '../auth/entities.js';
import type { Authenticator } from '../auth/store.js';
import type { AppConfig } from '../config.js';
import type { Db } from '../db/postgres.js';
import { AUTH, gate, login, sessionRouter } from './auth.js';
import { crudRouter, detailPath, isNestable } from './crud.js';
import { HttpError } from '../errors.js';
import { META, metaRouter } from './meta.js';
import type { TableInfo } from '../schema/model.js';

/** The static files directory for the frontend. */
const PUBLIC_DIR = path.join(import.meta.dirname, '..', '..', 'public');

/** Reserved entity names. */
const RESERVED = new Set([META, AUTH, ...authTables.map(t => t.table)]);

/** A schema with taken name should fail at startup. */
const refuseReserved = (tables: TableInfo[]): void => {
	const taken = tables.map(t => t.table).filter(name => RESERVED.has(name));

	if (taken.length) throw new Error(`entity name(s) reserved by the framework: ${taken.join(', ')}`);
};

/** Error handling middleware */
const onError: ErrorRequestHandler = (err, _req, res, _next) => {
	const status = err instanceof HttpError ? err.status : 500;

	if (status === 500) console.error(err);

	res.status(status).json({ error: status === 500 ? 'internal error' : err.message });
};



/* --- APP --- */

/** Takes a database connection + a list of tables + the authenticator guarding them.
 * @returns An Express app with a CRUD router for each table, and error handling middleware. */
export function buildApp(db: Db, tables: TableInfo[], auth: Authenticator, config: AppConfig) {
	refuseReserved(tables);

	const app = express();
	app.use(express.json());

	// --> 1. Health
	app.get('/health', (_req, res) => { res.json({ ok: true }); });

	// --> 2. Log in (before gate, so it's public)
	app.post(`/api/${AUTH}`, login(auth, config));

	// --> 3. Gate (require a live session or 401)
	app.use('/api', gate(auth));

	// --> 4. Session management (log out, user info, etc. after the gate, so it inherits the principal)
	app.use(`/api/${AUTH}`, sessionRouter(auth, config));

	// --> 5. Schema metadata
	app.use(`/api/${META}`, metaRouter(tables));

	// --> 6. CRUD routers
	for (const t of tables) {						// per table CRUD router at /api/<table>
		app.use(`/api/${t.table}`, crudRouter(db, t));

		// ...and mount each of its details' collections under it, at /api/<master>/<master key>/<detail>.
		for (const ref of t.details.filter(isNestable))
			app.use(`/api/${t.table}${detailPath(ref)}`, crudRouter(db, ref.from, ref));
	}

	// --> 7. Frontend
	app.use(express.static(PUBLIC_DIR));					// must go after /api; serves the login page anonymously

	// --> 8. Error handling
	app.use(onError);							// must go last

	return app;
}
