import React from 'react';

type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

export function cx(
  ...classes: Array<string | false | null | undefined>
): string {
  return classes.filter(Boolean).join(' ');
}

export function Panel({
  children,
  className,
  ...props
}: React.ComponentProps<'section'>) {
  return (
    <section {...props} className={cx('panel ui-panel', className)}>
      {children}
    </section>
  );
}

export function SectionHeader({
  actions,
  copy,
  eyebrow,
  title,
  titleId,
}: {
  actions?: React.ReactNode;
  copy?: React.ReactNode;
  eyebrow: string;
  title: React.ReactNode;
  titleId: string;
}) {
  return (
    <div className="panel-header ui-section-header">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h2 className="panel-title" id={titleId}>
          {title}
        </h2>
        {copy === undefined ? null : typeof copy === 'string' ? (
          <p className="panel-copy">{copy}</p>
        ) : (
          copy
        )}
      </div>
      {actions === undefined ? null : <div className="header-pills">{actions}</div>}
    </div>
  );
}

export function Pill({
  children,
  className,
  tone = 'neutral',
  ...props
}: React.ComponentProps<'span'> & { tone?: Tone }) {
  return (
    <span {...props} className={cx('small-pill ui-pill', `tone-${tone}`, className)}>
      {children}
    </span>
  );
}

export function MetricTile({
  caption,
  id,
  label,
  value,
}: {
  caption?: React.ReactNode;
  id: string;
  label: React.ReactNode;
  value: React.ReactNode;
}) {
  return (
    <div className="metric-card ui-metric-card" data-testid={`metric-${id}`}>
      <span className="label">{label}</span>
      <span className="metric-value">{value}</span>
      {caption === undefined ? null : <p className="metric-caption">{caption}</p>}
    </div>
  );
}
