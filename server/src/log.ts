type Level = 'debug' | 'info' | 'warn' | 'error';

const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = order[(process.env.LOG_LEVEL as Level) ?? 'info'] ?? 20;

function emit(level: Level, scope: string, data: unknown) {
  if (order[level] < threshold) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}]`;
  const stream = level === 'error' || level === 'warn' ? console.error : console.log;
  if (data instanceof Error) {
    stream(line, data.stack ?? data.message);
  } else if (typeof data === 'object' && data !== null) {
    stream(line, JSON.stringify(data));
  } else {
    stream(line, String(data));
  }
}

export const log = {
  debug: (scope: string, data?: unknown) => emit('debug', scope, data),
  info: (scope: string, data?: unknown) => emit('info', scope, data),
  warn: (scope: string, data?: unknown) => emit('warn', scope, data),
  error: (scope: string, data?: unknown) => emit('error', scope, data),
};
