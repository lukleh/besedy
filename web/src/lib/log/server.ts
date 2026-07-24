type ServerLogLevel = "debug" | "info" | "warn" | "error";

interface ServerLogger {
  debug: (message: string, payload?: unknown) => void;
  info: (message: string, payload?: unknown) => void;
  warn: (message: string, payload?: unknown) => void;
  error: (message: string, payload?: unknown) => void;
  event: (level: ServerLogLevel, payload: Record<string, unknown>) => void;
}

function getConsoleMethod(level: ServerLogLevel) {
  switch (level) {
    case "debug":
      return console.debug.bind(console);
    case "info":
      return console.info.bind(console);
    case "warn":
      return console.warn.bind(console);
    case "error":
      return console.error.bind(console);
  }
}

function formatMessage(scope: string | undefined, message: string): string {
  return scope ? `[${scope}] ${message}` : message;
}

export function createServerLogger(scope?: string): ServerLogger {
  const write = (level: ServerLogLevel, message: string, payload?: unknown) => {
    const log = getConsoleMethod(level);
    const formattedMessage = formatMessage(scope, message);

    if (payload === undefined) {
      log(formattedMessage);
      return;
    }

    log(formattedMessage, payload);
  };

  const event = (level: ServerLogLevel, payload: Record<string, unknown>) => {
    const log = getConsoleMethod(level);
    log(JSON.stringify(payload));
  };

  return {
    debug: (message, payload) => write("debug", message, payload),
    info: (message, payload) => write("info", message, payload),
    warn: (message, payload) => write("warn", message, payload),
    error: (message, payload) => write("error", message, payload),
    event,
  };
}
