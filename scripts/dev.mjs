import { spawn } from 'node:child_process';
import { root } from './environment.mjs';
import { supervise } from './services.mjs';

const environment = { ...process.env, FLOW_ROOT: root };
const build = spawn('npm', ['run', 'build', '-w', '@ai-flow/shared'], {
  cwd: root,
  env: environment,
  stdio: 'inherit',
});
build.once('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
build.once('exit', (code) => {
  if (code !== 0) {
    process.exitCode = code || 1;
    return;
  }
  supervise(
    [
      ['npm', ['run', 'dev', '-w', '@ai-flow/server']],
      [
        'npm',
        ['run', 'dev', '-w', '@ai-flow/web', '--', '--port', process.env.FLOW_WEB_PORT || '3000'],
      ],
    ],
    { cwd: root, env: environment },
  );
});
