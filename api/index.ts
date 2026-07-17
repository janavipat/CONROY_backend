// Vercel serverless entry point.
//
// Vercel's Node builder compiles this file (and everything it imports)
// directly from TypeScript source — no separate `dist/` build is involved
// for the function itself, so there's exactly one copy of this code, not
// two. Exporting the Express app as the default export is Vercel's documented
// pattern for wrapping an existing Express app: it's invoked as the request
// handler for every path (see the root-level `vercel.json` rewrite), and
// Express's own router still matches against the real incoming request path.
import { createApp } from "../src/app.js";

const app = createApp();

export default app;
