import { describe, it, expect, vi, beforeEach } from 'vitest';
import { initSW } from './sw.js';

const mockClients = {
  claim: vi.fn().mockResolvedValue(undefined),
  matchAll: vi.fn().mockResolvedValue([]),
};

beforeEach(() => {
  vi.restoreAllMocks();
  mockClients.claim.mockResolvedValue(undefined);
  mockClients.matchAll.mockResolvedValue([]);
});

describe('SW script behavior', () => {
  it('calls skipWaiting on install', () => {
    const skipWaitingSpy = vi.fn();
    const swGlobal = {
      addEventListener: vi.fn((type: string, handler: (...args: unknown[]) => void) => {
        if (type === 'install') handler();
      }),
      skipWaiting: skipWaitingSpy,
      clients: mockClients,
    } as unknown as ServiceWorkerGlobalScope;

    initSW(swGlobal);
    expect(skipWaitingSpy).toHaveBeenCalled();
  });

  it('calls clients.claim and matchAll on activate', () => {
    const swGlobal = {
      addEventListener: vi.fn((type: string, handler: (event: ExtendableEvent) => void) => {
        if (type === 'activate') {
          handler({ waitUntil: vi.fn() } as unknown as ExtendableEvent);
        }
      }),
      skipWaiting: vi.fn(),
      clients: mockClients,
    } as unknown as ServiceWorkerGlobalScope;

    initSW(swGlobal);
    expect(mockClients.claim).toHaveBeenCalled();
    expect(mockClients.matchAll).toHaveBeenCalledWith({ type: 'window' });
  });

  it('queues fetch requests before INIT_PORT and processes after', async () => {
    const respondWith = vi.fn();
    let fetchHandler: ((event: { request: Request; respondWith: typeof respondWith }) => void) | undefined;
    const swGlobal = {
      addEventListener: vi.fn((type: string, handler: (...args: unknown[]) => void) => {
        if (type === 'fetch') fetchHandler = handler as typeof fetchHandler;
      }),
      skipWaiting: vi.fn(),
      clients: mockClients,
    } as unknown as ServiceWorkerGlobalScope;

    initSW(swGlobal);

    fetchHandler?.({
      request: new Request('http://localhost:4173/__preview/3000/queued'),
      respondWith,
    });
    expect(respondWith).toHaveBeenCalledTimes(1);
    expect(respondWith).toHaveBeenCalledWith(expect.any(Promise));

    const mockPort = {
      postMessage: vi.fn(),
      onmessage: null as ((e: MessageEvent) => void) | null,
    };
    const messageHandler = (swGlobal.addEventListener as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[0] === 'message',
    )?.[1];
    messageHandler?.({ data: { type: 'INIT_PORT' }, ports: [mockPort] });

    await new Promise((r) => setTimeout(r, 0));

    expect(mockPort.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'FETCH_REQUEST',
        request: expect.objectContaining({ url: 'http://localhost:4173/__preview/3000/queued', method: 'GET' }),
      }),
    );
  });

  it('intercepts localhost fetch after INIT_PORT', async () => {
    const respondWith = vi.fn();
    let fetchHandler: ((event: { request: Request; respondWith: typeof respondWith }) => void) | undefined;
    const swGlobal = {
      addEventListener: vi.fn((type: string, handler: (...args: unknown[]) => void) => {
        if (type === 'fetch') fetchHandler = handler as typeof fetchHandler;
      }),
      skipWaiting: vi.fn(),
      clients: mockClients,
    } as unknown as ServiceWorkerGlobalScope;

    initSW(swGlobal);

    const mockPort = {
      postMessage: vi.fn(),
      onmessage: null as ((e: MessageEvent) => void) | null,
    };

    const messageHandler = (swGlobal.addEventListener as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[0] === 'message',
    )?.[1];
    messageHandler?.({ data: { type: 'INIT_PORT' }, ports: [mockPort] });

    fetchHandler?.({
      request: new Request('http://localhost:4173/__preview/3000/'),
      respondWith,
    });

    await new Promise((r) => setTimeout(r, 0));

    expect(mockPort.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'FETCH_REQUEST',
        request: expect.objectContaining({ url: 'http://localhost:4173/__preview/3000/', method: 'GET' }),
      }),
    );
    expect(respondWith).toHaveBeenCalled();
  });

  it('does not intercept non-localhost fetch', () => {
    const respondWith = vi.fn();
    let fetchHandler: ((event: { request: Request; respondWith: typeof respondWith }) => void) | undefined;
    const swGlobal = {
      addEventListener: vi.fn((type: string, handler: (...args: unknown[]) => void) => {
        if (type === 'fetch') fetchHandler = handler as typeof fetchHandler;
      }),
      skipWaiting: vi.fn(),
      clients: mockClients,
    } as unknown as ServiceWorkerGlobalScope;

    initSW(swGlobal);

    const mockPort = {
      postMessage: vi.fn(),
      onmessage: null as ((e: MessageEvent) => void) | null,
    };

    const messageHandler = (swGlobal.addEventListener as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[0] === 'message',
    )?.[1];
    messageHandler?.({ data: { type: 'INIT_PORT' }, ports: [mockPort] });

    fetchHandler?.({
      request: new Request('https://example.com/'),
      respondWith,
    });

    expect(respondWith).not.toHaveBeenCalled();
  });
});
