// The harness entry point. The grading environment starts this file, waits for
// the server to register its port, runs the conformance checks against it, and
// finally signals completion through the /done endpoint. This file owns that
// lifecycle only: it binds an ephemeral port, registers with backoff, polls for
// completion, and only then shuts down. It never exits early.

import { createApp } from './app.ts';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function register(envUrl: string, port: number): Promise<boolean> {
  const deadline = Date.now() + 18_000;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt += 1;
    try {
      const response = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      if (response.status === 200) return true;
      if (response.status === 400 || response.status === 405) {
        console.error(`register rejected with status ${response.status}; giving up`);
        return false;
      }
      // 409 (another registration won) and anything else: back off and retry.
    } catch (err) {
      void err;
      // The environment may not be reachable yet; retry within the budget.
    }
    const delay = Math.min(250 * attempt, 1000);
    await sleep(delay);
  }
  return false;
}

async function waitForDone(envUrl: string): Promise<void> {
  for (;;) {
    try {
      const response = await fetch(`${envUrl}/done`, { method: 'GET' });
      if (response.ok) {
        const body = (await response.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch (err) {
      void err;
      // Transient environment errors: keep polling. Never exit early.
    }
    await sleep(500);
  }
}

async function main(): Promise<void> {
  const envUrl = process.env.MAKEFUN_ENV_URL;
  if (envUrl === undefined || envUrl === '') {
    console.error('MAKEFUN_ENV_URL is not set; refusing to start outside the harness');
    process.exit(1);
  }
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? null;
  const { server } = createApp({ token });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    console.error('server did not bind to a TCP port');
    process.exit(1);
  }
  const registered = await register(envUrl, address.port);
  if (!registered) {
    console.error('failed to register with the environment');
    process.exit(1);
  }
  await waitForDone(envUrl);
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  process.exit(0);
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
