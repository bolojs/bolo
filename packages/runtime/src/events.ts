import type { PortListener, ServerReadyListener, Unsubscribe } from './container-types.js';

interface EventMap {
  port: [port: number, type: 'open' | 'close', url: string];
  'server-ready': [port: number, url: string];
  error: [error: Error];
}

type EventName = keyof EventMap;

export interface ContainerEvents {
  on(event: 'port', listener: PortListener): Unsubscribe;
  on(event: 'server-ready', listener: ServerReadyListener): Unsubscribe;
  on(event: 'error', listener: (error: Error) => void): Unsubscribe;
  emit(event: 'port', port: number, type: 'open' | 'close', url: string): void;
  emit(event: 'server-ready', port: number, url: string): void;
  emit(event: 'error', error: Error): void;
  removeAllListeners(): void;
}

export const createEventEmitter = (): ContainerEvents => {
  const listeners = new Map<EventName, Set<(...args: any[]) => void>>([
    ['port', new Set()],
    ['server-ready', new Set()],
    ['error', new Set()],
  ]);

  const on = (event: EventName, listener: (...args: any[]) => void): Unsubscribe => {
    const set = listeners.get(event)!;
    set.add(listener);
    return () => { set.delete(listener); };
  };

  const emit = (event: EventName, ...args: any[]): void => {
    for (const listener of listeners.get(event)!) {
      listener(...args);
    }
  };

  const removeAllListeners = (): void => {
    for (const set of listeners.values()) set.clear();
  };

  return {
    on: on as ContainerEvents['on'],
    emit: emit as ContainerEvents['emit'],
    removeAllListeners,
  };
};
