// The model every generator downstream reads: what a table, a column and a reference are.
// Nothing here knows how a definition is written (see `build.ts`) nor how SQL is spelled.

import type { TypeHandler } from '../types/handler.js';

/** What the SQL layer needs to know about one column.
 * `typeName` rides along beside the resolved handler because a handler is aliasable — one object
 * can be reachable under two names — so the name cannot live on the handler, and SCOPE(3)'s
 * schema generator needs it to pick a SQL type. */
export interface ColumnInfo {
	name: string;
	typeName: string;
	nullable: boolean;
	type: TypeHandler<any>;
}

/** A table's columns by name. Built once here, so nothing downstream rebuilds it. */
export type Columns = ReadonlyMap<string, ColumnInfo>;

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
	table: string;				// physical table name
	pk: ColumnInfo[];			// primary key columns, in declaration order; may be composite
	uks: Record<string, ColumnInfo[]>;	// unique keys, by the name the author gave each
	columns: ColumnInfo[];			// columns we're allowed to read/write
	byName: Columns;			// the same ColumnInfo objects, indexed
	references: ReferenceInfo[];		// fks this table declares
	details: ReferenceInfo[];		// fks *into* this table from tables that are details of it
}
