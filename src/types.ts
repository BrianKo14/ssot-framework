import { scalar, textual, typeOf, type TypeHandler } from './type-handler.js';


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

const 	INT4_MIN = -2147483648,
	INT4_MAX = 2147483647;

export const integer = (min = INT4_MIN, max = INT4_MAX): TypeHandler<number> => {
	const inRange = (n: number) => n >= min && n <= max ? n : undefined;

	return scalar(
		`a whole number between ${min} and ${max}`,
		raw => typeof raw === 'number' && Number.isInteger(raw) ? inRange(raw) : undefined,
		raw => /^-?\d+$/.test(raw) ? inRange(Number(raw)) : undefined);
};

/** Note: A JS number cannot hold what a Postgres `numeric` column can, so we bind it as a string. */
export const decimal: TypeHandler<string> = scalar('a number',
	raw => typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : undefined,
	raw => /^-?\d+(\.\d+)?$/.test(raw) ? raw : undefined);

/** 
 * @param maxLength optionally bounded. 
 * **Note:** Postgres counts code points (entries in the Unicode table), not UTF-16 code units, so `[...s].length` is the right answer, not `s.length`. */
export const text = (maxLength?: number): TypeHandler<string> =>
	typeOf(maxLength === undefined ? 'text' : `text of at most ${maxLength} characters`,
		raw => typeof raw === 'string' && (maxLength === undefined || [...raw].length <= maxLength)
			? raw : undefined);


const BOOLEAN_TEXT = new Map([['true', true], ['t', true], ['false', false], ['f', false]]);

/** Strictly true / false. */
export const boolean: TypeHandler<boolean> = scalar('true or false',
	raw => typeof raw === 'boolean' ? raw : undefined,
	raw => BOOLEAN_TEXT.get(raw));


// --- Temporal types ---

export const date: TypeHandler<string> = textual('a date (YYYY-MM-DD)',
	new RegExp(`^${DATE_SHAPE}$`), m => isRealDate(m, 1) ? m[0] : undefined);

export const time: TypeHandler<string> = textual('a time (HH:MM[:SS])',
	new RegExp(`^${TIME_SHAPE}$`), m => isRealTime(m, 1) ? m[0] : undefined);

export const datetime: TypeHandler<string> = textual('a date and time (YYYY-MM-DD HH:MM[:SS])',
	new RegExp(`^${DATE_SHAPE}[T ]${TIME_SHAPE}$`),
	m => isRealDate(m, 1) && isRealTime(m, 4) ? m[0] : undefined);

export const interval: TypeHandler<string> = textual('a duration (ISO-8601, e.g. P1DT2H30M)',
	/^P(?!$)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(?!$)(\d+H)?(\d+M)?(\d+(\.\d+)?S)?)?$/);




export const commonTypes = {
	text: text(),
	integer: integer(),
	boolean,
	decimal,
	date,
	datetime,
	time,
	interval,
};
