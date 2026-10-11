// The harness entry of the invariants: `npm run eval:match` runs this file with the eval config and passes --enforce as EVAL_ENFORCE.
import { parseEnforce } from './invariantList.js';
import { registerInvariants } from './invariants.eval.js';

registerInvariants({ enforce: parseEnforce(process.env.EVAL_ENFORCE) });
