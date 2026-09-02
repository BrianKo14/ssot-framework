// Serves the example system in `system.ts`.

import { serve } from '../serve.js';
import { tables } from './system.js';

await serve(tables);
