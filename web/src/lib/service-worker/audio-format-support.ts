"use client";

import { SW_MESSAGE_TYPES } from "@/lib/service-worker/messages";

/** How long to wait for the controlling worker to answer. */
export const AUDIO_FORMAT_SUPPORT_TIMEOUT_MS = 1000;

const answers = new WeakMap<ServiceWorker, Promise<boolean>>();

/**
 * Whether a `format=aac` audio request is safe to send through the service
 * worker that controls this page.
 *
 * A worker from before #291 drops `format` from its offline cache key, so it
 * would answer an AAC request with a downloaded WebM, the file iOS Safari
 * cannot stream. Workers that key by format say so when asked. With no
 * controlling worker nothing intercepts the request, so it is safe; a worker
 * that does not answer in time is treated as an old one for this request
 * only. An answer is kept per worker, so an updated worker is asked again,
 * and a timeout (an iOS worker slow to start) is asked again next time.
 */
export function serviceWorkerKeysAudioByFormat(): Promise<boolean> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return Promise.resolve(true);
  }
  const controller = navigator.serviceWorker.controller;
  if (!controller) return Promise.resolve(true);

  let answer = answers.get(controller);
  if (!answer) {
    // Shared while in flight, so concurrent callers ask once.
    const asked = askWorker(controller);
    answer = asked.then(({ keysByFormat }) => keysByFormat);
    answers.set(controller, answer);
    void asked.then(({ answered }) => {
      if (!answered && answers.get(controller) === answer) answers.delete(controller);
    });
  }
  return answer;
}

function askWorker(
  worker: ServiceWorker
): Promise<{ keysByFormat: boolean; answered: boolean }> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    let settled = false;
    const finish = (keysByFormat: boolean, answered: boolean) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeoutId);
      channel.port1.close();
      resolve({ keysByFormat, answered });
    };
    const timeoutId = window.setTimeout(
      () => finish(false, false),
      AUDIO_FORMAT_SUPPORT_TIMEOUT_MS
    );
    channel.port1.onmessage = (event: MessageEvent<unknown>) => {
      const payload = event.data as { type?: unknown; formatKey?: unknown } | null;
      finish(
        payload?.type === SW_MESSAGE_TYPES.AUDIO_FORMAT_SUPPORT && payload.formatKey === true,
        true
      );
    };
    try {
      worker.postMessage({ type: SW_MESSAGE_TYPES.GET_AUDIO_FORMAT_SUPPORT }, [channel.port2]);
    } catch {
      finish(false, false);
    }
  });
}
