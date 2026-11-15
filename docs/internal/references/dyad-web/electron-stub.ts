// Minimal Node-side stand-in for the `electron` module so Dyad's main-process
// handlers run in plain Node and talk to a browser over WebSocket.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const userData = process.env.DYAD_WEB_USERDATA ?? path.join(os.homedir(), ".dyad-web");
fs.mkdirSync(userData, { recursive: true });

export const channelHandlers = new Map<string, (e: any, ...a: any[]) => any>();
export const channelListeners = new Map<string, Array<(e: any, ...a: any[]) => void>>();
export const senders = new Set<any>();

export const ipcMain = {
  handle: (c: string, h: any) => void channelHandlers.set(c, h),
  removeHandler: (c: string) => void channelHandlers.delete(c),
  on: (c: string, l: any) => void channelListeners.set(c, [...(channelListeners.get(c) ?? []), l]),
  once: (c: string, l: any) => ipcMain.on(c, l),
  removeListener: () => {},
  removeAllListeners: () => {},
};

const noop = () => {};
export const app: any = {
  isPackaged: false,
  getPath: (n: string) =>
    n === "home" ? os.homedir() : n === "temp" ? os.tmpdir() : path.join(userData, n === "userData" ? "" : n),
  getAppPath: () => process.cwd(),
  getVersion: () => "web-spike",
  getName: () => "dyad",
  getLocale: () => "en-US",
  getSystemLocale: () => "en-US",
  whenReady: () => Promise.resolve(),
  isReady: () => true,
  on: noop, once: noop, off: noop, quit: noop, exit: noop, relaunch: noop, focus: noop,
  requestSingleInstanceLock: () => true,
  setAsDefaultProtocolClient: () => true,
  setLoginItemSettings: noop,
  commandLine: { appendSwitch: noop, hasSwitch: () => false },
  dock: { setBadge: noop, bounce: noop },
};

export const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from("web:" + s),
  decryptString: (b: Buffer) => b.toString().replace(/^web:/, ""),
  getSelectedStorageBackend: () => "web-spike-plaintext",
};

const wrap = (sender: any) => ({
  webContents: sender,
  isDestroyed: () => false,
  isFocused: () => true,
  isMinimized: () => false,
  isMaximized: () => false,
  isVisible: () => true,
  focus: noop, show: noop, hide: noop, close: noop, minimize: noop, maximize: noop,
  setTitle: noop, setFullScreen: noop, isFullScreen: () => false,
  on: noop, once: noop, off: noop,
  getBounds: () => ({ x: 0, y: 0, width: 1400, height: 900 }),
  contentView: { children: [], addChildView: noop, removeChildView: noop },
});
export const BrowserWindow: any = {
  getAllWindows: () => [...senders].map(wrap),
  getFocusedWindow: () => (senders.size ? wrap([...senders][0]) : null),
  fromWebContents: (wc: any) => (wc ? wrap(wc) : null),
  fromId: () => null,
};

export const dialog = {
  showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  showSaveDialog: async () => ({ canceled: true }),
  showMessageBox: async () => ({ response: 0 }),
  showErrorBox: noop,
};
export const shell = {
  openExternal: async (u: string) => console.log("[shell.openExternal]", u),
  openPath: async (p: string) => { console.log("[shell.openPath]", p); return ""; },
  showItemInFolder: noop,
  trashItem: async (p: string) => fs.promises.rm(p, { recursive: true, force: true }),
};
export const net = { fetch: (...a: Parameters<typeof fetch>) => fetch(...a), isOnline: () => true };
export const session: any = {
  defaultSession: { cookies: { get: async () => [], set: async () => {}, remove: async () => {} }, clearStorageData: async () => {}, setPermissionRequestHandler: noop, webRequest: { onBeforeSendHeaders: noop, onHeadersReceived: noop } },
  fromPartition: () => session.defaultSession,
};
export const Menu: any = { setApplicationMenu: noop, buildFromTemplate: () => ({ popup: noop }) };
export const protocol: any = { registerSchemesAsPrivileged: noop, handle: noop, registerFileProtocol: noop };
export const nativeImage: any = { createFromPath: () => ({ isEmpty: () => true }), createFromBuffer: () => ({ isEmpty: () => true }) };
export const nativeTheme: any = { themeSource: "system", shouldUseDarkColors: false, on: noop };
export const autoUpdater: any = { on: noop, setFeedURL: noop, checkForUpdates: noop };
export const crashReporter: any = { start: noop };
export const clipboard: any = { writeText: noop, readText: () => "" };
export const screen: any = { getPrimaryDisplay: () => ({ workAreaSize: { width: 1400, height: 900 } }) };
export const powerMonitor: any = { on: noop };
export const globalShortcut: any = { register: noop, unregisterAll: noop };
export const utilityProcess: any = { fork: () => { throw new Error("utilityProcess unavailable in web host"); } };
export const WebContentsView: any = class { constructor() { throw new Error("WebContentsView unavailable in web host"); } };
export const webContents: any = { getAllWebContents: () => [...senders], fromId: () => null };
export default { app, ipcMain, safeStorage, BrowserWindow, dialog, shell, net, session, Menu, protocol, nativeImage, nativeTheme };
