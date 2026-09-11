import { useState } from 'react';
import { api } from '../api/client';
import type { RequestAttempt } from '../api/types';
import { Alert, Badge, Card, Empty, Field, JsonBlock, Loading, Modal, StatRow, Tabs } from '../components/ui';
import { useDebounced, usePoll } from '../lib/hooks';
import { formatDateTime, formatMs, formatNumber, formatRelative, percent, statusTone } from '../lib/format';
import { enumLabel, useI18n, type TranslationKey } from '../i18n';
import type { ViewProps } from './shared';

/**
 * Request explorer.
 *
 * The detail drawer is built around three questions an operator actually asks:
 *   1. Where did this go?            → routing section (model, provider, key, fallbacks)
 *   2. Why did that take so long?    → timeline + latency breakdown (queue, TTFT, total)
 *   3. What did it cost, and to whom? → the two usage ledgers side by side
 */

const PAGE_SIZE = 25;
const RANGES = ['1h', '24h', '7d', '30d', 'all'] as const;

/** Longer labels for the range dropdown, as opposed to the compact chart labels. */
const RANGE_LABELS: Record<(typeof RANGES)[number], TranslationKey> = {
  '1h': 'range.last1h',
  '24h': 'range.last24h',
  '7d': 'range.last7d',
  '30d': 'range.last30d',
  all: 'range.all',
};

