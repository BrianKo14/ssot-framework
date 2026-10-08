// Starts the live server

import { serve } from '../serve.js';
import { monitor, tables } from './system.js';

await serve(tables, { monitor });
