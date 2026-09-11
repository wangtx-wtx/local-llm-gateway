import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { Alert, Badge, Card, Loading, StatRow } from '../components/ui';
import { usePoll } from '../lib/hooks';
import { useI18n, type TranslationKey } from '../i18n';
import { GatewayAuthCard } from './GatewayAuth';
import type { Settings } from '../api/types';
import type { ViewProps } from './shared';

/**
 * Gateway settings.
 *
 * These are runtime settings stored in the database and applied on the next
 * request (the registry snapshot is rebuilt on save). They are separate from
 * the process-level environment variables, which require a restart.
 */

interface SettingDescriptor {
  label: TranslationKey;
  hint: TranslationKey;
  kind: 'bool' | 'number' | 'enum';
}

/**
 * Descriptors hold dictionary KEYS, not translated text: the language is not
 * known at module scope, so translation happens at render time.
 */
const DESCRIPTIONS: Record<string, SettingDescriptor> = {
  storeRequestContent: {
    label: 'set.label.storeRequestContent',
    hint: 'set.hint.storeRequestContent',
    kind: 'bool',
  },
  apiKeySelectionPolicy: {
    label: 'set.label.apiKeySelectionPolicy',
    hint: 'set.hint.apiKeySelectionPolicy',
    kind: 'enum',
  },
  maxAttemptsPerRequest: {
    label: 'set.label.maxAttemptsPerRequest',
    hint: 'set.hint.maxAttemptsPerRequest',
    kind: 'number',
  },
  maxKeysPerModel: { label: 'set.label.maxKeysPerModel', hint: 'set.hint.maxKeysPerModel', kind: 'number' },
  enableFallback: { label: 'set.label.enableFallback', hint: 'set.hint.enableFallback', kind: 'bool' },
  fallbackOnRateLimit: {
    label: 'set.label.fallbackOnRateLimit',
    hint: 'set.hint.fallbackOnRateLimit',
    kind: 'bool',
  },
  keyFailureThreshold: {
    label: 'set.label.keyFailureThreshold',
    hint: 'set.hint.keyFailureThreshold',
    kind: 'number',
  },
  keyCooldownMs: { label: 'set.label.keyCooldownMs', hint: 'set.hint.keyCooldownMs', kind: 'number' },
  providerFailureThreshold: {
    label: 'set.label.providerFailureThreshold',
    hint: 'set.hint.providerFailureThreshold',
    kind: 'number',
  },
  providerCooldownMs: {
    label: 'set.label.providerCooldownMs',
    hint: 'set.hint.providerCooldownMs',
    kind: 'number',
  },
  retryBaseDelayMs: { label: 'set.label.retryBaseDelayMs', hint: 'set.hint.retryBaseDelayMs', kind: 'number' },
  dashboardRefreshMs: {
    label: 'set.label.dashboardRefreshMs',
    hint: 'set.hint.dashboardRefreshMs',
    kind: 'number',
  },
};

/** Environment variables are documented here; the names themselves stay literal. */
const ENV_ROWS: Array<{ name: string; description: TranslationKey }> = [
  { name: 'LOCAL_GATEWAY_HOST / PORT', description: 'set.envHost' },
  { name: 'LOCAL_GATEWAY_API_KEY', description: 'set.envApiKey' },
  { name: 'LOCAL_GATEWAY_ADMIN_PASSWORD', description: 'set.envAdmin' },
  { name: 'LOCAL_GATEWAY_MASTER_KEY', description: 'set.envMaster' },
  { name: 'LOCAL_GATEWAY_DB_PATH', description: 'set.envDb' },
  { name: 'LOCAL_GATEWAY_PERSIST_LOGS', description: 'set.envLogs' },
];

