// The `/api/_meta` endpoint: schema info for the frontend to use

import { Router } from 'express';
import type { ColumnMeta, MonitorMeta, ReferenceMeta, SystemMeta, TableMeta } from '../shared/api.js';
import { formatMeta } from '../format/registry.js';
import { DEFAULT_OP, operatorMeta } from '../sql/filter.js';
import { allows, CAPABILITIES } from '../schema/access.js';
import { ACTION_FILTERS, DUMP_FILTERS, USER_FILTERS } from '../auth/activity.js';
import { activityTable } from '../auth/entities.js';
import { UNDO } from '../auth/changes.js';
import type { ColumnInfo, ReferenceInfo, TableInfo } from '../schema/model.js';
import { DUMP } from './monitor.js';
import type { Guarded } from './permission.js';
import { STAMP } from '../schema/reserved.js';

/** Name of the metadata endpoint. */
export const META = '_meta';

const columnMeta = (c: ColumnInfo): ColumnMeta =>
	({
		name: c.name, type: c.typeName, nullable: c.nullable, isName: c.isName,
		expected: c.type.expected, defaultValue: c.defaultValue,
	});

/** An fk named on both sides by identity and column name. */
const referenceMeta = (r: ReferenceInfo): ReferenceMeta => ({
	name: r.name,
	to: r.to.entity,
	columns: r.columns.map(c => c.name),
	targetColumns: r.targetColumns.map(c => c.name),
	isDetail: r.isDetail,
});

/** Everything about a table. Yet unfiltered by access control. */
const tableMeta = (t: TableInfo): Omit<TableMeta, 'capabilities' | 'references'> =>
	({ entity: t.entity, pk: t.pk.map(c => c.name), columns: t.columns.map(columnMeta) });


/** One of the monitor's lists, described as a table is, so the filter bar takes it as one. */
const listMeta = (entity: string, columns: ColumnInfo[]): TableMeta =>
	({ entity, pk: [], columns: columns.map(columnMeta), references: [], capabilities: ['read'] });

/** What the monitor's filter bars can filter. */
const monitorMeta = (monitor: Guarded, dumping: boolean): MonitorMeta => ({
	users: listMeta(monitor.entity, USER_FILTERS),
	actions: listMeta(activityTable.entity, ACTION_FILTERS),
	dump: dumping ? listMeta(DUMP, DUMP_FILTERS) : null,
});

/** @param dumping whether the server writes the SQL dump, so there is one to show */
export function metaRouter(tables: TableInfo[], pollSeconds: number, monitor: Guarded, dumping: boolean): Router {

	const watching = monitorMeta(monitor, dumping);

	/** A list of all tables, with their metadata and references */
	const described = tables.map(t =>
		({ t, meta: tableMeta(t), refs: t.references.map(r => ({ to: r.to, meta: referenceMeta(r) })) }));

	return Router().get('/', (req, res) => {
		const role = req.principal?.role;

		const visible: TableMeta[] = role === undefined ? [] : described
			.filter(({ t }) => allows(t.access, role, 'read'))
			.map(({ t, meta, refs }) => ({
				...meta,
				references: refs.filter(r => allows(r.to.access, role, 'read')).map(r => r.meta),
				capabilities: CAPABILITIES.filter(c => allows(t.access, role, c)),
			}));

		res.json({
			tables: visible,
			operators: operatorMeta,
			defaultOperator: DEFAULT_OP,
			formats: formatMeta,
			stamp: STAMP.name,
			undo: UNDO,
			pollSeconds,
			monitor: role !== undefined && allows(monitor.access, role, 'read') ? watching : null,
		} satisfies SystemMeta);
	});
}
