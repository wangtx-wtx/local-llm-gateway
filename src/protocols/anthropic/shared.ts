/** Small shared helpers for the Anthropic adapter. */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function textContent(text: string): { type: 'text'; text: string } {
  return { type: 'text', text };
}

export function numberOrUndefined(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return undefined;
}
