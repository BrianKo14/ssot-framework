// Starts the live server

import { serve } from '../serve.js';
import { tables } from './system.js';

await serve(tables);
