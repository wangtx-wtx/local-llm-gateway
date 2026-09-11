import { StrictMode, useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { api, ApiError, getAdminPassword, onUnauthorized, setAdminPassword } from './api/client';
import { Alert, Badge, Field, Spinner } from './components/ui';
import { useLocalStorage } from './lib/hooks';
import { formatDuration } from './lib/format';
import { I18nProvider, LANGUAGES, useI18n, type Language, type TranslationKey } from './i18n';

import { DashboardView } from './views/Dashboard';
import { ProvidersView } from './views/Providers';
import { ModelsView } from './views/Models';
import { ApiKeysView } from './views/ApiKeys';
import { UsageView } from './views/Usage';
import { RequestsView } from './views/Requests';
import { LogsView } from './views/Logs';
import { SystemView } from './views/System';
import { SettingsView } from './views/Settings';

/**
 * Dashboard shell.
 *
 * Routing is deliberately minimal (hash-based) so the SPA works when served
 * from `/admin/` by the gateway itself without any server-side rewrite rules
 * beyond the index.html fallback.
 */

type ViewId =
  | 'dashboard'
  | 'providers'
  | 'models'
  | 'keys'
  | 'usage'
  | 'requests'
  | 'logs'
  | 'system'
  | 'settings';

const NAV: Array<{ section: TranslationKey; items: Array<{ id: ViewId; label: TranslationKey }> }> = [
  { section: 'nav.section.overview', items: [{ id: 'dashboard', label: 'nav.dashboard' }] },
  {
    section: 'nav.section.controlPlane',
    items: [
      { id: 'providers', label: 'nav.providers' },
      { id: 'models', label: 'nav.models' },
      { id: 'keys', label: 'nav.keys' },
    ],
  },
  {
    section: 'nav.section.observability',
    items: [
      { id: 'usage', label: 'nav.usage' },
      { id: 'requests', label: 'nav.requests' },
      { id: 'logs', label: 'nav.logs' },
    ],
  },
  {
    section: 'nav.section.system',
    items: [
      { id: 'system', label: 'nav.system' },
      { id: 'settings', label: 'nav.settings' },
    ],
  },
];

const TITLE_KEYS: Record<ViewId, TranslationKey> = {
  dashboard: 'title.dashboard',
  providers: 'title.providers',
  models: 'title.models',
  keys: 'title.keys',
  usage: 'title.usage',
  requests: 'title.requests',
  logs: 'title.logs',
  system: 'title.system',
  settings: 'title.settings',
};

const VIEW_IDS = new Set<string>(NAV.flatMap((group) => group.items.map((item) => item.id)));

function readHash(): { view: ViewId; param: string | null } {
  const raw = window.location.hash.replace(/^#\/?/, '');
  const [view, param] = raw.split('/');
  if (view && VIEW_IDS.has(view)) return { view: view as ViewId, param: param ?? null };
  return { view: 'dashboard', param: null };
}

interface Toast {
  id: number;
  tone: 'ok' | 'error' | 'warn' | 'info';
  title: string;
  message?: string;
}

function App(): JSX.Element {
  const { t, lang, setLang } = useI18n();
  const [route, setRoute] = useState(readHash);
  const [needsAuth, setNeedsAuth] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [bootstrapping, setBootstrapping] = useState(true);
  const [systemVersion, setSystemVersion] = useState<number | null>(null);
  const [uptime, setUptime] = useState<number | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [refreshMs, setRefreshMs] = useLocalStorage<number>('llmgw.refreshMs', 10_000);

  const pushToast = useCallback((tone: Toast['tone'], title: string, message?: string) => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current, { id, tone, title, ...(message !== undefined ? { message } : {}) }]);
    window.setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 6_000);
  }, []);

  // A 401/403 from any request means the password was wrong or has been removed.
  useEffect(() => {
    onUnauthorized(() => {
      setNeedsAuth(true);
      setAuthError(t('auth.rejected'));
    });
  }, [t]);

  useEffect(() => {
    const onHashChange = (): void => setRoute(readHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  // Determine whether the admin API is reachable at all (a password may not be
  // configured, in which case loopback access just works).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const meta = await api.meta();
        if (!cancelled) {
          setNeedsAuth(false);
          setSystemVersion(meta.registry.version);
        }
      } catch (error) {
        if (cancelled) return;
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
          // A password exists (or remote access is blocked): prompt for it.
          setNeedsAuth(true);
          setAuthError(error.status === 403 ? error.message : null);
        } else {
          setAuthError(error instanceof Error ? error.message : String(error));
          setNeedsAuth(true);
        }
      } finally {
        if (!cancelled) setBootstrapping(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Lightweight presence poll for the header (uptime + registry version).
  useEffect(() => {
    if (needsAuth) return;
    let cancelled = false;
    const tick = async (): Promise<void> => {
      if (document.hidden) return;
      try {
        const info = await api.system();
        if (!cancelled) {
          setSystemVersion(info.version);
          setUptime(info.uptimeMs);
        }
      } catch {
        /* the header is decorative; failures are surfaced by the views */
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), Math.max(5_000, refreshMs));
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [needsAuth, refreshMs]);

  const navigate = useCallback((view: string, param?: string) => {
    const target = VIEW_IDS.has(view) ? view : 'dashboard';
    window.location.hash = param ? `#/${target}/${param}` : `#/${target}`;
    setRoute({ view: target as ViewId, param: param ?? null });
  }, []);

  const content = useMemo(() => {
    const shared = { refreshMs, navigate, pushToast };
    switch (route.view) {
      case 'providers':
        return <ProvidersView {...shared} detailId={route.param} />;
      case 'models':
        return <ModelsView {...shared} detailId={route.param} />;
      case 'keys':
        return <ApiKeysView {...shared} detailId={route.param} />;
      case 'usage':
        return <UsageView {...shared} tab={route.param} />;
      case 'requests':
        return <RequestsView {...shared} detailId={route.param} />;
      case 'logs':
        return <LogsView {...shared} />;
      case 'system':
        return <SystemView {...shared} />;
      case 'settings':
        return <SettingsView {...shared} />;
      case 'dashboard':
      default:
        return <DashboardView {...shared} />;
    }
  }, [route, refreshMs, navigate, pushToast]);

  if (bootstrapping) {
    return (
      <div className="gate">
        <div style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
          <Spinner /> {t('app.connecting')}
        </div>
      </div>
    );
  }

  if (needsAuth) {
    return (
      <AuthGate
        error={authError}
        onAuthenticated={() => {
          setNeedsAuth(false);
          setAuthError(null);
          window.location.reload();
        }}
      />
    );
  }

  const activeView = route.view;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">G</span>
          <span>
            {t('app.name')}
            <span className="brand-sub">
              {systemVersion !== null ? t('app.registryVersion', { version: systemVersion }) : t('app.gateway')}
              {uptime !== null ? ` · ${t('app.uptime', { duration: formatDuration(uptime, lang) })}` : ''}
            </span>
          </span>
        </div>

        {NAV.map((group) => (
          <div key={group.section}>
            <div className="nav-section">{t(group.section)}</div>
            {group.items.map((item) => (
              <button
                key={item.id}
                className={`nav-item${item.id === activeView ? ' active' : ''}`}
                onClick={() => navigate(item.id)}
                type="button"
              >
                {t(item.label)}
              </button>
            ))}
          </div>
        ))}

        <div style={{ marginTop: 'auto', padding: '14px 10px 4px', fontSize: 11.5, color: 'var(--text-faint)' }}>
          <div>{t('app.endpoints')}</div>
          <div className="mono" style={{ marginTop: 5, lineHeight: 1.7, fontSize: 11 }}>
            /v1/chat/completions
            <br />
            /v1/responses
            <br />
            /v1/messages
            <br />
            /v1/models
          </div>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <h1>{t(TITLE_KEYS[activeView])}</h1>
          <div className="topbar-meta">
            <label className="checkbox" title={t('app.language')}>
              <select
                value={lang}
                onChange={(event) => setLang(event.target.value as Language)}
                style={{ width: 'auto', padding: '3px 6px', fontSize: 12 }}
                aria-label={t('app.language')}
              >
                {LANGUAGES.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="checkbox" title={t('set.hint.dashboardRefreshMs')}>
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('common.refresh')}</span>
              <select
                value={refreshMs}
                onChange={(event) => setRefreshMs(Number(event.target.value))}
                style={{ width: 'auto', padding: '3px 6px', fontSize: 12 }}
              >
                <option value={0}>{t('refresh.off')}</option>
                <option value={5000}>5s</option>
                <option value={10000}>10s</option>
                <option value={30000}>30s</option>
                <option value={60000}>60s</option>
              </select>
            </label>
            <Badge tone="accent" title={t('sys.registrySnapshot')}>
              v{systemVersion ?? '—'}
            </Badge>
          </div>
        </header>

        <div className="content">{content}</div>
      </main>

      <div
        style={{
          position: 'fixed',
          right: 18,
          bottom: 18,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          zIndex: 200,
          maxWidth: 380,
        }}
      >
        {toasts.map((toast) => (
          <Alert
            key={toast.id}
            tone={toast.tone === 'ok' ? 'ok' : toast.tone === 'error' ? 'error' : toast.tone === 'warn' ? 'warn' : 'info'}
            title={toast.title}
            dismissLabel={t('common.dismiss')}
            onDismiss={() => setToasts((current) => current.filter((entry) => entry.id !== toast.id))}
          >
            {toast.message}
          </Alert>
        ))}
      </div>
    </div>
  );
}

function AuthGate({ error, onAuthenticated }: { error: string | null; onAuthenticated: () => void }): JSX.Element {
  const { t } = useI18n();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(error);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (password.trim() === '') return;
    setBusy(true);
    setFailure(null);
    setAdminPassword(password);
    try {
      await api.meta();
      onAuthenticated();
    } catch (caught) {
      setAdminPassword(null);
      setFailure(caught instanceof Error ? caught.message : t('auth.failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="gate card" onSubmit={(event) => void submit(event)}>
      <div className="card-head">
        <div>
          <h2>{t('auth.title')}</h2>
          <div className="card-head-sub">
            {getAdminPassword() === null ? t('auth.subtitleRequired') : t('auth.subtitleReenter')}
          </div>
        </div>
      </div>
      <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {failure && (
          <Alert tone="error" title={t('auth.denied')}>
            {failure}
          </Alert>
        )}
        <Field label={t('auth.password')} hint={t('auth.passwordHint')}>
          <input
            type="password"
            value={password}
            autoFocus
            autoComplete="current-password"
            onChange={(event) => setPassword(event.target.value)}
            placeholder="••••••••"
          />
        </Field>
        <button className="primary" type="submit" disabled={busy || password.trim() === ''}>
          {busy ? t('auth.checking') : t('auth.unlock')}
        </button>
      </div>
    </form>
  );
}

const container = document.getElementById('root');
if (!container) throw new Error('Dashboard root element is missing from index.html');
createRoot(container).render(
  <StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </StrictMode>,
);
