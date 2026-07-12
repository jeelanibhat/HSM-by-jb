'use client';

import { cn } from '@/lib/cn';
import { Icon } from './icons';

/**
 * The primitives every screen is built from.
 *
 * Deliberately small. A design system that needs a storybook to explain it will not
 * survive contact with a team shipping features, and a receptionist does not care
 * how many variants a button has.
 */

// ── Card ────────────────────────────────────────────────────────────────────

export function Card({
  children,
  className,
  padded = true,
}: {
  children: React.ReactNode;
  className?: string | undefined;
  padded?: boolean;
}) {
  return (
    <div
      className={cn(
        'rounded-card border border-line bg-card shadow-card',
        padded && 'p-5',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  hint,
  action,
  className,
}: {
  title: string;
  /** `| undefined` explicitly: exactOptionalPropertyTypes is on, and callers pass
   *  values that may be undefined (a business date still loading, say). */
  hint?: string | undefined;
  action?: React.ReactNode | undefined;
  className?: string | undefined;
}) {
  return (
    <div className={cn('mb-4 flex items-start justify-between gap-3', className)}>
      <div>
        <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
        {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
      </div>
      {action}
    </div>
  );
}

// ── Stat card ───────────────────────────────────────────────────────────────

type Tone = 'brand' | 'success' | 'warning' | 'danger' | 'info';

const TONE: Record<Tone, { ring: string; text: string }> = {
  brand: { ring: 'bg-brand-50 text-brand', text: 'text-brand' },
  success: { ring: 'bg-success-soft text-success', text: 'text-success' },
  warning: { ring: 'bg-warning-soft text-warning', text: 'text-warning' },
  danger: { ring: 'bg-danger-soft text-danger', text: 'text-danger' },
  info: { ring: 'bg-info-soft text-info', text: 'text-info' },
};

export function StatCard({
  icon,
  label,
  value,
  hint,
  trend,
  tone = 'brand',
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint?: string | undefined;
  /** Signed percentage. Positive is not always good — the caller decides the tone. */
  trend?: { value: string; up: boolean; good?: boolean };
  tone?: Tone;
}) {
  const good = trend ? (trend.good ?? trend.up) : true;

  return (
    <Card className="flex items-center gap-4">
      <div
        className={cn(
          'grid h-14 w-14 shrink-0 place-items-center rounded-full',
          TONE[tone].ring,
        )}
      >
        {icon}
      </div>

      <div className="min-w-0 flex-1">
        <p className="truncate text-xl font-semibold tracking-tight tabular-nums">{value}</p>
        <p className="mt-0.5 truncate text-[13px] text-muted">{label}</p>
        {hint && <p className="mt-0.5 truncate text-[11px] text-muted/70">{hint}</p>}
      </div>

      {trend && (
        <div
          className={cn(
            'flex shrink-0 items-center gap-0.5 text-xs font-medium',
            good ? 'text-success' : 'text-danger',
          )}
        >
          {trend.up ? (
            <Icon.Trend className="h-3.5 w-3.5" />
          ) : (
            <Icon.TrendDown className="h-3.5 w-3.5" />
          )}
          {trend.value}
        </div>
      )}
    </Card>
  );
}

// ── Badge ───────────────────────────────────────────────────────────────────

export function Badge({
  children,
  tone = 'brand',
  className,
}: {
  children: React.ReactNode;
  tone?: Tone | 'neutral';
  className?: string | undefined;
}) {
  const tones: Record<string, string> = {
    brand: 'bg-brand-50 text-brand',
    success: 'bg-success-soft text-success',
    warning: 'bg-warning-soft text-warning',
    danger: 'bg-danger-soft text-danger',
    info: 'bg-info-soft text-info',
    neutral: 'bg-line text-muted',
  };

  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-medium',
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

// ── Button ──────────────────────────────────────────────────────────────────

export function Button({
  children,
  variant = 'primary',
  size = 'md',
  className,
  ...props
}: {
  variant?: 'primary' | 'ghost' | 'outline' | 'success' | 'danger';
  size?: 'sm' | 'md';
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const variants = {
    primary: 'bg-brand text-white hover:bg-brand-600',
    success: 'bg-success text-white hover:brightness-95',
    danger: 'bg-danger text-white hover:brightness-95',
    outline: 'border border-line bg-transparent hover:bg-canvas',
    ghost: 'bg-transparent text-muted hover:bg-canvas hover:text-ink',
  };

  return (
    <button
      {...props}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-45',
        size === 'sm' ? 'px-2.5 py-1.5 text-xs' : 'px-4 py-2 text-sm',
        variants[variant],
        className,
      )}
    >
      {children}
    </button>
  );
}

// ── Form ────────────────────────────────────────────────────────────────────

export function Input({
  className,
  invalid,
  ...props
}: { invalid?: boolean | undefined } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={cn(
        'w-full rounded-lg border bg-transparent px-3 py-2 text-sm outline-none transition-colors',
        'placeholder:text-muted/60 focus:border-brand',
        invalid ? 'border-danger' : 'border-line',
        className,
      )}
    />
  );
}

export function Select({
  className,
  children,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={cn(
        'w-full rounded-lg border border-line bg-transparent px-3 py-2 text-sm outline-none focus:border-brand',
        className,
      )}
    >
      {children}
    </select>
  );
}

export function Label({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span
      className={cn('mb-1.5 block text-[11px] font-medium uppercase tracking-wide text-muted', className)}
    >
      {children}
    </span>
  );
}

export function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string | undefined;
}) {
  return (
    <label className={cn('block', className)}>
      <Label>{label}</Label>
      {children}
    </label>
  );
}

