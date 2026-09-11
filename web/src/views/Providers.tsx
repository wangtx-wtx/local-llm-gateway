import { useMemo, useState } from 'react';
import { api, ApiError } from '../api/client';
import type { Provider, ProtocolId, TestResult } from '../api/types';
import { Alert, Badge, Card, Empty, Field, Loading, Modal, StatRow } from '../components/ui';
import { usePoll } from '../lib/hooks';
import { formatMs, formatRelative } from '../lib/format';
import { enumLabel, useI18n } from '../i18n';
import type { ViewProps } from './shared';

/**
 * Provider management.
 *
 * A provider is pure configuration: base URL, native protocol, auth style and
 * limits. Nothing here is specific to a vendor or a model name, which is what
 * lets a brand new endpoint be added from this screen alone.
 */

interface ProviderFormState {
  id: string;
  name: string;
  type: string;
  baseUrl: string;
  nativeProtocol: ProtocolId;
  enabled: boolean;
  allowPrivateNetwork: boolean;
  requestTimeoutMs: string;
  streamIdleTimeoutMs: string;
  maxConcurrentRequests: string;
  maxQueueSize: string;
  secret: string;
  testModel: string;
  authStyle: string;
  apiVersion: string;
  chatPath: string;
  responsesPath: string;
  messagesPath: string;
}

const EMPTY_FORM: ProviderFormState = {
  id: '',
  name: '',
  type: 'openai-compatible',
  baseUrl: '',
  nativeProtocol: 'openai-chat',
  enabled: true,
  allowPrivateNetwork: false,
  requestTimeoutMs: '',
  streamIdleTimeoutMs: '',
  maxConcurrentRequests: '',
  maxQueueSize: '',
  secret: '',
  testModel: '',
  authStyle: '',
  apiVersion: '',
  chatPath: '',
  responsesPath: '',
  messagesPath: '',
};

