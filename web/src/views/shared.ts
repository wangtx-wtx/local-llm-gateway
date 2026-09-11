/** Props every view receives from the app shell. */
export interface ViewProps {
  /** Auto-refresh interval from the header control (0 disables polling). */
  refreshMs: number;
  /**
   * Navigate to another view, optionally deep-linking to an entity.
   * The view name is a string because some views are reached by URL fragment
   * rather than from the typed navigation list.
   */
  navigate: (view: string, param?: string) => void;
  /** Show a transient toast. */
  pushToast: (tone: 'ok' | 'error' | 'warn' | 'info', title: string, message?: string) => void;
}

export type { ViewProps as default };
