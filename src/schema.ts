// Translates the SSOT vocabulary (system-definition) into the plain facts the backend needs.
// This is the only framework file that imports system-definition: everything else talks to
// TableInfo, so the vocabulary layer is reached through one seam and not from all over the app.
//
// The seam runs both ways. Inbound, an EntityDef becomes a TableInfo, with each field's declared
// type name resolved to the handler that will check its values. Outbound, a set of handlers
// becomes the TypeCollection the schema author writes against. Names are declared once, in the
// handlers; the descriptive collection is derived from them and never written a second time.

import { boxType, completeEntity, type EntityDef, type TypeCollection } from 'system-definition';
import type { TypeCollectionOf, TypeHandler, TypeHandlers } from './type-handler.js';

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

/** What the SQL layer needs to know about one entity.
 * Named "Info" following the library's own Def/Info convention: a Def is what the schema author
 * writes, an Info is the completed version that generators consume. */
export interface TableInfo {
	table: string;			// physical table name
	pk: ColumnInfo[];		// primary key columns, in declaration order; may be composite
	columns: ColumnInfo[];		// columns we're allowed to read/write
}

/** The descriptive TypeCollection implied by a set of handlers — what a schema author writes
 * `type:` against. The tsTypes are phantoms (boxType is `() => null`), so this carries no
 * behaviour: it stays plain JSON, as system-definition requires of its descriptive layer. */
export const typeCollectionOf = <H extends TypeHandlers>(handlers: H): TypeCollectionOf<H> =>
	Object.fromEntries(Object.keys(handlers).map(name => [name, { tsType: boxType() }])) as TypeCollectionOf<H>;

/** Completes one EntityDef and reduces it to the facts the SQL layer consumes.
 * Resolving type names here — once, at startup — is what lets every request path assume its
 * column has a handler: an unrecognised type is a boot failure, not a per-request branch. */
function tableInfo(entityName: string, entityDef: EntityDef<TypeCollection>, handlers: TypeHandlers): TableInfo {
	const info = completeEntity(entityDef);		// Def -> Info: fills in the defaults (nullable, label, ...)

	const columns = Object.entries(info.fields).map(([name, field]): ColumnInfo => {
		const typeName = String(field.type);
		const type = handlers[typeName];

		if (!type) throw new Error(`entity "${entityName}", field "${name}": unknown type "${typeName}"`);

		return { name, typeName, nullable: field.nullable, type };
	});

	const byName = new Map(columns.map(c => [c.name, c]));

	return {
		// The entity name doubles as the table name; TODO: SCOPE (4) is where a distinct physical name would come from.
		table: entityName,
		// The same ColumnInfo objects as `columns`, so the two can be compared by identity.
		pk: info.pk.map(name => {
			const column = byName.get(name);
			// extractPk yields undefined rather than complaining, so a pk naming no field gets caught here.
			if (!column) throw new Error(`entity "${entityName}": primary key names unknown field "${name}"`);
			return column;
		}),
		columns,				// field order is the order the schema author declared
	};
}

/** Maps a whole system definition to its tables.
 * @param entityDefs the entities of the system, keyed by entity name
 * @param handlers the system's domain types, the same set `typeCollectionOf` described */
export function tablesFrom(entityDefs: Record<string, EntityDef<TypeCollection>>, handlers: TypeHandlers): TableInfo[] {
	return Object.entries(entityDefs).map(([name, def]) => tableInfo(name, def, handlers));
}
