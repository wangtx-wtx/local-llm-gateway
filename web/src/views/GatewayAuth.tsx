import { useState } from 'react';
import { api, ApiError } from '../api/client';
import type { GatewayAuthState } from '../api/types';
import { Alert, Badge, Card, Field } from '../components/ui';
import { useI18n } from '../i18n';
import type { ViewProps } from './shared';

/**
 * Gateway access-key card.
 *
 * The key gates every /v1 request, so this card has to answer four questions at
 * a glance: is authentication on, where does the value come from, what is it,
 * and how do clients send it.
 *
 * Two rules are enforced by the API and surfaced here:
 *  - an environment-provided key wins and makes this card read-only;
 *  - the key cannot be removed while the gateway listens beyond loopback.
 */
export function GatewayAuthCard({ auth, onChanged }: { auth: GatewayAuthState; onChanged: () => void }): JSX.Element {
  const { t } = useI18n();
  const [draft, setDraft] = useState('');
  const [revealed, setRevealed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const tooShort = draft.trim().length > 0 && draft.trim().length < 8;

  const apply = async (key: string | null): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await api.setGatewayApiKey(key);
      setDraft('');
      setRevealed(null);
      onChanged();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const reveal = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const response = await api.revealGatewayApiKey();
      setRevealed(response.key);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const generate = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setDraft(await api.generateGatewayApiKey());
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const copy = async (value: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      /* clipboard may be unavailable; the value is visible for manual copy */
    }
  };

  return (
    <Card
      title={t('authKey.title')}
      subtitle={t('authKey.subtitle')}
      actions={
        <>
          <Badge tone={auth.required ? 'ok' : 'warn'}>
            {auth.required ? t('authKey.statusRequired') : t('authKey.statusOpen')}
          </Badge>
          <Badge tone="muted">
            {auth.source === 'env'
              ? t('authKey.sourceEnv')
              : auth.source === 'settings'
                ? t('authKey.sourceSettings')
                : t('authKey.sourceNone')}
          </Badge>
        </>
      }
    >
      {error && (
        <Alert tone="error" title={t('authKey.updateFailed')}>
          {error}
        </Alert>
      )}

      {!auth.required && (
        <Alert tone="warn" title={t('authKey.statusOpen')}>
          {t('authKey.openWarning')}
        </Alert>
      )}

      {auth.source === 'env' && (
        <Alert tone="info" title={t('authKey.sourceEnv')}>
          {t('authKey.envLocked')}
        </Alert>
      )}

      {auth.required && (
        <div style={{ marginTop: 12 }}>
          <div className="field-hint" style={{ marginBottom: 5 }}>
            {t('authKey.currentKey')}
            {auth.preview ? <span className="mono"> · {auth.preview}</span> : null}
          </div>
          <div className="btn-row" style={{ alignItems: 'center' }}>
            <code style={{ flex: 1, padding: '6px 9px', background: 'var(--bg-sunken)', borderRadius: 6 }}>
              {revealed ?? '•'.repeat(40)}
            </code>
            {revealed === null ? (
              <button className="sm" type="button" onClick={() => void reveal()} disabled={busy}>
                {t('authKey.reveal')}
              </button>
            ) : (
              <>
                <button className="sm" type="button" onClick={() => void copy(revealed)}>
                  {copied ? t('authKey.copied') : t('authKey.copy')}
                </button>
                <button className="sm" type="button" onClick={() => setRevealed(null)}>
                  {t('authKey.hide')}
                </button>
              </>
            )}
          </div>
          <div className="field-hint" style={{ marginTop: 5 }}>
            {t('authKey.revealHint')}
          </div>
        </div>
      )}

      {auth.editable && (
        <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Field
            label={auth.required ? t('authKey.newKey') : t('authKey.newKey')}
            hint={tooShort ? t('authKey.tooShort') : t('authKey.generateHint')}
          >
            <div className="btn-row">
              <input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="••••••••"
                className="mono"
                autoComplete="off"
                style={{ flex: 1 }}
              />
              <button className="sm" type="button" onClick={() => void generate()} disabled={busy}>
                {t('authKey.generate')}
              </button>
            </div>
          </Field>

          <Alert tone="info">{t('authKey.willApply')}</Alert>

          <div className="btn-row">
            <button
              className="primary sm"
              type="button"
              disabled={busy || draft.trim().length < 8}
              onClick={() => void apply(draft.trim())}
            >
              {busy ? t('common.saving') : t('authKey.set')}
            </button>
            {auth.required && (
              <button
                className="danger sm"
                type="button"
                disabled={busy || !auth.canDisable}
                title={auth.canDisable ? undefined : t('authKey.cannotDisable', { host: auth.host })}
                onClick={() => {
                  if (window.confirm(t('authKey.clearConfirm'))) void apply(null);
                }}
              >
                {t('authKey.clear')}
              </button>
            )}
          </div>

          {!auth.canDisable && auth.required && (
            <div className="field-hint">{t('authKey.cannotDisable', { host: auth.host })}</div>
          )}
        </div>
      )}

      <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px dashed var(--border)' }}>
        <div className="field-hint" style={{ marginBottom: 7 }}>
          {t('authKey.howClientsUse')}
        </div>
        <dl className="stat-list">
          <div className="stat-row">
            <dt>{t('authKey.bearerLine')}</dt>
            <dd className="mono">Authorization: Bearer &lt;key&gt;</dd>
          </div>
          <div className="stat-row">
            <dt>{t('authKey.apiKeyLine')}</dt>
            <dd className="mono">x-api-key: &lt;key&gt;</dd>
          </div>
          <div className="stat-row">
            <dt>{t('authKey.baseUrlOpenAi')}</dt>
            <dd className="mono">http://127.0.0.1:8317/v1</dd>
          </div>
          <div className="stat-row">
            <dt>{t('authKey.baseUrlAnthropic')}</dt>
            <dd className="mono">http://127.0.0.1:8317</dd>
          </div>
        </dl>
      </div>
    </Card>
  );
}

export type { ViewProps };
