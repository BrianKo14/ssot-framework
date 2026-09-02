// This is the CLI tool for creating/editing users.
// It's not part of the API. It's the only way to bootstrap the first admin.

// See src/ops/README.md for usage instructions.


import { createInterface } from 'node:readline';
import { dbAuthenticator, type UserProfile } from '../auth/store.js';
import { loadConfig } from '../config.js';
import { run, waitForDb } from './cli.js';

const USAGE = 'usage: npm run auth:user -- <username> [--role <r>] [--inactive] [--email <e>] [--no-password]';

const FLAGS = new Map<string, UserProfile>([
	['--active', { active: true }],
	['--inactive', { active: false }],
]);

interface Args { username: string; profile: UserProfile; setPassword: boolean }

function parse(argv: string[]): Args {
	let username: string | undefined;
	let profile: UserProfile = {};
	let setPassword = true;

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const flag = FLAGS.get(arg);

		if (flag) { profile = { ...profile, ...flag }; continue; }
		if (arg === '--no-password') { setPassword = false; continue; }
		if (arg === '--email') { profile = { ...profile, email: argv[++i] ?? null }; continue; }
		if (arg === '--role') {
			const role = argv[++i];

			if (role === undefined) throw new Error(`--role needs a value\n${USAGE}`);

			profile = { ...profile, role };
			continue;
		}
		if (arg.startsWith('--')) throw new Error(`unknown option ${arg}\n${USAGE}`);
		if (username !== undefined) throw new Error(`give exactly one user name\n${USAGE}`);

		username = arg;
	}

	if (username === undefined) throw new Error(USAGE);

	return { username, profile, setPassword };
}

async function readPassword(): Promise<string> {
	const fromEnv = process.env.AUTH_PASSWORD;

	if (fromEnv) return fromEnv;

	if (process.stdin.isTTY) process.stdout.write('Password: ');

	const lines = createInterface({ input: process.stdin });

	for await (const line of lines) { lines.close(); return line; }

	throw new Error('no password given');
}

async function main(): Promise<void> {
	const { username, profile, setPassword } = parse(process.argv.slice(2));
	const config = loadConfig();
	const password = setPassword ? await readPassword() : undefined;
	const db = await waitForDb(config.databaseUrl);

	try {
		await dbAuthenticator(db, config.sessionTtl).saveUser(username, profile, password);
		console.log(`user "${username}" saved${password === undefined ? ' (password unchanged)' : ''}`);
	} finally {
		await db.close();
	}
}

run(main);
