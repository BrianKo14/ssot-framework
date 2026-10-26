// The login screen, and the session it opens.

import { byId } from '../kit/dom.js';
import { api, ApiError, sending } from './api.js';

const AUTH = '/api/_auth';

export interface Session {
	username: string;
	role: string;
}

/** 401: the session has ended. */
export const sessionEnded = (err: unknown): boolean => err instanceof ApiError && err.status === 401;

/** On a 401, reloads the page, which lands on the login. True when it did. */
export const restarted = (err: unknown): boolean => {
	if (!sessionEnded(err)) return false;

	location.reload();

	return true;
};

/** Resolves once there is a session; `main()` waits for it before drawing anything.
 * The session token is an httpOnly cookie, so the page never reads it. */
export async function authenticated(): Promise<Session> {
	const view = byId('login');
	const form = byId('login-form') as HTMLFormElement;
	const username = byId('login-username') as HTMLInputElement;
	const password = byId('login-password') as HTMLInputElement;
	const submit = byId('login-submit') as HTMLButtonElement;
	const problem = byId('login-error');

	byId('logout').addEventListener('click', () => {
		void api<void>(AUTH, sending('DELETE')).finally(() => location.reload());
	});

	const signedIn = (session: Session): Session => {
		byId('account-username').textContent = session.username;
		byId('account-role').textContent = session.role;
		byId('account').hidden = false;
		view.hidden = true;

		return session;
	};

	const attempt = async (accept: (s: Session) => void): Promise<void> => {
		problem.hidden = true;
		submit.disabled = true;

		try {
			const { user } = await api<{ user: Session }>(AUTH,
				sending('POST', { username: username.value, password: password.value }));

			password.value = '';				// don't leave the password in the DOM
			accept(signedIn(user));
		} catch (err) {
			problem.textContent = (err as Error).message;
			problem.hidden = false;
			password.select();
		} finally {
			submit.disabled = false;
		}
	};

	const existing = await api<{ user: Session }>(AUTH).then(r => r.user).catch(() => null);

	if (existing) return signedIn(existing);

	view.dataset.state = 'asking';
	username.focus();

	return new Promise<Session>(accept => {
		form.addEventListener('submit', e => { e.preventDefault(); void attempt(accept); });
	});
}
