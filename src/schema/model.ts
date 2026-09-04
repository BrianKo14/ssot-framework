// Model for the schema generator: what a table, column, reference, etc., is

import type { Capability } from '../shared/api.js';
import type { TypeHandler } from '../types/handler.js';


export interface ColumnInfo {
	name: string;
	typeName: string;
	nullable: boolean;
	isName: boolean;
	type: TypeHandler<any>;
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
	access: Access;				// who may do what here; see `schema/access.ts`
}
