// The `/api/_meta` endpoint: schema info for the frontend to use

import { Router } from 'express';
import type { ColumnMeta, SystemMeta, TableMeta } from '../shared/api.js';
import { formatMeta } from '../format/registry.js';
import { operatorMeta } from '../sql/filter.js';
import { allows, CAPABILITIES } from '../schema/access.js';
import type { ColumnInfo, TableInfo } from '../schema/model.js';

/** Name of the metadata endpoint. */
export const META = '_meta';

const columnMeta = (c: ColumnInfo): ColumnMeta =>
	({ name: c.name, type: c.typeName, nullable: c.nullable, expected: c.type.expected });

/** Everything about a table. Yet unfiltered by access control. */
const tableMeta = (t: TableInfo): Omit<TableMeta, 'capabilities'> =>
	({ table: t.table, pk: t.pk.map(c => c.name), columns: t.columns.map(columnMeta) });


export function metaRouter(tables: TableInfo[]): Router {
	const described = tables.map(t => ({ t, meta: tableMeta(t) }));

	return Router().get('/', (req, res) => {
		const role = req.principal?.role;

		const visible: TableMeta[] = role === undefined ? [] : described
			.filter(({ t }) => allows(t.access, role, 'read'))
			.map(({ t, meta }) => ({ ...meta, capabilities: CAPABILITIES.filter(c => allows(t.access, role, c)) }));

		res.json({ 
			tables: visible,
			operators: operatorMeta,
			formats: formatMeta
		} satisfies SystemMeta);
	});
}
