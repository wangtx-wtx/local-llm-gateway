import type { ReactNode } from 'react';
import { useEffect } from 'react';
import { useI18n } from '../i18n';

/**
 * Small presentational primitives shared by every view.
 * Kept dependency-free and unstyled-by-library so the dashboard ships no CSS
 * framework and stays readable in either colour scheme.
 */

export function Card({
  title,
  subtitle,
  actions,
  children,
  flush = false,
  className = '',
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  flush?: boolean;
  className?: string;
}): JSX.Element {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <header className="card-head">
          <div>
            {title && <h2>{title}</h2>}
            {subtitle && <div className="card-head-sub">{subtitle}</div>}
          </div>
          {actions && <div className="btn-row">{actions}</div>}
        </header>
      )}
      <div className={`card-body${flush ? ' flush' : ''}`}>{children}</div>
    </section>
  );
}

export function Kpi({
  label,
  value,
  foot,
}: {
  label: string;
  value: ReactNode;
  foot?: ReactNode;
}): JSX.Element {
  return (
    <div className="kpi">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {foot !== undefined && <div className="kpi-foot">{foot}</div>}
    </div>
  );
}

export function Badge({
  tone = 'muted',
  children,
  title,
}: {
  tone?: 'ok' | 'warn' | 'error' | 'muted' | 'accent';
  children: ReactNode;
  title?: string;
}): JSX.Element {
  return (
    <span className={`badge ${tone}`} title={title}>
      {children}
    </span>
  );
}

export function Dot({ tone, pulse = false }: { tone: 'ok' | 'warn' | 'error' | 'muted'; pulse?: boolean }): JSX.Element {
  return <span className={`dot ${tone}${pulse ? ' pulse' : ''}`} />;
}

export function Alert({
  tone = 'info',
  title,
  children,
  onDismiss,
  dismissLabel,
}: {
  tone?: 'ok' | 'warn' | 'error' | 'info';
  title?: ReactNode;
  children?: ReactNode;
  onDismiss?: () => void;
  dismissLabel?: string;
}): JSX.Element {
  const { t } = useI18n();
  return (
    <div className={`alert ${tone}`}>
      <div className="alert-body">
        {title && <strong>{title}</strong>}
        {children}
      </div>
      {onDismiss && (
        <button className="ghost sm" onClick={onDismiss} aria-label={dismissLabel ?? t('common.dismiss')}>
          ✕
        </button>
      )}
    </div>
  );
}

export function Spinner(): JSX.Element {
  return <span className="spinner" />;
}

export function Loading({ label }: { label?: string } = {}): JSX.Element {
  const { t } = useI18n();
  return (
    <div className="loading-row">
      <Spinner /> {label ?? t('common.loading')}
    </div>
  );
}

export function Empty({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}): JSX.Element {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide = false,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}): JSX.Element {
  const { t } = useI18n();
  // Escape closes; the backdrop click is handled below.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="modal-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true">
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="ghost sm" onClick={onClose} aria-label={t('common.close')}>
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function StatRow({ label, children }: { label: ReactNode; children: ReactNode }): JSX.Element {
  return (
    <div className="stat-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: Array<{ id: T; label: string; count?: number }>;
  active: T;
  onChange: (id: T) => void;
}): JSX.Element {
  return (
    <div className="tabs">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          className={`tab${tab.id === active ? ' active' : ''}`}
          onClick={() => onChange(tab.id)}
          type="button"
        >
          {tab.label}
          {tab.count !== undefined ? ` (${tab.count})` : ''}
        </button>
      ))}
    </div>
  );
}

/** A tiny dependency-free sparkline/area chart for usage buckets. */
export function AreaChart({
  points,
  height = 190,
  color = 'var(--accent)',
  formatValue,
}: {
  points: Array<{ label: string; value: number }>;
  height?: number;
  color?: string;
  formatValue?: (value: number) => string;
}): JSX.Element {
  const { t } = useI18n();
  if (points.length === 0) {
    return (
      <div className="loading-row" style={{ padding: 30 }}>
        {t('common.noDataWindow')}
      </div>
    );
  }
  const width = 800;
  const padding = { top: 12, right: 10, bottom: 22, left: 10 };
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;
  const max = Math.max(...points.map((point) => point.value), 1);
  const step = points.length > 1 ? innerWidth / (points.length - 1) : 0;
  const y = (value: number): number => padding.top + innerHeight - (value / max) * innerHeight;

  const coordinates = points.map((point, index) => ({ x: padding.left + index * step, y: y(point.value) }));
  const line = coordinates.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
  const area = `${line} L${(padding.left + (points.length - 1) * step).toFixed(1)},${(padding.top + innerHeight).toFixed(1)} L${padding.left},${(padding.top + innerHeight).toFixed(1)} Z`;

  const labelStep = Math.max(1, Math.ceil(points.length / 7));

  return (
    <svg className="chart" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img">
      {/* horizontal gridlines */}
      {[0, 0.25, 0.5, 0.75, 1].map((fraction) => (
        <line
          key={fraction}
          x1={padding.left}
          x2={width - padding.right}
          y1={padding.top + innerHeight * fraction}
          y2={padding.top + innerHeight * fraction}
          stroke="var(--border)"
          strokeWidth="1"
          strokeDasharray={fraction === 1 ? undefined : '3 4'}
        />
      ))}
      <path d={area} fill={color} opacity="0.13" />
      <path d={line} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      {coordinates.map((point, index) => (
        <circle key={index} cx={point.x} cy={point.y} r="2.5" fill={color} />
      ))}
      <text x={padding.left} y={padding.top - 2} fontSize="10" fill="var(--text-faint)">
        {t('common.peak', { value: formatValue ? formatValue(max) : max.toLocaleString() })}
      </text>
      {points.map((point, index) =>
        index % labelStep === 0 ? (
          <text
            key={index}
            x={padding.left + index * step}
            y={height - 6}
            fontSize="10"
            fill="var(--text-faint)"
            textAnchor={index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle'}
          >
            {point.label}
          </text>
        ) : null,
      )}
    </svg>
  );
}

/** Horizontal bar list used for grouped usage tables. */
export function BarList({
  rows,
  formatValue,
}: {
  rows: Array<{ key: string; label: string; value: number; secondary?: string }>;
  formatValue?: (value: number) => string;
}): JSX.Element {
  const { t } = useI18n();
  const max = Math.max(...rows.map((row) => row.value), 1);
  if (rows.length === 0) return <div className="loading-row">{t('common.noData')}</div>;
  return (
    <div className="stat-list">
      {rows.map((row) => (
        <div key={row.key} style={{ padding: '7px 0', borderBottom: '1px dashed var(--border)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13 }}>
            <span className="mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {row.label}
            </span>
            <span style={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
              {formatValue ? formatValue(row.value) : row.value.toLocaleString()}
              {row.secondary ? <span style={{ color: 'var(--text-faint)', marginLeft: 8 }}>{row.secondary}</span> : null}
            </span>
          </div>
          <div className="bar" style={{ marginTop: 4 }}>
            <span style={{ width: `${Math.max(1, (row.value / max) * 100)}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function JsonBlock({ value, empty }: { value: unknown; empty?: string }): JSX.Element {
  const { t } = useI18n();
  const text =
    typeof value === 'string' ? value : value === null || value === undefined ? '' : JSON.stringify(value, null, 2);
  if (text === '') return <div className="loading-row">{empty ?? t('common.nothingRecorded')}</div>;
  return <pre className="code">{text}</pre>;
}
