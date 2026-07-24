"use client";

type ClientLogLevel = "debug" | "info" | "warn" | "error";

interface ClientLogger {
  debug: (message: string, payload?: unknown) => void;
  info: (message: string, payload?: unknown) => void;
  warn: (message: string, payload?: unknown) => void;
  error: (message: string, payload?: unknown) => void;
}

function getConsoleMethod(level: ClientLogLevel) {
  switch (level) {
    case "debug":
      return console.debug.bind(console);
    case "info":
      return console.log.bind(console);
    case "warn":
      return console.warn.bind(console);
    case "error":
      return console.error.bind(console);
  }
}

function formatMessage(scope: string | undefined, message: string): string {
  return scope ? `[${scope}] ${message}` : message;
}

export function createClientLogger(scope?: string): ClientLogger {
  const write = (level: ClientLogLevel, message: string, payload?: unknown) => {
    const log = getConsoleMethod(level);
    const formattedMessage = formatMessage(scope, message);

    if (payload === undefined) {
      log(formattedMessage);
      return;
    }

    log(formattedMessage, payload);
  };

  return {
    debug: (message, payload) => write("debug", message, payload),
    info: (message, payload) => write("info", message, payload),
    warn: (message, payload) => write("warn", message, payload),
    error: (message, payload) => write("error", message, payload),
  };
}
