// This is the CLI tool for creating/editing users.
// It's not part of the API. It's the only way to bootstrap the first admin.

// See src/ops/README.md for usage instructions.


import { createInterface } from 'node:readline';
import { dbAuthenticator, type UserProfile } from '../auth/store.js';
import { loadConfig } from '../config.js';
import { connect, type Db } from '../db/postgres.js';

const USAGE = 'usage: npm run auth:user -- <nombre> [--admin] [--inactive] [--email <e>] [--no-password]';

const FLAGS = new Map<string, UserProfile>([
	['--admin', { esAdmin: true }],
	['--no-admin', { esAdmin: false }],
	['--active', { activo: true }],
	['--inactive', { activo: false }],
]);

interface Args { nombre: string; profile: UserProfile; setPassword: boolean }

function parse(argv: string[]): Args {
	let nombre: string | undefined;
	let profile: UserProfile = {};
	let setPassword = true;

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const flag = FLAGS.get(arg);

		if (flag) { profile = { ...profile, ...flag }; continue; }
		if (arg === '--no-password') { setPassword = false; continue; }
		if (arg === '--email') { profile = { ...profile, email: argv[++i] ?? null }; continue; }
		if (arg.startsWith('--')) throw new Error(`unknown option ${arg}\n${USAGE}`);
		if (nombre !== undefined) throw new Error(`give exactly one user name\n${USAGE}`);

		nombre = arg;
	}

	if (nombre === undefined) throw new Error(USAGE);

	return { nombre, profile, setPassword };
}

async function readPassword(): Promise<string> {
	const fromEnv = process.env.AUTH_PASSWORD;

	if (fromEnv) return fromEnv;

	if (process.stdin.isTTY) process.stdout.write('Contraseña: ');

	const lines = createInterface({ input: process.stdin });

	for await (const line of lines) { lines.close(); return line; }

	throw new Error('no password given');
}

async function waitForDb(url: string, attempts = 20): Promise<Db> {
	for (let left = attempts; ; left--) {
		try {
			return await connect(url);
		} catch (err) {
			if (left <= 1) throw err;

			await new Promise(resolve => setTimeout(resolve, 500));
		}
	}
}

async function main(): Promise<void> {
	const { nombre, profile, setPassword } = parse(process.argv.slice(2));
	const config = loadConfig();
	const clave = setPassword ? await readPassword() : undefined;
	const db = await waitForDb(config.databaseUrl);

	try {
		await dbAuthenticator(db, config.sessionTtl).saveUser(nombre, profile, clave);
		console.log(`usuario "${nombre}" guardado${clave === undefined ? ' (contraseña sin cambios)' : ''}`);
	} finally {
		await db.close();
	}
}

main().catch((err: unknown) => {
	console.error(err instanceof Error ? err.message : String(err));
	process.exitCode = 1;
});
