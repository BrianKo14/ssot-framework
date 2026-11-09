// Router for GETs

import type { Request, Router } from 'express';
import { family } from './children.js';
import { HttpError } from '../../errors.js';
import type { ColumnInfo } from '../../schema/model.js';
import { STAMP } from '../../schema/reserved.js';
import { equalities, filterConditions, parseFilter, where } from '../../sql/filter.js';
import { columnList, q } from '../../sql/identifier.js';
import { atBase, parseReached, type Reading, reading } from '../../sql/reach.js';
import { formatNamed } from '../../format/registry.js';
import { sendAs, wrap } from '../handler.js';
import { readableBy } from '../permission.js';
import { askedField, CHANGES, type Mount, routes } from './mount.js';

/** SELECT cols FROM table [LEFT JOIN reached...] [WHERE ...] ORDER BY pk_col1, pk_col2, ...
 * The rows `conditions` picks, with whatever `?with=` reached and the children `?children=` asked for.
 * @param mentioned the columns the conditions name, beyond the ones `?with=` asks for */
const readRows = async (
	m: Mount, req: Request, mentioned: string[], conditions: (read: Reading, params: unknown[]) => string[],
) => {
	const asked = parseReached(req.query.with);
	const read = reading(m.t, [...asked, ...mentioned], readableBy(req));
	const columns = read.shown(asked);
	const kin = family(m.db, m.send, m.t, req.query.children, readableBy(req));	// before the query: a bad tree costs no round trip

	const params: unknown[] = [];
	const picked = where(conditions(read, params));

	const rows = await m.sent(columns, await m.db.query(
		`${read.statement([...columns, STAMP], picked)} order by ${read.order}`, params));	// sort by primary key

	await kin.attach(rows, read, picked, params);

	return { columns, rows };
};

export function readRouter(m: Mount): Router {
	return routes()
		// GET /[?filter={"col":value,"col2":{"op":"ge","value":...},...}][&with=["fk.col",...]][&children=["entity",{"entity":...,"fk":...},...]][&format=xlsx|txt]
		.get('/', wrap(async (req, res) => {
			const format = formatNamed(req.query.format);					// before the query: a bad format costs no round trip
			const raw = m.withInherited(req, parseFilter(req.query.filter)); 		// under a master, its key comes from the path

			const { columns, rows } = await readRows(m, req, Object.keys(raw),
				(read, params) => filterConditions(read.byName, raw, params, read.at));

			await sendAs(res, format, {
				name: m.t.entity,
				columns,								// the table's own, plus whatever it reached: exporting is reading
				pk: m.t.pk.map(c => c.name),
				rows,
			});
		}))

		// GET /:pk0[/:pk1...]/_changes[?field=<column>] — the record's history, newest first.
		.get(`${m.byPk}/${CHANGES}`, wrap(async (req, res) => {
			const field = askedField(m.t, req.query.field);
			const record = m.addressedRow(req);

			// Postgres quirk fix: we cast columns to text so booleans print as `true`/`false` rather than `t`/`f`
			const asText = (c: ColumnInfo) => `${q(c.name)}::text as ${q(c.name)}`;
			const now = await m.lookUp(req, columnList(m.t.columns, asText));

			if (now === undefined) throw new HttpError(404, 'not found');

			res.json(await m.changes.history(m.t.entity, m.addressOf(record), field, now));
		}))

		// GET /:pk0[/:pk1...][?with=["fk.col",...]][&children=["entity",{"entity":...,"fk":...},...]]
		.get(m.byPk, wrap(async (req, res) => {
			const { rows } = await readRows(m, req, [], (_, params) => equalities(m.addressedRow(req), params, atBase));

			if (!rows.length) throw new HttpError(404, 'not found');

			res.json(rows[0]);
		}));
}
