import { useState } from 'react';
import { api } from '../api/client';
import { Alert, Badge, Card, Empty, Field, JsonBlock, Loading, Modal } from '../components/ui';
import { useDebounced, usePoll } from '../lib/hooks';
import { formatDateTime } from '../lib/format';
import { enumLabel, useI18n } from '../i18n';
import type { LogRow } from '../api/types';
import type { ViewProps } from './shared';

/**
 * Structured log browser.
 *
 * The same records the gateway writes to stdout are persisted here in batches
 * (when persistence is enabled), with secrets already redacted by the logger.
 */

const LEVELS = ['all', 'debug', 'info', 'warn', 'error'] as const;

export function LogsView({ refreshMs }: ViewProps): JSX.Element {
  const { t, lang } = useI18n();
  const [level, setLevel] = useState<(typeof LEVELS)[number]>('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<LogRow | null>(null);
  const debounced = useDebounced(search, 300);
  const limit = 100;

  const logs = usePoll(
    () =>
      api.listLogs({
        limit,
        offset: page * limit,
        ...(level !== 'all' ? { level } : {}),
        ...(debounced ? { search: debounced } : {}),
      }),
    refreshMs,
    [level, debounced, page],
  );

  const rows = logs.data?.logs ?? [];
  const total = logs.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / limit));

  const prune = async (): Promise<void> => {
    if (!window.confirm(t('logs.pruneConfirm'))) return;
    try {
      const response = await fetch(
        `/api/admin/logs?before=${encodeURIComponent(new Date(Date.now() - 7 * 86_400_000).toISOString())}`,
        { method: 'DELETE' },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      logs.refresh();
    } catch {
      /* surfaced by the refresh below */
    }
  };

  return (
    <>
      {logs.error && (
        <Alert tone="error" title={t('logs.cannotLoad')}>
          {logs.error.message}. {t('logs.cannotLoadHint')}
        </Alert>
      )}

      <Card
        title={t('logs.title')}
        subtitle={t('logs.subtitle')}
        actions={
          <>
            <button className="sm" onClick={() => void prune()} type="button">
              {t('logs.prune')}
            </button>
            <button className="sm" onClick={logs.refresh} type="button">
              {t('common.refresh')}
            </button>
          </>
        }
        flush
      >
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
          <div className="filters">
            <Field label={t('logs.level')}>
              <select
                value={level}
                onChange={(event) => {
                  setLevel(event.target.value as (typeof LEVELS)[number]);
                  setPage(0);
                }}
              >
                {LEVELS.map((entry) => (
                  <option key={entry} value={entry}>
                    {entry === 'all' ? t('logs.levelAll') : enumLabel(t, 'level', entry)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('logs.search')}>
              <input
                placeholder={t('logs.searchPlaceholder')}
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setPage(0);
                }}
              />
            </Field>
          </div>
        </div>

        {logs.loading && rows.length === 0 ? (
          <Loading />
        ) : rows.length === 0 ? (
          <Empty title={t('logs.none')}>{t('logs.noneHint')}</Empty>
        ) : (
          <>
            <div className="table-wrap" style={{ maxHeight: 600 }}>
              <table>
                <thead>
                  <tr>
                    <th>{t('logs.time')}</th>
                    <th>{t('logs.level')}</th>
                    <th>{t('logs.event')}</th>
                    <th>{t('logs.request')}</th>
                    <th>{t('logs.message')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id} className="clickable" onClick={() => setSelected(row)}>
                      <td className="nowrap" title={formatDateTime(row.ts, lang)}>
                        {new Date(row.ts).toLocaleTimeString(lang === 'zh' ? 'zh-CN' : 'en-US')}
                      </td>
                      <td>
                        <Badge
                          tone={
                            row.level === 'error'
                              ? 'error'
                              : row.level === 'warn'
                                ? 'warn'
                                : row.level === 'debug'
                                  ? 'muted'
                                  : 'accent'
                          }
                        >
                          {enumLabel(t, 'level', row.level)}
                        </Badge>
                      </td>
                      <td className="mono">{row.event}</td>
                      <td className="mono" style={{ fontSize: 11.5 }}>
                        {row.requestId ?? '—'}
                      </td>
                      <td style={{ maxWidth: 460, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {row.message ?? ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="pagination">
              <span>
                {t('logs.records', { count: total })} · {t('common.page', { page: page + 1, total: pageCount })}
              </span>
              <div className="btn-row">
                <button
                  className="sm"
                  type="button"
                  disabled={page === 0}
                  onClick={() => setPage((value) => Math.max(0, value - 1))}
                >
                  {t('common.previous')}
                </button>
                <button
                  className="sm"
                  type="button"
                  disabled={page >= pageCount - 1}
                  onClick={() => setPage((value) => value + 1)}
                >
                  {t('common.next')}
                </button>
              </div>
            </div>
          </>
        )}
      </Card>

      {selected && (
        <Modal title={selected.event} onClose={() => setSelected(null)} wide>
          <dl className="stat-list">
            <div className="stat-row">
              <dt>{t('logs.time')}</dt>
              <dd>{formatDateTime(selected.ts, lang)}</dd>
            </div>
            <div className="stat-row">
              <dt>{t('logs.level')}</dt>
              <dd>
                <Badge
                  tone={selected.level === 'error' ? 'error' : selected.level === 'warn' ? 'warn' : 'muted'}
                >
                  {enumLabel(t, 'level', selected.level)}
                </Badge>
              </dd>
            </div>
            {selected.requestId && (
              <div className="stat-row">
                <dt>{t('logs.request')}</dt>
                <dd className="mono">{selected.requestId}</dd>
              </div>
            )}
            {selected.providerId && (
              <div className="stat-row">
                <dt>{t('common.provider')}</dt>
                <dd className="mono">{selected.providerId}</dd>
              </div>
            )}
            {selected.modelId && (
              <div className="stat-row">
                <dt>{t('common.model')}</dt>
                <dd className="mono">{selected.modelId}</dd>
              </div>
            )}
            {selected.apiKeyId && (
              <div className="stat-row">
                <dt>{t('usage.apiKey')}</dt>
                <dd className="mono">{selected.apiKeyId}</dd>
              </div>
            )}
          </dl>
          {selected.message && <Alert tone="info">{selected.message}</Alert>}
          <div className="field-hint">{t('logs.fields')}</div>
          <JsonBlock value={selected.fieldsJson} empty={t('logs.noFields')} />
        </Modal>
      )}
    </>
  );
}
