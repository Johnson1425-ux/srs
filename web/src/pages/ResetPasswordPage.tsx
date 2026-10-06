import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { post } from '../lib/api';
import { ErrorNote, Field } from '../components/ui';

interface ResetForm {
  password: string;
  confirm: string;
}

/**
 * Where a password reset link lands.
 *
 * The token in the URL is the credential, so this sits outside the application
 * shell: whoever opens it has no session and is not meant to need one.
 */
export function ResetPasswordPage() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState(false);

  const {
    register,
    handleSubmit,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm<ResetForm>();

  const onSubmit = handleSubmit(async (values) => {
    setError(null);
    try {
      await post('/auth/reset-password', { token, password: values.password });
      setDone(true);
      // Long enough to read the confirmation, then out of the way.
      setTimeout(() => navigate('/login', { replace: true }), 2500);
    } catch (err) {
      setError(err);
    }
  });

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-600 text-xl font-bold text-white">
            SMS
          </div>
          <h1 className="text-2xl font-semibold text-slate-900">Choose a new password</h1>
          <p className="mt-1 text-sm text-slate-500">
            This link works once, and only for a short while.
          </p>
        </div>

        <div className="card p-6">
          {done ? (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
              Your password has been changed. Taking you to sign in…
            </div>
          ) : (
            <>
              {error != null && (
                <div className="mb-4">
                  <ErrorNote error={error} />
                </div>
              )}

              <form onSubmit={onSubmit} className="space-y-4" noValidate>
                <Field
                  label="New password"
                  required
                  hint="At least 8 characters, with an upper-case letter, a lower-case letter and a number."
                  error={errors.password?.message}
                >
                  <input
                    type="password"
                    autoComplete="new-password"
                    autoFocus
                    className="input"
                    placeholder="••••••••"
                    {...register('password', {
                      required: 'A password is required',
                      minLength: { value: 8, message: 'At least 8 characters' },
                      validate: (value) =>
                        (/[a-z]/.test(value) && /[A-Z]/.test(value) && /[0-9]/.test(value)) ||
                        'Needs an upper-case letter, a lower-case letter and a number',
                    })}
                  />
                </Field>

                <Field label="Confirm new password" required error={errors.confirm?.message}>
                  <input
                    type="password"
                    autoComplete="new-password"
                    className="input"
                    placeholder="••••••••"
                    {...register('confirm', {
                      required: 'Type the password again',
                      validate: (value) =>
                        value === getValues('password') || 'The two passwords do not match',
                    })}
                  />
                </Field>

                <button type="submit" className="btn-primary w-full" disabled={isSubmitting}>
                  {isSubmitting ? 'Saving…' : 'Set my password'}
                </button>
              </form>
            </>
          )}
        </div>

        <p className="mt-6 text-center text-sm text-slate-500">
          <Link to="/login" className="text-brand-700 hover:underline">
            Back to sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
