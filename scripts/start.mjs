import { root } from './environment.mjs';
import { supervise } from './services.mjs';

supervise(
  [
    ['node', ['apps/server/dist/main.js']],
    [
      'npm',
      [
        'run',
        'start',
        '-w',
        '@ai-flow/web',
        '--',
        '--port',
        process.env.FLOW_WEB_PORT || '3000',
        '--hostname',
        process.env.FLOW_WEB_HOST || '127.0.0.1',
      ],
    ],
  ],
  { cwd: root, env: { ...process.env, FLOW_ROOT: root, NODE_ENV: 'production' } },
);
