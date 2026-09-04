export interface ColumnMeta {
	name: string;
	type: string;		// the domain type's name, e.g. "nombre" (not the SQL type)
	nullable: boolean;
	expected: string;	// e.g. "a date (YYYY-MM-DD)"
}

import type { Capability } from 'system-definition';
export type { Capability };

export interface TableMeta {
	entity: string;		// the entity's identity, qualified when it is not in the default schema
	pk: string[];		// column names, in declaration order
	columns: ColumnMeta[];	// in declaration order; the order screens present them in
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
