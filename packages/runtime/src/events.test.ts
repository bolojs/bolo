import { describe, it, expect, vi } from 'vitest';
import { createEventEmitter } from './events.js';
import type { ContainerEvents } from './events.js';

describe('createEventEmitter', () => {
  it('returns a ContainerEvents object', () => {
    const events = createEventEmitter();
    expect(events).toHaveProperty('on');
    expect(events).toHaveProperty('emit');
    expect(events).toHaveProperty('removeAllListeners');
  });

  describe('on / emit — port', () => {
    it('calls listener with correct args', () => {
      const events = createEventEmitter();
      const listener = vi.fn();
      events.on('port', listener);
      events.emit('port', 3000, 'open', 'http://localhost:3000');
      expect(listener).toHaveBeenCalledWith(3000, 'open', 'http://localhost:3000');
    });

    it('supports multiple listeners', () => {
      const events = createEventEmitter();
      const l1 = vi.fn();
      const l2 = vi.fn();
      events.on('port', l1);
      events.on('port', l2);
      events.emit('port', 8080, 'close', 'http://localhost:8080');
      expect(l1).toHaveBeenCalledTimes(1);
      expect(l2).toHaveBeenCalledTimes(1);
    });
  });

  describe('on / emit — server-ready', () => {
    it('calls listener with correct args', () => {
      const events = createEventEmitter();
      const listener = vi.fn();
      events.on('server-ready', listener);
      events.emit('server-ready', 4000, 'http://localhost:4000');
      expect(listener).toHaveBeenCalledWith(4000, 'http://localhost:4000');
    });
  });

  describe('on / emit — error', () => {
    it('calls listener with error', () => {
      const events = createEventEmitter();
      const listener = vi.fn();
      events.on('error', listener);
      const err = new Error('boom');
      events.emit('error', err);
      expect(listener).toHaveBeenCalledWith(err);
    });
  });

  describe('unsubscribe', () => {
    it('on returns an unsubscribe function', () => {
      const events = createEventEmitter();
      const unsub = events.on('port', vi.fn());
      expect(typeof unsub).toBe('function');
    });

    it('unsubscribed listener is not called', () => {
      const events = createEventEmitter();
      const listener = vi.fn();
      const unsub = events.on('port', listener);
      unsub();
      events.emit('port', 3000, 'open', 'http://localhost:3000');
      expect(listener).not.toHaveBeenCalled();
    });

    it('unsubscribe only removes that specific listener', () => {
      const events = createEventEmitter();
      const l1 = vi.fn();
      const l2 = vi.fn();
      events.on('port', l1);
      const unsub = events.on('port', l2);
      unsub();
      events.emit('port', 3000, 'open', 'http://localhost:3000');
      expect(l1).toHaveBeenCalledTimes(1);
      expect(l2).not.toHaveBeenCalled();
    });
  });

  describe('removeAllListeners', () => {
    it('removes all listeners for all events', () => {
      const events = createEventEmitter();
      const portListener = vi.fn();
      const readyListener = vi.fn();
      const errorListener = vi.fn();
      events.on('port', portListener);
      events.on('server-ready', readyListener);
      events.on('error', errorListener);
      events.removeAllListeners();
      events.emit('port', 3000, 'open', 'http://localhost:3000');
      events.emit('server-ready', 4000, 'http://localhost:4000');
      events.emit('error', new Error('boom'));
      expect(portListener).not.toHaveBeenCalled();
      expect(readyListener).not.toHaveBeenCalled();
      expect(errorListener).not.toHaveBeenCalled();
    });
  });

  describe('synchronous dispatch', () => {
    it('listeners fire synchronously during emit', () => {
      const events = createEventEmitter();
      let order: number[] = [];
      events.on('port', () => { order.push(1); });
      events.on('port', () => { order.push(2); });
      events.emit('port', 3000, 'open', 'http://localhost:3000');
      expect(order).toEqual([1, 2]);
    });
  });
});
