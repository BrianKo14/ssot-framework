// Translates EntityDef (schema author's vocabulary) to TableInfo (backend facts).

import {
	completeEntity, completeRoutine,
	ROUTINE_KINDS, ROUTINE_LANGUAGES, TRIGGER_EVENTS, TRIGGER_LEVELS, TRIGGER_TIMINGS,
	type AnyRoutineDef, type BehaviourCollection, type EntityDef, type EntityInfo, type RecordCollection,
	type RoutineInfo as RoutineInfoDef, type TypeCollection,
} from 'system-definition';
import type { TypeHandlers } from '../types/handler.js';
import { checkedName, DEFAULT_SCHEMA } from '../sql/identifier.js';
import { accessOf } from './access.js';
import { completeField, type FrameworkFieldDef } from './context.js';
import { defaultSqlOf } from './defaults.js';
import type { ColumnInfo, Columns, ReferenceInfo, RoutineInfo, TableInfo, Typed } from './model.js';

export {
	boxType, CAPABILITIES,
	defineEntities, defineEntity, defineRecord, defineRoutine, defineRoutines, defineType,
	inSchema, withRecords, withRoutines,
} from 'system-definition';
export type { AccessDef, AnyRoutineDef, Capability, EntityDef, FieldDef, InSchemaOf, RecordDef, TypeCollection } from 'system-definition';
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

/** The local part of an identity, e.g. `reserva` from `ventas.reserva`
 * @param what what the identity names, e.g. "entity" */
function localName(identity: string, schema: string, what: string): string {
	const local = identity.startsWith(`${schema}.`) ? identity.slice(schema.length + 1) : identity;

	if (local.includes('.'))
		throw new Error(`${what} "${identity}": a name may only be qualified by its own schema, "${schema}"`);

	return local;
}

/** Refuses a `word` that is not in `words`.
 * As an allowlist check of values going into SQL, santizing.
 * E.g. a timing (create trigger ... before insert). */
function oneOf<T extends string>(word: T, words: readonly T[], where: string, what: string): T {
	if (!words.includes(word))
		throw new Error(`${where}: unknown ${what} "${word}"; the ones there are: ${words.join(', ')}`);

	return word;
}

/** Resolves a type name to its handler, or throws if the system doesn't have it. */
function typed(typeName: string, handlers: TypeHandlers, where: string): Typed {
	const type = handlers[typeName];

	if (!type) throw new Error(`${where}: unknown type "${typeName}"`);

	return { typeName, type };
}

/** Get the physical table name of an entity.
 * If the entity declares a table name, use it. Else, use the entity's local name. */
function physicalName(entity: string, info: EntityInfo<AnySystem>, schema: string): string {
	if (info.table === null) return localName(entity, schema, 'entity');

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
		const where = `entity "${entityName}", field "${name}"`;
		const { typeName, type } = typed(String(field.type), handlers, where);

		const defaultSql = defaultSqlOf(field.defaultValue, type, field.nullable, where);

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
		referencedBy: [],
		access: accessOf(entityName, info.access),
		triggers: [],				// filled by linkTriggers, once the table exists
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
		to.referencedBy.push(reference);
		if (reference.isDetail) to.details.push(reference);
	}
}

/** Resolves each trigger of a table to the routine it'll run. */
function linkTriggers(t: TableInfo, triggers: EntityInfo<AnySystem>['triggers'], routines: Map<string, RoutineInfo>): void {
	for (const [name, trigger] of Object.entries(triggers)) {
		const where = `entity "${t.entity}", trigger "${name}"`;
		const routine = routines.get(trigger.routine);

		if (!routine) throw new Error(`${where}: unknown routine "${trigger.routine}"`);

		if (routine.kind !== 'trigger')
			throw new Error(`${where}: routine "${trigger.routine}" is a ${routine.kind}, not a trigger routine`);

		trigger.events.forEach(event => oneOf(event, TRIGGER_EVENTS, where, 'event'));

		if (!trigger.events.length) throw new Error(`${where}: a trigger fires on at least one event`);

		t.triggers.push({
			name: checkedName(name, 'trigger'),
			table: t,
			timing: oneOf(trigger.timing, TRIGGER_TIMINGS, where, 'timing'),
			events: TRIGGER_EVENTS.filter(event => trigger.events.includes(event)),
			level: oneOf(trigger.level, TRIGGER_LEVELS, where, 'level'),
			routine,
		});
	}
}

