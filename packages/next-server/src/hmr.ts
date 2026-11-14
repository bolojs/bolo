export interface NextHmrEvent {
  readonly type: "full-reload";
  readonly path?: string;
}

export interface NextHmr {
  broadcast(event: NextHmrEvent): void;
  close(): void;
}

/** Full-reload HMR over BroadcastChannel, matching the vite-server
 * convention (`{ type: "full-reload" }` on a named channel). */
export const createNextHmr = (channelName = "next-hmr"): NextHmr => {
  const channel = new BroadcastChannel(channelName);
  return {
    broadcast(event) {
      channel.postMessage(event);
    },
    close() {
      channel.close();
    },
  };
};
