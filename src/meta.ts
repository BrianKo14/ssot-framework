// The `/api/_meta` endpoint: schema info for the frontend to use

import { Router } from 'express';
import type { ColumnMeta, SystemMeta, TableMeta } from './api-meta.js';
import type { ColumnInfo, TableInfo } from './schema.js';

/** Name of the metadata endpoint. */
export const META = '_meta';

const columnMeta = (c: ColumnInfo): ColumnMeta =>
	({ name: c.name, type: c.typeName, nullable: c.nullable, expected: c.type.expected });

const tableMeta = (t: TableInfo): TableMeta =>
	({ table: t.table, pk: t.pk.map(c => c.name), columns: t.columns.map(columnMeta) });

/** Built once at boot, from the same `TableInfo[]` the routers use. */
const systemMeta = (tables: TableInfo[]): SystemMeta => ({ tables: tables.map(tableMeta) });


export function metaRouter(tables: TableInfo[]): Router {
	if (tables.some(t => t.table === META))
		throw new Error(`entity "${META}" collides with the metadata endpoint /api/${META}`);

	const meta = systemMeta(tables);
	return Router().get('/', (_req, res) => { res.json(meta); });
}
