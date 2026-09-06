

// -- Type handler interface ---

/** The outcome of checking one value. `ok: false` carries no message. */
export type Checked<T> = { ok: true; value: T } | { ok: false };

/** The type of a value as it is written into a cell (e.g. in Excel). */
export type CellValue = string | number | boolean | null;

/** Value -> cell value. */
type Written<T> = { readonly cell: (value: T) => CellValue; };

/** Is this one of my values? If so, return the value to bind.
 * Says nothing yet about how the value is stored, this is what the combinators below build. */
export type Recogniser<T> = {
	/** Human-readable description of the type, e.g. "an integer", "a date (YYYY-MM-DD)". */
	readonly expected: string;
	/** Wire value -> value to bind, or a refusal. Never throws. */
	check(raw: unknown): Checked<T>;
} & Partial<Written<T>>;

/** Interface for any type handler
 * A recogniser + how it is stored in the database + how it is written into a cell.
 *
 * Note: The conditional makes `cell` mandatory when `T` is not a `CellValue`. This removes repetition down the line,
 * otherwise `format.ts` would have to re-check at runtime. */
export type TypeHandler<T> = Recogniser<T> & {
	/** The SQL type of the handler. Must be a valid SQL type. */
	readonly sqlType: string

	/** How a column with a different type is converted to this one, in SQL.
	 * If left out, the conversion is Postgres's own. */
	readonly convert?: (from: string) => string;
} & (T extends CellValue ? unknown : Written<T>);

/** Collection of handlers exported to the framework. */
export type TypeHandlers = Record<string, TypeHandler<any>>;



// --- Combinators ---

// Every built-in type is built from these

const ok = <T>(value: T): Checked<T> => ({ ok: true, value });
const no: Checked<never> = { ok: false };

/** The base handler.
 * `recognise` returns the value to bind, or undefined to refuse. */
export const typeOf = <T>(expected: string, recognise: (raw: unknown) => T | undefined): Recogniser<T> => ({
	expected,
	check: raw => {
		const value = recognise(raw);
		return value === undefined ? no : ok(value);
	},
});

// Note: we build these as `Recogniser<T>`, not `TypeHandler<T>`.
// Necessarily, `sqlType` and `cell` are filled in later when instantiated.

/** TypeHandler<string> instances for string-shaped wire values (dates, emails, etc.)
 * 
 * @param expected the human-readable description of the type, e.g. "a date (YYYY-MM-DD)"
 * @param shape a RegExp that matches the string's shape, e.g. /^\d{4}-\d{2}-\d{2}$/
 * @param accept given the match, returns the string to bind, or undefined to refuse. 
 * 		 Semantic check: i.e. `99:99` is not a valid time, even if it matches the shape. */
export const textual = (
	expected: string,
	shape: RegExp,
	accept: (m: RegExpMatchArray) => string | undefined = m => m[0],
): Recogniser<string> =>
	typeOf(expected, raw => {
		if (typeof raw !== 'string') return undefined;
		const m = raw.trim().match(shape);
		return m ? accept(m) : undefined;
	});


/** TypeHandler<T> instances for types that are JSON scalars arriving as strings (e.g. integer, URL query, CSV import).
 * 
 * @param expected the human-readable description of the type, e.g. "an integer"
 * @param native recognises the value already parsed by JSON, e.g. `7` in the body POST {"id": 7} – i.e. only validates
 * @param lexical recognises the value as raw string, e.g. `"7"` in the string GET /api/cliente/7 – i.e. validates and converts */
export const scalar = <T>(
	expected: string,
	native: (raw: unknown) => T | undefined,
	lexical: (raw: string) => T | undefined,
): Recogniser<T> =>
	typeOf(expected, raw => typeof raw === 'string' ? lexical(raw.trim()) : native(raw));
