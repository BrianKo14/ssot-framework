// Update the database's structure to match the example `system.ts` definition

import { updateCli } from '../ops/schema.js';
import { tables } from './system.js';

updateCli(tables);
