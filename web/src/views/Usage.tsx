import { useMemo, useState } from 'react';
import { api } from '../api/client';
import type { UsageTotals } from '../api/types';
import { Alert, AreaChart, Badge, BarList, Card, Empty, Kpi, Loading, Tabs } from '../components/ui';
import { usePoll } from '../lib/hooks';
import { formatCompact, formatNumber, percent } from '../lib/format';
import { enumLabel, useI18n, type TranslationKey } from '../i18n';
import type { ViewProps } from './shared';

/**
 * Usage and accounting.
 *
 * Two ledgers are presented side by side and never merged:
 *   LOGICAL  — tokens the client received (`requests` + usage rollups).
 *   ATTEMPT  — tokens every upstream attempt generated (`request_attempts`),
 *              including retries and attempts that never reached the client.
 * A gap between them is the visible cost of retry and fallback behaviour, and
 * the attempt ledger is the one that reconciles with provider invoices.
 */

const RANGES = ['1h', '24h', '7d', '30d', 'all'] as const;

type TabId = 'overview' | 'models' | 'providers' | 'keys' | 'matrix' | 'errors';

const TABS: Array<{ id: TabId; label: TranslationKey }> = [
  { id: 'overview', label: 'usage.tabOverview' },
  { id: 'models', label: 'usage.tabModels' },
  { id: 'providers', label: 'usage.tabProviders' },
  { id: 'keys', label: 'usage.tabKeys' },
  { id: 'matrix', label: 'usage.tabMatrix' },
  { id: 'errors', label: 'usage.tabErrors' },
];

