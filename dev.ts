// A local practice runner: the same application without the harness lifecycle,
// so the forge can be exercised with real clients (git, curl, the kit's own
// conformance suite) before submission.
//
//   PORT=3000 MAKEFUN_SHOP_TOKEN=test-token node --experimental-strip-types dev.ts
//
// With no token set, every request is accepted.

import { createApp } from './app.ts';

const port = Number(process.env.PORT ?? '3000');
const token = process.env.MAKEFUN_SHOP_TOKEN ?? null;
const { server } = createApp({ token });
server.listen(port, () => {
  console.log(`forge listening on http://127.0.0.1:${port} (token ${token === null ? 'not required' : 'required'})`);
});
