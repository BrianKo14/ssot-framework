// Model for the schema generator: what a table, column, reference, etc., is

import type { DefaultDef, RoutineKind, RoutineLanguage, TriggerEvent, TriggerLevel, TriggerTiming } from 'system-definition';
import type { Capability } from '../shared/api.js';
import type { TypeHandler } from '../types/handler.js';


/** Anything declared with one of the system's types: a column, a routine's param or result. */
export interface Typed {
	typeName: string;
	type: TypeHandler<any>;
}

export interface ColumnInfo extends Typed {
	name: string;
	nullable: boolean;
	isName: boolean;
	defaultValue: DefaultDef<unknown> | null;
	defaultSql: string | null;
}

/** A table's columns by name. */
export type Columns = ReadonlyMap<string, ColumnInfo>;


/** Role -> set of capabilities. */
export type Access = ReadonlyMap<string, ReadonlySet<Capability>>;


/** One foreign key, with source / target columns resolved.
 *
 * `isDetail` is the master/detail distinction, and it is *derived*, not declared.
 * If fk ⊆ pk, then the fk's row is uniquely identified by the master row it points to, so it is a detail. */
export interface ReferenceInfo {
	name: string;			// the fk's name
	from: TableInfo;		// the table declaring the fk
	to: TableInfo;			// the table it references
	columns: ColumnInfo[];		// `from`'s columns, in the order they map
	targetColumns: ColumnInfo[];	// `to`'s columns, in the same order
	isDetail: boolean;
}

/** What the SQL layer needs to know about one entity.
 * Per the Def/Info convention: a Def is what the schema author writes,
 * an Info is the completed version that generators consume. */
export interface TableInfo {
	entity: string;				// the entity's identity, e.g. `ventas.reserva`
	schema: string;				// physical schema (namespace) the table lives in, e.g. `ventas`
	table: string;				// physical table name: declared, or the identity's local part, e.g. `reserva`
	pk: ColumnInfo[];			// primary key columns, in declaration order; may be composite
	uks: Record<string, ColumnInfo[]>;	// unique keys, by the name the author gave each
	columns: ColumnInfo[];			// columns we're allowed to read/write
	byName: Columns;			// the same ColumnInfo objects, indexed
	references: ReferenceInfo[];		// fks this table declares
	details: ReferenceInfo[];		// fks *into* this table from tables that are details of it
	referencedBy: ReferenceInfo[];		// every fk *into* this table, detail or not
	access: Access;				// who may do what here; see `schema/access.ts`
	triggers: TriggerInfo[];		// runs when its rows change, in declaration order
}


/** One param of a routine, in declaration order. */
export interface ParamInfo extends Typed {
	name: string;
}

/** The routine (procedure, function) that a trigger runs, with its types resolved. */
export interface RoutineInfo {
	routine: string;			// schema + name
	schema: string;				
	name: string;				
	kind: RoutineKind;
	params: ParamInfo[];
	returns: Typed | null;			
	language: RoutineLanguage;
	body: string;				// text in `language`
}

/** One trigger of a table + the routine it runs resolved. */
export interface TriggerInfo {
	name: string;
	table: TableInfo;
	timing: TriggerTiming;
	events: TriggerEvent[];			// distinct, in `TRIGGER_EVENTS` order
	level: TriggerLevel;
	routine: RoutineInfo;
}
