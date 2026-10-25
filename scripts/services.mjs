import { spawn } from 'node:child_process';

/** Own complete service process groups so stopping npm also stops its child servers. */
export function supervise(specifications, options) {
  const children = specifications.map(([command, args]) =>
    spawn(command, args, {
      ...options,
      stdio: 'inherit',
      detached: process.platform !== 'win32',
    }),
  );
  let stopping = false;
  const signal = (child, value) => {
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, value);
      else child.kill(value);
    } catch {
      /* The service has exited. */
    }
  };
  const stop = (code = 0) => {
    if (stopping) return;
    stopping = true;
    children.forEach((child) => signal(child, 'SIGTERM'));
    setTimeout(() => {
      children.forEach((child) => signal(child, 'SIGKILL'));
      process.exit(code);
    }, 3000);
  };
  process.once('SIGINT', () => stop());
  process.once('SIGTERM', () => stop());
  children.forEach((child) => {
    child.once('error', (error) => {
      console.error(error.message);
      stop(1);
    });
    child.once('exit', (code) => {
      if (!stopping) stop(code ?? 1);
    });
  });
}
