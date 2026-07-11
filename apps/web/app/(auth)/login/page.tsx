'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { loginSchema, type LoginInput } from '@hotelos/domain';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useAuth } from '@/lib/auth-context';

export default function LoginPage() {
  const { login, user, loading } = useAuth();
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginInput>({
    // The SAME zod schema the API validates with (TDD §7.1). One definition, so
    // the client cannot accept something the server will reject.
    resolver: zodResolver(loginSchema),
  });

  useEffect(() => {
    if (!loading && user) router.replace('/front-desk');
  }, [user, loading, router]);

  const onSubmit = handleSubmit(async (values) => {
    setServerError(null);
    try {
      await login(values.email, values.password);
      router.replace('/front-desk');
    } catch (err) {
      // The server deliberately does not distinguish "no such user" from "wrong
      // password" — surfacing its message verbatim keeps it that way.
      setServerError(err instanceof Error ? err.message : 'Sign in failed');
    }
  });

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">HotelOS</h1>
          <p className="mt-1 text-sm opacity-60">Sign in to your property</p>
        </div>

        <form onSubmit={onSubmit} noValidate className="space-y-4">
          <div>
            <label htmlFor="email" className="mb-1.5 block text-sm font-medium">
              Email
            </label>
            <input
              id="email"
              type="email"
              autoComplete="username"
              autoFocus
              {...register('email')}
              className="w-full rounded-md border border-black/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-status-occupied dark:border-white/20"
            />
            {errors.email && (
              <p className="mt-1 text-xs text-status-ooo">{errors.email.message}</p>
            )}
          </div>

          <div>
            <label htmlFor="password" className="mb-1.5 block text-sm font-medium">
              Password
            </label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              {...register('password')}
              className="w-full rounded-md border border-black/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-status-occupied dark:border-white/20"
            />
            {errors.password && (
              <p className="mt-1 text-xs text-status-ooo">{errors.password.message}</p>
            )}
          </div>

          {serverError && (
            <div
              role="alert"
              className="rounded-md bg-status-ooo/10 px-3 py-2 text-xs text-status-ooo"
            >
              {serverError}
            </div>
          )}

          <button
            type="submit"
            disabled={isSubmitting}
            className="w-full rounded-md bg-status-occupied px-3 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {isSubmitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        {/* Dev convenience. Seeded users only exist in dev/CI. */}
        {process.env.NODE_ENV !== 'production' && (
          <div className="mt-8 rounded-md border border-black/10 p-3 text-xs opacity-70 dark:border-white/15">
            <p className="mb-1.5 font-medium">Seeded users — password: Password123!</p>
            <ul className="space-y-0.5 font-mono text-[11px]">
              <li>admin@hotelos.dev — both properties</li>
              <li>frontdesk@hotelos.dev — Hotel Alpha only</li>
              <li>housekeeping@hotelos.dev — Hotel Alpha only</li>
              <li>beta.frontdesk@hotelos.dev — Hotel Beta only</li>
            </ul>
          </div>
        )}
      </div>
    </main>
  );
}
