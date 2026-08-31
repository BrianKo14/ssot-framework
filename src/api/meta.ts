// The `/api/_meta` endpoint: schema info for the frontend to use

import { Router } from 'express';
import type { ColumnMeta, SystemMeta, TableMeta } from '../shared/api.js';
import { operatorMeta } from '../sql/filter.js';
import type { ColumnInfo, TableInfo } from '../schema/model.js';

/** Name of the metadata endpoint. */
export const META = '_meta';

const columnMeta = (c: ColumnInfo): ColumnMeta =>
	({ name: c.name, type: c.typeName, nullable: c.nullable, expected: c.type.expected });

const tableMeta = (t: TableInfo): TableMeta =>
	({ table: t.table, pk: t.pk.map(c => c.name), columns: t.columns.map(columnMeta) });

const systemMeta = (tables: TableInfo[]): SystemMeta =>
	({ tables: tables.map(tableMeta), operators: operatorMeta });


/** The name collision check that used to live here now covers every reserved name at once, in
 * `buildApp` — `_meta` is no longer the only one the framework claims. */
export function metaRouter(tables: TableInfo[]): Router {
	const meta = systemMeta(tables);
	return Router().get('/', (_req, res) => { res.json(meta); });
}
