// The login screen

import { api, ApiError, sending } from './api.js';
import { byId } from './dom.js';

const AUTH = '/api/_auth';

export interface Session {
	nombre: string;
	esAdmin: boolean;
}

const el = <T extends HTMLElement>(id: string) => byId(id) as T;

const view = byId('login'),
	form = el<HTMLFormElement>('login-form'),
	nombre = el<HTMLInputElement>('login-nombre'),
	clave = el<HTMLInputElement>('login-clave'),
	submit = el<HTMLButtonElement>('login-submit'),
	problem = byId('login-error'),
	account = byId('account'),
	who = byId('account-name'),
	out = el<HTMLButtonElement>('logout');

/** The frontend token is an httpOnly cookie.
 * The browser attaches this to each request, the page can never read it. */
const whoami = () => api<{ usuario: Session }>(AUTH).then(r => r.usuario);

// Logging out (or session dying) just reloads the whole page.
const restart = () => location.reload();

const signedIn = (session: Session): Session => {
	who.textContent = session.nombre;
	account.hidden = false;
	view.hidden = true;

	return session;
};

const attempt = async (accept: (s: Session) => void): Promise<void> => {
	problem.hidden = true;
	submit.disabled = true;

	try {
		const { usuario } = await api<{ usuario: Session }>(AUTH,
			sending('POST', { nombre: nombre.value, clave: clave.value }));

		clave.value = '';				// remove password from the DOM for security
		accept(signedIn(usuario));
	} catch (err) {
		problem.textContent = (err as Error).message;
		problem.hidden = false;
		clave.select();
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
	nombre.focus();

	return new Promise<Session>(accept => {
		form.addEventListener('submit', e => { e.preventDefault(); void attempt(accept); });
	});
}

/** 401 indicates the session has ended. */
export const sessionEnded = (err: unknown): boolean => err instanceof ApiError && err.status === 401;

out.addEventListener('click', () => {
	void api<void>(AUTH, sending('DELETE')).finally(restart);
});
