/**
 * Formatting helpers shared across views.
 *
 * Token counts are nullable on purpose: `null` means the provider never
 * reported the number, which must render as "—" rather than "0". Turning
 * "unknown" into "0" in the UI would hide exactly the accounting problem the
 * gateway is built to expose.
 *
 * `locale` is passed in rather than read from the environment so every formatted
 * value follows the language the operator selected in the header.
 */

export type Locale = 'en' | 'zh';

function localeTag(locale: Locale | undefined): string {
  return locale === 'zh' ? 'zh-CN' : 'en-US';
}

export function formatNumber(value: number | null | undefined, locale?: Locale): string {
  if (value === null || value === undefined) return '—';
  return value.toLocaleString(localeTag(locale));
}

/**
 * Compact token counts.
 *
 * Both languages use the same SI-ish suffixes here: on a dense dashboard the
 * suffix is a unit, not prose, and mixing 万/亿 with K/M would make columns
 * inconsistent when switching language.
 */
export function formatCompact(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  if (Math.abs(value) < 1_000) return String(value);
  if (Math.abs(value) < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}K`;
  return `${(value / 1_000_000).toFixed(2)}M`;
}

export function formatMs(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  if (value < 1_000) return `${Math.round(value)} ms`;
  return `${(value / 1_000).toFixed(2)} s`;
}

export function formatBytes(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function formatDateTime(value: string | number | null | undefined, locale?: Locale): string {
  if (value === null || value === undefined) return '—';
  const date = typeof value === 'number' ? new Date(value) : new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  return date.toLocaleString(localeTag(locale), {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/**
 * Relative time ("3m ago" / "3 分钟前").
 *
 * Unit suffixes are localised because at this granularity they read as words,
 * unlike the compact token suffixes above.
 */
export function formatRelative(value: string | number | null | undefined, locale?: Locale): string {
  if (value === null || value === undefined) return '—';
  const date = typeof value === 'number' ? new Date(value) : new Date(value);
  const delta = Date.now() - date.getTime();
  if (!Number.isFinite(delta)) return '—';
  if (delta < 0) return locale === 'zh' ? '刚刚' : 'just now';

  const seconds = Math.floor(delta / 1_000);
  const suffix = (count: number, unit: string): string =>
    locale === 'zh' ? `${count}${unit}前` : `${count}${unit} ago`;

  if (seconds < 60) return suffix(seconds, 's');
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return suffix(minutes, 'm');
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return suffix(hours, 'h');
  const days = Math.floor(hours / 24);
  if (days < 30) return suffix(days, 'd');
  return formatDateTime(value, locale);
}

export function formatDuration(ms: number, locale?: Locale): string {
  const seconds = Math.floor(ms / 1_000);
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const parts: string[] = [];
  if (days > 0) parts.push(locale === 'zh' ? `${days}天` : `${days}d`);
  if (hours > 0) parts.push(locale === 'zh' ? `${hours}小时` : `${hours}h`);
  if (minutes > 0) parts.push(locale === 'zh' ? `${minutes}分` : `${minutes}m`);
  if (parts.length === 0) parts.push(locale === 'zh' ? `${seconds}秒` : `${seconds}s`);
  return parts.join(locale === 'zh' ? '' : ' ');
}

export function truncate(value: string, max = 60): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

export function prettyJson(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function percent(part: number, total: number): string {
  if (total <= 0) return '—';
  return `${((part / total) * 100).toFixed(1)}%`;
}

/**
 * Protocol display labels.
 *
 * These mirror the `enum.protocol.*` dictionary keys so views can translate them
 * through `t()`; the raw protocol id is always kept for `enumLabel` lookup.
 */
export function protocolLabel(protocol: string | null | undefined): string {
  switch (protocol) {
    case 'openai-chat':
      return 'Chat Completions';
    case 'openai-responses':
      return 'Responses';
    case 'anthropic-messages':
      return 'Anthropic Messages';
    default:
      return protocol ?? '—';
  }
}

export function protocolEndpoint(protocol: string | null | undefined): string {
  switch (protocol) {
    case 'openai-chat':
      return '/v1/chat/completions';
    case 'openai-responses':
      return '/v1/responses';
    case 'anthropic-messages':
      return '/v1/messages';
    default:
      return '—';
  }
}

/** Colour token for a result/status; centralised so the theme stays consistent. */
export function statusTone(value: {
  success?: boolean;
  statusCode?: number | null;
  errorType?: string | null;
}): 'ok' | 'warn' | 'error' | 'muted' {
  if (value.statusCode === 499 || value.errorType === 'client_disconnected_error') return 'muted';
  if (value.success === true) return 'ok';
  const status = value.statusCode ?? 0;
  if (status === 429 || status === 408) return 'warn';
  if (status >= 500) return 'error';
  if (value.success === false) return 'error';
  return 'muted';
}

export function keyStatusTone(status: string): 'ok' | 'warn' | 'error' | 'muted' {
  switch (status) {
    case 'healthy':
      return 'ok';
    case 'rate_limited':
    case 'cooldown':
    case 'circuit_open':
      return 'warn';
    case 'auth_failed':
    case 'quota_exhausted':
      return 'error';
    default:
      return 'muted';
  }
}

export function modeTone(mode: string): 'ok' | 'warn' | 'muted' {
  switch (mode) {
    case 'native':
      return 'ok';
    case 'emulated':
      return 'warn';
    default:
      return 'muted';
  }
}