export function RequestsView({ refreshMs, navigate, detailId }: ViewProps & { detailId?: string | null }): JSX.Element {
  const { t, lang } = useI18n();
  const [search, setSearch] = useState('');
  const [success, setSuccess] = useState('');
  const [stream, setStream] = useState('');
  const [errorType, setErrorType] = useState('');
  const [range, setRange] = useState('24h');
  const [sort, setSort] = useState('started_at');
  const [order, setOrder] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(0);
  const debouncedSearch = useDebounced(search, 300);

  const requests = usePoll(
    () =>
      api.listRequests({
        range,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
        ...(debouncedSearch ? { search: debouncedSearch } : {}),
        ...(success !== '' ? { success: success === 'true' } : {}),
        ...(stream !== '' ? { stream: stream === 'true' } : {}),
        ...(errorType ? { errorType } : {}),
        sort,
        order,
      }),
    refreshMs,
    [range, page, debouncedSearch, success, stream, errorType, sort, order],
  );

  const errorTypes = usePoll(() => api.errorBreakdown({ range }), null, [range]);

  const rows = requests.data?.requests ?? [];
  const total = requests.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const toggleSort = (column: string): void => {
    if (sort === column) setOrder(order === 'asc' ? 'desc' : 'asc');
    else {
      setSort(column);
      setOrder('desc');
    }
  };

  const sortIndicator = (column: string): string => (sort === column ? (order === 'asc' ? ' ▲' : ' ▼') : '');

  return (
    <>
      {requests.error && (
        <Alert tone="error" title={t('req.cannotLoad')}>
          {requests.error.message}
        </Alert>
      )}

      <Card
        title={t('req.title')}
        subtitle={t('req.subtitle')}
        actions={
          <button onClick={requests.refresh} type="button" className="sm">
            {t('common.refresh')}
          </button>
        }
        flush
      >
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
          <div className="filters">
            <Field label={t('req.search')}>
              <input
                placeholder={t('req.searchPlaceholder')}
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setPage(0);
                }}
              />
            </Field>
            <Field label={t('req.range')}>
              <select
                value={range}
                onChange={(event) => {
                  setRange(event.target.value);
                  setPage(0);
                }}
              >
                {RANGES.map((option) => (
                  <option key={option} value={option}>
                    {t(RANGE_LABELS[option])}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('req.outcome')}>
              <select
                value={success}
                onChange={(event) => {
                  setSuccess(event.target.value);
                  setPage(0);
                }}
              >
                <option value="">{t('req.outcomeAny')}</option>
                <option value="true">{t('req.outcomeSuccess')}</option>
                <option value="false">{t('req.outcomeFailed')}</option>
              </select>
            </Field>
            <Field label={t('req.mode')}>
              <select
                value={stream}
                onChange={(event) => {
                  setStream(event.target.value);
                  setPage(0);
                }}
              >
                <option value="">{t('req.modeAny')}</option>
                <option value="true">{t('req.modeStream')}</option>
                <option value="false">{t('req.modeNonStream')}</option>
              </select>
            </Field>
            <Field label={t('req.errorType')}>
              <select
                value={errorType}
                onChange={(event) => {
                  setErrorType(event.target.value);
                  setPage(0);
                }}
              >
                <option value="">{t('req.outcomeAny')}</option>
                {(errorTypes.data ?? []).map((entry) => (
                  <option key={entry.label} value={entry.label}>
                    {entry.label} ({entry.count})
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </div>

        {requests.loading && rows.length === 0 ? (
          <Loading />
        ) : rows.length === 0 ? (
          <Empty title={t('req.none')}>{t('req.noneHint')}</Empty>
        ) : (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t('req.started')}</th>
                    <th>{t('req.clientModel')}</th>
                    <th>{t('common.protocol')}</th>
                    <th>{t('req.providerModel')}</th>
                    <th>{t('req.key')}</th>
                    <th>{t('req.outcome')}</th>
                    <th className="num sortable" onClick={() => toggleSort('latency_ms')}>
                      {t('common.latency')}
                      {sortIndicator('latency_ms')}
                    </th>
                    <th className="num sortable" onClick={() => toggleSort('ttft_ms')}>
                      {t('dashboard.ttft')}
                      {sortIndicator('ttft_ms')}
                    </th>
                    <th className="num sortable" onClick={() => toggleSort('total_tokens')}>
                      {t('req.tokens')}
                      {sortIndicator('total_tokens')}
                    </th>
                    <th className="num">{t('req.fallbacks')}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((request) => {
                    const tone = statusTone(request);
                    return (
                      <tr key={request.id} className="clickable" onClick={() => navigate('requests', request.id)}>
                        <td className="nowrap" title={formatDateTime(request.startedAt, lang)}>
                          {formatRelative(request.startedAt, lang)}
                        </td>
                        <td>
                          <div className="mono" style={{ fontWeight: 600 }}>
                            {request.clientModel}
                          </div>
                          {request.modelAlias && (
                            <div className="field-hint" style={{ fontSize: 11 }}>
                              {t('req.aliasPrefix', { name: request.modelAlias })}
                            </div>
                          )}
                        </td>
                        <td className="nowrap">
                          <Badge tone="muted">{enumLabel(t, 'protocol', request.clientProtocol)}</Badge>
                          {request.stream ? <Badge tone="accent">{t('common.stream')}</Badge> : null}
                        </td>
                        <td className="nowrap">
                          {request.providerId ? (
                            <>
                              <div>{request.providerId}</div>
                              <div className="field-hint" style={{ fontSize: 11 }}>
                                {request.upstreamProtocol ?? '—'}
                                {request.responsesMode && request.responsesMode !== 'unsupported'
                                  ? ` · responses: ${enumLabel(t, 'mode', request.responsesMode)}`
                                  : ''}
                              </div>
                            </>
                          ) : (
                            <span style={{ color: 'var(--text-faint)' }}>—</span>
                          )}
                        </td>
                        <td className="nowrap">
                          {request.apiKeyId ?? <span style={{ color: 'var(--text-faint)' }}>—</span>}
                        </td>
                        <td className="nowrap">
                          <Badge tone={tone} title={request.errorType ?? undefined}>
                            {request.success
                              ? `${request.statusCode ?? 200}`
                              : (request.errorType ?? `HTTP ${request.statusCode ?? '?'}`)}
                          </Badge>
                          {request.finishReason === 'tool_calls' ? <Badge tone="accent">tools</Badge> : null}
                          {request.finishReason === 'length' ? <Badge tone="warn">{t('enum.finish.length')}</Badge> : null}
                        </td>
                        <td className="num">{formatMs(request.latencyMs)}</td>
                        <td className="num">{formatMs(request.ttftMs)}</td>
                        <td className="num" title={request.usageSource ?? t('req.usagenotReported')}>
                          {formatNumber(request.totalTokens, lang)}
                          {request.usageSource === 'gateway_estimated' ? (
                            <span className="field-hint" style={{ fontSize: 10.5, display: 'block' }} title={t('req.estTitle')}>
                              {t('common.estimate')}
                            </span>
                          ) : null}
                        </td>
                        <td className="num">
                          {request.fallbackCount > 0 ? <Badge tone="warn">{request.fallbackCount}</Badge> : '—'}
                        </td>
                        <td>
                          <button className="ghost sm" type="button">
                            ›
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="pagination">
              <span>
                {t('req.count', { count: formatNumber(total, lang) })} ·{' '}
                {t('common.page', { page: page + 1, total: pageCount })}
              </span>
              <div className="btn-row">
                <button
                  className="sm"
                  onClick={() => setPage((value) => Math.max(0, value - 1))}
                  disabled={page === 0}
                  type="button"
                >
                  {t('common.previous')}
                </button>
                <button
                  className="sm"
                  onClick={() => setPage((value) => Math.min(pageCount - 1, value + 1))}
                  disabled={page >= pageCount - 1}
                  type="button"
                >
                  {t('common.next')}
                </button>
              </div>
            </div>
          </>
        )}
      </Card>

      {detailId && <RequestDetail id={detailId} onClose={() => navigate('requests')} refreshMs={refreshMs} />}
    </>
  );
}

function RequestDetail({ id, onClose, refreshMs }: { id: string; onClose: () => void; refreshMs: number }): JSX.Element {
  const { t, lang } = useI18n();
  const detail = usePoll(() => api.getRequest(id), refreshMs, [id]);
  const [tab, setTab] = useState<'overview' | 'attempts' | 'timeline' | 'payload' | 'raw'>('overview');

  if (detail.loading && !detail.data) {
    return (
      <Modal wide title={t('title.requests')} onClose={onClose}>
        <Loading />
      </Modal>
    );
  }
  if (!detail.data) {
    return (
      <Modal wide title={t('title.requests')} onClose={onClose}>
        <Alert tone="error" title={t('req.cannotLoad')}>
          {detail.error?.message ?? '—'}
        </Alert>
      </Modal>
    );
  }

  const { request, attempts, resolved, attemptUsage } = detail.data;
  const logicalTokens = request.totalTokens;
  const billedTokens = attemptUsage.totalTokens;
  const overhead = logicalTokens !== null && billedTokens !== null ? billedTokens - logicalTokens : null;
  const failedAttempts = attempts.filter((attempt) => attempt.result !== 'success').length;

  // Context sentence: complete translated sentences joined with a space, so word
  // order stays correct in both languages.
  const contextParts = [t('req.contextLine', { latency: formatMs(request.latencyMs) })];
  if (request.queueWaitMs !== null && request.queueWaitMs > 0) {
    contextParts.push(t('req.contextQueue', { value: formatMs(request.queueWaitMs) }));
  }
  if (request.ttftMs !== null) {
    contextParts.push(t('req.contextTtft', { value: formatMs(request.ttftMs) }));
  }
  if (overhead !== null && overhead > 0) {
    contextParts.push(t('req.contextOverhead', { percent: percent(overhead, billedTokens ?? 1) }));
  }

  return (
    <Modal wide title={t('req.detailTitle', { id: request.id })} onClose={onClose}>
      <div className="btn-row" style={{ justifyContent: 'space-between' }}>
        <Badge tone={statusTone(request)}>
          {request.success ? t('enum.phase.completed') : (request.errorType ?? enumLabel(t, 'phase', 'failed'))}
        </Badge>
        <span className="field-hint">{formatDateTime(request.startedAt, lang)}</span>
      </div>

      <Tabs
        tabs={[
          { id: 'overview' as const, label: t('req.tabOverview') },
          { id: 'attempts' as const, label: t('req.tabAttempts'), count: attempts.length },
          { id: 'timeline' as const, label: t('req.tabTimeline'), count: (request.timeline ?? []).length },
          { id: 'payload' as const, label: t('req.tabPayloads') },
          { id: 'raw' as const, label: t('req.tabRaw') },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'overview' && (
        <>
          <h4 style={{ margin: 0, fontSize: 13 }}>{t('req.routing')}</h4>
          <dl className="stat-list">
            <StatRow label={t('req.clientRequested')}>
              <span className="mono">{request.clientModel}</span>
              {request.modelAlias ? <Badge tone="accent">{t('req.aliasPrefix', { name: request.modelAlias })}</Badge> : null}
            </StatRow>
            <StatRow label={t('req.resolvedModel')}>
              <span className="mono">{resolved['modelName'] ?? request.modelId ?? '—'}</span>
            </StatRow>
            <StatRow label={t('req.upstreamModelId')}>
              <span className="mono">{resolved['upstreamModelId'] ?? '—'}</span>
            </StatRow>
            <StatRow label={t('common.provider')}>
              {resolved['providerName'] ?? request.providerId ?? '—'}
              {resolved['providerProtocol'] ? <Badge tone="muted">{resolved['providerProtocol']}</Badge> : null}
            </StatRow>
            <StatRow label={t('usage.apiKey')}>
              {resolved['apiKeyName'] ?? '—'}
              {resolved['apiKeyMask'] ? <span className="mono field-hint"> {resolved['apiKeyMask']}</span> : null}
            </StatRow>
            <StatRow label={t('req.clientProtocol')}>
              <Badge tone="muted">{enumLabel(t, 'protocol', request.clientProtocol)}</Badge>
              {request.stream ? <Badge tone="accent">{t('common.streaming')}</Badge> : null}
            </StatRow>
            <StatRow label={t('req.responsesModeHeading')}>{enumLabel(t, 'mode', request.responsesMode)}</StatRow>
            <StatRow label={t('req.finishReason')}>
              {request.finishReason === null ? (
                <Badge tone="muted">{t('enum.finish.none')}</Badge>
              ) : (
                <Badge
                  tone={request.finishReason === 'tool_calls' ? 'accent' : request.finishReason === 'length' ? 'warn' : 'ok'}
                >
                  {enumLabel(t, 'finish', request.finishReason)}
                </Badge>
              )}
            </StatRow>
            <StatRow label={t('req.fallbacksUsed')}>{request.fallbackCount}</StatRow>
            <StatRow label={t('req.tabAttempts')}>{attempts.length}</StatRow>
          </dl>

          <h4 style={{ margin: 0, fontSize: 13 }}>{t('req.latencyHeading')}</h4>
          <dl className="stat-list">
            <StatRow label={t('req.queueWait')}>{formatMs(request.queueWaitMs)}</StatRow>
            <StatRow label={t('req.ttft')}>{formatMs(request.ttftMs)}</StatRow>
            <StatRow label={t('req.totalLatency')}>{formatMs(request.latencyMs)}</StatRow>
            <StatRow label={t('req.completedAt')}>{formatDateTime(request.completedAt, lang)}</StatRow>
          </dl>

          <h4 style={{ margin: 0, fontSize: 13 }}>{t('req.usageHeading')}</h4>
          <Alert tone={overhead !== null && overhead > 0 ? 'warn' : 'info'} title={overhead !== null && overhead > 0 ? t('req.overheadDetected') : t('req.usageAccounting')}>
            {overhead !== null && overhead > 0
              ? t('req.overheadExplain', { tokens: formatNumber(overhead, lang), failed: failedAttempts })
              : t('req.ledgersMatch')}
          </Alert>
          <div className="split-2">
            <div>
              <div className="field-hint" style={{ marginBottom: 6 }}>
                {t('req.logicalLabel')}
              </div>
              <dl className="stat-list">
                <StatRow label={t('usage.inputTokens')}>{formatNumber(request.inputTokens, lang)}</StatRow>
                <StatRow label={t('usage.cachedInputTokens')}>{formatNumber(request.cachedInputTokens, lang)}</StatRow>
                <StatRow label={t('usage.outputTokens')}>{formatNumber(request.outputTokens, lang)}</StatRow>
                <StatRow label={t('usage.reasoningTokens')}>{formatNumber(request.reasoningTokens, lang)}</StatRow>
                <StatRow label={t('usage.totalTokens')}>{formatNumber(request.totalTokens, lang)}</StatRow>
                <StatRow label={t('req.result')}>
                  {request.usageSource === null ? (
                    <Badge tone="muted">{t('req.sourceNotReported')}</Badge>
                  ) : request.usageSource === 'provider' ? (
                    <Badge tone="ok">{t('req.sourceProvider')}</Badge>
                  ) : (
                    <Badge tone="warn">{t('req.sourceEstimated')}</Badge>
                  )}
                </StatRow>
              </dl>
            </div>
            <div>
              <div className="field-hint" style={{ marginBottom: 6 }}>
                {t('req.attemptLabel', { count: attemptUsage.attempts })}
              </div>
              <dl className="stat-list">
                <StatRow label={t('usage.inputTokensBilled')}>{formatNumber(attemptUsage.inputTokens, lang)}</StatRow>
                <StatRow label={t('usage.outputTokensBilled')}>{formatNumber(attemptUsage.outputTokens, lang)}</StatRow>
                <StatRow label={t('usage.totalTokensBilled')}>{formatNumber(attemptUsage.totalTokens, lang)}</StatRow>
                <StatRow label={t('req.failedAttempts')}>
                  <span style={{ color: attemptUsage.failedAttempts > 0 ? 'var(--error)' : 'inherit' }}>
                    {formatNumber(attemptUsage.failedAttempts, lang)}
                  </span>
                </StatRow>
                <StatRow label={t('req.overhead')}>
                  {overhead === null
                    ? '—'
                    : overhead === 0
                      ? t('dashboard.overheadNone')
                      : t('dashboard.overheadTokens', { tokens: formatNumber(overhead, lang) })}
                </StatRow>
              </dl>
            </div>
          </div>
        </>
      )}

      {tab === 'attempts' && (
        <>
          {attempts.length === 0 ? (
            <Empty title={t('req.noAttempts')}>{t('req.noAttemptsHint')}</Empty>
          ) : (
            <table>
              <thead>
                <tr>
                  <th className="num">{t('req.attemptNo')}</th>
                  <th>{t('common.provider')}</th>
                  <th>{t('req.upstreamModel')}</th>
                  <th>{t('req.key')}</th>
                  <th>{t('req.result')}</th>
                  <th className="num">{t('common.status')}</th>
                  <th className="num">{t('common.latency')}</th>
                  <th className="num">{t('req.queue')}</th>
                  <th className="num">{t('req.in')}</th>
                  <th className="num">{t('req.out')}</th>
                  <th className="num">{t('usage.colTotal')}</th>
                </tr>
              </thead>
              <tbody>
                {attempts.map((attempt) => (
                  <tr key={attempt.id}>
                    <td className="num">{attempt.attemptNo}</td>
                    <td>{attempt.providerId}</td>
                    <td className="mono">{attempt.upstreamModelId}</td>
                    <td className="mono">{attempt.apiKeyId ?? '—'}</td>
                    <td>
                      <Badge
                        tone={
                          attempt.result === 'success'
                            ? 'ok'
                            : attempt.result === 'aborted'
                              ? 'muted'
                              : attempt.result === 'retryable_error'
                                ? 'warn'
                                : 'error'
                        }
                        title={attempt.errorMessage ?? undefined}
                      >
                        {attempt.errorType ?? attempt.result}
                      </Badge>
                    </td>
                    <td className="num">{attempt.statusCode ?? '—'}</td>
                    <td className="num">{formatMs(attempt.latencyMs)}</td>
                    <td className="num">{attempt.queueWaitMs == null ? '—' : formatMs(attempt.queueWaitMs)}</td>
                    <td className="num">{formatNumber(attempt.inputTokens, lang)}</td>
                    <td className="num">{formatNumber(attempt.outputTokens, lang)}</td>
                    <td className="num">{formatNumber(attempt.totalTokens, lang)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="field-hint">{t('req.retryPolicy')}</div>
        </>
      )}

      {tab === 'timeline' && (
        <>
          {(request.timeline ?? []).length === 0 ? (
            <Empty title={t('req.noTimeline')} />
          ) : (
            <table>
              <thead>
                <tr>
                  <th className="num">{t('req.tMillis')}</th>
                  <th>{t('req.event')}</th>
                  <th>{t('req.detail')}</th>
                </tr>
              </thead>
              <tbody>
                {(request.timeline ?? []).map((entry, index) => (
                  <tr key={index}>
                    <td className="num mono">{entry.t}</td>
                    <td>
                      <Badge
                        tone={
                          entry.label.includes('fail') || entry.label.includes('error')
                            ? 'error'
                            : entry.label.includes('fallback')
                              ? 'warn'
                              : 'muted'
                        }
                      >
                        {entry.label}
                      </Badge>
                    </td>
                    <td className="mono" style={{ fontSize: 12 }}>
                      {entry.detail ?? ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      {tab === 'payload' && (
        <>
          {request.content === null ? (
            <Alert tone="info" title={t('req.payloadDisabled')}>
              {t('req.payloadDisabledHint')}
            </Alert>
          ) : (
            <>
              <h4 style={{ margin: 0, fontSize: 13 }}>{t('req.clientRequest')}</h4>
              <JsonBlock value={request.content.request} empty={t('common.notCaptured')} />
              <h4 style={{ margin: 0, fontSize: 13 }}>{t('req.clientResponse')}</h4>
              <JsonBlock value={request.content.response} empty={t('common.notCaptured')} />
            </>
          )}
        </>
      )}

      {tab === 'raw' && (
        <>
          {attempts.length === 0 ? (
            <Empty title={t('req.noAttemptsToShow')} />
          ) : (
            attempts.map((attempt: RequestAttempt) => (
              <div key={attempt.id} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <h4 style={{ margin: 0, fontSize: 13 }}>
                  {t('req.attemptHeading', { no: attempt.attemptNo, protocol: attempt.upstreamProtocol })}
                  {attempt.errorType ? (
                    <Badge tone="error">{attempt.errorType}</Badge>
                  ) : (
                    <Badge tone="ok">{enumLabel(t, 'phase', 'completed')}</Badge>
                  )}
                </h4>
                {attempt.errorMessage && <Alert tone="error">{attempt.errorMessage}</Alert>}
                <div className="split-2">
                  <div>
                    <div className="field-hint">{t('req.upstreamRequest')}</div>
                    <JsonBlock value={attempt.upstreamRequestJson} empty={t('common.notCaptured')} />
                  </div>
                  <div>
                    <div className="field-hint">{t('req.upstreamResponse')}</div>
                    <JsonBlock value={attempt.upstreamResponseJson} empty={t('req.streamNotStored')} />
                  </div>
                </div>
                {attempt.usageJson && (
                  <div>
                    <div className="field-hint">{t('req.attemptUsage')}</div>
                    <JsonBlock value={attempt.usageJson} />
                  </div>
                )}
              </div>
            ))
          )}
        </>
      )}

      <div className="field-hint">{contextParts.join(' ')}</div>
    </Modal>
  );
}
