// Example system of an SSOT, imported from `system-definition`
//
// Every command runs from here, which the npm script runs:
// 	`node dist/example/index.js <start|schema|update|seed|locks>`

import { aidaTypeDefs, entityDefs } from 'system-definition/examples';
import { main, type System } from '../ops/main.js';
import { tablesFrom } from '../schema/build.js';
import { date } from '../types/builtin.js';
import { handlersFor } from '../types/registry.js';

export const system: System = {
	tables: tablesFrom(entityDefs,
		handlersFor(
			aidaTypeDefs,
			{ fecha: () => date }	// `fecha` has no base, we link it to the `date` type handler here
		)),
	grants: { monitor: ['admin'] },		// which roles are allowed to monitor
	seed: 'src/example/aida',
};

if (import.meta.main) // when not run directly (tests), this is false
	main(system);
