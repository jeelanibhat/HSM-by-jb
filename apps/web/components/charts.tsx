'use client';

import { cn } from '@/lib/cn';

/**
 * Hand-rolled SVG charts.
 *
 * A charting library is 100–300KB for what amounts to two shapes. These render on a
 * front-desk terminal that may be a decade old, so the trade is not close.
 *
 * Both are honest by construction: bars are scaled to the true maximum (never a
 * truncated axis that exaggerates a trend), and a series of zeroes renders as a flat
 * line rather than dividing by zero and drawing noise.
 */

export function Sparkline({
  points,
  className,
  stroke = 'var(--color-brand)',
}: {
  points: number[];
  className?: string;
  stroke?: string;
}) {
  if (points.length < 2) {
    return <div className={cn('h-16', className)} />;
  }

  const max = Math.max(...points, 1);
  const min = Math.min(...points, 0);
  const range = max - min || 1;

  const w = 100;
  const h = 32;

  const coords = points.map((p, i) => {
    const x = (i / (points.length - 1)) * w;
    const y = h - ((p - min) / range) * h;
    return [x, y] as const;
  });

  const line = coords.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
  const area = `${line} L${w},${h} L0,${h} Z`;

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      className={cn('h-16 w-full', className)}
    >
      <defs>
        <linearGradient id="spark" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.18" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#spark)" />
      <path
        d={line}
        fill="none"
        stroke={stroke}
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

export function BarChart({
  data,
  className,
  format,
}: {
  data: Array<{ label: string; value: number }>;
  className?: string;
  format?: (v: number) => string;
}) {
  // Scaled to the true maximum. A truncated axis makes a 2% move look like a crisis.
  const max = Math.max(...data.map((d) => d.value), 1);

  return (
    <div className={cn('flex items-end gap-1.5', className)}>
      {data.map((d) => (
        <div key={d.label} className="group flex flex-1 flex-col items-center gap-1.5">
          <div className="relative flex h-32 w-full items-end justify-center">
            <div
              style={{ height: `${Math.max((d.value / max) * 100, 2)}%` }}
              className="w-full max-w-[28px] rounded-t-md bg-brand/85 transition-colors group-hover:bg-brand"
            />
            <span className="pointer-events-none absolute -top-6 rounded bg-ink px-1.5 py-0.5 text-[10px] font-medium text-card opacity-0 transition-opacity group-hover:opacity-100">
              {format ? format(d.value) : d.value}
            </span>
          </div>
          <span className="text-[10px] text-muted">{d.label}</span>
        </div>
      ))}
    </div>
  );
}

/** Occupancy as an arc. Reads faster than a number when you glance at it. */
export function Gauge({ bps, label }: { bps: number; label: string }) {
  const pct = Math.min(Math.max(bps / 100, 0), 100);

  const r = 60;
  const circumference = Math.PI * r; // half circle
  const filled = (pct / 100) * circumference;

  return (
    <div className="flex flex-col items-center">
      <svg viewBox="0 0 140 78" className="w-full max-w-[220px]">
        <path
          d="M10 70 A60 60 0 0 1 130 70"
          fill="none"
          stroke="var(--color-line)"
          strokeWidth="12"
          strokeLinecap="round"
        />
        <path
          d="M10 70 A60 60 0 0 1 130 70"
          fill="none"
          stroke="var(--color-brand)"
          strokeWidth="12"
          strokeLinecap="round"
          strokeDasharray={`${filled} ${circumference}`}
        />
        <text
          x="70"
          y="62"
          textAnchor="middle"
          className="fill-ink text-[20px] font-semibold"
          style={{ fontVariantNumeric: 'tabular-nums' }}
        >
          {pct.toFixed(1)}%
        </text>
      </svg>
      <p className="mt-1 text-xs text-muted">{label}</p>
    </div>
  );
}
