// Translates EntityDef (schema author's vocabulary) to TableInfo (backend facts).

import {
	completeEntity,
	type BehaviourCollection, type EntityDef, type EntityInfo, type RecordCollection, type TypeCollection,
} from 'system-definition';
import type { TypeHandlers } from '../types/handler.js';
import { checkedName, DEFAULT_SCHEMA } from '../sql/identifier.js';
import { accessOf } from './access.js';
import { completeField, type FrameworkFieldDef } from './context.js';
import { defaultSqlOf } from './defaults.js';
import type { ColumnInfo, Columns, ReferenceInfo, TableInfo } from './model.js';

export { boxType, CAPABILITIES, defineEntities, defineEntity, defineRecord, defineType, inSchema, withRecords } from 'system-definition';
export type { AccessDef, Capability, EntityDef, FieldDef, InSchemaOf, RecordDef, TypeCollection } from 'system-definition';
export { describeTypes, type FrameworkFieldDef } from './context.js';


// --- Build the table ---

/** The widest system: any types, any records, the framework's fields. What `tablesFrom` accepts. */
type AnySystem = {
	types: TypeCollection;
	completeField: (fieldDef: FrameworkFieldDef<TypeCollection>, name: string) => ReturnType<typeof completeField>;
	behaviours: BehaviourCollection;
	records: RecordCollection;
};

/** Context to be filled in by `completeEntity`. */
const anySystem: AnySystem = { types: {}, completeField, behaviours: {}, records: {} };

/** Returns a function that resolves a column name to a ColumnInfo, or throws if the name is unknown. */
const namedColumn = (columns: Columns, where: string) => (name: string): ColumnInfo => {
	const column = columns.get(name);

	if (!column) throw new Error(`${where} names unknown field "${name}"`);

	return column;
};

/** The local part of an entity's identity, e.g. `reserva` from `ventas.reserva` */
function localName(entity: string, schema: string): string {
	const local = entity.startsWith(`${schema}.`) ? entity.slice(schema.length + 1) : entity;

	if (local.includes('.'))
		throw new Error(`entity "${entity}": a name may only be qualified by its own schema, "${schema}"`);

	return local;
}

/** Get the physical table name of an entity.
 * If the entity declares a table name, use it. Else, use the entity's local name. */
function physicalName(entity: string, info: EntityInfo<AnySystem>, schema: string): string {
	if (info.table === null) return localName(entity, schema);

	if (info.table.includes('.'))
		throw new Error(`entity "${entity}": table name "${info.table}" is qualified; `
			+ `the namespace is the schema, "${schema}"`);

	return checkedName(info.table, 'table');
}

/** Reduces one completed entity to the facts the SQL layer consumes.
 * Except its fks, which are resolved in a second pass once every table exists.
 * 
 * Resolving type names here (once, at startup) is what lets every request path assume its
 * column has a handler: an unrecognised type is a boot failure, not a per-request branch. */
function tableInfo(
	entityName: string,
	info: EntityInfo<AnySystem>,
	handlers: TypeHandlers,
): TableInfo {
	const columns = Object.entries(info.fields).map(([name, field]): ColumnInfo => {
		const typeName = String(field.type);
		const type = handlers[typeName];

		if (!type) throw new Error(`entity "${entityName}", field "${name}": unknown type "${typeName}"`);

		const defaultSql = defaultSqlOf(field.defaultValue, type, field.nullable,
			`entity "${entityName}", field "${name}"`);

		return { name, typeName, nullable: field.nullable, isName: field.isName, type,
			defaultValue: field.defaultValue, defaultSql };
	});

	const byName: Columns = new Map(columns.map(c => [c.name, c]));

	const schema = info.schema ?? DEFAULT_SCHEMA;

	return {
		entity: entityName,			// the identity the author writes: fks, access and URLs all name this
		schema,
		table: physicalName(entityName, info, schema),
		pk: info.pk.map(namedColumn(byName, `entity "${entityName}": primary key`)),
		uks: Object.fromEntries(Object.entries(info.uks).map(([uk, fields]) =>
			[uk, fields.map(namedColumn(byName, `entity "${entityName}": unique key "${uk}"`))])),
		columns,				// field order is the order the schema author declared
		byName,
		references: [],				// filled by linkReferences, later once every table exists
		details: [],
		access: accessOf(entityName, info.access),
	};
}

/** Do these columns form a key of the table (its pk or a uk)? */
const isKeyOf = (t: TableInfo, columns: ColumnInfo[]): boolean =>
	[t.pk, ...Object.values(t.uks)].some(key =>
		key.length === columns.length && key.every(c => columns.includes(c)));

/** Resolves foreign keys between tables. */
function linkReferences(from: TableInfo, fks: EntityInfo<AnySystem>['fks'], tables: Map<string, TableInfo>): void {
	for (const [name, fk] of Object.entries(fks)) {
		const where = `entity "${from.entity}", foreign key "${name}"`;
		const to = tables.get(fk.entity);

		if (!to) throw new Error(`${where}: unknown entity "${fk.entity}"`);

		const pairs = Object.entries(fk.fields);
		const columns = pairs.map(([own]) => namedColumn(from.byName, where)(own));
		const targetColumns = pairs.map(([, target]) => namedColumn(to.byName, `${where}, in "${to.entity}",`)(target));

		if (!isKeyOf(to, targetColumns))
			throw new Error(`${where}: (${targetColumns.map(c => c.name).join(', ')}) is neither `
				+ `the primary key nor a unique key of "${to.entity}"`);

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
 * @param handlers the system's domain types. */
export function tablesFrom<TEntities extends Readonly<Record<string, EntityDef<AnySystem>>>>(
	entityDefs: TEntities,
	handlers: TypeHandlers,
): TableInfo[] {

	// --- Build the table ---

	// 1. Def -> Info (fills in the defaults: nullable, label, ...)
	const completed: [string, EntityInfo<AnySystem>][] =
		Object.entries(entityDefs).map(([name, def]) => [name, completeEntity(anySystem, def)]);

	// 2. Info -> TableInfo (resolves type names to handlers, builds column maps, merges access)
	const tables = new Map(completed.map(([name, info]) =>
		[name, tableInfo(name, info, handlers)]));

	// 3. Resolve fks (needs every table to exist first)
	for (const [name, info] of completed) linkReferences(tables.get(name)!, info.fks, tables);

	// 4. Check for table name collisions
	const stored = new Map<string, string>();

	for (const t of tables.values()) {
		const at = `"${t.schema}"."${t.table}"`;
		const first = stored.get(at);

		if (first !== undefined)
			throw new Error(`entities "${first}" and "${t.entity}" are both stored in table ${at}`);

		stored.set(at, t.entity);
	}

	return [...tables.values()];
}
