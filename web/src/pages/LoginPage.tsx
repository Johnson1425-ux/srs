import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { ApiError, post } from '../lib/api';
import { ErrorNote, Field } from '../components/ui';

interface LoginForm {
  email: string;
  password: string;
  schoolCode?: string;
}

export function LoginPage() {
  const { user, loading, signIn } = useAuth();
  const navigate = useNavigate();
  const location = useLocation() as { state?: { from?: string } };
  const [error, setError] = useState<unknown>(null);
  const [needsSchoolCode, setNeedsSchoolCode] = useState(false);
  const [resetSent, setResetSent] = useState<string | null>(null);
  const [mode, setMode] = useState<'signin' | 'forgot'>('signin');

  const {
    register,
    handleSubmit,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm<LoginForm>();

  if (!loading && user) return <Navigate to={location.state?.from ?? '/'} replace />;

  const onSubmit = handleSubmit(async (values) => {
    setError(null);
    try {
      await signIn(values.email, values.password, values.schoolCode || undefined);
      navigate(location.state?.from ?? '/', { replace: true });
    } catch (err) {
      // The API asks for a school code when one address exists at two schools.
      if (err instanceof ApiError && err.details?.some((d) => d.field === 'schoolCode')) {
        setNeedsSchoolCode(true);
      }
      setError(err);
    }
  });

  const onForgot = async () => {
    setError(null);
    setResetSent(null);
    try {
      const res = await post<{ message: string; devToken?: string }>('/auth/forgot-password', {
        email: getValues('email'),
        schoolCode: getValues('schoolCode') || undefined,
      });
      setResetSent(res.message);
    } catch (err) {
      setError(err);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-600 text-xl font-bold text-white">
            SMS
          </div>
          <h1 className="text-2xl font-semibold text-slate-900">School Management System</h1>
          <p className="mt-1 text-sm text-slate-500">
            {mode === 'signin' ? 'Sign in to your school account' : 'Reset your password'}
          </p>
        </div>

        <div className="card p-6">
          {error != null && (
            <div className="mb-4">
              <ErrorNote error={error} />
            </div>
          )}
          {resetSent && (
            <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
              {resetSent}
            </div>
          )}

          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            <Field label="Email address" required error={errors.email?.message}>
              <input
                type="email"
                autoComplete="username"
                autoFocus
                className="input"
                placeholder="you@school.ac.tz"
                {...register('email', {
                  required: 'Email is required',
                  pattern: { value: /^\S+@\S+\.\S+$/, message: 'Enter a valid email address' },
                })}
              />
            </Field>

            {mode === 'signin' && (
              <Field label="Password" required error={errors.password?.message}>
                <input
                  type="password"
                  autoComplete="current-password"
                  className="input"
                  placeholder="••••••••"
                  {...register('password', { required: 'Password is required' })}
                />
              </Field>
            )}

            {(needsSchoolCode || mode === 'forgot') && (
              <Field
                label="School code"
                hint="Only needed when the same email is registered at more than one school."
                error={errors.schoolCode?.message}
              >
                <input className="input" placeholder="MLM" {...register('schoolCode')} />
              </Field>
            )}

            {mode === 'signin' ? (
              <>
                <button type="submit" className="btn-primary w-full" disabled={isSubmitting}>
                  {isSubmitting ? 'Signing in…' : 'Sign in'}
                </button>
                <button
                  type="button"
                  className="w-full text-center text-sm text-brand-700 hover:underline"
                  onClick={() => {
                    setMode('forgot');
                    setError(null);
                  }}
                >
                  Forgot your password?
                </button>
              </>
            ) : (
              <>
                <button type="button" className="btn-primary w-full" onClick={onForgot}>
                  Send reset instructions
                </button>
                <button
                  type="button"
                  className="w-full text-center text-sm text-brand-700 hover:underline"
                  onClick={() => {
                    setMode('signin');
                    setError(null);
                    setResetSent(null);
                  }}
                >
                  Back to sign in
                </button>
              </>
            )}
          </form>
        </div>

        <p className="mt-6 text-center text-xs text-slate-400">
          Protected system. All access is logged.
        </p>
      </div>
    </div>
  );
}
