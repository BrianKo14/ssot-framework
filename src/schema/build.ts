// Translates EntityDef (schema author's vocabulary) to TableInfo (backend facts).
// This is the one framwework file that imports `system-definition`.

import { boxType, completeEntity, type EntityDef, type EntityInfo, type TypeCollection } from 'system-definition';
import type { TypeCollectionOf, TypeHandlers } from '../types/handler.js';
import type { ColumnInfo, Columns, ReferenceInfo, TableInfo } from './model.js';

export { defineEntities, defineEntity } from 'system-definition';
export type { EntityDef, FieldDef, RecordDef, TypeCollection } from 'system-definition';

/** The descriptive TypeCollection implied by a set of handlers */
export const typeCollectionOf = <H extends TypeHandlers>(handlers: H): TypeCollectionOf<H> =>
	Object.fromEntries(Object.keys(handlers).map(name => [name, { tsType: boxType() }])) as TypeCollectionOf<H>;

/** Returns a function that resolves a column name to a ColumnInfo, or throws if the name is unknown. */
const namedColumn = (columns: Columns, where: string) => (name: string): ColumnInfo => {
	const column = columns.get(name);

	if (!column) throw new Error(`${where} names unknown field "${name}"`);

	return column;
};

/** Reduces one completed entity to the facts the SQL layer consumes.
 * Except its fks, which are resolved in a second pass once every table exists.
 * 
 * Resolving type names here (once, at startup) is what lets every request path assume its
 * column has a handler: an unrecognised type is a boot failure, not a per-request branch. */
function tableInfo(entityName: string, info: EntityInfo<TypeCollection>, handlers: TypeHandlers): TableInfo {
	const columns = Object.entries(info.fields).map(([name, field]): ColumnInfo => {
		const typeName = String(field.type);
		const type = handlers[typeName];

		if (!type) throw new Error(`entity "${entityName}", field "${name}": unknown type "${typeName}"`);

		return { name, typeName, nullable: field.nullable, type };
	});

	const byName: Columns = new Map(columns.map(c => [c.name, c]));

	return {
		// The entity name doubles as the table name; TODO: SCOPE (4) is where a distinct physical name would come from.
		table: entityName,
		pk: info.pk.map(namedColumn(byName, `entity "${entityName}": primary key`)),
		uks: Object.fromEntries(Object.entries(info.uks).map(([uk, fields]) =>
			[uk, fields.map(namedColumn(byName, `entity "${entityName}": unique key "${uk}"`))])),
		columns,				// field order is the order the schema author declared
		byName,
		references: [],				// filled by linkReferences, later once every table exists
		details: [],
	};
}

/** Do these columns form a key of the table (its pk or a uk)? */
const isKeyOf = (t: TableInfo, columns: ColumnInfo[]): boolean =>
	[t.pk, ...Object.values(t.uks)].some(key =>
		key.length === columns.length && key.every(c => columns.includes(c)));

/** Resolves foreign keys between tables. */
function linkReferences(from: TableInfo, fks: EntityInfo<TypeCollection>['fks'], tables: Map<string, TableInfo>): void {
	for (const [name, fk] of Object.entries(fks)) {
		const where = `entity "${from.table}", foreign key "${name}"`;
		const to = tables.get(fk.entity);

		if (!to) throw new Error(`${where}: unknown entity "${fk.entity}"`);

		const pairs = Object.entries(fk.fields);
		const columns = pairs.map(([own]) => namedColumn(from.byName, where)(own));
		const targetColumns = pairs.map(([, target]) => namedColumn(to.byName, `${where}, in "${to.table}",`)(target));

		if (!isKeyOf(to, targetColumns))
			throw new Error(`${where}: (${targetColumns.map(c => c.name).join(', ')}) is neither `
				+ `the primary key nor a unique key of "${to.table}"`);

		const reference: ReferenceInfo = {
			name, from, to, columns, targetColumns,
			isDetail: columns.every(c => from.pk.includes(c)),
		};

		from.references.push(reference);
		if (reference.isDetail) to.details.push(reference);
	}
}

/** Maps a whole system definition to its tables.
 * @param entityDefs the entities of the system, keyed by entity name
 * @param handlers the system's domain types, the same set `typeCollectionOf` described */
export function tablesFrom(entityDefs: Record<string, EntityDef<TypeCollection>>, handlers: TypeHandlers): TableInfo[] {

	// 1. Def -> Info (fills in the defaults: nullable, label, ...)
	const completed: [string, EntityInfo<TypeCollection>][] =
		Object.entries(entityDefs).map(([name, def]) => [name, completeEntity(def)]);

	// 2. Info -> TableInfo (resolves type names to handlers, builds column maps, etc.)
	const tables = new Map(completed.map(([name, info]) => [name, tableInfo(name, info, handlers)]));

	// 3. Resolve fks (needs every table to exist first)
	for (const [name, info] of completed) linkReferences(tables.get(name)!, info.fks, tables);

	return [...tables.values()];
}
