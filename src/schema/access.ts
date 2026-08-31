// Authorization rules

import type { Capability } from '../shared/api.js';
import { role as roleType } from '../types/builtin.js';
import type { Access } from './model.js';

/** All capabilities.
 * Written as an object so the compiler can check that every capability is listed. An array wouldn't check. */
const ALL: Record<Capability, true> = { read: true, create: true, update: true, delete: true };
export const CAPABILITIES = Object.keys(ALL) as Capability[];

/** Shape of the access definition in the schema.
 * EntityName -> Role -> Capabilities */
export type AccessDef<TEntities = Record<string, unknown>> = {
	readonly [E in keyof TEntities]?: Readonly<Record<string, readonly Capability[]>>;
};

/** Turns an entity's `AccessDef` entry into an `Access` map that goes in
 * `TableInfo.access` for the guard to read. */
export function accessOf(entityName: string, granted: Readonly<Record<string, readonly Capability[]>> = {}): Access {
	const access = new Map<string, ReadonlySet<Capability>>();

	for (const [role, capabilities] of Object.entries(granted)) {
		const where = `entity "${entityName}", role "${role}"`;

		if (!roleType.check(role).ok) throw new Error(`${where}: a role must be ${roleType.expected}`);

		const unknown = capabilities.filter(c => !(c in ALL));

		if (unknown.length) throw new Error(`${where}: unknown capabilit(ies) ${unknown.join(', ')}`);

		access.set(role, new Set(capabilities));
	}

	return access;
}

/** The one question the guard and `/api/_meta` both ask. */
export const allows = (access: Access, role: string, can: Capability): boolean =>
	access.get(role)?.has(can) ?? false;