export function UsageView({ refreshMs, tab: initialTab }: ViewProps & { tab?: string | null }): JSX.Element {
  const { t, lang } = useI18n();
  const [range, setRange] = useState('7d');
  const [tab, setTab] = useState<TabId>(isTab(initialTab) ? initialTab : 'overview');

  const overview = usePoll(() => api.overview({ range }), refreshMs, [range]);
  const series = usePoll(() => api.timeseries({ range }), refreshMs, [range]);
  const byModel = usePoll(() => api.grouped({ range, groupBy: 'model' }), refreshMs, [range]);
  const byProvider = usePoll(() => api.grouped({ range, groupBy: 'provider' }), refreshMs, [range]);
  const byKey = usePoll(() => api.grouped({ range, groupBy: 'apiKey' }), refreshMs, [range]);
  const byProtocol = usePoll(() => api.grouped({ range, groupBy: 'protocol' }), refreshMs, [range]);
  const matrix = usePoll(() => api.keyModelMatrix({ range }), refreshMs, [range]);
  const errors = usePoll(() => api.errorBreakdown({ range }), refreshMs, [range]);
  const models = usePoll(() => api.listModels(), refreshMs * 3);
  const providers = usePoll(() => api.listProviders(), refreshMs * 3);
  const keys = usePoll(() => api.listApiKeys(), refreshMs * 3);

  const modelNameById = useMemo(
    () => new Map((models.data ?? []).map((model) => [model.id, model.clientModelId])),
    [models.data],
  );
  const providerNameById = useMemo(
    () => new Map((providers.data ?? []).map((provider) => [provider.id, provider.name])),
    [providers.data],
  );
  const keyNameById = useMemo(() => new Map((keys.data ?? []).map((key) => [key.id, key.name])), [keys.data]);

  if (overview.loading && !overview.data) return <Loading />;

  const data = overview.data;
  if (!data) {
    return (
      <Alert tone="error" title={t('sys.cannotLoad')}>
        {overview.error?.message ?? '—'}
      </Alert>
    );
  }

  const logical = data.logicalUsage;
  const attempt = data.attemptUsage;
  const overhead =
    logical.totalTokens !== null && attempt.totalTokens !== null ? attempt.totalTokens - logical.totalTokens : null;

  const chartPoints = (series.data?.series ?? []).map((row) => ({
    label: bucketLabel(row.bucket),
    value: row.totalTokens ?? 0,
  }));

  return (
    <>
      <div className="btn-row" style={{ justifyContent: 'space-between' }}>
        <Tabs tabs={TABS.map((entry) => ({ id: entry.id, label: t(entry.label) }))} active={tab} onChange={setTab} />
        <div className="btn-row">
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
        </div>
      </div>

      <div className="grid cols-4">
        <Kpi
          label={t('usage.kpiClientTokens')}
          value={formatCompact(logical.totalTokens)}
          foot={t('usage.kpiInOut', {
            in: formatNumber(logical.inputTokens, lang),
            out: formatNumber(logical.outputTokens, lang),
          })}
        />
        <Kpi
          label={t('usage.kpiUpstreamTokens')}
          value={formatCompact(attempt.totalTokens)}
          foot={t('usage.kpiInOut', {
            in: formatNumber(attempt.inputTokens, lang),
            out: formatNumber(attempt.outputTokens, lang),
          })}
        />
        <Kpi
          label={t('usage.kpiOverhead')}
          value={overhead === null ? '—' : formatCompact(overhead)}
          foot={
            attempt.failedAttempts > 0
              ? t('usage.kpiOverheadFoot', { failed: attempt.failedAttempts, total: attempt.attempts })
              : t('usage.kpiNoFailed')
          }
        />
        <Kpi
          label={t('usage.kpiRequests')}
          value={formatNumber(logical.requests, lang)}
          foot={t('usage.kpiRequestsFoot', {
            percent: percent(logical.successfulRequests, logical.requests),
            failed: formatNumber(logical.failedRequests, lang),
          })}
        />
      </div>

      {tab === 'overview' && (
        <>
          <Card title={t('usage.tokensOverTime')} subtitle={t('usage.tokensOverTimeSub')}>
            <AreaChart points={chartPoints} formatValue={(value) => formatCompact(value)} />
            <div className="legend" style={{ marginTop: 10 }}>
              <span>
                <span className="legend-swatch" style={{ background: 'var(--accent)' }} />
                {t('chart.totalTokens')}
              </span>
              <span>
                {t('common.granularity', { value: series.data?.granularity ?? '—' })} ·{' '}
                {t('common.table', { value: data.window.table })}
              </span>
            </div>
          </Card>

          <div className="split-2">
            <Card title={t('usage.logicalTitle')} subtitle={t('usage.logicalSub')}>
              <UsageTable
                totals={logical}
                labels={[
                  ['requests', t('usage.requestsHeader')],
                  ['inputTokens', t('usage.inputTokens')],
                  ['cachedInputTokens', t('usage.cachedInputTokens')],
                  ['cacheReadInputTokens', t('usage.cacheReadTokens')],
                  ['outputTokens', t('usage.outputTokens')],
                  ['reasoningTokens', t('usage.reasoningTokens')],
                  ['totalTokens', t('usage.totalTokens')],
                ]}
                successSuffix={(value) => t('usage.successSuffix', { percent: percent(logical.successfulRequests, value) })}
                locale={lang}
              />
            </Card>
            <Card title={t('usage.attemptTitle')} subtitle={t('usage.attemptSub')}>
              <UsageTable
                totals={{
                  requests: attempt.attempts,
                  successfulRequests: attempt.attempts - attempt.failedAttempts,
                  failedRequests: attempt.failedAttempts,
                  inputTokens: attempt.inputTokens,
                  cachedInputTokens: null,
                  uncachedInputTokens: null,
                  cacheCreationInputTokens: null,
                  cacheReadInputTokens: null,
                  outputTokens: attempt.outputTokens,
                  reasoningTokens: null,
                  totalTokens: attempt.totalTokens,
                }}
                labels={[
                  ['requests', t('usage.attemptsLabel')],
                  ['inputTokens', t('usage.inputTokensBilled')],
                  ['outputTokens', t('usage.outputTokensBilled')],
                  ['totalTokens', t('usage.totalTokensBilled')],
                ]}
                successSuffix={(value) =>
                  t('usage.successSuffix', {
                    percent: percent(attempt.attempts - attempt.failedAttempts, value),
                  })
                }
                locale={lang}
              />
            </Card>
          </div>

          <Card title={t('usage.byProtocol')} subtitle={t('usage.byProtocolSub')} flush>
            <table>
              <thead>
                <tr>
                  <th>{t('common.protocol')}</th>
                  <th>{t('common.endpoint')}</th>
                  <th className="num">{t('usage.colRequests')}</th>
                  <th className="num">{t('usage.colSuccess')}</th>
                  <th className="num">{t('usage.colInput')}</th>
                  <th className="num">{t('usage.colOutput')}</th>
                  <th className="num">{t('usage.colTotal')}</th>
                </tr>
              </thead>
              <tbody>
                {(byProtocol.data?.rows ?? []).map((row) => (
                  <tr key={row.key}>
                    <td>
                      <Badge tone="accent">{enumLabel(t, 'protocol', row.key)}</Badge>
                    </td>
                    <td className="mono">{endpointLabel(row.key)}</td>
                    <td className="num">{formatNumber(row.requests, lang)}</td>
                    <td className="num">{percent(row.successfulRequests, row.requests)}</td>
                    <td className="num">{formatNumber(row.inputTokens, lang)}</td>
                    <td className="num">{formatNumber(row.outputTokens, lang)}</td>
                    <td className="num">{formatNumber(row.totalTokens, lang)}</td>
                  </tr>
                ))}
                {(byProtocol.data?.rows ?? []).length === 0 && (
                  <tr>
                    <td colSpan={7}>
                      <div className="loading-row">{t('usage.noTraffic')}</div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </Card>
        </>
      )}

      {tab === 'models' && (
        <Card title={t('usage.byModel')} subtitle={t('usage.byModelSub')} flush>
          {(byModel.data?.rows ?? []).length === 0 ? (
            <Empty title={t('usage.noModelUsage')} />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t('common.model')}</th>
                    <th className="num">{t('usage.colRequests')}</th>
                    <th className="num">{t('usage.colSuccess')}</th>
                    <th className="num">{t('usage.colInput')}</th>
                    <th className="num">{t('usage.colCached')}</th>
                    <th className="num">{t('usage.colOutput')}</th>
                    <th className="num">{t('usage.colReasoning')}</th>
                    <th className="num">{t('usage.colTotal')}</th>
                  </tr>
                </thead>
                <tbody>
                  {(byModel.data?.rows ?? []).map((row) => (
                    <tr key={row.key}>
                      <td className="mono">{modelNameById.get(row.key) ?? row.key}</td>
                      <td className="num">{formatNumber(row.requests, lang)}</td>
                      <td className="num">{percent(row.successfulRequests, row.requests)}</td>
                      <td className="num">{formatNumber(row.inputTokens, lang)}</td>
                      <td className="num">{formatNumber(row.cachedInputTokens, lang)}</td>
                      <td className="num">{formatNumber(row.outputTokens, lang)}</td>
                      <td className="num">{formatNumber(row.reasoningTokens, lang)}</td>
                      <td className="num" style={{ fontWeight: 600 }}>
                        {formatNumber(row.totalTokens, lang)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="card-body">
            <BarList
              rows={(byModel.data?.rows ?? []).map((row) => ({
                key: row.key,
                label: modelNameById.get(row.key) ?? row.key,
                value: row.totalTokens ?? 0,
                secondary: `${formatNumber(row.requests, lang)} ${t('common.req')}`,
              }))}
              formatValue={(value) => formatCompact(value)}
            />
          </div>
        </Card>
      )}

      {tab === 'providers' && (
        <Card title={t('usage.byProvider')} subtitle={t('usage.byProviderSub')} flush>
          {(byProvider.data?.rows ?? []).length === 0 ? (
            <Empty title={t('usage.noProviderUsage')} />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t('common.provider')}</th>
                    <th className="num">{t('usage.colRequests')}</th>
                    <th className="num">{t('usage.colFailed')}</th>
                    <th className="num">{t('usage.colInput')}</th>
                    <th className="num">{t('usage.colOutput')}</th>
                    <th className="num">{t('usage.colTotal')}</th>
                  </tr>
                </thead>
                <tbody>
                  {(byProvider.data?.rows ?? []).map((row) => (
                    <tr key={row.key}>
                      <td>{providerNameById.get(row.key) ?? row.key}</td>
                      <td className="num">{formatNumber(row.requests, lang)}</td>
                      <td className="num">
                        <span style={{ color: row.failedRequests > 0 ? 'var(--error)' : 'inherit' }}>
                          {formatNumber(row.failedRequests, lang)}
                        </span>
                      </td>
                      <td className="num">{formatNumber(row.inputTokens, lang)}</td>
                      <td className="num">{formatNumber(row.outputTokens, lang)}</td>
                      <td className="num" style={{ fontWeight: 600 }}>
                        {formatNumber(row.totalTokens, lang)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {tab === 'keys' && (
        <Card title={t('usage.byKey')} subtitle={t('usage.byKeySub')} flush>
          {(byKey.data?.rows ?? []).length === 0 ? (
            <Empty title={t('usage.noKeyUsage')} />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t('usage.colApiKey')}</th>
                    <th className="num">{t('usage.colRequests')}</th>
                    <th className="num">{t('usage.colSuccess')}</th>
                    <th className="num">{t('usage.colInput')}</th>
                    <th className="num">{t('usage.colOutput')}</th>
                    <th className="num">{t('usage.colTotal')}</th>
                  </tr>
                </thead>
                <tbody>
                  {(byKey.data?.rows ?? []).map((row) => (
                    <tr key={row.key}>
                      <td>
                        {row.key === '' ? (
                          <em style={{ color: 'var(--text-faint)' }}>{t('usage.noKeySelected')}</em>
                        ) : (
                          (keyNameById.get(row.key) ?? row.key)
                        )}
                      </td>
                      <td className="num">{formatNumber(row.requests, lang)}</td>
                      <td className="num">{percent(row.successfulRequests, row.requests)}</td>
                      <td className="num">{formatNumber(row.inputTokens, lang)}</td>
                      <td className="num">{formatNumber(row.outputTokens, lang)}</td>
                      <td className="num" style={{ fontWeight: 600 }}>
                        {formatNumber(row.totalTokens, lang)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {tab === 'matrix' && (
        <Card title={t('usage.matrixTitle')} subtitle={t('usage.matrixSub')} flush>
          {(matrix.data ?? []).length === 0 ? (
            <Empty title={t('usage.matrixEmpty')}>{t('usage.matrixEmptyHint')}</Empty>
          ) : (
            <MatrixTable
              rows={matrix.data ?? []}
              keyNameById={keyNameById}
              modelNameById={modelNameById}
              totalLabel={t('common.total')}
              apiKeyLabel={t('usage.colApiKey')}
              requestsLabel={t('common.req')}
              locale={lang}
            />
          )}
        </Card>
      )}

      {tab === 'errors' && (
        <Card title={t('usage.errorsTitle')} subtitle={t('usage.errorsSub')} flush>
          {(errors.data ?? []).length === 0 ? (
            <Empty title={t('usage.noErrors')}>{t('usage.noErrorsHint')}</Empty>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>{t('usage.colErrorType')}</th>
                  <th className="num">{t('common.total')}</th>
                  <th className="num">{t('usage.colShare')}</th>
                </tr>
              </thead>
              <tbody>
                {(errors.data ?? []).map((row) => {
                  const total = (errors.data ?? []).reduce((sum, entry) => sum + entry.count, 0);
                  return (
                    <tr key={row.label}>
                      <td className="mono">{row.label}</td>
                      <td className="num">{formatNumber(row.count, lang)}</td>
                      <td className="num">{percent(row.count, total)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Card>
      )}
    </>
  );
}

function MatrixTable({
  rows,
  keyNameById,
  modelNameById,
  totalLabel,
  apiKeyLabel,
  requestsLabel,
  locale,
}: {
  rows: Array<{ apiKeyId: string; modelId: string; totalTokens: number | null; requests: number; successfulRequests: number }>;
  keyNameById: Map<string, string>;
  modelNameById: Map<string, string>;
  totalLabel: string;
  apiKeyLabel: string;
  requestsLabel: string;
  locale: 'en' | 'zh';
}): JSX.Element {
  const keyIds = [...new Set(rows.map((row) => row.apiKeyId))];
  const modelIds = [...new Set(rows.map((row) => row.modelId))];
  const lookup = new Map(rows.map((row) => [`${row.apiKeyId}\u0000${row.modelId}`, row]));

  const columnTotals = new Map<string, number>();
  const rowTotals = new Map<string, number>();
  for (const row of rows) {
    columnTotals.set(row.modelId, (columnTotals.get(row.modelId) ?? 0) + (row.totalTokens ?? 0));
    rowTotals.set(row.apiKeyId, (rowTotals.get(row.apiKeyId) ?? 0) + (row.totalTokens ?? 0));
  }

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>{apiKeyLabel}</th>
            {modelIds.map((modelId) => (
              <th key={modelId} className="num">
                {modelNameById.get(modelId) ?? modelId}
              </th>
            ))}
            <th className="num">{totalLabel}</th>
          </tr>
        </thead>
        <tbody>
          {keyIds.map((keyId) => (
            <tr key={keyId}>
              <td style={{ fontWeight: 600 }}>
                {keyId === '' ? '—' : (keyNameById.get(keyId) ?? keyId)}
              </td>
              {modelIds.map((modelId) => {
                const cell = lookup.get(`${keyId}\u0000${modelId}`);
                if (!cell) {
                  return (
                    <td key={modelId} className="num" style={{ color: 'var(--text-faint)' }}>
                      —
                    </td>
                  );
                }
                return (
                  <td
                    key={modelId}
                    className="num"
                    title={`${formatNumber(cell.requests, locale)} ${requestsLabel} / ${formatNumber(cell.successfulRequests, locale)}`}
                  >
                    {formatNumber(cell.totalTokens, locale)}
                    <div className="field-hint" style={{ fontSize: 10.5 }}>
                      {formatNumber(cell.requests, locale)} {requestsLabel}
                    </div>
                  </td>
                );
              })}
              <td className="num" style={{ fontWeight: 600 }}>
                {formatNumber(rowTotals.get(keyId) ?? 0, locale)}
              </td>
            </tr>
          ))}
          <tr>
            <td style={{ fontWeight: 600, color: 'var(--text-muted)' }}>{totalLabel}</td>
            {modelIds.map((modelId) => (
              <td key={modelId} className="num" style={{ fontWeight: 600, color: 'var(--text-muted)' }}>
                {formatNumber(columnTotals.get(modelId) ?? 0, locale)}
              </td>
            ))}
            <td className="num" style={{ fontWeight: 700 }}>
              {formatNumber(
                rows.reduce((sum, row) => sum + (row.totalTokens ?? 0), 0),
                locale,
              )}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/**
 * Presentational usage table. Labels arrive already translated so this stays a
 * pure function with no dictionary access of its own.
 */
function UsageTable({
  totals,
  labels,
  successSuffix,
  locale,
}: {
  totals: UsageTotals;
  labels: Array<[string, string]>;
  successSuffix: (requests: number) => string;
  locale: 'en' | 'zh';
}): JSX.Element {
  const record = totals as unknown as Record<string, number | null>;
  return (
    <dl className="stat-list">
      {labels.map(([key, label]) => {
        const value = record[key];
        if (key !== 'requests' && (value === null || value === undefined)) return null;
        return (
          <div className="stat-row" key={key}>
            <dt>{label}</dt>
            <dd>
              {formatNumber(value ?? null, locale)}
              {key === 'requests' ? (
                <span style={{ color: 'var(--text-faint)', marginLeft: 8 }}>
                  {successSuffix(totals.requests)}
                </span>
              ) : null}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

function isTab(value: string | null | undefined): value is TabId {
  return (
    value === 'overview' ||
    value === 'models' ||
    value === 'providers' ||
    value === 'keys' ||
    value === 'matrix' ||
    value === 'errors'
  );
}

function endpointLabel(protocol: string): string {
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

function bucketLabel(bucket: string): string {
  const date = new Date(bucket);
  if (!Number.isFinite(date.getTime())) return bucket;
  if (bucket.includes('T')) {
    return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:00`;
  }
  return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
