/** Minimal logging seam: uses the host logger when present, console otherwise. */
export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

type HostLogger = Partial<Record<keyof Logger, (message: string) => void>>;

export function loggerFrom(ctx: { logger?: HostLogger }): Logger {
  const host = ctx.logger;
  const wrap = (level: keyof Logger) => (message: string): void => {
    const fn = host?.[level];
    if (typeof fn === 'function') {
      try {
        fn.call(host, `engram-bridge: ${message}`);
        return;
      } catch {
        /* fall through to console */
      }
    }
    // eslint-disable-next-line no-console
    console[level === 'debug' ? 'log' : level](`engram-bridge: ${message}`);
  };
  return { debug: wrap('debug'), info: wrap('info'), warn: wrap('warn'), error: wrap('error') };
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
