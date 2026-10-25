import { spawn } from 'node:child_process';
import { root } from './environment.mjs';

const workspaces = ['@ai-flow/shared', '@ai-flow/server', '@ai-flow/web'];
let current;
let stopping = false;
function buildNext(index) {
  if (index >= workspaces.length || stopping) return;
  current = spawn('npm', ['run', 'build', '-w', workspaces[index]], {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
  });
  current.once('error', (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  current.once('exit', (code) => {
    if (code !== 0) process.exitCode = code || 1;
    else buildNext(index + 1);
  });
}
process.once('SIGINT', () => {
  stopping = true;
  current?.kill('SIGINT');
});
process.once('SIGTERM', () => {
  stopping = true;
  current?.kill('SIGTERM');
});
buildNext(0);
