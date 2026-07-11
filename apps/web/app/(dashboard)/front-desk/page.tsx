'use client';

import { useQuery } from '@apollo/client';
import { useAuth } from '@/lib/auth-context';
import { CURRENT_PROPERTY, type Property } from '@/lib/graphql/operations';

/**
 * Front desk. Today it proves the auth + tenancy stack end-to-end in a browser:
 * everything below is fetched under the active property's context and is
 * RLS-scoped server-side.
 *
 * The tape chart lands here at build step 6.
 */
export default function FrontDeskPage() {
  const { role } = useAuth();
  const { data, loading, error } = useQuery<{ currentProperty: Property | null }>(
    CURRENT_PROPERTY,
  );

  if (loading) return <p className="text-sm opacity-60">Loading property…</p>;

  if (error) {
    return (
      <div className="rounded-md bg-status-ooo/10 px-4 py-3 text-sm text-status-ooo">
        {error.message}
      </div>
    );
  }

  const property = data?.currentProperty;
  if (!property) return <p className="text-sm opacity-60">No property selected.</p>;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{property.name}</h1>
        <p className="mt-1 text-sm opacity-60">Front desk</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Business date"
          value={property.businessDate}
          hint="Advances only at night audit — not today's date"
        />
        <Stat label="Currency" value={property.currency} />
        <Stat label="Timezone" value={property.timezone} />
        <Stat label="Your role" value={role?.replace('_', ' ') ?? '—'} hint="At this property" />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Stat label="Check-in" value={property.checkInTime ?? '—'} />
        <Stat label="Check-out" value={property.checkOutTime ?? '—'} />
      </div>

      <div className="rounded-md border border-dashed border-black/15 px-4 py-8 text-center dark:border-white/15">
        <p className="text-sm opacity-60">Tape chart lands at build step 6.</p>
        <p className="mt-1 text-xs opacity-40">
          Needs inventory (step 4) and reservations (step 5) first.
        </p>
      </div>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md border border-black/10 px-4 py-3 dark:border-white/10">
      <p className="text-xs uppercase tracking-wide opacity-50">{label}</p>
      <p className="mt-1 text-lg font-medium tabular-nums">{value}</p>
      {hint && <p className="mt-1 text-xs opacity-45">{hint}</p>}
    </div>
  );
}
