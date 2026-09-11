import { useState } from 'react';
import { api } from '../api/client';
import { Alert, Badge, Card, Dot, Empty, Kpi, Loading, StatRow, Tabs } from '../components/ui';
import { usePoll } from '../lib/hooks';
import { formatBytes, formatDuration, formatNumber, formatRelative } from '../lib/format';
import { enumLabel, useI18n } from '../i18n';
import type { ViewProps } from './shared';
/**
 * Runtime introspection: process, database, registry, circuits and queue state.
 * Everything here comes from `/api/admin/system` and `/api/admin/limiters`,
 * which read live process state rather than the durable tables.
 */

type TabId = 'runtime' | 'capacity' | 'config' | 'playground';

export function SystemView({ refreshMs, pushToast }: ViewProps): JSX.Element {
  const { t, lang } = useI18n();
  const system = usePoll(() => api.system(), refreshMs);
  const limiters = usePoll(() => api.limiters(), refreshMs);
  const providerHealth = usePoll(() => api.providerHealth(), refreshMs);
  const [tab, setTab] = useState<TabId>('runtime');
  const [playground, setPlayground] = useState('{\n  "model": "my-model",\n  "input": "Hello"\n}');
  const [protocol, setProtocol] = useState<string>('openai-responses');
  const [result, setResult] = useState<{ status: number; latencyMs: number; body: string; contentType: string | null } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runPlayground = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const payload = JSON.parse(playground) as unknown;
      setResult(await api.playground(protocol, payload));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  if (system.loading && !system.data) return <Loading label={t('sys.loading')} />;
  if (!system.data) {
    return (
      <Alert tone="error" title={t('sys.cannotLoad')}>
        {system.error?.message}
      </Alert>
    );
  }

  const info = system.data;

  /**
   * providerId → display name.
   *
   * Needed because key names are not unique: adding a provider auto-creates its
   * first key under a shared default name, so a list of keys is unreadable
   * without the provider beside it.
   */
  const providerNameById = new Map<string, string>(
    (providerHealth.data ?? []).map((entry) => {
      const record = entry as Record<string, unknown>;
      return [String(record['id'] ?? ''), String(record['name'] ?? '')];
    }),
  );

  const backup = async (): Promise<void> => {
    try {
      const response = await api.backup();
      pushToast('ok', t('sys.backupCreated'), response.backupPath);
    } catch (caught) {
      pushToast('error', t('sys.backupFailed'), caught instanceof Error ? caught.message : String(caught));
    }
  };

  const checkpoint = async (): Promise<void> => {
    try {
      await api.checkpoint();
      pushToast('ok', t('sys.checkpointed'), t('sys.checkpointedFoot'));
      system.refresh();
    } catch (caught) {
      pushToast('error', t('sys.checkpointFailed'), caught instanceof Error ? caught.message : String(caught));
    }
  };

  const prune = async (): Promise<void> => {
    const days = Number(window.prompt(t('sys.prunePrompt'), '30') ?? '');
    if (!Number.isFinite(days) || days <= 0) return;
    try {
      const response = await api.prune(days);
      pushToast('ok', t('sys.pruned'), t('sys.prunedFoot', { requests: response.removedRequests, logs: response.removedLogs }));
      system.refresh();
    } catch (caught) {
      pushToast('error', t('sys.pruneFailed'), caught instanceof Error ? caught.message : String(caught));
    }
  };

  const openCircuits = info.circuits.filter((circuit) => circuit.state !== 'closed');

  return (
    <>
      <div className="grid cols-4">
        <Kpi
          label={t('sys.uptime')}
          value={formatDuration(info.uptimeMs, lang)}
          foot={t('sys.since', { when: formatRelative(info.startedAt, lang) })}
        />
        <Kpi
          label={t('sys.activeQueued')}
          value={`${formatNumber(info.runtime.active, lang)} / ${formatNumber(info.runtime.queued, lang)}`}
          foot={t('sys.streamingCount', { count: info.runtime.streaming })}
        />
        <Kpi
          label={t('sys.database')}
          value={formatBytes(info.database.dbBytes)}
          foot={t('sys.walFoot', { wal: formatBytes(info.database.walBytes), mode: info.database.journalMode })}
        />
        <Kpi
          label={t('sys.memory')}
          value={formatBytes(info.memory.rssBytes)}
          foot={t('sys.heapFoot', {
            used: formatBytes(info.memory.heapUsedBytes),
            total: formatBytes(info.memory.heapTotalBytes),
          })}
        />
      </div>

      {(openCircuits.length > 0 || !info.bindIsLoopback) && (
        <Alert
          tone={info.bindIsLoopback ? 'warn' : 'error'}
          title={info.bindIsLoopback ? t('sys.circuitsOpen') : t('sys.beyondLoopback')}
        >
          {!info.bindIsLoopback && <div>{t('sys.beyondLoopbackHint', { host: info.host })}</div>}
          {openCircuits.map((circuit) => (
            <div key={circuit.providerId}>
              {t('sys.circuitLine', {
                id: circuit.providerId,
                state: enumLabel(t, 'circuit', circuit.state),
                count: circuit.consecutiveFailures,
              })}
            </div>
          ))}
        </Alert>
      )}

      <Card title={t('nav.system')} flush>
        <Tabs
          tabs={[
            { id: 'runtime' as const, label: t('sys.tabRuntime') },
            { id: 'capacity' as const, label: t('sys.tabCapacity') },
            { id: 'config' as const, label: t('sys.tabConfig') },
            { id: 'playground' as const, label: t('sys.tabPlayground') },
          ]}
          active={tab}
          onChange={setTab}
        />

        {tab === 'runtime' && (
          <div className="card-body">
            <div className="split-2">
              <div>
                <h4 style={{ margin: '0 0 8px', fontSize: 13 }}>{t('sys.process')}</h4>
                <dl className="stat-list">
                  <StatRow label={t('sys.node')}>{info.node}</StatRow>
                  <StatRow label={t('sys.platform')}>{info.platform}</StatRow>
                  <StatRow label={t('sys.started')}>{formatRelative(info.startedAt, lang)}</StatRow>
                  <StatRow label={t('sys.uptime')}>{formatDuration(info.uptimeMs, lang)}</StatRow>
                  <StatRow label={t('sys.logLevel')}>{enumLabel(t, 'level', info.logLevel.toLowerCase())}</StatRow>
                  <StatRow label={t('sys.logPersistence')}>
                    {info.persistLogs ? t('common.enabled') : t('common.disabled')}
                  </StatRow>
                </dl>
              </div>
              <div>
                <h4 style={{ margin: '0 0 8px', fontSize: 13 }}>{t('sys.bindAuth')}</h4>
                <dl className="stat-list">
                  <StatRow label={t('sys.listeningOn')}>
                    <span className="mono">
                      {info.host}:{info.port}
                    </span>
                  </StatRow>
                  <StatRow label={t('sys.loopbackOnly')}>
                    {info.bindIsLoopback ? <Badge tone="ok">{t('common.yes')}</Badge> : <Badge tone="warn">{t('common.no')}</Badge>}
                  </StatRow>
                  <StatRow label={t('sys.gatewayKey')}>
                    {info.gatewayAuthEnabled ? (
                      <Badge tone="ok">{t('sys.required')}</Badge>
                    ) : (
                      <Badge tone="warn">{t('sys.notSet')}</Badge>
                    )}
                  </StatRow>
                  <StatRow label={t('sys.adminPassword')}>
                    {info.adminAuthEnabled ? (
                      <Badge tone="ok">{t('sys.required')}</Badge>
                    ) : (
                      <Badge tone="warn">{t('sys.notSet')}</Badge>
                    )}
                  </StatRow>
                </dl>
              </div>
            </div>

            <h4 style={{ margin: '16px 0 8px', fontSize: 13 }}>{t('sys.defaultLimits')}</h4>
            <dl className="stat-list">
              {Object.entries(info.limits).map(([key, value]) => (
                <StatRow label={<span className="mono">{key}</span>} key={key}>
                  {key.toLowerCase().includes('bytes')
                    ? formatBytes(value)
                    : key.toLowerCase().includes('ms')
                      ? `${formatNumber(value, lang)} ms`
                      : formatNumber(value, lang)}
                </StatRow>
              ))}
            </dl>

            <h4 style={{ margin: '16px 0 8px', fontSize: 13 }}>{t('sys.protocolEndpoints')}</h4>
            <table>
              <thead>
                <tr>
                  <th>{t('common.protocol')}</th>
                  <th>{t('common.endpoint')}</th>
                  <th>{t('sys.contentType')}</th>
                </tr>
              </thead>
              <tbody>
                {info.protocols.map((entry) => (
                  <tr key={entry.id}>
                    <td className="mono">{entry.id}</td>
                    <td className="mono">{entry.endpoint}</td>
                    <td className="mono" style={{ fontSize: 11.5 }}>
                      {entry.contentType}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {tab === 'capacity' && (
          <div className="card-body">
            <div className="grid cols-3" style={{ marginBottom: 16 }}>
              <Kpi
                label={t('sys.keyPoolActive')}
                value={formatNumber(info.keyPool.active, lang)}
                foot={t('sys.queuedFoot', { count: formatNumber(info.keyPool.queued, lang) })}
              />
              <Kpi
                label={t('sys.limiterActive')}
                value={formatNumber(info.limiters.active, lang)}
                foot={t('sys.queuedFoot', { count: formatNumber(info.limiters.queued, lang) })}
              />
              <Kpi
                label={t('sys.openCircuits')}
                value={formatNumber(openCircuits.length, lang)}
                foot={t('sys.trackedFoot', { count: formatNumber(info.circuits.length, lang) })}
              />
            </div>

            <h4 style={{ margin: '0 0 8px', fontSize: 13 }}>{t('sys.semaphores')}</h4>
            {(limiters.data?.entries ?? []).length === 0 ? (
              <div className="field-hint">{t('sys.noSemaphores')}</div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>{t('sys.scope')}</th>
                    <th>{t('providers.id')}</th>
                    <th className="num">{t('sys.limit')}</th>
                    <th className="num">{t('providers.active')}</th>
                    <th className="num">{t('dashboard.phase')}</th>
                    <th className="num">{t('sys.acquired')}</th>
                    <th className="num">{t('sys.rejected')}</th>
                  </tr>
                </thead>
                <tbody>
                  {(limiters.data?.entries ?? []).map((entry, index) => {
                    const record = entry as Record<string, unknown>;
                    const stats = (record['stats'] ?? record) as Record<string, unknown>;
                    const rejected = Number(stats['rejected'] ?? 0);
                    return (
                      <tr key={index}>
                        <td className="mono">{String(record['scope'] ?? '—')}</td>
                        <td className="mono">{String(record['id'] ?? '—')}</td>
                        <td className="num">{formatNumber(Number(stats['limit'] ?? 0), lang)}</td>
                        <td className="num">{formatNumber(Number(stats['active'] ?? 0), lang)}</td>
                        <td className="num">{formatNumber(Number(stats['queued'] ?? 0), lang)}</td>
                        <td className="num">{formatNumber(Number(stats['acquired'] ?? 0), lang)}</td>
                        <td className="num">
                          {rejected > 0 ? (
                            <span style={{ color: 'var(--warn)' }}>{formatNumber(rejected, lang)}</span>
                          ) : (
                            '0'
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}

            <h4 style={{ margin: '16px 0 8px', fontSize: 13 }}>{t('sys.providerHealth')}</h4>
            <table>
              <thead>
                <tr>
                  <th>{t('common.provider')}</th>
                  <th>{t('common.protocol')}</th>
                  <th>{t('providers.circuit')}</th>
                  <th className="num">{t('sys.keysSelectable')}</th>
                  <th className="num">{t('providers.active')}</th>
                  <th className="num">{t('sys.queued')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {(providerHealth.data ?? []).map((entry) => {
                  const record = entry as Record<string, unknown>;
                  const circuit = (record['circuit'] ?? {}) as Record<string, unknown>;
                  const keys = (record['keys'] ?? {}) as Record<string, unknown>;
                  const state = String(circuit['state'] ?? 'closed');
                  return (
                    <tr key={String(record['id'])}>
                      <td style={{ fontWeight: 600 }}>{String(record['name'])}</td>
                      <td className="mono">{String(record['nativeProtocol'])}</td>
                      <td>
                        <Dot tone={state === 'closed' ? 'ok' : state === 'half_open' ? 'warn' : 'error'} />
                        {enumLabel(t, 'circuit', state)}
                      </td>
                      <td className="num">
                        {formatNumber(Number(keys['selectable'] ?? 0), lang)} /{' '}
                        {formatNumber(Number(keys['total'] ?? 0), lang)}
                      </td>
                      <td className="num">{formatNumber(Number(record['activeRequests'] ?? 0), lang)}</td>
                      <td className="num">{formatNumber(Number(record['queuedRequests'] ?? 0), lang)}</td>
                      <td>
                        <button
                          className="sm"
                          type="button"
                          onClick={async () => {
                            await api.resetProviderHealth(String(record['id']));
                            pushToast('ok', t('sys.resetDone'), String(record['name']));
                            providerHealth.refresh();
                          }}
                        >
                          {t('common.reset')}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            <h4 style={{ margin: '16px 0 8px', fontSize: 13 }}>{t('sys.keyHealthLive')}</h4>
            {(limiters.data?.keyPool ?? []).length === 0 ? (
              <Empty title={t('sys.noKeyState')} />
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>{t('common.provider')}</th>
                    <th>{t('keys.name')}</th>
                    <th>{t('common.status')}</th>
                    <th>{t('sys.selectable')}</th>
                    <th>{t('providers.circuit')}</th>
                    <th className="num">{t('providers.active')}</th>
                    <th className="num">{t('keys.selections')}</th>
                    <th className="num">{t('keys.okFail')}</th>
                  </tr>
                </thead>
                <tbody>
                  {(limiters.data?.keyPool ?? []).map((entry, index) => {
                    const record = entry as Record<string, unknown>;
                    const breaker = (record['breaker'] ?? {}) as Record<string, unknown>;
                    const status = String(record['status']);
                    const providerId = String(record['providerId'] ?? '');
                    // A key name alone is not an identifier: several providers
                    // auto-create a first key with the same default name. Show the
                    // provider and the mask so rows stay distinguishable.
                    const providerName = providerNameById.get(providerId) ?? providerId;
                    return (
                      <tr key={index}>
                        <td>{providerName}</td>
                        <td>
                          <div>{String(record['name'])}</div>
                          <div className="mono field-hint" style={{ fontSize: 11 }}>
                            {String(record['mask'] ?? '')}
                          </div>
                        </td>
                        <td>
                          <Badge tone={status === 'healthy' ? 'ok' : status === 'rate_limited' ? 'warn' : 'error'}>
                            {enumLabel(t, 'status', status)}
                          </Badge>
                        </td>
                        <td>
                          {record['selectable'] ? (
                            <Badge tone="ok">{t('common.yes')}</Badge>
                          ) : (
                            <Badge tone="muted">{t('common.no')}</Badge>
                          )}
                        </td>
                        <td>{enumLabel(t, 'circuit', String(breaker['state'] ?? 'closed'))}</td>
                        <td className="num">{formatNumber(Number(record['active'] ?? 0), lang)}</td>
                        <td className="num">{formatNumber(Number(record['selections'] ?? 0), lang)}</td>
                        <td className="num">
                          <span style={{ color: 'var(--ok)' }}>{formatNumber(Number(record['successCount'] ?? 0), lang)}</span>
                          {' / '}
                          <span
                            style={{
                              color: Number(record['failureCount'] ?? 0) > 0 ? 'var(--error)' : 'inherit',
                            }}
                          >
                            {formatNumber(Number(record['failureCount'] ?? 0), lang)}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        )}

        {tab === 'config' && (
          <div className="card-body">
            <div className="split-2">
              <div>
                <h4 style={{ margin: '0 0 8px', fontSize: 13 }}>{t('sys.database')}</h4>
                <dl className="stat-list">
                  <StatRow label={t('providers.baseUrl')}>
                    <span className="mono" style={{ fontSize: 11.5 }}>
                      {info.database.path}
                    </span>
                  </StatRow>
                  <StatRow label={t('sys.journalMode')}>{info.database.journalMode}</StatRow>
                  <StatRow label={t('sys.size')}>{formatBytes(info.database.dbBytes)}</StatRow>
                  <StatRow label={t('sys.walSize')}>{formatBytes(info.database.walBytes)}</StatRow>
                  <StatRow label={t('sys.tables')}>{formatNumber(info.database.tables, lang)}</StatRow>
                  <StatRow label={t('sys.pageSize')}>{formatBytes(info.database.pageSize)}</StatRow>
                </dl>
                <div className="btn-row" style={{ marginTop: 12 }}>
                  <button className="sm" onClick={() => void checkpoint()} type="button">
                    {t('sys.checkpointWal')}
                  </button>
                  <button className="sm" onClick={() => void backup()} type="button">
                    {t('sys.createBackup')}
                  </button>
                  <button className="sm danger" onClick={() => void prune()} type="button">
                    {t('sys.pruneHistory')}
                  </button>
                </div>
              </div>
              <div>
                <h4 style={{ margin: '0 0 8px', fontSize: 13 }}>{t('sys.registrySnapshot')}</h4>
                <dl className="stat-list">
                  <StatRow label={t('sys.version')}>v{info.registry.version}</StatRow>
                  <StatRow label={t('sys.built')}>{formatRelative(info.registry.builtAt, lang)}</StatRow>
                  <StatRow label={t('sys.providers')}>{formatNumber(info.registry.providers, lang)}</StatRow>
                  <StatRow label={t('sys.models')}>{formatNumber(info.registry.models, lang)}</StatRow>
                  <StatRow label={t('sys.aliases')}>{formatNumber(info.registry.aliases, lang)}</StatRow>
                  <StatRow label={t('sys.apiKeys')}>{formatNumber(info.registry.apiKeys, lang)}</StatRow>
                </dl>
                <Alert tone="info" title={t('sys.atomicSwap')}>
                  {t('sys.atomicSwapHint')}
                </Alert>
              </div>
            </div>

            <h4 style={{ margin: '16px 0 8px', fontSize: 13 }}>{t('sys.exportImport')}</h4>
            <div className="btn-row">
              <button
                className="sm"
                type="button"
                onClick={async () => {
                  const config = await api.exportConfig(false);
                  downloadJson(config, 'gateway-config.json');
                  pushToast('ok', t('sys.exportedOk'), t('sys.exportedCiphertext'));
                }}
              >
                {t('sys.exportConfig')}
              </button>
              <button
                className="sm"
                type="button"
                onClick={async () => {
                  const config = await api.exportConfig(true);
                  downloadJson(config, 'gateway-config-with-secrets.json');
                  pushToast('warn', t('sys.exportedSecretsWarn'), t('sys.storeSecurely'));
                }}
              >
                {t('sys.exportSecrets')}
              </button>
              <label className="btn-row" style={{ gap: 6 }}>
                <span className="field-hint">{t('sys.import')}</span>
                <input
                  type="file"
                  accept="application/json"
                  style={{ width: 'auto' }}
                  onChange={async (event) => {
                    const file = event.target.files?.[0];
                    if (!file) return;
                    try {
                      const text = await file.text();
                      const parsed = JSON.parse(text) as Record<string, unknown>;
                      const response = await api.importConfig(parsed);
                      pushToast('ok', t('sys.importedOk'), JSON.stringify(response.imported));
                      system.refresh();
                    } catch (caught) {
                      pushToast('error', t('sys.importFailed'), caught instanceof Error ? caught.message : String(caught));
                    }
                  }}
                />
              </label>
            </div>
            <div className="field-hint" style={{ marginTop: 8 }}>
              {t('sys.keyPortability')}
            </div>
          </div>
        )}

        {tab === 'playground' && (
          <div className="card-body">
            <div className="field-hint" style={{ marginBottom: 10 }}>
              {t('sys.playgroundHint')}
            </div>
            <div className="form-grid">
              <label className="field">
                <span>{t('common.protocol')}</span>
                <select value={protocol} onChange={(event) => setProtocol(event.target.value)}>
                  {info.protocols.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.id} → {entry.endpoint}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="field" style={{ marginTop: 12 }}>
              <span>{t('sys.requestBody')}</span>
              <textarea value={playground} onChange={(event) => setPlayground(event.target.value)} rows={10} />
            </label>
            <div className="btn-row" style={{ marginTop: 10 }}>
              <button className="primary sm" onClick={() => void runPlayground()} type="button" disabled={busy}>
                {busy ? t('sys.sending') : t('sys.sendRequest')}
              </button>
              <span className="field-hint">{t('sys.playgroundHint2')}</span>
            </div>
            {error && (
              <Alert tone="error" title={t('providers.requestFailed')}>
                {error}
              </Alert>
            )}
            {result && (
              <>
                <div className="btn-row" style={{ marginTop: 12 }}>
                  <Badge tone={result.status < 400 ? 'ok' : 'error'}>HTTP {result.status}</Badge>
                  <Badge tone="muted">{formatNumber(result.latencyMs, lang)} ms</Badge>
                  <Badge tone="muted">{result.contentType ?? '—'}</Badge>
                </div>
                <pre className="code" style={{ marginTop: 8 }}>
                  {result.body}
                </pre>
              </>
            )}
          </div>
        )}
      </Card>
    </>
  );
}

function downloadJson(value: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