// ── Table ───────────────────────────────────────────────────────────────────

export function Table({ children, className }: { children: React.ReactNode; className?: string }) {
  // Wide tables scroll inside their own card; the page body never scrolls sideways.
  return (
    <div className="-mx-5 overflow-x-auto px-5">
      <table className={cn('w-full min-w-[560px] text-sm', className)}>{children}</table>
    </div>
  );
}

export function Th({
  children,
  className,
  align = 'left',
}: {
  children?: React.ReactNode;
  className?: string | undefined;
  align?: 'left' | 'right' | 'center';
}) {
  return (
    <th
      className={cn(
        'border-b border-line pb-2.5 text-[11px] font-medium uppercase tracking-wide text-muted',
        align === 'right' && 'text-right',
        align === 'center' && 'text-center',
        align === 'left' && 'text-left',
        className,
      )}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  className,
  align = 'left',
}: {
  children?: React.ReactNode;
  className?: string | undefined;
  align?: 'left' | 'right' | 'center';
}) {
  return (
    <td
      className={cn(
        'border-b border-line/60 py-3',
        align === 'right' && 'text-right',
        align === 'center' && 'text-center',
        className,
      )}
    >
      {children}
    </td>
  );
}

// ── Feedback ────────────────────────────────────────────────────────────────

export function Alert({
  tone = 'danger',
  children,
  onDismiss,
}: {
  tone?: Tone;
  children: React.ReactNode;
  onDismiss?: (() => void) | undefined;
}) {
  return (
    <div
      role="alert"
      className={cn(
        'flex items-start gap-3 rounded-lg px-4 py-3 text-sm',
        TONE[tone].ring,
      )}
    >
      <div className="flex-1">{children}</div>
      {onDismiss && (
        <button onClick={onDismiss} className="shrink-0 opacity-60 hover:opacity-100">
          <Icon.Close className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

export function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-line px-4 py-10 text-center text-sm text-muted">
      {children}
    </div>
  );
}

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 py-6 text-sm text-muted">
      <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-line border-t-brand" />
      {label}
    </div>
  );
}

// ── Page header ─────────────────────────────────────────────────────────────

export function PageHeader({
  title,
  crumb,
  action,
}: {
  title: string;
  crumb?: string | undefined;
  action?: React.ReactNode | undefined;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
      <h1 className="text-lg font-semibold tracking-tight">{title}</h1>

      <div className="flex items-center gap-3">
        {action}
        <nav className="hidden items-center gap-1.5 text-xs text-muted sm:flex">
          <Icon.Home className="h-3.5 w-3.5" />
          <span>/</span>
          <span>{crumb ?? 'HotelOS'}</span>
          <span>/</span>
          <span className="text-brand">{title}</span>
        </nav>
      </div>
    </div>
  );
}
