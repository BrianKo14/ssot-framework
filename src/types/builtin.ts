import { scalar, textual, typeOf, type TypeHandler } from './handler.js';


// --- Dates ---

const DATE_SHAPE = '(\\d{4})-(\\d{2})-(\\d{2})';				// y, m, d
const TIME_SHAPE = '(\\d{2}):(\\d{2})(?::(\\d{2})(?:\\.(\\d{1,6}))?)?';		// h, mi, s, frac

/** Is e.g. "2026-02-30" well-formed?
 * @param at index of the first of the three date groups */
const isRealDate = (m: RegExpMatchArray, at: number): boolean => {
	const [y, mo, d] = [Number(m[at]), Number(m[at + 1]), Number(m[at + 2])];

	const probe = new Date(0);
	probe.setUTCFullYear(y, mo - 1, d);		// setUTCFullYear, not Date.UTC (years 0-99 are not 19xx)

	return probe.getUTCFullYear() === y && probe.getUTCMonth() === mo - 1 && probe.getUTCDate() === d;
};

/** @param at index of the first of the four time groups */
const isRealTime = (m: RegExpMatchArray, at: number): boolean =>
	Number(m[at]) <= 23 && Number(m[at + 1]) <= 59 && Number(m[at + 2] ?? 0) <= 59;



// --- THE TYPES ---

const 	INT2_MIN = -32768,
	INT2_MAX = 32767,
	INT4_MIN = -2147483648,
	INT4_MAX = 2147483647;

/** How an integer is stored in the database.
 * Picks the narrowest integer column that can hold every value the handler accepts. */
const integerStorage = (min: number, max: number): string =>
	min >= INT2_MIN && max <= INT2_MAX ? 'smallint'
		: min >= INT4_MIN && max <= INT4_MAX ? 'integer' : 'bigint';

export const integer = (min = INT4_MIN, max = INT4_MAX): TypeHandler<number> => {
	const inRange = (n: number) => n >= min && n <= max ? n : undefined;

	return {
		sqlType: integerStorage(min, max),
		...scalar(
			`a whole number between ${min} and ${max}`,
			raw => typeof raw === 'number' && Number.isInteger(raw) ? inRange(raw) : undefined,
			raw => /^-?\d+$/.test(raw) ? inRange(Number(raw)) : undefined),
	};
};

/** Note: A JS number cannot hold what a Postgres `numeric` column can, so we bind it as a string.
 *
 * Stored as `decimal`, not `numeric`: the two are the same Postgres type, and naming the storage
 * after the type means no domain is emitted for it — a domain `"decimal"` is one Postgres would
 * shadow with the grammar alias, which `SHADOWED` in `sql/ddl.ts` refuses outright. */
export const decimal = (precision?: number, scale?: number): TypeHandler<string> => ({
	sqlType: precision === undefined ? 'decimal' : `numeric(${precision}${scale === undefined ? '' : `,${scale}`})`,
	...scalar(precision === undefined ? 'a number'
			: `a number of at most ${precision} digits${scale === undefined ? '' : `, ${scale} after the point`}`,
		raw => typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : undefined,
		raw => /^-?\d+(\.\d+)?$/.test(raw) ? raw : undefined),
	cell: Number,
});

/**
 * @param maxLength optionally bounded.
 * **Note:** Postgres counts code points (entries in the Unicode table), not UTF-16 code units, so `[...s].length` is the right answer, not `s.length`. */
export const text = (maxLength?: number): TypeHandler<string> => ({
	sqlType: maxLength === undefined ? 'text' : `varchar(${maxLength})`,
	...typeOf(maxLength === undefined ? 'text' : `text of at most ${maxLength} characters`,
		raw => typeof raw === 'string' && (maxLength === undefined || [...raw].length <= maxLength)
			? raw : undefined),
});


const BOOLEAN_TEXT = new Map([['true', true], ['t', true], ['false', false], ['f', false]]);

/** Strictly true / false. */
export const boolean: TypeHandler<boolean> = {
	sqlType: 'boolean',
	...scalar('true or false',
		raw => typeof raw === 'boolean' ? raw : undefined,
		raw => BOOLEAN_TEXT.get(raw)),
};


// --- Temporal types ---
// Kept as strings end to end for simplicity, because JS Date is a mess. (TODO: use temporal types.)

export const date: TypeHandler<string> = {
	sqlType: 'date',
	...textual('a date (YYYY-MM-DD)',
		new RegExp(`^${DATE_SHAPE}$`), m => isRealDate(m, 1) ? m[0] : undefined),
};

export const time: TypeHandler<string> = {
	sqlType: 'time',
	...textual('a time (HH:MM[:SS])',
		new RegExp(`^${TIME_SHAPE}$`), m => isRealTime(m, 1) ? m[0] : undefined),
};

export const datetime: TypeHandler<string> = {
	sqlType: 'timestamp',
	...textual('a date and time (YYYY-MM-DD HH:MM[:SS])',
		new RegExp(`^${DATE_SHAPE}[T ]${TIME_SHAPE}$`),
		m => isRealDate(m, 1) && isRealTime(m, 4) ? m[0] : undefined),
};

export const interval: TypeHandler<string> = {
	sqlType: 'interval',
	...textual('a duration (ISO-8601, e.g. P1DT2H30M)',
		/^P(?!$)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(?!$)(\d+H)?(\d+M)?(\d+(\.\d+)?S)?)?$/),
};


// --- Secrets ---

// Password / token are never really columns (password is hashed and token is digested).
// We still type them to validate their wire value.

/** A password as it was typed */
export const password = (min = 8, max = 200): TypeHandler<string> => ({
	sqlType: `varchar(${max})`,				// redundant because not really stored as such
	...typeOf(`a password of ${min} to ${max} characters`, raw => {
		if (typeof raw !== 'string') return undefined;

		const length = [...raw].length;			// code points, as `text` counts them

		return length >= min && length <= max ? raw : undefined;
	}),
});

/** A session token as it is written on the wire */
export const TOKEN_BYTES = 32;
export const token: TypeHandler<string> = {
	sqlType: 'varchar(43)',					// redundant because not really stored as such
	...textual('a session token', /^[A-Za-z0-9_-]{43}$/),
};

/** A SHA-256 digest in hex (how session tokens are stored) */
export const digest: TypeHandler<string> = {
	sqlType: 'varchar(64)',					// note: not `char(64)` because it compares padding
	...textual('a hex digest', /^[0-9a-f]{64}$/),
};


// --- Access ---

/** A role name, as used in the application's access policy. */
export const role: TypeHandler<string> = {
	sqlType: 'varchar(60)',
	...textual('a role name (lowercase, e.g. "admin")', /^[a-z][a-z0-9_]{0,59}$/),
};
