// List and clear the claims standing on the example system's records

import { locksCli } from '../ops/locks.js';
import { tables } from './system.js';

locksCli(tables);