export function SettingsView({ refreshMs, pushToast, navigate }: ViewProps): JSX.Element {
  const { t } = useI18n();
  const settings = usePoll(() => api.getSettings(), refreshMs);
  const meta = usePoll(() => api.meta(), null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (settings.data && draft === null) setDraft(settings.data.settings);
  }, [settings.data, draft]);

  if (settings.loading && !settings.data) return <Loading />;
  if (!settings.data || !draft) {
    return (
      <Alert tone="error" title={t('set.cannotLoad')}>
        {settings.error?.message}
      </Alert>
    );
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(settings.data.settings);

  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const updated = await api.updateSettings(draft as unknown as Record<string, unknown>);
      setDraft(updated);
      pushToast('ok', t('set.saved'), t('set.savedFoot'));
      settings.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const resetField = (key: string): void => {
    const defaults = settings.data?.defaults as Record<string, unknown> | undefined;
    if (!defaults) return;
    setDraft({ ...draft, [key]: defaults[key] } as Settings);
  };

  const changedKeys = Object.keys(draft).filter(
    (key) => (draft as Record<string, unknown>)[key] !== (settings.data?.settings as Record<string, unknown>)[key],
  );

  return (
    <>
      {error && (
        <Alert tone="error" title={t('set.saveFailed')}>
          {error}
        </Alert>
      )}

      {settings.data?.gatewayAuth && (
        <GatewayAuthCard auth={settings.data.gatewayAuth} onChanged={() => settings.refresh()} />
      )}

      <Card
        title={t('set.title')}
        subtitle={t('set.subtitle')}
        actions={
          <>
            <button
              className="sm"
              type="button"
              disabled={!dirty || busy}
              onClick={() => setDraft(settings.data?.settings ?? null)}
            >
              {t('set.discard')}
            </button>
            <button className="primary sm" type="button" disabled={!dirty || busy} onClick={() => void save()}>
              {busy ? t('common.saving') : t('set.save')}
            </button>
          </>
        }
      >
        {dirty && (
          <Alert tone="warn" title={t('set.unsaved')}>
            {changedKeys.map((key) => (DESCRIPTIONS[key] ? t(DESCRIPTIONS[key].label) : key)).join(', ')}
          </Alert>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: dirty ? 14 : 0 }}>
          {Object.entries(DESCRIPTIONS).map(([key, description]) => {
            const value = (draft as Record<string, unknown>)[key];
            const original = (settings.data?.settings as Record<string, unknown>)[key];
            const changed = value !== original;
            const defaults = (settings.data?.defaults as Record<string, unknown>)[key];

            return (
              <div
                key={key}
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'minmax(220px, 1fr) minmax(180px, 260px)',
                  gap: 16,
                  alignItems: 'start',
                  paddingBottom: 14,
                  borderBottom: '1px dashed var(--border)',
                }}
              >
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>
                    {t(description.label)}
                    {changed && <Badge tone="warn">{t('set.modified')}</Badge>}
                  </div>
                  <div className="field-hint" style={{ marginTop: 2 }}>
                    {t(description.hint)}
                  </div>
                  <div className="field-hint mono" style={{ fontSize: 11, marginTop: 3 }}>
                    {key} · {t('set.default', { value: JSON.stringify(defaults) })}
                  </div>
                </div>
                <div>
                  {description.kind === 'bool' ? (
                    <label className="checkbox">
                      <input
                        type="checkbox"
                        checked={value === true}
                        onChange={(event) => setDraft({ ...draft, [key]: event.target.checked } as Settings)}
                      />
                      {value === true ? t('common.enabled') : t('common.disabled')}
                    </label>
                  ) : description.kind === 'enum' ? (
                    <select
                      value={String(value)}
                      onChange={(event) => setDraft({ ...draft, [key]: event.target.value } as Settings)}
                    >
                      {(meta.data?.selectionPolicies ?? []).map((policy) => (
                        <option key={policy} value={policy}>
                          {policy}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      value={String(value)}
                      onChange={(event) => {
                        const parsed = Number.parseInt(event.target.value.replace(/[^0-9]/g, ''), 10);
                        setDraft({ ...draft, [key]: Number.isFinite(parsed) ? parsed : 0 } as Settings);
                      }}
                    />
                  )}
                  {changed && (
                    <button className="ghost sm" type="button" style={{ marginTop: 4 }} onClick={() => resetField(key)}>
                      {t('set.resetDefault')}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      <Card title={t('set.envTitle')} subtitle={t('set.envSubtitle')}>
        <dl className="stat-list">
          {ENV_ROWS.map((row) => (
            <StatRow label={<span className="mono">{row.name}</span>} key={row.name}>
              {t(row.description)}
            </StatRow>
          ))}
        </dl>
        <Alert tone="info" title={t('set.whereToLook')}>
          {t('set.whereToLookHint')}{' '}
          <a
            href="#/system"
            onClick={(event) => {
              event.preventDefault();
              navigate('system');
            }}
          >
            {t('set.openSystem')}
          </a>
        </Alert>
      </Card>

      <Card title={t('set.portability')} subtitle={t('set.portabilitySub')}>
        <div className="field-hint">{t('set.portabilityHint')}</div>
        <div className="btn-row" style={{ marginTop: 12 }}>
          <button
            className="sm"
            type="button"
            onClick={() => {
              navigate('system');
            }}
          >
            {t('set.goToConfig')}
          </button>
        </div>
      </Card>
    </>
  );
}
