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

export interface SystemMeta {
	tables: TableMeta[];
}
