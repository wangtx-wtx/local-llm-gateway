import { useMemo, useState } from 'react';
import { api, ApiError } from '../api/client';
import type { Model, ModelCapabilities, ProtocolId, ProtocolMode, TestResult } from '../api/types';
import { Alert, Badge, Card, Empty, Field, Loading, Modal, Tabs } from '../components/ui';
import { usePoll } from '../lib/hooks';
import { formatMs, formatNumber, modeTone } from '../lib/format';
import { enumLabel, useI18n, type TranslationKey } from '../i18n';
import type { ViewProps } from './shared';

/**
 * Model registry.
 *
 * Every model is a database row: client-facing id, upstream id, the protocol
 * modes it exposes, and its capability flags. Adding a model here makes it
 * appear in `GET /v1/models` immediately — the registry snapshot is rebuilt on
 * save, with no restart and no code change.
 */

/** Capability descriptors hold dictionary keys; translation happens at render. */
const CAPABILITY_LABELS: Record<string, { label: TranslationKey; hint: TranslationKey }> = {
  streaming: { label: 'models.capStreaming', hint: 'models.capStreamingHint' },
  tools: { label: 'models.capTools', hint: 'models.capToolsHint' },
  parallelToolCalls: { label: 'models.capParallel', hint: 'models.capParallelHint' },
  vision: { label: 'models.capVision', hint: 'models.capVisionHint' },
  jsonMode: { label: 'models.capJson', hint: 'models.capJsonHint' },
  reasoning: { label: 'models.capReasoning', hint: 'models.capReasoningHint' },
  systemPrompt: { label: 'models.capSystem', hint: 'models.capSystemHint' },
};

interface ModelForm {
  id: string;
  providerId: string;
  clientModelId: string;
  upstreamModelId: string;
  displayName: string;
  enabled: boolean;
  contextWindow: string;
  maxOutputTokens: string;
  nativeProtocol: ProtocolId;
  responsesMode: ProtocolMode;
  chatCompletionsMode: ProtocolMode;
  anthropicMessagesMode: ProtocolMode;
  maxConcurrentRequests: string;
  capabilities: ModelCapabilities;
}

const DEFAULT_CAPS: ModelCapabilities = {
  streaming: true,
  tools: true,
  parallelToolCalls: true,
  vision: false,
  jsonMode: true,
  reasoning: false,
  systemPrompt: true,
};

