import path from 'node:path';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { createApp } from './api';

async function acquireLock(directory: string): Promise<() => Promise<void>> {
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, 'controller.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(file, 'wx', 0o600);
      await handle.writeFile(String(process.pid));
      await handle.close();
      return async () => {
        await unlink(file).catch(() => {});
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const pid = Number(await readFile(file, 'utf8').catch(() => '0'));
      let alive = false;
      if (pid > 0) {
        try {
          process.kill(pid, 0);
          alive = true;
        } catch {
          /* Stale controller. */
        }
      }
      if (alive)
        throw new Error(`Another AI Flow controller is using this data directory (PID ${pid}).`);
      await unlink(file).catch(() => {});
    }
  }
  throw new Error('Unable to acquire the controller lock.');
}

async function main() {
  const root = process.env.FLOW_ROOT || path.resolve(__dirname, '../../..');
  const dataDirectory = path.resolve(process.env.FLOW_DATA_DIR || path.join(root, '.ai-flow'));
  const release = await acquireLock(dataDirectory);
  try {
    const { app, flow, store } = await createApp({ root, dataDirectory });
    const port = Number(process.env.FLOW_API_PORT || 4310);
    await app.listen(port, '127.0.0.1');
    console.log(`AI Flow controller: http://127.0.0.1:${port}/api/health`);
    let closing = false;
    const shutdown = async () => {
      if (closing) return;
      closing = true;
      await flow.shutdown();
      await app.close();
      store.close();
      await release();
      process.exit(0);
    };
    process.on('SIGINT', () => {
      void shutdown();
    });
    process.on('SIGTERM', () => {
      void shutdown();
    });
  } catch (error) {
    await release();
    throw error;
  }
}

main().catch((error) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
