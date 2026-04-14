import type { PortListener, ServerReadyListener, Unsubscribe } from './container-types.js';

export interface ContainerEvents {
  on(event: 'port', listener: PortListener): Unsubscribe;
  on(event: 'server-ready', listener: ServerReadyListener): Unsubscribe;
  on(event: 'error', listener: (error: Error) => void): Unsubscribe;
  emit(event: 'port', port: number, type: 'open' | 'close', url: string): void;
  emit(event: 'server-ready', port: number, url: string): void;
  emit(event: 'error', error: Error): void;
  removeAllListeners(): void;
}

type EventName = 'port' | 'server-ready' | 'error';
type Listener = (...args: any[]) => void;

export function createEventEmitter(): ContainerEvents {
  const listeners = new Map<EventName, Set<Listener>>();

  const on: ContainerEvents['on'] = (event, listener): Unsubscribe => {
    if (!listeners.has(event)) {
      listeners.set(event, new Set());
    }
    listeners.get(event)!.add(listener as Listener);
    return () => {
      listeners.get(event)?.delete(listener as Listener);
    };
  };

  function emit(event: 'port', port: number, type: 'open' | 'close', url: string): void;
  function emit(event: 'server-ready', port: number, url: string): void;
  function emit(event: 'error', error: Error): void;
  function emit(event: EventName, ...args: any[]): void {
    const set = listeners.get(event);
    if (set) {
      for (const listener of set) {
        listener(...args);
      }
    }
  }

  const removeAllListeners = (): void => {
    listeners.clear();
  };

  return { on, emit, removeAllListeners };
}
