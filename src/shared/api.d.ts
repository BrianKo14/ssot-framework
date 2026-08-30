export interface ColumnMeta {
	name: string;
	type: string;		// the domain type's name, e.g. "nombre" (not the SQL type)
	nullable: boolean;
	expected: string;	// e.g. "a date (YYYY-MM-DD)"
}

export interface TableMeta {
	table: string;
	pk: string[];		// column names, in declaration order
	columns: ColumnMeta[];	// in declaration order; the order screens present them in
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

export interface SystemMeta {
	tables: TableMeta[];
	operators: OperatorMeta[];
}
