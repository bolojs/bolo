import type { RuntimeMessage, RunScriptOptions } from './runtime-worker.js';

const post = (msg: RuntimeMessage) => self.postMessage(msg);

const runUserCode = (code: string, _opts: RunScriptOptions) => {
  const wrapped = `
    (function() {
      const originalLog = console.log;
      console.log = function(...args) {
        postMessage({ type: 'STDOUT', data: args.map(String).join(' ') });
        originalLog.apply(console, args);
      };
      ${code}
    })()
  `;
  try {
    // eslint-disable-next-line no-eval
    (0, eval)(wrapped);
    post({ type: 'EXIT', code: 0 });
  } catch (err) {
    post({ type: 'STDERR', data: String(err) });
    post({ type: 'EXIT', code: 1 });
  }
};

setInterval(() => {
  post({ type: 'HEARTBEAT' });
}, 5000);

self.onmessage = (ev: MessageEvent<RuntimeMessage>) => {
  const msg = ev.data;
  if (msg.type === 'RUN_SCRIPT') {
    runUserCode(msg.code, msg.opts);
  }
};
