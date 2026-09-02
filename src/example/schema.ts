// Applies the schema defined in `system.ts` to the database.

import { schemaCli } from '../ops/schema.js';
import { tables } from './system.js';

schemaCli(tables);
