// Router for reads (POST, PUT, PATCH, _undo, DELETE, LOCK, UNLOCK)

import express, { type Request, type RequestHandler, type Response, type Router } from 'express';
import { forgetting, logging, undoing, UNDO } from '../../auth/changes.js';
import { HttpError } from '../../errors.js';
import type { Imported } from '../../shared/api.js';
import { fileRows, formatReading } from '../../format/registry.js';
import type { ColumnInfo } from '../../schema/model.js';
import { LOCK } from '../../schema/reserved.js';
import { asRecord, checkedValues, inserted, namedColumns } from '../../schema/values.js';
import { script } from '../../sql/ddl.js';
import { equalities, where } from '../../sql/filter.js';
import { insertSql } from '../../sql/insert.js';
import { q } from '../../sql/identifier.js';
import { loadStatements } from '../../sql/seed.js';
import { wrap } from '../handler.js';
import { deletableBy, readableBy } from '../permission.js';
import {
	askedField, holder, type Mount, preconditions, presentedVersion, refuseUnmatched, routes, unheld,
} from './mount.js';

/** An imported file arrives as text. */
const fileBody = express.text({ type: 'text/plain', limit: '5mb' });

export function writeRouter(m: Mount): Router {
	const { db, t, table, cols, pkCols, byPk, updatable } = m;

	/** UPDATE table SET col1 = $1, col2 = $2, ... WHERE pk_col1 = $N ... RETURNING cols
	* @param columnsToSet PATCH picks, which of the updatable columns to write */
	const update = (columnsToSet: (body: Record<string, unknown>) => ColumnInfo[]): RequestHandler =>
		wrap(async (req, res) => {
			const body = asRecord(req.body);
			namedColumns(t.byName, body);				// refuse columns the schema does not declare

			const given = columnsToSet(body);

			if (!given.length) throw new HttpError(400, 'no updatable columns provided');

			const values = checkedValues(given, body, true);
			const version = presentedVersion(req);

			const params: unknown[] = [];

			// Update the columns the body provided
			const sets = given.map(c => `${q(c.name)} = $${params.push(values[c.name])}`).join(', ');

			const at = equalities(m.addressedRow(req), params);
			const addressed = where([...at, ...preconditions(req, version, params)]);

			const write = `update ${table} set ${sets}${addressed} returning ${cols}`;

			const rows = await db.query(
				logging({ t, given, addressed: at, by: holder(req), params }, write, cols), params);

			if (!rows.length) await refuseUnmatched(m, req, version);

			res.json(await m.wire(rows[0]));
		});

	const refuseUnclaimed = async (req: Request): Promise<never> => {
		const row = await m.lookUp(req, '1');

		throw row === undefined
			? new HttpError(404, 'not found')
			: new HttpError(403, `not allowed to take somebody else's claim on ${t.entity}`);
	};

	/** The answer to a claim route, with the record's current version. */
	const claimAnswer = async (req: Request, res: Response, row: Record<string, unknown>) => {
		if (readableBy(req)(t)) res.json(await m.wire(row));
		else res.status(204).end();
	};

	// INSERT INTO table (col1, col2, ...) VALUES ($1, $2, ...) RETURNING *
	const insertOne: RequestHandler = wrap(async (req, res) => {
		const body = m.withInherited(req, asRecord(req.body));			    // under a master, its key comes from the path
		const { given, values } = inserted(t, body);

		const rows = await db.query(`${insertSql(t, given)} returning ${cols}`, given.map(c => values[c.name]));

		res.status(201).json(await m.wire(rows[0]));			            // return the newly created row, including the PK
	});

	/** The rows of a file, inserted as in with `db:seed`. Each checked same as POST would be, all or nothing. */
	const importFile: RequestHandler = wrap(async (req, res) => {
		const format = formatReading(req.query.format);

		if (typeof req.body !== 'string') throw new HttpError(400, `send the file as ${format.contentType}`);

		const name = `${t.entity}.${String(req.query.format)}`;
		const source = { name, entity: t.entity, ...fileRows(format, name, req.body) };

		// Under a master, every row gets its key from the path
		const statements = loadStatements([t], [source], { fill: row => m.withInherited(req, row) });

		if (statements.length) await db.query(script(statements, `import into ${t.entity}`));

		const imported: Imported = { inserted: statements.length };

		res.status(201).json(imported);
	});

	return routes()

		// POST / — one row, as JSON
		// POST /?format=txt — a file of rows, as the export of that format writes them
		.post('/', fileBody, (req, res, next) => (req.query.format === undefined ? insertOne : importFile)(req, res, next))

		// PUT /:pk0[/:pk1...] — full update, omitted columns set to null
		.put(byPk, update(() => updatable))

		// PATCH /:pk0[/:pk1...] — partial update
		.patch(byPk, update(body => updatable.filter(c => c.name in body)))

		// PATCH /:pk0[/:pk1...]/_undo[?field=<column>] — undo from version history
		.patch(`${byPk}/${UNDO}`, wrap(async (req, res) => {
			const field = askedField(t, req.query.field);
			const record = m.addressedRow(req);
			const at = m.addressOf(record);
			const version = presentedVersion(req);

			const params: unknown[] = [];
			const addressed = [...equalities(record, params), ...preconditions(req, version, params)];

			const rows = await db.query(undoing(t, updatable, params, at, field, addressed, cols), params);

			if (!rows.length) {
				const undone = (await m.changes.newest(t.entity, [at])).get(at) ?? {};
				const nothing = !(field === null ? Object.keys(undone).length : field in undone);

				await refuseUnmatched(m, req, version, nothing ? new HttpError(409, 'nothing to undo') : undefined);
			}

			res.json(await m.wire(rows[0]));
		}))

		// DELETE /:pk0[/:pk1...]
		// DELETE FROM table WHERE pk_col1 = $1 AND pk_col2 = $2 ...
		.delete(byPk, wrap(async (req, res) => {
			const version = presentedVersion(req);

			const params: unknown[] = [];
			const addressed = where([...equalities(m.addressedRow(req), params), ...preconditions(req, version, params)]);

			const remove = `delete from ${table}${addressed} returning ${pkCols}`;

			const rows = await db.query(forgetting(t, params, remove, pkCols), params);

			if (!rows.length) await refuseUnmatched(m, req, version);

			res.status(204).end();
		}))

		// LOCK /:pk0[/:pk1...] — claim the record, so that nobody else may write it
		.lock(byPk, wrap(async (req, res) => {
			const params: unknown[] = [];
			const set = `${q(LOCK.name)} = $${params.push(holder(req))}`;
			const addressed = where([...equalities(m.addressedRow(req), params), ...unheld(req, params)]);

			const rows = await db.query(
				`update ${table} set ${set}${addressed} returning ${cols}`, params);

			if (!rows.length) await refuseUnmatched(m, req, null);	// gone, or somebody else's

			await claimAnswer(req, res, rows[0]);
		}))

		// UNLOCK /:pk0[/:pk1...] — let the claim go.
		.unlock(byPk, wrap(async (req, res) => {
			// Note: taking a claim off somebody else asks for `delete` on the record.
			const forcing = deletableBy(req)(t);

			const params: unknown[] = [];
			const addressed = where([
				...equalities(m.addressedRow(req), params),
				...(forcing ? [] : unheld(req, params)),
			]);

			const rows = await db.query(
				`update ${table} set ${q(LOCK.name)} = null${addressed} returning ${cols}`, params);

			if (!rows.length) await refuseUnclaimed(req);

			await claimAnswer(req, res, rows[0]);
		}));
}