export function ModelsView({ refreshMs, pushToast, detailId }: ViewProps & { detailId?: string | null }): JSX.Element {
  const { t, lang } = useI18n();
  const models = usePoll(() => api.listModels(), refreshMs);
  const providers = usePoll(() => api.listProviders(), refreshMs * 3);
  const aliases = usePoll(() => api.listAliases(), refreshMs * 3);
  const fallbacks = usePoll(() => api.listFallbacks(), refreshMs * 3);
  const [tab, setTab] = useState<'models' | 'aliases' | 'fallbacks'>('models');
  const [editing, setEditing] = useState<ModelForm | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ model: Model; result: TestResult } | null>(null);
  const [aliasForm, setAliasForm] = useState<{ alias: string; targetModelId: string; note: string } | null>(null);
  const [chainModelId, setChainModelId] = useState<string | null>(null);
  const [chainSelection, setChainSelection] = useState<string[]>([]);
  const [filter, setFilter] = useState('');

  const providerList = providers.data ?? [];
  const providerById = useMemo(() => new Map(providerList.map((provider) => [provider.id, provider])), [providerList]);

  const visible = useMemo(() => {
    const list = models.data ?? [];
    if (filter.trim() === '') return list;
    const needle = filter.trim().toLowerCase();
    return list.filter(
      (model) =>
        model.clientModelId.toLowerCase().includes(needle) ||
        model.upstreamModelId.toLowerCase().includes(needle) ||
        model.displayName.toLowerCase().includes(needle),
    );
  }, [models.data, filter]);

  const openCreate = (): void => {
    setEditing({
      id: '',
      providerId: providerList[0]?.id ?? '',
      clientModelId: '',
      upstreamModelId: '',
      displayName: '',
      enabled: true,
      contextWindow: '',
      maxOutputTokens: '',
      nativeProtocol: providerList[0]?.nativeProtocol ?? 'openai-chat',
      responsesMode: providerList[0]?.nativeProtocol === 'openai-responses' ? 'native' : 'emulated',
      chatCompletionsMode: providerList[0]?.nativeProtocol === 'openai-chat' ? 'native' : 'emulated',
      anthropicMessagesMode: providerList[0]?.nativeProtocol === 'anthropic-messages' ? 'native' : 'emulated',
      maxConcurrentRequests: '',
      capabilities: { ...DEFAULT_CAPS },
    });
    setEditingId(null);
    setFormError(null);
  };

  const openEdit = (model: Model): void => {
    setEditing({
      id: model.id,
      providerId: model.providerId,
      clientModelId: model.clientModelId,
      upstreamModelId: model.upstreamModelId,
      displayName: model.displayName,
      enabled: model.enabled,
      contextWindow: model.contextWindow === null ? '' : String(model.contextWindow),
      maxOutputTokens: model.maxOutputTokens === null ? '' : String(model.maxOutputTokens),
      nativeProtocol: model.nativeProtocol,
      responsesMode: model.responsesMode,
      chatCompletionsMode: model.chatCompletionsMode,
      anthropicMessagesMode: model.anthropicMessagesMode,
      maxConcurrentRequests: model.maxConcurrentRequests === null ? '' : String(model.maxConcurrentRequests),
      capabilities: { ...model.capabilities },
    });
    setEditingId(model.id);
    setFormError(null);
  };

  const save = async (): Promise<void> => {
    if (!editing) return;
    setBusy(true);
    setFormError(null);
    try {
      const body = {
        ...(editing.id ? { id: editing.id } : {}),
        providerId: editing.providerId,
        clientModelId: editing.clientModelId.trim(),
        upstreamModelId:
          editing.upstreamModelId.trim() === '' ? editing.clientModelId.trim() : editing.upstreamModelId.trim(),
        displayName: editing.displayName.trim() === '' ? editing.clientModelId.trim() : editing.displayName.trim(),
        enabled: editing.enabled,
        contextWindow: editing.contextWindow === '' ? null : Number(editing.contextWindow),
        maxOutputTokens: editing.maxOutputTokens === '' ? null : Number(editing.maxOutputTokens),
        nativeProtocol: editing.nativeProtocol,
        responsesMode: editing.responsesMode,
        chatCompletionsMode: editing.chatCompletionsMode,
        anthropicMessagesMode: editing.anthropicMessagesMode,
        maxConcurrentRequests: editing.maxConcurrentRequests === '' ? null : Number(editing.maxConcurrentRequests),
        capabilities: editing.capabilities,
      };
      const saved = editingId ? await api.updateModel(editingId, body) : await api.createModel(body);
      pushToast(
        'ok',
        editingId ? t('models.updated') : t('models.created'),
        t('models.liveInModels', { name: saved.clientModelId }),
      );
      setEditing(null);
      models.refresh();
    } catch (error) {
      // A 409 means the client model id is taken (or the row id collides).
      setFormError(
        error instanceof ApiError
          ? error.isConflict
            ? t('models.conflictHint', { message: error.message })
            : error.message
          : String(error),
      );
    } finally {
      setBusy(false);
    }
  };

  const remove = async (model: Model): Promise<void> => {
    if (!window.confirm(t('models.deleteConfirm', { name: model.clientModelId }))) return;
    try {
      await api.deleteModel(model.id);
      pushToast('ok', t('models.deleted'), model.clientModelId);
      models.refresh();
    } catch (error) {
      pushToast('error', t('providers.deleteFailed'), error instanceof Error ? error.message : String(error));
    }
  };

  const runTest = async (model: Model): Promise<void> => {
    try {
      const result = await api.testModel(model.id);
      setTestResult({ model, result });
      pushToast(
        result.ok ? 'ok' : 'error',
        result.ok ? t('models.testOk') : t('models.testFail'),
        `${model.clientModelId}: ${result.detail}`,
      );
    } catch (error) {
      pushToast('error', t('providers.testFailed'), error instanceof Error ? error.message : String(error));
    }
  };

  const saveAlias = async (): Promise<void> => {
    if (!aliasForm) return;
    setBusy(true);
    try {
      await api.createAlias({
        alias: aliasForm.alias.trim(),
        targetModelId: aliasForm.targetModelId,
        note: aliasForm.note.trim() === '' ? null : aliasForm.note.trim(),
      });
      pushToast('ok', t('models.aliasCreated'), aliasForm.alias);
      setAliasForm(null);
      aliases.refresh();
    } catch (error) {
      pushToast('error', t('models.aliasFailed'), error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const saveChain = async (): Promise<void> => {
    if (!chainModelId) return;
    setBusy(true);
    try {
      await api.setFallbackChain(chainModelId, chainSelection);
      pushToast('ok', t('models.chainSaved'), t('models.chainSavedFoot', { count: chainSelection.length }));
      setChainModelId(null);
      fallbacks.refresh();
    } catch (error) {
      pushToast('error', t('models.chainFailed'), error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  if (models.loading && !models.data) return <Loading />;

  return (
    <>
      {models.error && (
        <Alert tone="error" title={t('models.cannotLoad')}>
          {models.error.message}
        </Alert>
      )}

      {providerList.length === 0 && (
        <Alert tone="warn" title={t('models.noProviders')}>
          {t('models.noProvidersHint')}
        </Alert>
      )}

      <Card
        title={t('models.title')}
        subtitle={t('models.subtitle')}
        actions={
          <>
            <button onClick={models.refresh} type="button" className="sm">
              {t('common.refresh')}
            </button>
            <button className="primary sm" onClick={openCreate} type="button" disabled={providerList.length === 0}>
              {t('models.add')}
            </button>
          </>
        }
        flush
      >
        <Tabs
          tabs={[
            { id: 'models' as const, label: t('models.tabModels'), count: (models.data ?? []).length },
            { id: 'aliases' as const, label: t('models.tabAliases'), count: (aliases.data ?? []).length },
            { id: 'fallbacks' as const, label: t('models.tabFallbacks'), count: (fallbacks.data ?? []).length },
          ]}
          active={tab}
          onChange={setTab}
        />

        {tab === 'models' && (
          <>
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
              <input
                placeholder={t('models.filter')}
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                style={{ maxWidth: 320 }}
              />
            </div>
            {visible.length === 0 ? (
              <Empty title={filter ? t('models.noneMatch') : t('models.none')}>
                {filter ? t('models.tryAnother') : t('models.noneHint')}
              </Empty>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>{t('models.clientId')}</th>
                      <th>{t('models.upstreamId')}</th>
                      <th>{t('common.provider')}</th>
                      <th>{t('models.chat')}</th>
                      <th>{t('models.responses')}</th>
                      <th>{t('models.anthropic')}</th>
                      <th>{t('models.capabilities')}</th>
                      <th className="num">{t('models.ctx')}</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((model) => {
                      const provider = providerById.get(model.providerId);
                      return (
                        <tr key={model.id} style={detailId === model.id ? { background: 'var(--accent-soft)' } : undefined}>
                          <td>
                            <div className="mono" style={{ fontWeight: 600 }}>
                              {model.clientModelId}
                            </div>
                            {!model.enabled && <Badge tone="muted">{t('common.disabled')}</Badge>}
                          </td>
                          <td className="mono">{model.upstreamModelId}</td>
                          <td>
                            {provider?.name ?? <span style={{ color: 'var(--error)' }}>{t('common.missing')}</span>}
                          </td>
                          <td>
                            <Badge tone={modeTone(model.chatCompletionsMode)}>
                              {enumLabel(t, 'mode', model.chatCompletionsMode)}
                            </Badge>
                          </td>
                          <td>
                            <Badge tone={modeTone(model.responsesMode)}>{enumLabel(t, 'mode', model.responsesMode)}</Badge>
                          </td>
                          <td>
                            <Badge tone={modeTone(model.anthropicMessagesMode)}>
                              {enumLabel(t, 'mode', model.anthropicMessagesMode)}
                            </Badge>
                          </td>
                          <td>
                            <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
                              {model.capabilities.streaming && <Badge tone="muted">{t('common.stream')}</Badge>}
                              {model.capabilities.tools && <Badge tone="muted">tools</Badge>}
                              {model.capabilities.vision && <Badge tone="muted">vision</Badge>}
                              {model.capabilities.jsonMode && <Badge tone="muted">json</Badge>}
                              {model.capabilities.reasoning && <Badge tone="muted">reasoning</Badge>}
                            </div>
                          </td>
                          <td className="num">
                            {model.contextWindow === null ? '—' : formatNumber(model.contextWindow, lang)}
                          </td>
                          <td className="nowrap">
                            <div className="btn-row">
                              <button className="sm" onClick={() => void runTest(model)} type="button">
                                {t('common.test')}
                              </button>
                              <button className="sm" onClick={() => openEdit(model)} type="button">
                                {t('common.edit')}
                              </button>
                              <button
                                className="sm"
                                onClick={() => {
                                  setChainModelId(model.id);
                                  const existing = (fallbacks.data ?? []).find((chain) => chain.modelId === model.id);
                                  setChainSelection(existing?.fallbackModelIds ?? []);
                                }}
                                type="button"
                              >
                                {t('models.fallbacksButton')}
                              </button>
                              <button className="sm danger" onClick={() => void remove(model)} type="button">
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
          </>
        )}

        {tab === 'aliases' && (
          <>
            <div
              style={{
                padding: '12px 16px',
                borderBottom: '1px solid var(--border)',
                display: 'flex',
                justifyContent: 'space-between',
                gap: 12,
              }}
            >
              <span className="field-hint">{t('models.aliasHint')}</span>
              <button
                className="primary sm"
                type="button"
                disabled={(models.data ?? []).length === 0}
                onClick={() => setAliasForm({ alias: '', targetModelId: (models.data ?? [])[0]?.id ?? '', note: '' })}
              >
                {t('models.addAlias')}
              </button>
            </div>
            {(aliases.data ?? []).length === 0 ? (
              <Empty title={t('models.noAliases')}>{t('models.noAliasesHint')}</Empty>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>{t('models.alias')}</th>
                    <th>{t('models.targets')}</th>
                    <th>{t('common.note')}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {(aliases.data ?? []).map((alias) => {
                    const target = (models.data ?? []).find((model) => model.id === alias.targetModelId);
                    return (
                      <tr key={alias.id}>
                        <td className="mono" style={{ fontWeight: 600 }}>
                          {alias.alias}
                        </td>
                        <td className="mono">{target?.clientModelId ?? alias.targetModelId}</td>
                        <td>{alias.note ?? '—'}</td>
                        <td>
                          <button
                            className="sm danger"
                            type="button"
                            onClick={async () => {
                              if (!window.confirm(t('models.aliasDeleteConfirm', { name: alias.alias }))) return;
                              await api.deleteAlias(alias.id);
                              aliases.refresh();
                            }}
                          >
                            {t('common.delete')}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </>
        )}

        {tab === 'fallbacks' && (
          <>
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
              <span className="field-hint">{t('models.fallbackHint')}</span>
            </div>
            {(fallbacks.data ?? []).length === 0 ? (
              <Empty title={t('models.noFallbacks')}>{t('models.noFallbacksHint')}</Empty>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>{t('models.primary')}</th>
                    <th>{t('models.fallbackOrder')}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {(fallbacks.data ?? []).map((chain) => (
                    <tr key={chain.modelId}>
                      <td className="mono" style={{ fontWeight: 600 }}>
                        {chain.modelName}
                      </td>
                      <td>
                        <div className="btn-row">
                          {chain.fallbackNames.map((name, index) => (
                            <span key={name}>
                              <Badge tone="muted">{index + 1}</Badge> <span className="mono">{name}</span>
                            </span>
                          ))}
                        </div>
                      </td>
                      <td>
                        <button
                          className="sm"
                          type="button"
                          onClick={() => {
                            setChainModelId(chain.modelId);
                            setChainSelection(chain.fallbackModelIds);
                          }}
                        >
                          {t('common.edit')}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </Card>

      {editing && (
        <Modal
          wide
          title={editingId ? t('models.editTitle', { name: editing.clientModelId }) : t('models.registerTitle')}
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
                disabled={busy || editing.clientModelId.trim() === '' || editing.providerId === ''}
              >
                {busy ? t('common.saving') : editingId ? t('providers.saveChanges') : t('models.registerButton')}
              </button>
            </>
          }
        >
          {formError && (
            <Alert tone="error" title={t('providers.requestFailed')}>
              {formError}
            </Alert>
          )}

          <div className="form-grid">
            <Field label={t('common.provider')}>
              <select
                value={editing.providerId}
                onChange={(event) => {
                  const providerId = event.target.value;
                  const provider = providerById.get(providerId);
                  setEditing({
                    ...editing,
                    providerId,
                    nativeProtocol: provider ? provider.nativeProtocol : editing.nativeProtocol,
                    responsesMode: provider?.nativeProtocol === 'openai-responses' ? 'native' : 'emulated',
                    chatCompletionsMode: provider?.nativeProtocol === 'openai-chat' ? 'native' : 'emulated',
                    anthropicMessagesMode: provider?.nativeProtocol === 'anthropic-messages' ? 'native' : 'emulated',
                  });
                }}
              >
                {providerList.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.name} ({provider.nativeProtocol})
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('models.clientId')} hint={t('models.clientIdHint')}>
              <input
                value={editing.clientModelId}
                onChange={(event) => setEditing({ ...editing, clientModelId: event.target.value })}
                placeholder="my-model"
                className="mono"
                autoFocus
              />
            </Field>
            <Field label={t('models.upstreamId')} hint={t('models.upstreamIdHint')}>
              <input
                value={editing.upstreamModelId}
                onChange={(event) => setEditing({ ...editing, upstreamModelId: event.target.value })}
                placeholder="gpt-4o-mini"
                className="mono"
              />
            </Field>
            <Field label={t('providers.displayName')}>
              <input
                value={editing.displayName}
                onChange={(event) => setEditing({ ...editing, displayName: event.target.value })}
                placeholder={t('models.displayNamePlaceholder')}
              />
            </Field>
          </div>

          <h4 style={{ margin: 0, fontSize: 13 }}>{t('models.protocolExposure')}</h4>
          <div className="field-hint" style={{ marginTop: -8 }}>
            {t('models.protocolExposureHint')}
          </div>
          <div className="form-grid">
            <Field label="/v1/chat/completions">
              <select
                value={editing.chatCompletionsMode}
                onChange={(event) => setEditing({ ...editing, chatCompletionsMode: event.target.value as ProtocolMode })}
              >
                <option value="native">{t('enum.mode.native')}</option>
                <option value="emulated">{t('enum.mode.emulated')}</option>
                <option value="unsupported">{t('enum.mode.unsupported')}</option>
              </select>
            </Field>
            <Field label="/v1/responses">
              <select
                value={editing.responsesMode}
                onChange={(event) => setEditing({ ...editing, responsesMode: event.target.value as ProtocolMode })}
              >
                <option value="native">{t('enum.mode.native')}</option>
                <option value="emulated">{t('enum.mode.emulated')}</option>
                <option value="unsupported">{t('enum.mode.unsupported')}</option>
              </select>
            </Field>
            <Field label="/v1/messages">
              <select
                value={editing.anthropicMessagesMode}
                onChange={(event) =>
                  setEditing({ ...editing, anthropicMessagesMode: event.target.value as ProtocolMode })
                }
              >
                <option value="native">{t('enum.mode.native')}</option>
                <option value="emulated">{t('enum.mode.emulated')}</option>
                <option value="unsupported">{t('enum.mode.unsupported')}</option>
              </select>
            </Field>
          </div>

          <h4 style={{ margin: 0, fontSize: 13 }}>{t('models.capabilities')}</h4>
          <div className="form-grid">
            {Object.entries(CAPABILITY_LABELS).map(([key, info]) => (
              <label className="checkbox" key={key} title={t(info.hint)}>
                <input
                  type="checkbox"
                  checked={editing.capabilities[key] ?? false}
                  onChange={(event) =>
                    setEditing({
                      ...editing,
                      capabilities: { ...editing.capabilities, [key]: event.target.checked },
                    })
                  }
                />
                {t(info.label)}
              </label>
            ))}
          </div>

          <div className="form-grid">
            <Field label={t('models.contextWindow')} hint={t('models.informational')}>
              <input
                value={editing.contextWindow}
                onChange={(event) => setEditing({ ...editing, contextWindow: event.target.value.replace(/[^0-9]/g, '') })}
                placeholder="128000"
              />
            </Field>
            <Field label={t('models.maxOutput')} hint={t('models.informational')}>
              <input
                value={editing.maxOutputTokens}
                onChange={(event) =>
                  setEditing({ ...editing, maxOutputTokens: event.target.value.replace(/[^0-9]/g, '') })
                }
                placeholder="4096"
              />
            </Field>
            <Field label={t('models.maxConcurrent')} hint={t('models.maxConcurrentHint')}>
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
            {t('models.enabled')}
          </label>
        </Modal>
      )}

      {aliasForm && (
        <Modal
          title={t('models.aliasModal')}
          onClose={() => setAliasForm(null)}
          footer={
            <>
              <button onClick={() => setAliasForm(null)} type="button" disabled={busy}>
                {t('common.cancel')}
              </button>
              <button
                className="primary"
                onClick={() => void saveAlias()}
                type="button"
                disabled={busy || aliasForm.alias.trim() === ''}
              >
                {t('models.createAlias')}
              </button>
            </>
          }
        >
          <Field label={t('models.alias')} hint={t('models.aliasFieldHint')}>
            <input
              value={aliasForm.alias}
              onChange={(event) => setAliasForm({ ...aliasForm, alias: event.target.value })}
              placeholder="gpt-4o"
              className="mono"
              autoFocus
            />
          </Field>
          <Field label={t('models.targetModel')}>
            <select
              value={aliasForm.targetModelId}
              onChange={(event) => setAliasForm({ ...aliasForm, targetModelId: event.target.value })}
            >
              {(models.data ?? []).map((model) => (
                <option key={model.id} value={model.id}>
                  {model.clientModelId} ({providerById.get(model.providerId)?.name ?? t('common.unknownProvider')})
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('common.note')}>
            <input
              value={aliasForm.note}
              onChange={(event) => setAliasForm({ ...aliasForm, note: event.target.value })}
              placeholder={t('common.optional')}
            />
          </Field>
        </Modal>
      )}

      {chainModelId && (
        <Modal
          title={t('models.editChain', {
            name: (models.data ?? []).find((model) => model.id === chainModelId)?.clientModelId ?? chainModelId,
          })}
          onClose={() => setChainModelId(null)}
          footer={
            <>
              <button onClick={() => setChainModelId(null)} type="button" disabled={busy}>
                {t('common.cancel')}
              </button>
              <button className="primary" onClick={() => void saveChain()} type="button" disabled={busy}>
                {t('models.saveChain')}
              </button>
            </>
          }
        >
          <div className="field-hint">{t('models.chainHint')}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {(models.data ?? [])
              .filter((model) => model.id !== chainModelId)
              .map((model) => {
                const index = chainSelection.indexOf(model.id);
                return (
                  <label className="checkbox" key={model.id} style={{ justifyContent: 'space-between' }}>
                    <span>
                      <input
                        type="checkbox"
                        checked={index >= 0}
                        onChange={(event) => {
                          if (event.target.checked) setChainSelection([...chainSelection, model.id]);
                          else setChainSelection(chainSelection.filter((id) => id !== model.id));
                        }}
                      />
                      <span className="mono">{model.clientModelId}</span>
                      <span style={{ color: 'var(--text-faint)' }}>
                        {' '}
                        · {providerById.get(model.providerId)?.name ?? t('common.unknownProvider')}
                      </span>
                    </span>
                    {index >= 0 && <Badge tone="accent">#{index + 1}</Badge>}
                  </label>
                );
              })}
          </div>
          {chainSelection.length === 0 && <div className="field-hint">{t('models.chainCleared')}</div>}
        </Modal>
      )}

      {testResult && (
        <Modal
          title={t('models.testTitle', { name: testResult.model.clientModelId })}
          onClose={() => setTestResult(null)}
          footer={
            <button onClick={() => setTestResult(null)} type="button">
              {t('common.close')}
            </button>
          }
        >
          <Alert
            tone={testResult.result.ok ? 'ok' : 'error'}
            title={testResult.result.ok ? t('models.testOk') : t('models.testFail')}
          >
            {testResult.result.detail}
            {testResult.result.latencyMs !== undefined ? ` · ${formatMs(testResult.result.latencyMs)}` : ''}
            {testResult.result.attempts !== undefined
              ? ` · ${t('common.attempts')}: ${testResult.result.attempts}`
              : ''}
          </Alert>
          {testResult.result.providerName && (
            <div className="field-hint">
              {testResult.result.apiKeyName
                ? t('models.routedToVia', {
                    provider: testResult.result.providerName,
                    name: testResult.result.apiKeyName,
                  })
                : t('models.routedTo', { provider: testResult.result.providerName })}
            </div>
          )}
          {testResult.result.output !== undefined && testResult.result.output !== '' && (
            <div>
              <div className="field-hint" style={{ marginBottom: 5 }}>
                {t('models.reply')}
              </div>
              <pre className="code">{testResult.result.output}</pre>
            </div>
          )}
          {testResult.result.usage && (
            <div>
              <div className="field-hint" style={{ marginBottom: 5 }}>
                {t('models.usageReported')}
              </div>
              <pre className="code">{JSON.stringify(testResult.result.usage, null, 2)}</pre>
            </div>
          )}
        </Modal>
      )}

      <Card title={t('models.compatibility')} subtitle={t('models.compatibilitySub')}>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('common.model')}</th>
                <th>{enumLabel(t, 'protocol', 'openai-chat')}</th>
                <th>{enumLabel(t, 'protocol', 'openai-responses')}</th>
                <th>{enumLabel(t, 'protocol', 'anthropic-messages')}</th>
              </tr>
            </thead>
            <tbody>
              {(models.data ?? []).map((model) => (
                <tr key={model.id}>
                  <td className="mono">{model.clientModelId}</td>
                  <td>
                    <Badge tone={modeTone(model.chatCompletionsMode)}>
                      {enumLabel(t, 'mode', model.chatCompletionsMode)}
                    </Badge>
                  </td>
                  <td>
                    <Badge tone={modeTone(model.responsesMode)}>{enumLabel(t, 'mode', model.responsesMode)}</Badge>
                  </td>
                  <td>
                    <Badge tone={modeTone(model.anthropicMessagesMode)}>
                      {enumLabel(t, 'mode', model.anthropicMessagesMode)}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
