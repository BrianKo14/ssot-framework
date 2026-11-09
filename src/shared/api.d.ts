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
	/** Name of the column that tracks the version of each row, for concurrency control.
	 * Presented in `If-Match` headers. E.g. `_version`. */
	stamp: string;
	/** Name of the key each row carries its undoable changes under, as an `Undoable`. E.g. `_undo`.
	 * Published for the same reason `stamp` is: so the browser never writes the name itself. */
	undo: string;
	/** Polling interval + presence tracking, in seconds. */
	pollSeconds: number;
	/** The monitor, when *this* caller may see it; null when not. */
	monitor: MonitorMeta | null;
}

/** Another tab, on this screen or on any other the caller is allowed to know about. */
export interface Viewer {
	id: string;
	user: string;
	/** Which screen they have open. */
	entity: string;
	/** The records they are on, each as the address writes its pk values. */
	records: string[];
}

/** A held record. */
export interface Lock {
	record: string;
	holder: string;
}

/** About a tab; its viewers and locks. */
export interface Watching {
	tab: string;
	viewers: Viewer[];
	locks: Lock[];
}

/** The monitor's two lists, each described as a table is, so the filter bar takes it as one. */
export interface MonitorMeta {
	users: TableMeta;	// the signed-in users: who they are, and their newest action
	actions: TableMeta;	// one user's actions
	/** The SQL dump, when the server writes one; null when it does not. */
	dump: TableMeta | null;
}

/** A row of the activity log. */
export interface Activity {
	at: string;			// when, by the database's clock
	screen: string | null;		// the entity the page was showing
	request: string;		// method + URL
	statements: string;		// the SQL it ran, semicolon-separated
}

/** A statement that took effect, as the SQL dump writes it. */
export interface Dumped {
	at: string;			// when its answer arrived, by the server's clock
	statements: string;		// one statement, its values written in
}

/** The SQL dump, as one viewer sees it. */
export interface DumpRead {
	/** How many statements the filter matched. */
	total: number;
	entries: Dumped[];
}

/** A signed-in user, as the monitor lists them. */
export interface Online {
	user: string;
	role: string;
	last: Activity | null;
}

/** What the monitor is answered each round. */
export interface Monitored {
	online: Online[];
	/** Every open tab the watcher may be told about, whoever's and whatever the list's filter:
	 * a user's are their *Tablas abiertas*, and all of them are what the rail draws. */
	tabs: Viewer[];
}

/** A change to a record. */
export interface Change {
	field: string;		// the column that changed
	was: string | null;	// what it held, as the database renders it
	/** The row version this write produced. A string, like `_version` (compared, not counted) */
	version: string;
	at: string;		// when, by the database's clock
	by: string;		// who
}

/** A record's history, map of column names to their latest changes. */
export type Undoable = Record<string, Change>;

/** One line of a record's history: a change, and what it made the column. */
export interface Logged extends Change {
	became: string | null;
}

/** One refusal per column name. */
export type FieldErrors = Record<string, string>;

export interface ErrorBody {
	error: string;
	fields?: FieldErrors;
}