export function ProvidersView({
  refreshMs,
  navigate,
  pushToast,
  detailId,
}: ViewProps & { detailId?: string | null }): JSX.Element {
  const { t } = useI18n();
  const providers = usePoll(() => api.listProviders(), refreshMs);
  const meta = usePoll(() => api.meta(), null);
  const [editing, setEditing] = useState<ProviderFormState | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [probe, setProbe] = useState<TestResult | null>(null);
  const [detail, setDetail] = useState<Provider | null>(null);

  const detailProvider = useMemo(
    () => (detailId ? (providers.data ?? []).find((provider) => provider.id === detailId) ?? null : null),
    [detailId, providers.data],
  );

  const openCreate = (): void => {
    setEditing({ ...EMPTY_FORM });
    setEditingId(null);
    setFormError(null);
    setProbe(null);
  };

  const openEdit = (provider: Provider): void => {
    setEditing({
      id: provider.id,
      name: provider.name,
      type: provider.type,
      baseUrl: provider.baseUrl,
      nativeProtocol: provider.nativeProtocol,
      enabled: provider.enabled,
      allowPrivateNetwork: provider.allowPrivateNetwork,
      requestTimeoutMs: provider.requestTimeoutMs === null ? '' : String(provider.requestTimeoutMs),
      streamIdleTimeoutMs: provider.streamIdleTimeoutMs === null ? '' : String(provider.streamIdleTimeoutMs),
      maxConcurrentRequests: provider.maxConcurrentRequests === null ? '' : String(provider.maxConcurrentRequests),
      maxQueueSize: provider.maxQueueSize === null ? '' : String(provider.maxQueueSize),
      secret: '',
      testModel: '',
      authStyle: typeof provider.extra?.['authStyle'] === 'string' ? (provider.extra['authStyle'] as string) : '',
      apiVersion: typeof provider.extra?.['apiVersion'] === 'string' ? (provider.extra['apiVersion'] as string) : '',
      chatPath: typeof provider.extra?.['chatPath'] === 'string' ? (provider.extra['chatPath'] as string) : '',
      responsesPath:
        typeof provider.extra?.['responsesPath'] === 'string' ? (provider.extra['responsesPath'] as string) : '',
      messagesPath:
        typeof provider.extra?.['messagesPath'] === 'string' ? (provider.extra['messagesPath'] as string) : '',
    });
    setEditingId(provider.id);
    setFormError(null);
    setProbe(null);
  };

  const buildBody = (form: ProviderFormState): Record<string, unknown> => {
    const extra: Record<string, unknown> = {};
    if (form.authStyle) extra['authStyle'] = form.authStyle;
    if (form.apiVersion) extra['apiVersion'] = form.apiVersion;
    if (form.chatPath) extra['chatPath'] = form.chatPath;
    if (form.responsesPath) extra['responsesPath'] = form.responsesPath;
    if (form.messagesPath) extra['messagesPath'] = form.messagesPath;
    return {
      ...(form.id ? { id: form.id } : {}),
      name: form.name,
      type: form.type,
      baseUrl: form.baseUrl,
      nativeProtocol: form.nativeProtocol,
      enabled: form.enabled,
      allowPrivateNetwork: form.allowPrivateNetwork,
      requestTimeoutMs: form.requestTimeoutMs === '' ? null : Number(form.requestTimeoutMs),
      streamIdleTimeoutMs: form.streamIdleTimeoutMs === '' ? null : Number(form.streamIdleTimeoutMs),
      maxConcurrentRequests: form.maxConcurrentRequests === '' ? null : Number(form.maxConcurrentRequests),
      maxQueueSize: form.maxQueueSize === '' ? null : Number(form.maxQueueSize),
      extra,
    };
  };

  const save = async (): Promise<void> => {
    if (!editing) return;
    setBusy(true);
    setFormError(null);
    try {
      const body = buildBody(editing);
      const provider = editingId ? await api.updateProvider(editingId, body) : await api.createProvider(body);
      // The optional first key is created right away so a new provider is
      // immediately usable rather than requiring a second trip to API Keys.
      // Named after the provider, not "Default key": with several providers in
      // play, a shared default name makes every key list unreadable.
      if (!editingId && editing.secret.trim() !== '') {
        await api.createApiKey({
          providerId: provider.id,
          name: `${provider.name} key`,
          secret: editing.secret.trim(),
          enabled: true,
          priority: 100,
          weight: 1,
        });
      }
      pushToast(
        'ok',
        editingId ? t('providers.updated') : t('providers.created'),
        t('providers.registryReloaded', { name: provider.name }),
      );
      setEditing(null);
      providers.refresh();
    } catch (error) {
      // A 409 means the id is taken; show it inline next to the form rather than
      // as a toast, since the user needs to change a specific field.
      setFormError(
        error instanceof ApiError
          ? error.isConflict
            ? t('providers.conflictHint', { message: error.message })
            : error.message
          : String(error),
      );
    } finally {
      setBusy(false);
    }
  };

  const runProbe = async (): Promise<void> => {
    if (!editing) return;
    setBusy(true);
    setProbe(null);
    setFormError(null);
    try {
      const result = await api.probeProvider({
        baseUrl: editing.baseUrl,
        nativeProtocol: editing.nativeProtocol,
        type: editing.type,
        allowPrivateNetwork: editing.allowPrivateNetwork,
        model: editing.testModel || 'test',
        secret: editing.secret,
        extra: buildBody(editing)['extra'],
      });
      setProbe(result);
    } catch (error) {
      setFormError(error instanceof ApiError ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (provider: Provider): Promise<void> => {
    if (!window.confirm(t('providers.deleteConfirm', { name: provider.name }))) return;
    try {
      await api.deleteProvider(provider.id);
      pushToast('ok', t('providers.deleted'), provider.name);
      providers.refresh();
    } catch (error) {
      pushToast('error', t('providers.deleteFailed'), error instanceof Error ? error.message : String(error));
    }
  };

  const testProvider = async (provider: Provider): Promise<void> => {
    setDetail(provider);
    try {
      const result = await api.testProvider(provider.id);
      pushToast(
        result.ok ? 'ok' : 'error',
        result.ok ? t('providers.testOk', { name: provider.name }) : t('providers.testFail', { name: provider.name }),
        result.detail,
      );
    } catch (error) {
      pushToast('error', t('providers.testFailed'), error instanceof Error ? error.message : String(error));
    }
  };

  if (providers.loading && !providers.data) return <Loading />;

  const list = providers.data ?? [];

  return (
    <>
      {providers.error && (
        <Alert tone="error" title={t('providers.cannotLoad')}>
          {providers.error.message}
        </Alert>
      )}

      <Card
        title={t('providers.title')}
        subtitle={t('providers.subtitle')}
        actions={
          <>
            <button onClick={providers.refresh} type="button" className="sm">
              {t('common.refresh')}
            </button>
            <button className="primary sm" onClick={openCreate} type="button">
              {t('providers.add')}
            </button>
          </>
        }
        flush
      >
        {list.length === 0 ? (
          <Empty
            title={t('providers.none')}
            action={
              <button className="primary" onClick={openCreate} type="button">
                {t('providers.noneAction')}
              </button>
            }
          >
            {t('providers.noneHint')}
          </Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t('common.name')}</th>
                  <th>{t('providers.nativeProtocol')}</th>
                  <th>{t('providers.baseUrl')}</th>
                  <th className="num">{t('providers.models')}</th>
                  <th className="num">{t('providers.keys')}</th>
                  <th>{t('providers.circuit')}</th>
                  <th className="num">{t('providers.active')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.map((provider) => {
                  const circuitState = provider.circuit?.state ?? 'closed';
                  return (
                    <tr key={provider.id} className={detailProvider?.id === provider.id ? 'clickable' : undefined}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{provider.name}</div>
                        <div className="mono" style={{ fontSize: 11, color: 'var(--text-faint)' }}>
                          {provider.id} · {provider.type}
                        </div>
                      </td>
                      <td>
                        <Badge tone="accent">{provider.nativeProtocol}</Badge>
                      </td>
                      <td
                        className="mono"
                        style={{ fontSize: 12, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis' }}
                      >
                        {provider.baseUrl}
                        {provider.allowPrivateNetwork ? (
                          <Badge tone="warn" title={t('providers.privateBadgeTitle')}>
                            {t('providers.privateBadge')}
                          </Badge>
                        ) : null}
                      </td>
                      <td className="num">{provider.modelCount ?? 0}</td>
                      <td className="num">
                        {provider.enabledKeyCount ?? 0}/{provider.keyCount ?? 0}
                      </td>
                      <td>
                        {circuitState === 'closed' ? (
                          <Badge tone="ok">{enumLabel(t, 'circuit', 'closed')}</Badge>
                        ) : (
                          <Badge tone={circuitState === 'open' ? 'error' : 'warn'}>
                            {enumLabel(t, 'circuit', circuitState)}
                          </Badge>
                        )}
                      </td>
                      <td className="num">
                        {provider.activeRequests ?? 0}
                        {provider.queuedRequests ? (
                          <span style={{ color: 'var(--warn)' }}> +{provider.queuedRequests}</span>
                        ) : null}
                      </td>
                      <td className="nowrap">
                        <div className="btn-row">
                          <button className="sm" onClick={() => void testProvider(provider)} type="button">
                            {t('common.test')}
                          </button>
                          <button className="sm" onClick={() => openEdit(provider)} type="button">
                            {t('common.edit')}
                          </button>
                          <button
                            className="sm"
                            onClick={() => {
                              navigate('keys', provider.id);
                            }}
                            type="button"
                          >
                            {t('providers.keysButton')}
                          </button>
                          <button className="sm danger" onClick={() => void remove(provider)} type="button">
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

      {detail && <ProviderDetail provider={detail} onClose={() => setDetail(null)} />}

      {editing && (
        <Modal
          wide
          title={editingId ? t('providers.editTitle', { name: editing.name }) : t('providers.createTitle')}
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
                disabled={busy || editing.name.trim() === '' || editing.baseUrl.trim() === ''}
              >
                {busy ? t('common.saving') : editingId ? t('providers.saveChanges') : t('providers.createButton')}
              </button>
            </>
          }
        >
          {formError && (
            <Alert tone="error" title={t('providers.requestFailed')}>
              {formError}
            </Alert>
          )}
          {probe && (
            <Alert
              tone={probe.ok ? 'ok' : 'error'}
              title={probe.ok ? t('providers.connectionOk') : t('providers.connectionFailed')}
            >
              {probe.detail}
              {probe.latencyMs ? ` (${formatMs(probe.latencyMs)})` : ''}
              {probe.authFailed ? ` — ${t('keys.keyFailed')}` : ''}
            </Alert>
          )}

          <div className="form-grid">
            <Field label={t('providers.displayName')}>
              <input
                value={editing.name}
                onChange={(event) => setEditing({ ...editing, name: event.target.value })}
                placeholder={t('providers.displayNamePlaceholder')}
                autoFocus
              />
            </Field>
            <Field label={t('providers.type')} hint={t('providers.typeHint')}>
              <select
                value={editing.type}
                onChange={(event) => {
                  const type = event.target.value;
                  const preset = (meta.data?.providerTypes ?? []).find((entry) => entry.type === type);
                  setEditing({
                    ...editing,
                    type,
                    nativeProtocol: preset ? preset.nativeProtocol : editing.nativeProtocol,
                    baseUrl: editing.baseUrl === '' && preset ? preset.baseUrlHint : editing.baseUrl,
                  });
                }}
              >
                {(meta.data?.providerTypes ?? [{ type: 'custom', label: 'Custom' }]).map((entry) => (
                  <option key={entry.type} value={entry.type}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <Field label={t('providers.baseUrl')} hint={t('providers.baseUrlHint')}>
            <input
              value={editing.baseUrl}
              onChange={(event) => setEditing({ ...editing, baseUrl: event.target.value })}
              placeholder="https://api.openai.com/v1"
              className="mono"
            />
          </Field>

          <div className="form-grid">
            <Field label={t('providers.nativeProtocol')} hint={t('providers.nativeProtocolHint')}>
              <select
                value={editing.nativeProtocol}
                onChange={(event) => setEditing({ ...editing, nativeProtocol: event.target.value as ProtocolId })}
              >
                {(meta.data?.protocols ?? ['openai-chat']).map((protocol) => (
                  <option key={protocol} value={protocol}>
                    {protocol}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('providers.authStyle')} hint={t('providers.authStyleHint')}>
              <select
                value={editing.authStyle}
                onChange={(event) => setEditing({ ...editing, authStyle: event.target.value })}
              >
                <option value="">{t('providers.authStyleDefault')}</option>
                <option value="bearer">{t('providers.authStyleBearerOption')}</option>
                <option value="x-api-key">{t('providers.authStyleApiKeyOption')}</option>
                <option value="none">{t('providers.authNone')}</option>
              </select>
            </Field>
          </div>

          <div className="form-grid">
            <Field label={t('providers.apiVersion')} hint={t('providers.apiVersionHint')}>
              <input
                value={editing.apiVersion}
                onChange={(event) => setEditing({ ...editing, apiVersion: event.target.value })}
                placeholder="2023-06-01"
                className="mono"
              />
            </Field>
            <Field label={t('providers.requestTimeout')} hint={t('providers.blankUsesDefault')}>
              <input
                value={editing.requestTimeoutMs}
                onChange={(event) =>
                  setEditing({ ...editing, requestTimeoutMs: event.target.value.replace(/[^0-9]/g, '') })
                }
                placeholder="120000"
              />
            </Field>
          </div>

          <details>
            <summary style={{ cursor: 'pointer', fontSize: 13, color: 'var(--text-muted)' }}>
              {t('providers.advanced')}
            </summary>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 13, marginTop: 13 }}>
              <div className="form-grid">
                <Field label={t('providers.chatPath')}>
                  <input
                    value={editing.chatPath}
                    onChange={(event) => setEditing({ ...editing, chatPath: event.target.value })}
                    placeholder="chat/completions"
                    className="mono"
                  />
                </Field>
                <Field label={t('providers.responsesPath')}>
                  <input
                    value={editing.responsesPath}
                    onChange={(event) => setEditing({ ...editing, responsesPath: event.target.value })}
                    placeholder="responses"
                    className="mono"
                  />
                </Field>
                <Field label={t('providers.messagesPath')}>
                  <input
                    value={editing.messagesPath}
                    onChange={(event) => setEditing({ ...editing, messagesPath: event.target.value })}
                    placeholder="messages"
                    className="mono"
                  />
                </Field>
              </div>
              <div className="form-grid">
                <Field label={t('providers.maxConcurrent')} hint={t('providers.maxConcurrentHint')}>
                  <input
                    value={editing.maxConcurrentRequests}
                    onChange={(event) =>
                      setEditing({ ...editing, maxConcurrentRequests: event.target.value.replace(/[^0-9]/g, '') })
                    }
                    placeholder="16"
                  />
                </Field>
                <Field label={t('providers.maxQueue')} hint={t('providers.maxQueueHint')}>
                  <input
                    value={editing.maxQueueSize}
                    onChange={(event) =>
                      setEditing({ ...editing, maxQueueSize: event.target.value.replace(/[^0-9]/g, '') })
                    }
                    placeholder="256"
                  />
                </Field>
                <Field label={t('providers.streamIdleTimeout')}>
                  <input
                    value={editing.streamIdleTimeoutMs}
                    onChange={(event) =>
                      setEditing({ ...editing, streamIdleTimeoutMs: event.target.value.replace(/[^0-9]/g, '') })
                    }
                    placeholder="120000"
                  />
                </Field>
              </div>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={editing.allowPrivateNetwork}
                  onChange={(event) => setEditing({ ...editing, allowPrivateNetwork: event.target.checked })}
                />
                {t('providers.allowPrivate')}
              </label>
              <div className="field-hint">{t('providers.allowPrivateHint')}</div>
            </div>
          </details>

          {!editingId && (
            <div className="form-grid">
              <Field label={t('providers.firstKey')} hint={t('providers.firstKeyHint')}>
                <input
                  type="password"
                  value={editing.secret}
                  onChange={(event) => setEditing({ ...editing, secret: event.target.value })}
                  placeholder="sk-…"
                  autoComplete="off"
                />
              </Field>
              <Field label={t('providers.modelToProbe')} hint={t('providers.modelToProbeHint')}>
                <input
                  value={editing.testModel}
                  onChange={(event) => setEditing({ ...editing, testModel: event.target.value })}
                  placeholder="gpt-4o-mini"
                  className="mono"
                />
              </Field>
            </div>
          )}

          <div className="btn-row">
            <button onClick={() => void runProbe()} type="button" disabled={busy || editing.baseUrl.trim() === ''}>
              {busy ? t('common.testing') : t('providers.testConnection')}
            </button>
            <span className="field-hint">
              {t('providers.testConnectionHint', { url: editing.baseUrl || '—' })}
            </span>
          </div>

          <label className="checkbox">
            <input
              type="checkbox"
              checked={editing.enabled}
              onChange={(event) => setEditing({ ...editing, enabled: event.target.checked })}
            />
            {t('providers.enabled')}
          </label>
        </Modal>
      )}
    </>
  );
}

function ProviderDetail({ provider, onClose }: { provider: Provider; onClose: () => void }): JSX.Element {
  const { t, lang } = useI18n();
  const detail = usePoll(() => api.getProvider(provider.id), null, [provider.id]);
  return (
    <Modal wide title={t('providers.detailTitle', { name: provider.name })} onClose={onClose}>
      {detail.loading && !detail.data ? (
        <Loading />
      ) : detail.data ? (
        <>
          <dl className="stat-list">
            <StatRow label={t('providers.id')}>
              <span className="mono">{provider.id}</span>
            </StatRow>
            <StatRow label={t('providers.nativeProtocol')}>
              <Badge tone="accent">{provider.nativeProtocol}</Badge>
            </StatRow>
            <StatRow label={t('providers.baseUrl')}>
              <span className="mono" style={{ fontSize: 12 }}>
                {provider.baseUrl}
              </span>
            </StatRow>
            <StatRow label={t('providers.models')}>{detail.data.models.length}</StatRow>
            <StatRow label={t('providers.keys')}>
              {detail.data.apiKeys.length} ({detail.data.apiKeys.filter((key) => key.enabled).length}{' '}
              {t('common.enabled').toLowerCase()})
            </StatRow>
            <StatRow label={t('providers.updatedAt')}>{formatRelative(provider.updatedAt, lang)}</StatRow>
          </dl>

          <h4 style={{ margin: '4px 0 0', fontSize: 13 }}>{t('providers.apiKeysHeading')}</h4>
          {detail.data.apiKeys.length === 0 ? (
            <div className="field-hint">{t('providers.noKeysYet')}</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>{t('common.name')}</th>
                  <th>{t('providers.mask')}</th>
                  <th>{t('common.status')}</th>
                  <th className="num">{t('keys.activeCol')}</th>
                  <th className="num">{t('providers.okFail')}</th>
                </tr>
              </thead>
              <tbody>
                {detail.data.apiKeys.map((key) => (
                  <tr key={key.id}>
                    <td>{key.name}</td>
                    <td className="mono">{key.secretMask}</td>
                    <td>
                      <Badge
                        tone={
                          key.health?.status === 'healthy'
                            ? 'ok'
                            : key.health?.status === 'rate_limited'
                              ? 'warn'
                              : 'error'
                        }
                      >
                        {enumLabel(t, 'status', key.health?.status ?? key.status)}
                      </Badge>
                    </td>
                    <td className="num">{key.health?.active ?? 0}</td>
                    <td className="num">
                      {key.health?.successCount ?? 0} / {key.health?.failureCount ?? 0}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h4 style={{ margin: '4px 0 0', fontSize: 13 }}>{t('providers.modelsHeading')}</h4>
          {detail.data.models.length === 0 ? (
            <div className="field-hint">{t('providers.noModels')}</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>{t('providers.clientModelId')}</th>
                  <th>{t('providers.upstreamModelId')}</th>
                  <th>{t('providers.responsesMode')}</th>
                  <th>{t('common.enabled')}</th>
                </tr>
              </thead>
              <tbody>
                {detail.data.models.map((model) => (
                  <tr key={model.id}>
                    <td className="mono">{model.clientModelId}</td>
                    <td className="mono">{model.upstreamModelId}</td>
                    <td>
                      <Badge
                        tone={
                          model.responsesMode === 'native' ? 'ok' : model.responsesMode === 'emulated' ? 'warn' : 'muted'
                        }
                      >
                        {enumLabel(t, 'mode', model.responsesMode)}
                      </Badge>
                    </td>
                    <td>
                      {model.enabled ? (
                        <Badge tone="ok">{t('common.yes')}</Badge>
                      ) : (
                        <Badge tone="muted">{t('common.no')}</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {detail.data.health && (
            <div className="field-hint">
              {t('providers.circuitLine', {
                state: enumLabel(t, 'circuit', detail.data.health.state),
                failures: detail.data.health.consecutiveFailures,
              })}
              {detail.data.health.cooldownUntil
                ? ` · ${t('providers.cooldownUntil', {
                    time: new Date(detail.data.health.cooldownUntil).toLocaleTimeString(
                      lang === 'zh' ? 'zh-CN' : 'en-US',
                    ),
                  })}`
                : ''}
            </div>
          )}
        </>
      ) : (
        <Alert tone="error" title={t('providers.cannotLoadDetail')}>
          {detail.error?.message}
        </Alert>
      )}
    </Modal>
  );
}
