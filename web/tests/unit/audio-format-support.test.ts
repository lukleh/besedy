import { afterEach, describe, expect, it, vi } from "vitest";

type Reply = { type: string; formatKey?: unknown } | null;

function stubController(reply: Reply) {
  const postMessage = vi.fn((_message: unknown, ports: MessagePort[]) => {
    if (reply) ports[0].postMessage(reply);
  });
  const controller = { postMessage } as unknown as ServiceWorker;
  vi.stubGlobal("navigator", Object.assign(Object.create(navigator), {
    serviceWorker: { controller },
  }));
  return postMessage;
}

async function load() {
  vi.resetModules();
  return import("@/lib/service-worker/audio-format-support");
}

describe("serviceWorkerKeysAudioByFormat", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("is safe without a controlling worker", async () => {
    vi.stubGlobal("navigator", Object.assign(Object.create(navigator), {
      serviceWorker: { controller: null },
    }));
    const { serviceWorkerKeysAudioByFormat } = await load();
    await expect(serviceWorkerKeysAudioByFormat()).resolves.toBe(true);
  });

  it("trusts a worker that says it keys by format, and asks it once", async () => {
    const postMessage = stubController({ type: "AUDIO_FORMAT_SUPPORT", formatKey: true });
    const { serviceWorkerKeysAudioByFormat } = await load();

    await expect(serviceWorkerKeysAudioByFormat()).resolves.toBe(true);
    await expect(serviceWorkerKeysAudioByFormat()).resolves.toBe(true);
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0][0]).toEqual({ type: "GET_AUDIO_FORMAT_SUPPORT" });
  });

  it("rejects any other answer", async () => {
    stubController({ type: "WEB_VERSION", formatKey: true });
    const { serviceWorkerKeysAudioByFormat } = await load();
    await expect(serviceWorkerKeysAudioByFormat()).resolves.toBe(false);
  });

  it("treats a worker that never answers as one from before #291", async () => {
    vi.useFakeTimers();
    stubController(null);
    const { serviceWorkerKeysAudioByFormat, AUDIO_FORMAT_SUPPORT_TIMEOUT_MS } = await load();

    const answer = serviceWorkerKeysAudioByFormat();
    await vi.advanceTimersByTimeAsync(AUDIO_FORMAT_SUPPORT_TIMEOUT_MS);
    await expect(answer).resolves.toBe(false);
  });

  it("asks the same worker again after a timeout, and keeps a real answer", async () => {
    vi.useFakeTimers();
    let reply: Reply = null;
    const postMessage = vi.fn((_message: unknown, ports: MessagePort[]) => {
      if (reply) ports[0].postMessage(reply);
    });
    vi.stubGlobal("navigator", Object.assign(Object.create(navigator), {
      serviceWorker: { controller: { postMessage } },
    }));
    const { serviceWorkerKeysAudioByFormat, AUDIO_FORMAT_SUPPORT_TIMEOUT_MS } = await load();

    const slow = serviceWorkerKeysAudioByFormat();
    await vi.advanceTimersByTimeAsync(AUDIO_FORMAT_SUPPORT_TIMEOUT_MS);
    await expect(slow).resolves.toBe(false);
    vi.useRealTimers();

    // The worker has started by now and answers.
    reply = { type: "AUDIO_FORMAT_SUPPORT", formatKey: true };
    await expect(serviceWorkerKeysAudioByFormat()).resolves.toBe(true);
    await expect(serviceWorkerKeysAudioByFormat()).resolves.toBe(true);
    expect(postMessage).toHaveBeenCalledTimes(2);
  });

  it("asks an updated worker again", async () => {
    stubController(null);
    vi.useFakeTimers();
    const { serviceWorkerKeysAudioByFormat, AUDIO_FORMAT_SUPPORT_TIMEOUT_MS } = await load();
    const first = serviceWorkerKeysAudioByFormat();
    await vi.advanceTimersByTimeAsync(AUDIO_FORMAT_SUPPORT_TIMEOUT_MS);
    await expect(first).resolves.toBe(false);
    vi.useRealTimers();

    stubController({ type: "AUDIO_FORMAT_SUPPORT", formatKey: true });
    await expect(serviceWorkerKeysAudioByFormat()).resolves.toBe(true);
  });
});
