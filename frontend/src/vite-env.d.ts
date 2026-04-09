/// <reference types="vite/client" />

import type { CaptureBridge, WindowControls } from './ipc/contracts'

export interface IpcRenderer {
    on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): this;
    off(channel: string, ...omit: unknown[]): this;
    send(channel: string, ...omit: unknown[]): void;
    invoke(channel: string, ...omit: unknown[]): Promise<unknown>;
}

declare global {
    interface Window {
        ipcRenderer: IpcRenderer;
        windowControls: WindowControls;
        captureBridge?: CaptureBridge;
    }
}
