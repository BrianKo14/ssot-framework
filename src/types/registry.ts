// Resolves type definitions into handlers with behaviour

import { boxType, commonTypeDefs, type TypeAttrs, type TypeCollection } from 'system-definition';
import { boolean, date, datetime, decimal, digest, integer, interval, password, role, text, time, token } from './builtin.js';
import type { TypeHandler, TypeHandlers } from './handler.js';

export type BaseType = (attrs: TypeAttrs | undefined) => TypeHandler<any>;

const bound = (a: TypeAttrs | undefined): number | undefined => a?.kind === 'bound' ? a.maxLength : undefined;
const range = (a: TypeAttrs | undefined) => a?.kind === 'range' ? a : undefined;
const exact = (a: TypeAttrs | undefined) => a?.kind === 'decimal' ? a : undefined;

const BASE_TYPES: Readonly<Record<string, BaseType>> = {
	text: a => text(bound(a)),
	integer: a => { const r = range(a); return r ? integer(r.min, r.max) : integer(); },
	decimal: a => { const d = exact(a); return d ? decimal(d.precision, d.scale) : decimal(); },
	boolean: () => boolean,
	date: () => date,
	datetime: () => datetime,
	time: () => time,
	interval: () => interval,
	password: a => { const r = range(a); return r ? password(r.min, r.max) : password(); },
	token: () => token,
	digest: () => digest,
	role: () => role,
};

export const builtinTypeDefs = {
	...commonTypeDefs,		// text, integer and boolean are the vocabulary's, not ours to restate
	decimal: { tsType: boxType<string>() },
	date: { tsType: boxType<string>() },
	datetime: { tsType: boxType<string>() },
	time: { tsType: boxType<string>() },
	interval: { tsType: boxType<string>() },
} satisfies TypeCollection;	// checked whole where a system's types are: `describeTypes` in `schema/build.ts`

/** Type definitions -> type handlers
 *
 * @param typeDefs a description of the system's types
 * @param extra bases this system adds */
export function handlersFor(typeDefs: TypeCollection, extra: Readonly<Record<string, BaseType>> = {}): TypeHandlers {
	const bases = { ...BASE_TYPES, ...extra };

	return Object.fromEntries(Object.entries(typeDefs).map(([name, typeDef]) => {
		const baseName = typeDef.base ?? name;
		const base = bases[baseName];

		if (!base) throw new Error(`type "${name}": unknown base "${baseName}"`);

		return [name, base(typeDef.attrs)];
	}));
}

export const commonTypes: TypeHandlers = handlersFor(builtinTypeDefs);