/** Error message for a routine that doesn't meet requirements. */
const SAYS: Readonly<Record<RoutineInfoDef['kind'], (r: RoutineInfoDef) => string | null>> = {
	function: r => r.returns === null ? 'a function says what it returns' : null,
	procedure: r => r.returns !== null ? 'a procedure returns nothing' : null,
	trigger: r => Object.keys(r.params).length || r.returns !== null ? 'a trigger routine takes no params and returns nothing'
		: r.language !== 'plpgsql' ? 'a trigger routine is written in plpgsql' : null,
};

/** Turn a system's routines to SQL, resolving types.
 * 
 * @param routineDefs the routines of the system, keyed by identity
 * @param handlers the system's domain types */
export function routinesFrom(routineDefs: Readonly<Record<string, AnyRoutineDef>>, handlers: TypeHandlers): RoutineInfo[] {
	const named = new Map<string, string>();

	return Object.entries(routineDefs).map(([routine, def]): RoutineInfo => {
		const where = `routine "${routine}"`;
		const info: RoutineInfoDef = completeRoutine(def);
		const schema = info.schema ?? DEFAULT_SCHEMA;
		const name = checkedName(localName(routine, schema, 'routine'), 'routine');

		const refusal = SAYS[oneOf(info.kind, ROUTINE_KINDS, where, 'kind')](info);

		if (refusal) throw new Error(`${where}: ${refusal}`);

		const at = `"${schema}"."${name}"`;
		const first = named.get(at);

		if (first !== undefined) throw new Error(`routines "${first}" and "${routine}" are both named ${at}`);

		named.set(at, routine);

		return {
			routine, schema, name,
			kind: info.kind,
			params: Object.entries(info.params).map(([param, { type }]) =>
				({ name: checkedName(param, 'param'), ...typed(type, handlers, `${where}, param "${param}"`) })),
			returns: info.returns === null ? null : typed(info.returns, handlers, `${where}, result`),
			language: oneOf(info.language, ROUTINE_LANGUAGES, where, 'language'),
			body: info.body,
		};
	});
}

/** Maps a whole system definition to its tables.
 * @param entityDefs the entities of the system, keyed by entity name
 * @param handlers the system's domain types.
 * @param routines the system's routines, as `routinesFrom` built them: what its triggers run */
export function tablesFrom<TEntities extends Readonly<Record<string, EntityDef<AnySystem>>>>(
	entityDefs: TEntities,
	handlers: TypeHandlers,
	routines: RoutineInfo[] = [],
): TableInfo[] {

	// --- Build the table ---

	// 1. Def -> Info (fills in the defaults: nullable, label, ...)
	const completed: [string, EntityInfo<AnySystem>][] =
		Object.entries(entityDefs).map(([name, def]) => [name, completeEntity(anySystem, def)]);

	// 2. Info -> TableInfo (resolves type names to handlers, builds column maps, merges access)
	const tables = new Map(completed.map(([name, info]) =>
		[name, tableInfo(name, info, handlers)]));

	// Now that every table exists...
	// 3. Resolve fks + trigger routines
	const byRoutine = new Map(routines.map(r => [r.routine, r]));

	for (const [name, info] of completed) {
		linkReferences(tables.get(name)!, info.fks, tables);
		linkTriggers(tables.get(name)!, info.triggers, byRoutine);
	}

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
