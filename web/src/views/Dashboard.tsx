import { useState } from 'react';
import { api } from '../api/client';
import { Alert, AreaChart, Badge, Card, Dot, Empty, Kpi, Loading, StatRow } from '../components/ui';
import { usePoll } from '../lib/hooks';
import { formatCompact, formatMs, formatNumber, formatRelative, percent } from '../lib/format';
import { enumLabel, useI18n } from '../i18n';
import type { ViewProps } from './shared';

/**
 * Operational overview.
 *
 * The headline number that matters here is the pair of ledgers:
 *  - LOGICAL usage: tokens clients actually received.
 *  - UPSTREAM ATTEMPT usage: tokens every provider attempt generated, including
 *    retries and abandoned attempts. This is what reconciles with invoices.
 * They are shown side by side on purpose; a gap between them is not a bug, it
 * is the cost of retries and fallbacks made visible.
 */

const RANGES = ['1h', '24h', '7d', '30d'] as const;

export function DashboardView({ refreshMs, navigate }: ViewProps): JSX.Element {
  const { t, lang } = useI18n();
  const [range, setRange] = useState<string>('24h');

  const overview = usePoll(() => api.overview({ range }), refreshMs, [range]);
  const series = usePoll(() => api.timeseries({ range }), refreshMs, [range]);
  const models = usePoll(() => api.listModels(), refreshMs * 3);
  const providers = usePoll(() => api.listProviders(), refreshMs * 3);
  const keys = usePoll(() => api.listApiKeys(), refreshMs * 3);

  if (overview.loading && !overview.data) return <Loading />;
  if (overview.error && !overview.data) {
    return (
      <Alert tone="error" title={t('dashboard.attention')}>
        {overview.error.message}
      </Alert>
    );
  }

  const data = overview.data;
  if (!data) return <Loading />;

  const logical = data.logicalUsage;
  const attempt = data.attemptUsage;
  const counters = data.counters;

  const attemptDelta =
    logical.totalTokens !== null && attempt.totalTokens !== null ? attempt.totalTokens - logical.totalTokens : null;

  const chartPoints = (series.data?.series ?? []).map((row) => ({
    label: bucketLabel(row.bucket),
    value: row.totalTokens ?? 0,
  }));

  const unhealthyKeys = (keys.data ?? []).filter(
    (key) => key.health !== null && (key.health.status === 'auth_failed' || key.health.status === 'quota_exhausted'),
  );
  const cooledKeys = (keys.data ?? []).filter(
    (key) => key.health !== null && (key.health.status === 'cooldown' || key.health.status === 'rate_limited'),
  );
  const openCircuits = data.circuits.filter((circuit) => circuit.state !== 'closed');

  const rangeKey = `range.${range}` as 'range.1h';

  return (
    <>
      <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
        {RANGES.map((option) => (
          <button
            key={option}
            className={option === range ? 'primary sm' : 'sm'}
            onClick={() => setRange(option)}
            type="button"
          >
            {t(`range.${option}` as 'range.1h')}
          </button>
        ))}
        <span className="field-hint" style={{ marginLeft: 8 }}>
          {t('common.granularity', { value: t(rangeKey) })}
        </span>
      </div>

      {(openCircuits.length > 0 || unhealthyKeys.length > 0) && (
        <Alert tone="warn" title={t('dashboard.attention')}>
          {openCircuits.length > 0 && <div>{t('dashboard.circuitOpen', { count: openCircuits.length })}</div>}
          {unhealthyKeys.length > 0 && (
            <div>
              {t('dashboard.keysNeedAttention', { count: unhealthyKeys.length })}{' '}
              <a
                href="#/keys"
                onClick={(event) => {
                  event.preventDefault();
                  navigate('keys');
                }}
              >
                {t('dashboard.reviewKeys')}
              </a>
            </div>
          )}
        </Alert>
      )}

      <div className="grid cols-4">
        <Kpi
          label={t('dashboard.kpi.requests')}
          value={formatNumber(counters.total, lang)}
          foot={t('dashboard.kpi.requestsFoot', {
            success: formatNumber(counters.success, lang),
            failed: formatNumber(counters.failed, lang),
          })}
        />
        <Kpi
          label={t('dashboard.kpi.tokensDelivered')}
          value={formatCompact(logical.totalTokens)}
          foot={
            logical.requests > 0
              ? t('dashboard.kpi.acrossRequests', { count: formatNumber(logical.requests, lang) })
              : t('dashboard.kpi.noTraffic')
          }
        />
        <Kpi
          label={t('dashboard.kpi.upstreamBilled')}
          value={formatCompact(attempt.totalTokens)}
          foot={
            attemptDelta === null ? (
              t('dashboard.kpi.attemptLedger')
            ) : attemptDelta > 0 ? (
              <span style={{ color: 'var(--warn)' }}>
                {t('dashboard.kpi.overClientUsage', {
                  tokens: formatCompact(attemptDelta),
                  failed: attempt.failedAttempts,
                })}
              </span>
            ) : (
              t('dashboard.kpi.matchesClient')
            )
          }
        />
        <Kpi
          label={t('dashboard.kpi.activeNow')}
          value={formatNumber(data.runtime.active, lang)}
          foot={t('dashboard.kpi.activeFoot', {
            streaming: formatNumber(data.runtime.streaming, lang),
            queued: formatNumber(data.runtime.queued, lang),
          })}
        />
      </div>

      <div className="grid cols-4">
        <Kpi
          label={t('dashboard.kpi.successRate')}
          value={percent(counters.success, counters.total)}
          foot={t('dashboard.kpi.rateAndErrors', {
            limited: counters.rateLimited,
            errors: counters.serverErrors,
          })}
        />
        <Kpi
          label={t('dashboard.kpi.fallbacks')}
          value={formatNumber(counters.fallbackCount, lang)}
          foot={t('dashboard.kpi.fallbacksFoot')}
        />
        <Kpi
          label={t('dashboard.kpi.toolTurns')}
          value={formatNumber(counters.withToolCalls, lang)}
          foot={
            counters.total > 0
              ? t('dashboard.kpi.toolTurnsFoot', { percent: percent(counters.withToolCalls, counters.total) })
              : t('dashboard.kpi.noRequestsYet')
          }
        />
        <Kpi
          label={t('dashboard.kpi.models')}
          value={formatNumber(data.registry.models, lang)}
          foot={t('dashboard.kpi.modelsFoot', {
            providers: formatNumber(data.registry.providers, lang),
            keys: formatNumber(data.registry.apiKeys, lang),
          })}
        />
      </div>

      <div className="grid cols-4">
        <Kpi
          label={t('dashboard.kpi.registryVersion')}
          value={`v${data.registry.version}`}
          foot={t('dashboard.kpi.snapshotBuilt', { when: formatRelative(data.registry.builtAt, lang) })}
        />
      </div>

      <Card
        title={t('dashboard.tokensOverTime')}
        subtitle={t('dashboard.tokensOverTimeSub')}
        actions={overview.refreshing ? <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>{t('common.refreshing')}</span> : null}
      >
        <AreaChart points={chartPoints} formatValue={(value) => formatCompact(value)} />
        <div className="legend" style={{ marginTop: 10 }}>
          <span>
            <span className="legend-swatch" style={{ background: 'var(--accent)' }} />
            {t('chart.totalTokens')}
          </span>
          <span>
            {t('common.table', { value: data.window.table })} · {t('common.window', { value: range })}
          </span>
        </div>
      </Card>

      <div className="split-2">
        <Card title={t('dashboard.activeRequests')} subtitle={t('dashboard.activeRequestsSub')} flush>
          {data.activeRequests.length === 0 ? (
            <Empty title={t('dashboard.noRequestsInFlight')}>{t('dashboard.gatewayIdle')}</Empty>
          ) : (
            <div className="table-wrap" style={{ maxHeight: 320 }}>
              <table>
                <thead>
                  <tr>
                    <th>{t('common.model')}</th>
                    <th>{t('common.protocol')}</th>
                    <th>{t('dashboard.providerKey')}</th>
                    <th>{t('dashboard.phase')}</th>
                    <th className="num">{t('dashboard.ttft')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.activeRequests.map((request) => (
                    <tr key={request.requestId}>
                      <td className="mono">{request.requestedModel}</td>
                      <td>
                        <Badge tone="muted">{enumLabel(t, 'protocol', request.clientProtocol)}</Badge>
                        {request.stream ? <Badge tone="accent">{t('common.stream')}</Badge> : null}
                      </td>
                      <td>
                        {request.providerName ?? '—'}
                        {request.apiKeyName ? <span style={{ color: 'var(--text-faint)' }}> / {request.apiKeyName}</span> : null}
                      </td>
                      <td>
                        <span className={`phase ${request.phase}`}>
                          <Dot tone="ok" pulse /> {enumLabel(t, 'phase', request.phase)}
                        </span>
                      </td>
                      <td className="num">{request.ttftMs === null ? '—' : formatMs(request.ttftMs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card title={t('dashboard.recentActivity')} subtitle={t('dashboard.recentActivitySub')} flush>
          {data.recentRequests.length === 0 ? (
            <Empty title={t('dashboard.noRecent')}>{t('dashboard.noRecentHint')}</Empty>
          ) : (
            <div className="table-wrap" style={{ maxHeight: 320 }}>
              <table>
                <thead>
                  <tr>
                    <th>{t('common.model')}</th>
                    <th>{t('dashboard.outcome')}</th>
                    <th className="num">{t('common.latency')}</th>
                    <th className="num">{t('dashboard.ended')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recentRequests.slice(0, 12).map((request) => (
                    <tr key={request.requestId}>
                      <td className="mono" title={request.requestId}>
                        {request.resolvedModel ?? request.requestedModel}
                      </td>
                      <td>
                        {request.phase === 'completed' ? (
                          <Badge tone="ok">{enumLabel(t, 'phase', 'completed')}</Badge>
                        ) : request.phase === 'cancelled' ? (
                          <Badge tone="muted">{enumLabel(t, 'phase', 'cancelled')}</Badge>
                        ) : (
                          <Badge tone="error" title={request.errorType ?? undefined}>
                            {request.errorType ?? enumLabel(t, 'phase', 'failed')}
                          </Badge>
                        )}
                        {request.fallbackCount > 0 ? (
                          <Badge tone="warn">{t('dashboard.fallbackBadge', { count: request.fallbackCount })}</Badge>
                        ) : null}
                      </td>
                      <td className="num">{request.ttftMs === null ? '—' : formatMs(request.ttftMs)}</td>
                      <td className="num">{formatRelative(request.completedAt, lang)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <div className="split-2">
        <Card title={t('dashboard.accounting')} subtitle={t('dashboard.accountingNote')}>
          <dl className="stat-list">
            <StatRow label={t('dashboard.clientInput')}>{formatNumber(logical.inputTokens, lang)}</StatRow>
            <StatRow label={t('dashboard.clientOutput')}>{formatNumber(logical.outputTokens, lang)}</StatRow>
            <StatRow label={t('dashboard.cachedInput')}>
              {formatNumber(logical.cachedInputTokens, lang)}
              {logical.cacheReadInputTokens !== null
                ? ` (${t('dashboard.cacheRead', { value: formatNumber(logical.cacheReadInputTokens, lang) })})`
                : ''}
            </StatRow>
            <StatRow label={t('dashboard.reasoningTokens')}>{formatNumber(logical.reasoningTokens, lang)}</StatRow>
            <StatRow label={t('dashboard.upstreamInput')}>{formatNumber(attempt.inputTokens, lang)}</StatRow>
            <StatRow label={t('dashboard.upstreamOutput')}>{formatNumber(attempt.outputTokens, lang)}</StatRow>
            <StatRow label={t('dashboard.upstreamAttempts')}>
              {formatNumber(attempt.attempts, lang)}
              {attempt.failedAttempts > 0 ? (
                <span style={{ color: 'var(--warn)' }}> {t('dashboard.failedSuffix', { count: attempt.failedAttempts })}</span>
              ) : null}
            </StatRow>
            <StatRow label={t('dashboard.retryOverhead')}>
              {attemptDelta === null
                ? '—'
                : attemptDelta === 0
                  ? t('dashboard.overheadNone')
                  : t('dashboard.overheadTokens', { tokens: formatNumber(attemptDelta, lang) })}
            </StatRow>
          </dl>
        </Card>

        <Card title={t('dashboard.capacity')} subtitle={t('dashboard.capacitySub')}>
          <dl className="stat-list">
            <StatRow label={t('dashboard.keyPoolActive')}>
              {formatNumber(data.keyPool.active, lang)} / {formatNumber(data.keyPool.queued, lang)}
            </StatRow>
            <StatRow label={t('dashboard.limiterActive')}>
              {formatNumber(data.limiters.active, lang)} / {formatNumber(data.limiters.queued, lang)}
            </StatRow>
            <StatRow label={t('dashboard.providersConfigured')}>
              {formatNumber(data.registry.providers, lang)}
              {providers.data
                ? ` ${t('dashboard.enabledCount', { count: providers.data.filter((provider) => provider.enabled).length })}`
                : ''}
            </StatRow>
            <StatRow label={t('dashboard.modelsAvailable')}>
              {formatNumber(data.registry.models, lang)}
              {models.data
                ? ` ${t('dashboard.disabledCount', { count: models.data.filter((model) => !model.enabled).length })}`
                : ''}
            </StatRow>
            <StatRow label={t('dashboard.apiKeys')}>
              {formatNumber(data.registry.apiKeys, lang)}
              {cooledKeys.length > 0 ? (
                <span style={{ color: 'var(--warn)' }}> {t('dashboard.coolingCount', { count: cooledKeys.length })}</span>
              ) : null}
            </StatRow>
            <StatRow label={t('dashboard.openCircuits')}>
              {openCircuits.length === 0 ? t('common.none') : String(openCircuits.length)}
            </StatRow>
          </dl>
        </Card>
      </div>
    </>
  );
}

/** `2026-09-10T14:00:00.000Z` → `14:00`, `2026-09-10` → `09-10`. */
function bucketLabel(bucket: string): string {
  if (bucket.length <= 10) return bucket.slice(5);
  const date = new Date(bucket);
  if (!Number.isFinite(date.getTime())) return bucket;
  const hasHour = bucket.includes('T');
  return hasHour
    ? `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:00`
    : `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
