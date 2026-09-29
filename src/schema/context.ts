// The system's context
// I.e. a system's types -> the context its records/entities are validated and serialized against.

import {
	completeCoreField, completeDefault, defineTypes, notParsed, parsed,
	type AnyTypeBehaviour, type CoreFieldDef, type DefaultValueFieldDef,
	type TypeCollection, type TypeProvider, type ValidatedTypes,
} from 'system-definition';
import type { TypeHandler } from '../types/handler.js';
import { type BaseType, handlersFor } from '../types/registry.js';

/** Core field definition, incl. core type + default value + name flag. */
export type FrameworkFieldDef<TTypes extends TypeCollection> =
	CoreFieldDef<TTypes> & DefaultValueFieldDef<TTypes> & { isName?: boolean };

/** Def -> Info for one field. */
export const completeField = (fieldDef: FrameworkFieldDef<TypeCollection>, name: string) => ({
	...completeCoreField(fieldDef, name),
	isName: fieldDef.isName ?? false,
	defaultValue: completeDefault(fieldDef),
});

/** Wraps type's validation logic into the three behaviours: (1) text -> value, (2) value -> text, (3) check validity.  */
const behaviourOf = (name: string, handler: TypeHandler<any>): AnyTypeBehaviour => ({
	deserialize: text => {
		const checked = handler.check(text);
		return checked.ok ? parsed(checked.value) : notParsed(`type.${name}`);
	},
	serialize: (value: never) => String(handler.cell ? handler.cell(value) : value),
	check: value => handler.check(value).ok,
});

/** A system's types -> the context its records and entities are described against.
 * Incl. handlers (validation code for each type) + behaviours (serialization and validation).
 *
 * @param types a description of the system's types
 * @param extra bases this system adds */
export function describeTypes<const TTypes extends TypeCollection>(
	types: TTypes & ValidatedTypes<TTypes>,
	extra: Readonly<Record<string, BaseType>> = {},
) {
	const handlers = handlersFor(types, extra);
	const behaviours = Object.fromEntries(Object.entries(handlers).map(([name, handler]) =>
		[name, behaviourOf(name, handler)])) as unknown as TypeProvider<TTypes>;

	return {
		...defineTypes({
			types,
			completeField: (fieldDef: FrameworkFieldDef<TTypes>, name: string) =>
				({ ...completeField(fieldDef as FrameworkFieldDef<TypeCollection>, name), type: fieldDef.type }),
			behaviours,
		}),
		handlers,
	};
}
