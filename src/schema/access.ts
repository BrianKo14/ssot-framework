// Authorization rules

import { CAPABILITIES, type AccessDef, type Capability } from 'system-definition';
import { role as roleType } from '../types/builtin.js';
import type { Access } from './model.js';

export { CAPABILITIES };
export type { AccessDef };

/** Turns an entity's declared policy into the `Access` map for the guard to use. */
export function accessOf(entityName: string, granted: AccessDef = {}): Access {
	const access = new Map<string, ReadonlySet<Capability>>();

	for (const [declared, capabilities] of Object.entries(granted)) {
		const where = `entity "${entityName}", role "${declared}"`;
		const checked = roleType.check(declared);

		if (!checked.ok) throw new Error(`${where}: a role must be ${roleType.expected}`);

		const unknown = capabilities.filter(c => !CAPABILITIES.includes(c));

		if (unknown.length) throw new Error(`${where}: unknown capabilit(ies) ${unknown.join(', ')}`);

		access.set(checked.value, new Set(capabilities));
	}

	return access;
}

/** The one question the guard and `/api/_meta` both ask. */
export const allows = (access: Access, role: string, can: Capability): boolean =>
	access.get(role)?.has(can) ?? false;
