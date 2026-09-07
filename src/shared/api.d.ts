import type { DefaultDef } from 'system-definition';

export interface ColumnMeta {
	name: string;
	type: string;		// the domain type's name, e.g. "nombre" (not the SQL type)
	nullable: boolean;
	isName: boolean;	// what a row of this table is called; what an fk list shows
	expected: string;	// e.g. "a date (YYYY-MM-DD)"
	defaultValue: DefaultDef<unknown> | null;
}

/** One foreign key, columns on both sides.
 * Only fks whose target the caller may read are published. */
export interface ReferenceMeta {
	name: string;			// the fk's name
	to: string;			// the target's entity identity, e.g. "ventas.reserva"
	columns: string[];		// this table's columns, in the order they map
	targetColumns: string[];	// the target's columns, in the same order
	isDetail: boolean;
}

import type { Capability } from 'system-definition';
export type { Capability };

export interface TableMeta {
	entity: string;		// the entity's identity, qualified when it is not in the default schema
	pk: string[];		// column names, in declaration order
	columns: ColumnMeta[];	// in declaration order; the order screens present them in
	references: ReferenceMeta[];	// the fks this table declares, minus the ones this caller may not read
	/** What *this* caller may do here. A table it cannot read is not sent at all. */
	capabilities: Capability[];
}

export interface OperatorMeta {
	name: string;		// the wire name, e.g. "ge"
	symbol: string;		// how it is written, e.g. ">="
	label: string;		// what it is called on screen
	takesValue: boolean;	// false for one that is the whole question, e.g. `is null`
}

export interface FilterCondition {
	op: string;		// an `OperatorMeta.name`
	value: unknown;
}

/** Note: Only the formats that hand back a file are listed. */
export interface FormatMeta {
	name: string;		// e.g. "xlsx", i.e. what `?format=` takes
	label: string;		// human-readable name, e.g. "Excel"
	extension: string;	// e.g. "xlsx"
}

export interface SystemMeta {
	tables: TableMeta[];
	operators: OperatorMeta[];
	defaultOperator: string;
	formats: FormatMeta[];
}

/** One refusal per column name. */
export type FieldErrors = Record<string, string>;

export interface ErrorBody {
	error: string;
	fields?: FieldErrors;
}
