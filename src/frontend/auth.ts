// The login screen

import { api, ApiError, sending } from './api.js';
import { byId } from './dom.js';

const AUTH = '/api/_auth';

export interface Session {
	username: string;
	role: string;
}

const el = <T extends HTMLElement>(id: string) => byId(id) as T;

const view = byId('login'),
	form = el<HTMLFormElement>('login-form'),
	username = el<HTMLInputElement>('login-username'),
	password = el<HTMLInputElement>('login-password'),
	submit = el<HTMLButtonElement>('login-submit'),
	problem = byId('login-error'),
	account = byId('account'),
	who = byId('account-username'),
	asRole = byId('account-role'),
	out = el<HTMLButtonElement>('logout');

/** The frontend token is an httpOnly cookie.
 * The browser attaches this to each request, the page can never read it. */
const whoami = () => api<{ user: Session }>(AUTH).then(r => r.user);

// Logging out (or session dying) just reloads the whole page.
const restart = () => location.reload();

const signedIn = (session: Session): Session => {
	who.textContent = session.username;
	asRole.textContent = session.role;		// what is on screen follows from this, so it is shown
	account.hidden = false;
	view.hidden = true;

	return session;
};

const attempt = async (accept: (s: Session) => void): Promise<void> => {
	problem.hidden = true;
	submit.disabled = true;

	try {
		const { user } = await api<{ user: Session }>(AUTH,
			sending('POST', { username: username.value, password: password.value }));

		password.value = '';				// remove password from the DOM for security
		accept(signedIn(user));
	} catch (err) {
		problem.textContent = (err as Error).message;
		problem.hidden = false;
		password.select();
	} finally {
		submit.disabled = false;
	}
};

/** Resolves only once the user is authenticated.
 * `main()` awaits this. */
export async function authenticated(): Promise<Session> {
	const existing = await whoami().catch(() => null);

	if (existing) return signedIn(existing);

	view.dataset.state = 'asking';
	username.focus();

	return new Promise<Session>(accept => {
		form.addEventListener('submit', e => { e.preventDefault(); void attempt(accept); });
	});
}

/** 401 indicates the session has ended. */
export const sessionEnded = (err: unknown): boolean => err instanceof ApiError && err.status === 401;

out.addEventListener('click', () => {
	void api<void>(AUTH, sending('DELETE')).finally(restart);
});
