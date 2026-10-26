// The page's entry point: sign in, read `_meta`, build the screens, then draw whatever the
// address says. Every move (a link, the filter bar, Back) ends in `draw`.

import type { SystemMeta } from '../shared/api.js';
import { byId } from './kit/dom.js';
import { selectionOf } from './kit/selection.js';
import { statusOf } from './kit/status.js';
import { fkIndex } from './model/fk.js';
import { router, screenOf } from './model/route.js';
import { api } from './wire/api.js';
import { authenticated, restarted } from './wire/auth.js';
import { recordsOf } from './wire/records.js';
import { cellsOf } from './sheet/cells.js';
import { refusalsOf } from './sheet/refusals.js';
import type { Env } from './sheet/sheet.js';
import { DUMP, dumpScreen } from './screens/dump.js';
import { MONITOR, monitorScreen } from './screens/monitor.js';
import { tableScreen } from './screens/table.js';
import { current, toolLink } from './screens/viewers.js';

async function main(): Promise<void> {
	const status = statusOf(byId('status'));
	const me = await authenticated();		// nothing below runs until there is a session

	let meta: SystemMeta;

	try {
		meta = await api<SystemMeta>('/api/_meta');
	} catch (err) {
		status.fail(`No se pudo leer el esquema: ${(err as Error).message}`);
		return;
	}

	const { tables } = meta;

	if (!tables.length) { status.say('No hay entidades disponibles para este usuario.'); return; }



	// --- Building the screens ---

	const route = router(meta);
	const fkOf = fkIndex(tables);

	const env: Env = {
		status, route, fkOf,
		records: recordsOf(meta),
		refusals: refusalsOf(me.username),
		cells: cellsOf(fkOf, route),
		selection: selectionOf(),
		failSoftly: err => { if (!restarted(err)) status.fail((err as Error).message); },
	};

	const table = tableScreen(meta, env);

	const observer = meta.monitor && monitorScreen({
		meta: meta.monitor, operators: meta.operators, seconds: meta.pollSeconds, status,
		hrefOf: user => route.href(screenOf(MONITOR, [user])),
		close: () => route.go(screenOf(MONITOR)),
		tab: () => table.tab(),
		seen: viewers => table.seen(viewers),		// the rail still says who is on each screen
	});

	const reader = meta.monitor?.dump && dumpScreen({ meta: meta.monitor.dump, operators: meta.operators, status });

	if (observer) {
		const tools = byId('tools');

		tools.replaceChildren(toolLink(route, MONITOR, 'Monitor'));
		byId('tools-title').hidden = false;

		if (reader) tools.append(toolLink(route, DUMP, 'SQL dump'));
	}

	byId('toolbar').append(...[observer, reader].flatMap(own => own ? [own.bar] : []));
	byId('header-end').append(...(reader ? [reader.refresh] : []));



	// --- Drawing what the address says ---

	/** One of the framework's own screens, instead of a table's. */
	const ownScreen = (name: string, title: string) => {
		status.standing(route, []);
		current(name);
		table.leave();
		byId('title').replaceChildren(title);
		status.busy('Cargando…');
	};

	const draw = async (): Promise<void> => {
		const { view, unresolved } = route.read();

		if (view.screen === MONITOR && observer) {
			reader?.stop();
			ownScreen(MONITOR, 'Monitor');
			observer.show(view.key[0] ?? null);
			return;
		}

		if (view.screen === DUMP && reader) {
			observer?.stop();
			ownScreen(DUMP, 'SQL dump');
			reader.show();
			return;
		}

		const t = tables.find(x => x.entity === view.screen);

		if (!t) { route.go(screenOf(tables[0].entity), true); return; }

		observer?.stop();
		reader?.stop();

		await table.draw(t, view, unresolved);
	};

	const render = () => void draw().catch(err => table.broke(err));

	route.onNavigate(render);
	render();
}

void main();
