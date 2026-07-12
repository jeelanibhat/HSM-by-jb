'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { loginSchema, type LoginInput } from '@hotelos/domain';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Icon } from '@/components/icons';
import { Alert, Button, Input, Label } from '@/components/ui';
import { useAuth } from '@/lib/auth-context';

const SEEDED = [
  { email: 'admin@hotelos.dev', role: 'Admin', note: 'both properties' },
  { email: 'manager@hotelos.dev', role: 'Manager', note: 'Hotel Alpha' },
  { email: 'frontdesk@hotelos.dev', role: 'Front desk', note: 'Hotel Alpha' },
  { email: 'housekeeping@hotelos.dev', role: 'Housekeeping', note: 'Hotel Alpha' },
  { email: 'auditor@hotelos.dev', role: 'Auditor', note: 'read-only' },
];

export default function LoginPage() {
  const { login, user, loading } = useAuth();
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<LoginInput>({
    // The SAME zod schema the API validates with (TDD §7.1). One definition, so the
    // client cannot accept something the server will reject.
    resolver: zodResolver(loginSchema),
  });

  useEffect(() => {
    if (!loading && user) router.replace('/dashboard');
  }, [user, loading, router]);

  const onSubmit = handleSubmit(async (values) => {
    setServerError(null);
    try {
      await login(values.email, values.password);
      router.replace('/dashboard');
    } catch (err) {
      // The server deliberately does not distinguish "no such user" from "wrong
      // password" — surfacing its message verbatim keeps it that way.
      setServerError(err instanceof Error ? err.message : 'Sign in failed');
    }
  });

  return (
    <main className="grid min-h-screen lg:grid-cols-2">
      {/* Brand panel — hidden on small screens, where it would just push the form down. */}
      <div className="relative hidden overflow-hidden bg-rail p-12 lg:flex lg:flex-col lg:justify-between">
        <div className="flex items-center gap-2.5">
          <div className="grid h-9 w-9 place-items-center rounded-lg bg-brand">
            <Icon.Key className="h-4.5 w-4.5 text-white" />
          </div>
          <span className="text-lg font-semibold tracking-tight text-white">HotelOS</span>
        </div>

        <div className="relative z-10 max-w-md">
          <h2 className="text-3xl font-semibold leading-tight tracking-tight text-white">
            Every room, every rate, every rupee.
          </h2>
          <p className="mt-4 text-[15px] leading-relaxed text-rail-text">
            Reservations, front desk, cashiering and night audit — with a ledger that cannot be
            quietly rewritten and a room that cannot be sold twice.
          </p>
        </div>

        <div className="absolute -bottom-24 -right-24 h-80 w-80 rounded-full bg-brand/20 blur-3xl" />
        <div className="absolute -left-10 top-1/3 h-48 w-48 rounded-full bg-brand/10 blur-2xl" />
      </div>

      {/* Form */}
      <div className="flex items-center justify-center p-6 sm:p-10">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-2.5 lg:hidden">
            <div className="grid h-9 w-9 place-items-center rounded-lg bg-brand">
              <Icon.Key className="h-4.5 w-4.5 text-white" />
            </div>
            <span className="text-lg font-semibold tracking-tight">HotelOS</span>
          </div>

          <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
          <p className="mt-1 text-sm text-muted">Welcome back. Pick up where the shift left off.</p>

          <form onSubmit={onSubmit} noValidate className="mt-7 space-y-4">
            <div>
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="username"
                autoFocus
                placeholder="you@hotel.com"
                invalid={Boolean(errors.email)}
                {...register('email')}
              />
              {errors.email && <p className="mt-1 text-xs text-danger">{errors.email.message}</p>}
            </div>

            <div>
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                placeholder="••••••••"
                invalid={Boolean(errors.password)}
                {...register('password')}
              />
              {errors.password && (
                <p className="mt-1 text-xs text-danger">{errors.password.message}</p>
              )}
            </div>

            {serverError && <Alert tone="danger">{serverError}</Alert>}

            <Button type="submit" disabled={isSubmitting} className="w-full">
              {isSubmitting ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>

          {/* Dev only. These accounts exist in dev and CI, never in production. */}
          {process.env.NODE_ENV !== 'production' && (
            <div className="mt-8 rounded-card border border-line p-4">
              <p className="mb-2.5 text-[11px] font-medium uppercase tracking-wide text-muted">
                Seeded users · password <span className="font-mono">Password123!</span>
              </p>
              <div className="space-y-1">
                {SEEDED.map((u) => (
                  <button
                    key={u.email}
                    type="button"
                    onClick={() => {
                      setValue('email', u.email);
                      setValue('password', 'Password123!');
                    }}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-canvas"
                  >
                    <span className="text-xs font-medium">{u.role}</span>
                    <span className="truncate font-mono text-[11px] text-muted">{u.email}</span>
                    <span className="ml-auto shrink-0 text-[10px] text-muted/70">{u.note}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
