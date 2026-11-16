import { spawn } from 'node:child_process';
import { mkdtemp, rm, cp, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout } from 'node:timers/promises';

const state = await mkdtemp(join(tmpdir(), 'home-inventory-test-'));
const cf = resolve('node_modules/.bin/cf');
const probe = createServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const base = `http://127.0.0.1:${port}`;
const run = (command, args, env = process.env, cwd = process.cwd()) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: 'inherit', env, cwd });
  child.on('error', reject);
  child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)));
});
let server;
let logs = '';
try {
  for (const file of ['src', 'public', 'config', 'migrations', 'package.json', 'cloudflare.config.ts', 'wrangler.config.ts']) await cp(resolve(file), join(state,file), { recursive: true });
  await symlink(resolve('node_modules'), join(state,'node_modules'), 'dir');
  await run(cf, ['d1', 'migrations', 'apply', '00000000-0000-4000-8000-000000000002', '--local', '--mode', 'development', '--dir', 'migrations'], process.env, state);
  server = spawn(cf, ['dev', '--mode', 'development', '--port', String(port)], { cwd: state, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  server.stdout.on('data', chunk => { logs = (logs + chunk).slice(-12000); });
  server.stderr.on('data', chunk => { logs = (logs + chunk).slice(-12000); });
  const deadline = Date.now() + 45000;
  for (;;) {
    if (server.exitCode !== null) throw new Error('The local server stopped.');
    try { if ((await fetch(`${base}/api/bootstrap`, { signal: AbortSignal.timeout(1000) })).ok) break; } catch {}
    if (Date.now() > deadline) throw new Error('The local server did not start.');
    await setTimeout(200);
  }
  await run(process.execPath, ['--test', '--test-concurrency=1', 'tests/*.test.mjs'], { ...process.env, TEST_URL: base });
} catch (error) {
  process.stderr.write(`${logs}\n${error.message}\n`);
  process.exitCode = 1;
} finally {
  if (server?.pid) {
    const stopped = new Promise(resolve => server.once('exit', resolve));
    try { process.kill(-server.pid, 'SIGTERM'); } catch {}
    await Promise.race([stopped, setTimeout(3000)]);
    if (server.exitCode === null) { try { process.kill(-server.pid, 'SIGKILL'); } catch {} }
  }
  await rm(state, { recursive: true, force: true });
}
