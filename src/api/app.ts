import path from 'node:path';
import express from 'express';
import { activityStore, noticing, traced } from '../auth/activity.js';
import { AUTH_SCHEMA, authTables } from '../auth/entities.js';
import { presenceStore } from '../auth/presence.js';
import type { Authenticator } from '../auth/store.js';
import type { AppConfig } from '../config.js';
import type { Db } from '../db/postgres.js';
import { AUTH, gate, login, sessionRouter } from './auth.js';
import { entityRouter } from './crud.js';
import { onError } from './handler.js';
import { META, metaRouter } from './meta.js';
import { MONITOR, monitorRouter } from './monitor.js';
import type { Access } from '../schema/model.js';
import type { TableInfo } from '../schema/model.js';

/** The static files directory for the frontend. */
const PUBLIC_DIR = path.join(import.meta.dirname, '..', '..', 'public');

/** URLs handled by the frontend. */
const SCREEN = /^(?!\/api(\/|$))/;

/** Reserved entity names. */
const RESERVED = new Set([META, AUTH, MONITOR, ...authTables.map(t => t.entity)]);

/** A schema with taken name should fail at startup. */
const refuseReserved = (tables: TableInfo[]): void => {
	const taken = tables.map(t => t.entity).filter(name => RESERVED.has(name));

	if (taken.length) throw new Error(`entity name(s) reserved by the framework: ${taken.join(', ')}`);

	// We forbid any app entity from entering the auth schema
	const intruding = tables.filter(t => t.schema === AUTH_SCHEMA).map(t => t.entity);

	if (intruding.length) throw new Error(`schema "${AUTH_SCHEMA}" is reserved by the framework: ${intruding.join(', ')}`);
};



/* --- APP --- */

/** Takes a database connection + a list of tables + the authenticator guarding them.
 * @param monitor who may see the monitor, as the application stated it
 * @returns An Express app with a CRUD router for each table, and error handling middleware. */
export function buildApp(db: Db, tables: TableInfo[], auth: Authenticator, config: AppConfig, monitor: Access) {
	refuseReserved(tables);

	const presence = presenceStore(db, config.pollSeconds);
	const activities = activityStore(db);				// on the plain connection: noting a request down is not part of it
	const guarded = { entity: MONITOR, access: monitor };

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
	app.use(`/api/${META}`, metaRouter(tables, config.pollSeconds, guarded));

	// --> 6. Activity
	app.use(`/api/${MONITOR}`, monitorRouter(activities, presence, guarded, tables));

	// --> 7. One CRUD router per table + each detail under its master
	const screens = new Set(tables.map(t => t.entity));

	app.use('/api', entityRouter(traced(db), tables, presence, noticing(activities, screens)));

	// --> 8. Frontend
	app.use(express.static(PUBLIC_DIR));

	// --> 9. Deep links
	app.get(SCREEN, (req, res, next) => {
		if (req.accepts(['*/*', 'html']) !== 'html') { next(); return; }

		res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
	});

	// --> 10. Error handling
	app.use(onError);								// must go last

	return app;
}
