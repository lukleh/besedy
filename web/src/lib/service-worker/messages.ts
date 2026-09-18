/**
 * Service worker message protocol.
 *
 * Only the update handshake remains: the worker no longer downloads content,
 * so there is no cache protocol. Downloads are driven from the page by
 * `src/lib/offline/download-manager.ts`.
 */

export const SW_MESSAGE_TYPES = {
  // Client → SW: ask the (possibly waiting) worker which web version it carries.
  GET_WEB_VERSION: "GET_WEB_VERSION",
  // SW → Client: reply on the provided MessagePort.
  WEB_VERSION: "WEB_VERSION",
  // Client → SW: activate the waiting worker.
  SKIP_WAITING: "SKIP_WAITING",
} as const;

export interface GetWebVersionMessage {
  type: typeof SW_MESSAGE_TYPES.GET_WEB_VERSION;
}

export interface SkipWaitingMessage {
  type: typeof SW_MESSAGE_TYPES.SKIP_WAITING;
}

export interface WebVersionMessage {
  type: typeof SW_MESSAGE_TYPES.WEB_VERSION;
  version: string | null;
}

export type ClientToSWMessage = GetWebVersionMessage | SkipWaitingMessage;

export type SWToClientMessage = WebVersionMessage;

export type SWMessage = ClientToSWMessage | SWToClientMessage;
