import { render } from 'solid-js/web';
import App from './App';
import './style.css';

if (typeof globalThis.process !== 'undefined') {
  const proc = globalThis.process as any;
  if (!proc.stdin) {
    proc.stdin = {
      on: () => {},
      pipe: () => {},
      resume: () => {},
      pause: () => {},
      setEncoding: () => {},
      isTTY: false,
    };
  }
  if (!proc.stdout) {
    proc.stdout = {
      write: () => {},
      on: () => {},
      once: () => {},
      emit: () => {},
      isTTY: false,
    };
  }
  if (!proc.stderr) {
    proc.stderr = {
      write: () => {},
      on: () => {},
      once: () => {},
      emit: () => {},
      isTTY: false,
    };
  }
}

render(() => <App />, document.getElementById('root')!);
