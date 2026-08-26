


// --- TYPE HANDLER INTERFACE ---

/** The outcome of checking one value. `ok: false` carries no message. */
export type Checked<T> = { ok: true; value: T } | { ok: false };

/** Interface for any type handler */
export interface TypeHandler<T> {
	/** How this type is described when a value is refused, e.g. "an integer", "a date (YYYY-MM-DD)". */
	readonly expected: string;
	/** Wire value -> value to bind, or a refusal. Never throws. */
	check(raw: unknown): Checked<T>;
}

/** Collection of handlers exported to the framework. */
export type TypeHandlers = Record<string, TypeHandler<any>>;

/** The TypeScript type of a handler, as in e.g. `let x : TsTypeOf<typeof handler> = ...` instead of `let x : integer`. */
export type TsTypeOf<H> = H extends TypeHandler<infer T> ? T : never;

/** Map: set of handlers -> their result types */
export type TypeCollectionOf<H extends TypeHandlers> = { [K in keyof H]: { tsType: TsTypeOf<H[K]> } };



// --- COMBINATORS ---

// Every built-in type is built from these

const ok = <T>(value: T): Checked<T> => ({ ok: true, value });
const no: Checked<never> = { ok: false };

/** The base handler.
 * `recognise` returns the value to bind, or undefined to refuse. */
export const typeOf = <T>(expected: string, recognise: (raw: unknown) => T | undefined): TypeHandler<T> => ({
	expected,
	check: raw => {
		const value = recognise(raw);
		return value === undefined ? no : ok(value);
	},
});


/** TypeHandler<string> instances for string-shaped wire values (dates, emails, etc.)
 * @param expected the human-readable description of the type, e.g. "a date (YYYY-MM-DD)"
 * @param shape a RegExp that matches the string's shape, e.g. /^\d{4}-\d{2}-\d{2}$/
 * @param accept given the match, returns the string to bind, or undefined to refuse. 
 * 		 Semantic check: i.e. `99:99` is not a valid time, even if it matches the shape. */
export const textual = (
	expected: string,
	shape: RegExp,
	accept: (m: RegExpMatchArray) => string | undefined = m => m[0],
): TypeHandler<string> =>
	typeOf(expected, raw => {
		if (typeof raw !== 'string') return undefined;
		const m = raw.trim().match(shape);
		return m ? accept(m) : undefined;
	});


/** TypeHandler<T> instances for types that are JSON scalars arriving as strings (e.g. integer, URL query, CSV import).
 * @param expected the human-readable description of the type, e.g. "an integer"
 * @param native recognises the value already parsed by JSON, e.g. `7` in the body POST {"id": 7} – i.e. only validates
 * @param lexical recognises the value as raw string, e.g. `"7"` in the string GET /api/cliente/7 – i.e. validates and converts */
export const scalar = <T>(
	expected: string,
	native: (raw: unknown) => T | undefined,
	lexical: (raw: string) => T | undefined,
): TypeHandler<T> =>
	typeOf(expected, raw => typeof raw === 'string' ? lexical(raw.trim()) : native(raw));
