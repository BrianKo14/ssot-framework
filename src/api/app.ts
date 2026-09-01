import path from 'node:path';
import express from 'express';
import { authTables } from '../auth/entities.js';
import type { Authenticator } from '../auth/store.js';
import type { AppConfig } from '../config.js';
import type { Db } from '../db/postgres.js';
import { AUTH, gate, login, sessionRouter } from './auth.js';
import { entityRouter } from './crud.js';
import { onError } from './handler.js';
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

	// --> 6. One CRUD router per table + each detail under its master
	app.use('/api', entityRouter(db, tables));

	// --> 7. Frontend
	app.use(express.static(PUBLIC_DIR));					// must go after /api; serves the login page anonymously

	// --> 8. Error handling
	app.use(onError);							// must go last

	return app;
}
