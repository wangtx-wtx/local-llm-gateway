import { useMemo, useState } from 'react';
import { api, ApiError } from '../api/client';
import type { ApiKey, Provider, TestResult } from '../api/types';
import { Alert, Badge, Card, Dot, Empty, Field, Kpi, Loading, Modal, StatRow } from '../components/ui';
import { usePoll } from '../lib/hooks';
import { formatMs, formatNumber, formatRelative, keyStatusTone } from '../lib/format';
import { enumLabel, useI18n, type TranslationKey } from '../i18n';
import type { ViewProps } from './shared';

/**
 * API key pool.
 *
 * A key is a rotating credential with its own health state and its own
 * concurrency slot. The dashboard renders the LIVE health from the pool (which
 * lives outside the registry snapshot, keyed by id) alongside the persisted
 * row, so what you see is what the selector will actually do on the next
 * request.
 */

interface KeyForm {
  providerId: string;
  name: string;
  secret: string;
  note: string;
  enabled: boolean;
  priority: string;
  weight: string;
  maxConcurrentRequests: string;
}

export function ApiKeysView({ refreshMs, pushToast, detailId }: ViewProps & { detailId?: string | null }): JSX.Element {
  const { t, lang } = useI18n();
  const keys = usePoll(() => api.listApiKeys(), refreshMs);
  const providers = usePoll(() => api.listProviders(), refreshMs * 3);
  const meta = usePoll(() => api.meta(), null);
  const [editing, setEditing] = useState<KeyForm | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [detail, setDetail] = useState<ApiKey | null>(null);
  const [testResult, setTestResult] = useState<{ key: ApiKey; result: TestResult } | null>(null);
  const [secretNotice, setSecretNotice] = useState<Record<string, boolean>>({});
  const [providerFilter, setProviderFilter] = useState<string>('');

  const providerById = useMemo(
    () => new Map((providers.data ?? []).map((provider) => [provider.id, provider])),
    [providers.data],
  );

  const list = useMemo(() => {
    const all = keys.data ?? [];
    if (providerFilter === '') return all;
    return all.filter((key) => key.providerId === providerFilter);
  }, [keys.data, providerFilter]);

  const summary = useMemo(() => {
    const all = keys.data ?? [];
    const selectable = all.filter((key) => key.health?.selectable ?? key.enabled);
    const failing = all.filter(
      (key) => key.health !== null && (key.health.status === 'auth_failed' || key.health.status === 'quota_exhausted'),
    );
    const cooling = all.filter(
      (key) => key.health !== null && (key.health.status === 'cooldown' || key.health.status === 'rate_limited'),
    );
    const totalSelections = all.reduce((sum, key) => sum + (key.health?.selections ?? 0), 0);
    return { total: all.length, selectable: selectable.length, failing: failing.length, cooling: cooling.length, totalSelections };
  }, [keys.data]);

  const openCreate = (): void => {
    setEditing({
      providerId: detailId ?? providerFilter ?? (providers.data ?? [])[0]?.id ?? '',
      name: '',
      secret: '',
      note: '',
      enabled: true,
      priority: '100',
      weight: '1',
      maxConcurrentRequests: '',
    });
    setEditingId(null);
    setFormError(null);
  };

  const openEdit = (key: ApiKey): void => {
    setEditing({
      providerId: key.providerId,
      name: key.name,
      secret: '',
      note: key.note ?? '',
      enabled: key.enabled,
      priority: String(key.priority),
      weight: String(key.weight),
      maxConcurrentRequests: key.maxConcurrentRequests === null ? '' : String(key.maxConcurrentRequests),
    });
    setEditingId(key.id);
    setFormError(null);
  };

  const save = async (): Promise<void> => {
    if (!editing) return;
    setBusy(true);
    setFormError(null);
    try {
      const base = {
        name: editing.name.trim(),
        note: editing.note.trim() === '' ? null : editing.note.trim(),
        enabled: editing.enabled,
        priority: Number(editing.priority) || 100,
        weight: Number(editing.weight) || 1,
        maxConcurrentRequests: editing.maxConcurrentRequests === '' ? null : Number(editing.maxConcurrentRequests),
      };
      if (editingId) {
        await api.updateApiKey(editingId, {
          ...base,
          ...(editing.secret.trim() !== '' ? { secret: editing.secret.trim() } : {}),
        });
        pushToast('ok', t('keys.updated'), editing.name);
      } else {
        await api.createApiKey({ ...base, providerId: editing.providerId, secret: editing.secret.trim() });
        pushToast('ok', t('keys.added'), editing.name);
      }
      setEditing(null);
      keys.refresh();
    } catch (error) {
      setFormError(
        error instanceof ApiError
          ? error.isConflict
            ? t('keys.conflictHint', { message: error.message })
            : error.message
          : String(error),
      );
    } finally {
      setBusy(false);
    }
  };

  const remove = async (key: ApiKey): Promise<void> => {
    if (!window.confirm(t('keys.deletedConfirm', { name: key.name }))) return;
    try {
      await api.deleteApiKey(key.id);
      pushToast('ok', t('keys.deleted'), key.name);
      keys.refresh();
    } catch (error) {
      pushToast('error', t('providers.deleteFailed'), error instanceof Error ? error.message : String(error));
    }
  };

  const reset = async (key: ApiKey): Promise<void> => {
    try {
      await api.resetApiKey(key.id);
      pushToast('ok', t('keys.resetDone'), t('keys.resetDoneFoot', { name: key.name }));
      keys.refresh();
    } catch (error) {
      pushToast('error', t('keys.resetFailed'), error instanceof Error ? error.message : String(error));
    }
  };

  const test = async (key: ApiKey): Promise<void> => {
    setDetail(key);
    try {
      const response = await api.testApiKey(key.id);
      setTestResult({ key, result: response.result });
      pushToast(
        response.result.ok ? 'ok' : 'error',
        response.result.ok ? t('keys.keyWorks') : t('keys.keyFailed'),
        `${key.name}: ${response.result.detail}`,
      );
      keys.refresh();
    } catch (error) {
      pushToast('error', t('providers.testFailed'), error instanceof Error ? error.message : String(error));
    }
  };

  if (keys.loading && !keys.data) return <Loading />;

  /** Colour a policy name the way the key status badges are coloured. */
  const policyTone = (policy: string): 'ok' | 'muted' => (policy === meta.data?.settings.apiKeySelectionPolicy ? 'ok' : 'muted');

  return (
    <>
      {keys.error && (
        <Alert tone="error" title={t('keys.cannotLoad')}>
          {keys.error.message}
        </Alert>
      )}

      <div className="grid cols-4">
        <Kpi
          label={t('keys.kpiKeys')}
          value={formatNumber(summary.total, lang)}
          foot={t('keys.kpiSelectable', { count: formatNumber(summary.selectable, lang) })}
        />
        <Kpi
          label={t('keys.kpiCooling')}
          value={formatNumber(summary.cooling, lang)}
          foot={t('keys.kpiCoolingFoot')}
        />
        <Kpi
          label={t('keys.kpiAttention')}
          value={formatNumber(summary.failing, lang)}
          foot={t('keys.kpiAttentionFoot')}
        />
        <Kpi
          label={t('keys.kpiSelections')}
          value={formatNumber(summary.totalSelections, lang)}
          foot={t('keys.kpiPolicy', { name: meta.data?.settings.apiKeySelectionPolicy ?? '—' })}
        />
      </div>

      {(providers.data ?? []).length === 0 && (
        <Alert tone="warn" title={t('keys.noProviders')}>
          {t('keys.noProvidersHint')}
        </Alert>
      )}

      <Card
        title={t('keys.title')}
        subtitle={t('keys.subtitle')}
        actions={
          <>
            <select
              value={providerFilter}
              onChange={(event) => setProviderFilter(event.target.value)}
              style={{ width: 'auto', fontSize: 12 }}
            >
              <option value="">{t('common.allProviders')}</option>
              {(providers.data ?? []).map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.name}
                </option>
              ))}
            </select>
            <button onClick={keys.refresh} type="button" className="sm">
              {t('common.refresh')}
            </button>
            <button className="primary sm" onClick={openCreate} type="button" disabled={(providers.data ?? []).length === 0}>
              {t('keys.add')}
            </button>
          </>
        }
        flush
      >
        {list.length === 0 ? (
          <Empty
            title={t('keys.none')}
            action={
              (providers.data ?? []).length > 0 ? (
                <button className="primary" onClick={openCreate} type="button">
                  {t('keys.noneAction')}
                </button>
              ) : undefined
            }
          >
            {t('keys.noneHint')}
          </Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t('common.name')}</th>
                  <th>{t('common.provider')}</th>
                  <th>{t('keys.secret')}</th>
                  <th>{t('common.status')}</th>
                  <th className="num">{t('keys.priority')}</th>
                  <th className="num">{t('keys.weight')}</th>
                  <th className="num">{t('keys.activeCol')}</th>
                  <th className="num">{t('keys.picked')}</th>
                  <th className="num">{t('keys.okFail')}</th>
                  <th className="num">{t('keys.lastUsed')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.map((key) => {
                  const health = key.health;
                  const status = health?.status ?? key.status;
                  const cooling =
                    health?.cooldownUntil !== null &&
                    health?.cooldownUntil !== undefined &&
                    health.cooldownUntil > Date.now();
                  return (
                    <tr key={key.id}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{key.name}</div>
                        {key.note && (
                          <div className="field-hint" style={{ fontSize: 11 }}>
                            {key.note}
                          </div>
                        )}
                        {!key.enabled && <Badge tone="muted">{t('common.disabled')}</Badge>}
                      </td>
                      <td>
                        {providerById.get(key.providerId)?.name ?? (
                          <span style={{ color: 'var(--error)' }}>{t('common.missing')}</span>
                        )}
                      </td>
                      <td className="mono" style={{ fontSize: 12 }}>
                        {key.secretMask}
                        {secretNotice[key.id] ? (
                          <div className="field-hint" style={{ fontSize: 11 }}>
                            {t('keys.secretHidden')}
                          </div>
                        ) : (
                          <button
                            className="ghost sm"
                            onClick={() => setSecretNotice((current) => ({ ...current, [key.id]: true }))}
                            type="button"
                            title={t('keys.whySecret')}
                          >
                            ?
                          </button>
                        )}
                      </td>
                      <td>
                        <Badge tone={keyStatusTone(status)} title={health?.selectable ? t('keys.selectable') : t('keys.notSelectable')}>
                          {enumLabel(t, 'status', status)}
                        </Badge>
                        {health && !health.selectable && key.enabled && status === 'healthy' ? (
                          <Badge tone="warn">{t('keys.skipped')}</Badge>
                        ) : null}
                        {cooling && health?.cooldownUntil ? (
                          <div className="field-hint" style={{ fontSize: 11 }}>
                            {t('keys.coolingUntil', {
                              time: new Date(health.cooldownUntil).toLocaleTimeString(lang === 'zh' ? 'zh-CN' : 'en-US'),
                            })}
                          </div>
                        ) : null}
                      </td>
                      <td className="num">{key.priority}</td>
                      <td className="num">{key.weight}</td>
                      <td className="num">
                        {health?.active ?? 0}
                        {key.maxConcurrentRequests !== null ? (
                          <span style={{ color: 'var(--text-faint)' }}>/{key.maxConcurrentRequests}</span>
                        ) : null}
                      </td>
                      <td className="num">{formatNumber(health?.selections ?? 0, lang)}</td>
                      <td className="num">
                        <span style={{ color: 'var(--ok)' }}>{health?.successCount ?? 0}</span> /{' '}
                        <span style={{ color: (health?.failureCount ?? 0) > 0 ? 'var(--error)' : 'inherit' }}>
                          {health?.failureCount ?? 0}
                        </span>
                      </td>
                      <td className="num">{formatRelative(health?.lastUsedAt ?? key.lastUsedAt, lang)}</td>
                      <td className="nowrap">
                        <div className="btn-row">
                          <button className="sm" onClick={() => void test(key)} type="button">
                            {t('common.test')}
                          </button>
                          <button className="sm" onClick={() => void reset(key)} type="button" title={t('keys.resetTitle')}>
                            {t('common.reset')}
                          </button>
                          <button className="sm" onClick={() => openEdit(key)} type="button">
                            {t('common.edit')}
                          </button>
                          <button className="sm danger" onClick={() => void remove(key)} type="button">
                            {t('common.delete')}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title={t('keys.howChosen')} subtitle={t('keys.howChosenSub')}>
        <div className="split-2">
          <div>
            <h4 style={{ margin: '0 0 6px', fontSize: 13 }}>{t('keys.filtering')}</h4>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.8 }}>
              <li>{t('keys.filter1')}</li>
              <li>{t('keys.filter2')}</li>
              <li>{t('keys.filter3')}</li>
              <li>{t('keys.filter4')}</li>
            </ul>
          </div>
          <div>
            <h4 style={{ margin: '0 0 6px', fontSize: 13 }}>{t('keys.ordering')}</h4>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.8 }}>
              {(meta.data?.selectionPolicies ?? []).map((policy) => (
                <li key={policy}>
                  <span className="mono">{policy}</span>{' '}
                  {policy === meta.data?.settings.apiKeySelectionPolicy ? (
                    <Badge tone={policyTone(policy)}>{t('keys.activePolicy')}</Badge>
                  ) : null}
                  {' — '}
                  {t(`keys.policyHint.${policy}` as TranslationKey)}
                </li>
              ))}
            </ul>
          </div>
        </div>
        <div className="field-hint" style={{ marginTop: 12 }}>
          {t('keys.failureClassification')}
        </div>
      </Card>

      {editing && (
        <Modal
          title={editingId ? t('keys.editTitle', { name: editing.name }) : t('keys.addTitle')}
          onClose={() => setEditing(null)}
          footer={
            <>
              <button onClick={() => setEditing(null)} type="button" disabled={busy}>
                {t('common.cancel')}
              </button>
              <button
                className="primary"
                onClick={() => void save()}
                type="button"
                disabled={busy || editing.name.trim() === '' || (!editingId && editing.secret.trim() === '') || editing.providerId === ''}
              >
                {busy ? t('common.saving') : editingId ? t('providers.saveChanges') : t('keys.addButton')}
              </button>
            </>
          }
        >
          {formError && (
            <Alert tone="error" title={t('providers.requestFailed')}>
              {formError}
            </Alert>
          )}

          {!editingId && (
            <Field label={t('common.provider')}>
              <select
                value={editing.providerId}
                onChange={(event) => setEditing({ ...editing, providerId: event.target.value })}
              >
                {(providers.data ?? []).map((provider: Provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.name}
                  </option>
                ))}
              </select>
            </Field>
          )}

          <div className="form-grid">
            <Field label={t('keys.name')} hint={t('keys.nameHint')}>
              <input
                value={editing.name}
                onChange={(event) => setEditing({ ...editing, name: event.target.value })}
                placeholder={t('keys.namePlaceholder')}
                autoFocus
              />
            </Field>
            <Field label={t('common.note')}>
              <input
                value={editing.note}
                onChange={(event) => setEditing({ ...editing, note: event.target.value })}
                placeholder={t('common.optional')}
              />
            </Field>
          </div>

          <Field label={editingId ? t('keys.replaceSecret') : t('keys.secret')} hint={t('keys.secretHint')}>
            <input
              type="password"
              value={editing.secret}
              onChange={(event) => setEditing({ ...editing, secret: event.target.value })}
              placeholder={editingId ? t('keys.secretKeep') : 'sk-…'}
              autoComplete="off"
              className="mono"
            />
          </Field>

          <div className="form-grid">
            <Field label={t('keys.priority')} hint={t('keys.priorityHint')}>
              <input
                value={editing.priority}
                onChange={(event) => setEditing({ ...editing, priority: event.target.value.replace(/[^0-9]/g, '') })}
                placeholder="100"
              />
            </Field>
            <Field label={t('keys.weight')} hint={t('keys.weightHint')}>
              <input
                value={editing.weight}
                onChange={(event) => setEditing({ ...editing, weight: event.target.value.replace(/[^0-9]/g, '') })}
                placeholder="1"
              />
            </Field>
            <Field label={t('sys.limit')} hint={t('keys.maxConcurrentHint')}>
              <input
                value={editing.maxConcurrentRequests}
                onChange={(event) =>
                  setEditing({ ...editing, maxConcurrentRequests: event.target.value.replace(/[^0-9]/g, '') })
                }
                placeholder="8"
              />
            </Field>
          </div>

          <label className="checkbox">
            <input
              type="checkbox"
              checked={editing.enabled}
              onChange={(event) => setEditing({ ...editing, enabled: event.target.checked })}
            />
            {t('keys.enabled')}
          </label>
        </Modal>
      )}

      {detail && (
        <Modal
          wide
          title={t('keys.detailTitle', { name: detail.name })}
          onClose={() => {
            setDetail(null);
            setTestResult(null);
          }}
          footer={
            <button
              onClick={() => {
                setDetail(null);
                setTestResult(null);
              }}
              type="button"
            >
              {t('common.close')}
            </button>
          }
        >
          {testResult && testResult.key.id === detail.id && (
            <Alert
              tone={testResult.result.ok ? 'ok' : 'error'}
              title={testResult.result.ok ? t('keys.keyWorks') : t('keys.keyFailed')}
            >
              {testResult.result.detail}
              {testResult.result.latencyMs ? ` · ${formatMs(testResult.result.latencyMs)}` : ''}
            </Alert>
          )}
          <dl className="stat-list">
            <StatRow label={t('common.provider')}>
              {providerById.get(detail.providerId)?.name ?? detail.providerId}
            </StatRow>
            <StatRow label={t('keys.secret')}>{detail.secretMask}</StatRow>
            <StatRow label={t('common.status')}>
              <Badge tone={keyStatusTone(detail.health?.status ?? detail.status)}>
                {enumLabel(t, 'status', detail.health?.status ?? detail.status)}
              </Badge>
            </StatRow>
            <StatRow label={t('keys.selectable')}>
              {detail.health?.selectable ? t('common.yes') : t('common.no')}
            </StatRow>
            <StatRow label={t('keys.consecutiveFailures')}>
              {formatNumber(detail.health?.consecutiveFailures ?? detail.consecutiveFailures, lang)}
            </StatRow>
            <StatRow label={t('keys.selections')}>{formatNumber(detail.health?.selections ?? 0, lang)}</StatRow>
            <StatRow label={t('keys.successFailure')}>
              {formatNumber(detail.health?.successCount ?? 0, lang)} /{' '}
              {formatNumber(detail.health?.failureCount ?? 0, lang)}
            </StatRow>
            <StatRow label={t('keys.currentlyActive')}>{formatNumber(detail.health?.active ?? 0, lang)}</StatRow>
            <StatRow label={t('keys.circuitState')}>
              {detail.health ? (
                <>
                  <Dot
                    tone={
                      detail.health.circuit.state === 'closed'
                        ? 'ok'
                        : detail.health.circuit.state === 'half_open'
                          ? 'warn'
                          : 'error'
                    }
                  />
                  {t('keys.circuitDetail', {
                    state: enumLabel(t, 'circuit', detail.health.circuit.state),
                    count: detail.health.circuit.consecutiveFailures,
                  })}
                </>
              ) : (
                '—'
              )}
            </StatRow>
            <StatRow label={t('keys.lastUsed')}>
              {formatRelative(detail.health?.lastUsedAt ?? detail.lastUsedAt, lang)}
            </StatRow>
            <StatRow label={t('keys.lastSuccess')}>
              {formatRelative(detail.health?.lastSuccessAt ?? detail.lastSuccessAt, lang)}
            </StatRow>
            <StatRow label={t('keys.lastFailure')}>
              {formatRelative(detail.health?.lastFailureAt ?? detail.lastFailureAt, lang)}
            </StatRow>
            <StatRow label={t('keys.created')}>{formatRelative(detail.createdAt, lang)}</StatRow>
          </dl>

          {detail.health?.circuit.cooldownUntil ? (
            <div className="field-hint">
              {t('keys.cooldownUntilFull', {
                time: new Date(detail.health.circuit.cooldownUntil).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US'),
              })}
            </div>
          ) : null}

          <div className="btn-row">
            <button onClick={() => void test(detail)} type="button">
              {t('keys.testTitle')}
            </button>
            <button onClick={() => void reset(detail)} type="button">
              {t('keys.resetHealth')}
            </button>
          </div>

          <div className="field-hint">{t('keys.healthPersisted')}</div>
        </Modal>
      )}
    </>
  );
}
