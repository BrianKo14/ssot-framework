// This is a main entry point for running commands on a system.
// It hols a table of commands and their implementations
// 	+ a `main` function that looks up the command and runs it with args
//
// See src/ops/README.md for usage instructions.

import type { RoutineInfo, TableInfo } from '../schema/model.js';
import { type Grants, serve } from '../serve.js';
import { run } from './cli.js';
import { locksCli } from './locks.js';
import { schemaCli, seedCli, updateCli } from './schema.js';

export interface System {
	/** As `tablesFrom` built them */
	tables: TableInfo[];
	/** As `routinesFrom` built them */
	routines?: RoutineInfo[];
	grants?: Grants;
	/** A folder of `<entity>.tab` files, for `seed` */
	seed?: string;
	/** A folder of `<entity>.tab` files, loaded into a table when `schema` or `update` creates it */
	initial?: string;
}

const COMMANDS: Record<string, (system: System, argv: string[]) => void> = {

	/** Builds the app from the tables (API, screens, login, monitor) and turns it on a port. */
	start: (s) => run(() => serve(s.tables, s.grants)),

	/** Creates the whole database with its initial data, or prints the SQL if you leave out `--apply`. */
	schema: (s, argv) => schemaCli(s.tables, s.routines ?? [], s.initial, argv),

	/** Changes the database to match the definition, if using `--drop` and `--retype`.
	 * A table it creates gets its initial data. */
	update: (s, argv) => updateCli(s.tables, s.routines ?? [], s.initial, argv),

	/** Checks the sample rows and loads them. */
	seed: (s, argv) => {
		if (s.seed === undefined) throw new Error('this system has no sample data');
		seedCli(s.tables, s.seed, argv);
	},

	/** Lists who is editing which record, and can release locks. */
	locks: (s, argv) => locksCli(s.tables, argv),
};

const USAGE = `usage: node <system> <${Object.keys(COMMANDS).join('|')}> [options]`;

/** Runs the command named first on the command line, with the rest as its options. */
export function main(system: System, [command, ...argv] = process.argv.slice(2)): void {
	const chosen = command === undefined ? undefined : COMMANDS[command];

	if (chosen === undefined) {
		console.error(command === undefined ? USAGE : `unknown command ${command}\n${USAGE}`);
		process.exitCode = 1;
		return;
	}

	chosen(system, argv);
}
