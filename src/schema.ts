// Translates the SSOT vocabulary (system-definition) into the plain facts the backend needs.
// This is the only framework file that imports system-definition: everything else talks to
// TableInfo, so the vocabulary layer is reached through one seam and not from all over the app.

import { completeEntity, type EntityDef, type TypeCollection } from 'system-definition';

/** What the SQL layer needs to know about one entity.
 * Named "Info" following the library's own Def/Info convention: a Def is what the schema author
 * writes, an Info is the completed version that generators consume. */
export interface TableInfo {
	table: string;			// physical table name
	pk: string[];			// primary key columns, in declaration order; may be composite
	columns: string[];		// columns we're allowed to read/write
}

/** Completes one EntityDef and reduces it to the facts the SQL layer consumes. */
function tableInfo(entityName: string, entityDef: EntityDef<TypeCollection>): TableInfo {
	const info = completeEntity(entityDef);		// Def -> Info: fills in the defaults (nullable, label, ...)

	return {
		// The entity name doubles as the table name; TODO: SCOPE (4) is where a distinct physical name would come from.
		table: entityName,
		pk: [...info.pk],
		columns: Object.keys(info.fields),	// field order is the order the schema author declared
	};
}

/** Maps a whole system definition to its tables.
 * @param entityDefs the entities of the system, keyed by entity name */
export function tablesFrom(entityDefs: Record<string, EntityDef<TypeCollection>>): TableInfo[] {
	return Object.entries(entityDefs).map(([name, def]) => tableInfo(name, def));
}
