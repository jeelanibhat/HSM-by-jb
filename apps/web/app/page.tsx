/**
 * Placeholder root. Replaced by the front-desk dashboard in build step 6
 * (tape chart) — the route groups from TDD §3.1 land as their modules do.
 */
export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-8">
      <h1 className="text-3xl font-semibold tracking-tight">HotelOS</h1>
      <p className="text-sm opacity-70">Property management system — Phase 1 scaffold</p>
      <div className="mt-4 flex gap-2 text-xs">
        <span className="rounded bg-status-vacant-clean/15 px-2 py-1 text-status-vacant-clean">
          Vacant clean
        </span>
        <span className="rounded bg-status-vacant-dirty/15 px-2 py-1 text-status-vacant-dirty">
          Vacant dirty
        </span>
        <span className="rounded bg-status-occupied/15 px-2 py-1 text-status-occupied">
          Occupied
        </span>
        <span className="rounded bg-status-ooo/15 px-2 py-1 text-status-ooo">Out of order</span>
      </div>
    </main>
  );
}
