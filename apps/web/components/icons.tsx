/**
 * Inline icons.
 *
 * Hand-rolled rather than an icon package: we need about fifteen, and shipping a
 * 200KB library so a receptionist can see a bed glyph is not a trade worth making
 * on a machine that lives behind a front desk.
 */
type P = { className?: string };

const base = 'h-[18px] w-[18px]';

export const Icon = {
  Dashboard: (p: P) => (
    <svg viewBox="0 0 24 24" fill="none" className={p.className ?? base} strokeWidth="1.7">
      <rect x="3" y="3" width="7" height="9" rx="2" stroke="currentColor" />
      <rect x="14" y="3" width="7" height="5" rx="2" stroke="currentColor" />
      <rect x="14" y="12" width="7" height="9" rx="2" stroke="currentColor" />
      <rect x="3" y="16" width="7" height="5" rx="2" stroke="currentColor" />
    </svg>
  ),
  Desk: (p: P) => (
    <svg viewBox="0 0 24 24" fill="none" className={p.className ?? base} strokeWidth="1.7">
      <path d="M3 11h18M5 11V7a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v4" stroke="currentColor" />
      <path d="M4 11v8M20 11v8M3 15h18" stroke="currentColor" strokeLinecap="round" />
    </svg>
  ),
  Plus: (p: P) => (
    <svg viewBox="0 0 24 24" fill="none" className={p.className ?? base} strokeWidth="1.8">
      <path d="M12 5v14M5 12h14" stroke="currentColor" strokeLinecap="round" />
    </svg>
  ),
  Calendar: (p: P) => (
    <svg viewBox="0 0 24 24" fill="none" className={p.className ?? base} strokeWidth="1.7">
      <rect x="3" y="5" width="18" height="16" rx="2" stroke="currentColor" />
      <path d="M3 10h18M8 3v4M16 3v4" stroke="currentColor" strokeLinecap="round" />
    </svg>
  ),
  Bed: (p: P) => (
    <svg viewBox="0 0 24 24" fill="none" className={p.className ?? base} strokeWidth="1.7">
      <path d="M3 18v-7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v7" stroke="currentColor" />
      <path d="M3 14h18M3 18h18M7 9V7a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2" stroke="currentColor" />
    </svg>
  ),
  Broom: (p: P) => (
    <svg viewBox="0 0 24 24" fill="none" className={p.className ?? base} strokeWidth="1.7">
      <path d="M14 4 9.5 8.5" stroke="currentColor" strokeLinecap="round" />
      <path d="M12.5 7 17 11.5" stroke="currentColor" strokeLinecap="round" />
      <path d="M6 20c-1.5-1.5-1.5-4 0-5.5L9.5 11l3.5 3.5-3.5 3.5C8 19.5 7.5 20 6 20Z" stroke="currentColor" strokeLinejoin="round" />
      <path d="M6 20h7" stroke="currentColor" strokeLinecap="round" />
    </svg>
  ),
  Moon: (p: P) => (
    <svg viewBox="0 0 24 24" fill="none" className={p.className ?? base} strokeWidth="1.7">
      <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" stroke="currentColor" />
    </svg>
  ),
  Chart: (p: P) => (
    <svg viewBox="0 0 24 24" fill="none" className={p.className ?? base} strokeWidth="1.7">
      <path d="M4 20V10M10 20V4M16 20v-6M22 20H2" stroke="currentColor" strokeLinecap="round" />
    </svg>
  ),
  Users: (p: P) => (
    <svg viewBox="0 0 24 24" fill="none" className={p.className ?? base} strokeWidth="1.7">
      <circle cx="9" cy="8" r="3.2" stroke="currentColor" />
      <path d="M3 20a6 6 0 0 1 12 0M16 5.5a3 3 0 0 1 0 5.6M18 20a5.5 5.5 0 0 0-3-4.9" stroke="currentColor" strokeLinecap="round" />
    </svg>
  ),
  Money: (p: P) => (
    <svg viewBox="0 0 24 24" fill="none" className={p.className ?? base} strokeWidth="1.7">
      <rect x="2.5" y="6" width="19" height="12" rx="2" stroke="currentColor" />
      <circle cx="12" cy="12" r="2.5" stroke="currentColor" />
      <path d="M6 10v4M18 10v4" stroke="currentColor" strokeLinecap="round" />
    </svg>
  ),
  Trend: (p: P) => (
    <svg viewBox="0 0 24 24" fill="none" className={p.className ?? base} strokeWidth="1.8">
      <path d="M3 17l6-6 4 4 8-8" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M15 7h6v6" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  TrendDown: (p: P) => (
    <svg viewBox="0 0 24 24" fill="none" className={p.className ?? base} strokeWidth="1.8">
      <path d="M3 7l6 6 4-4 8 8" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M15 17h6v-6" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  Search: (p: P) => (
    <svg viewBox="0 0 24 24" fill="none" className={p.className ?? base} strokeWidth="1.8">
      <circle cx="11" cy="11" r="6.5" stroke="currentColor" />
      <path d="m16 16 4 4" stroke="currentColor" strokeLinecap="round" />
    </svg>
  ),
  Bell: (p: P) => (
    <svg viewBox="0 0 24 24" fill="none" className={p.className ?? base} strokeWidth="1.7">
      <path d="M18 15V10a6 6 0 1 0-12 0v5l-1.5 2.5h15L18 15Z" stroke="currentColor" strokeLinejoin="round" />
      <path d="M10 20a2 2 0 0 0 4 0" stroke="currentColor" strokeLinecap="round" />
    </svg>
  ),
  Sun: (p: P) => (
    <svg viewBox="0 0 24 24" fill="none" className={p.className ?? base} strokeWidth="1.7">
      <circle cx="12" cy="12" r="4" stroke="currentColor" />
      <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" stroke="currentColor" strokeLinecap="round" />
    </svg>
  ),
  Menu: (p: P) => (
    <svg viewBox="0 0 24 24" fill="none" className={p.className ?? base} strokeWidth="1.8">
      <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeLinecap="round" />
    </svg>
  ),
  Close: (p: P) => (
    <svg viewBox="0 0 24 24" fill="none" className={p.className ?? base} strokeWidth="1.8">
      <path d="m6 6 12 12M18 6 6 18" stroke="currentColor" strokeLinecap="round" />
    </svg>
  ),
  Logout: (p: P) => (
    <svg viewBox="0 0 24 24" fill="none" className={p.className ?? base} strokeWidth="1.7">
      <path d="M9 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3" stroke="currentColor" strokeLinecap="round" />
      <path d="M16 8l4 4-4 4M20 12H9" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  Chevron: (p: P) => (
    <svg viewBox="0 0 24 24" fill="none" className={p.className ?? base} strokeWidth="1.8">
      <path d="m9 6 6 6-6 6" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  Home: (p: P) => (
    <svg viewBox="0 0 24 24" fill="none" className={p.className ?? base} strokeWidth="1.7">
      <path d="m3 10 9-7 9 7v9a2 2 0 0 1-2 2h-4v-6H9v6H5a2 2 0 0 1-2-2v-9Z" stroke="currentColor" strokeLinejoin="round" />
    </svg>
  ),
  Key: (p: P) => (
    <svg viewBox="0 0 24 24" fill="none" className={p.className ?? base} strokeWidth="1.7">
      <circle cx="8" cy="8" r="4.5" stroke="currentColor" />
      <path d="m11.5 11.5 8 8M17 17l2-2M15 15l2-2" stroke="currentColor" strokeLinecap="round" />
    </svg>
  ),
};
