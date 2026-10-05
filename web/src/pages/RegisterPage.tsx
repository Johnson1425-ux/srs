import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { get, post } from '../lib/api';
import { money } from '../lib/format';
import { ErrorNote, Field, Spinner } from '../components/ui';

type Plan = 'BASIC' | 'STANDARD' | 'PREMIUM';

interface PlanOffer {
  plan: Plan;
  amount: number;
  currency: string;
  maxStudents: number;
  storageQuotaMb: number;
}

interface Registration {
  claimToken: string;
  status: 'PENDING' | 'CONFIRMED' | 'FAILED' | 'REVERSED';
  school: { id: string; name: string; code: string; status: string };
  plan: Plan;
  amount: number;
  currency: string;
  msisdn: string;
  message: string | null;
  paidAt: string | null;
  administratorEmail: string;
  temporaryPassword?: string;
}

interface RegisterForm {
  name: string;
  code: string;
  email?: string;
  phone?: string;
  city?: string;
  region?: string;
  plan: Plan;
  msisdn: string;
  adminFirstName: string;
  adminLastName: string;
  adminEmail: string;
}

function Shell({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 px-4 py-10">
      <div className="w-full max-w-2xl">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-600 text-xl font-bold text-white">
            SMS
          </div>
          <h1 className="text-2xl font-semibold text-slate-900">{title}</h1>
          <p className="mt-1 text-sm text-slate-500">{subtitle}</p>
        </div>
        <div className="card p-6">{children}</div>
        <p className="mt-6 text-center text-sm text-slate-500">
          Already registered?{' '}
          <Link to="/login" className="text-brand-700 hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}

/** The form a school fills in. Nothing exists server-side until it is sent. */
function SignUpForm() {
  const navigate = useNavigate();
  const [error, setError] = useState<unknown>(null);

  const plans = useQuery({
    queryKey: ['registration', 'plans'],
    queryFn: () =>
      get<{ currency: string; paymentsEnabled: boolean; data: PlanOffer[] }>('/registration/plans'),
  });

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<RegisterForm>({ defaultValues: { plan: 'BASIC' } });

  const chosen = plans.data?.data.find((p) => p.plan === watch('plan'));

  const onSubmit = handleSubmit(async (values) => {
    setError(null);
    try {
      const created = await post<Registration>('/registration', {
        name: values.name,
        code: values.code,
        email: values.email || null,
        phone: values.phone || null,
        city: values.city || null,
        region: values.region || null,
        plan: values.plan,
        msisdn: values.msisdn,
        admin: {
          firstName: values.adminFirstName,
          lastName: values.adminLastName,
          email: values.adminEmail,
        },
      });
      navigate(`/register/${created.claimToken}`, { replace: true });
    } catch (err) {
      setError(err);
    }
  });

  return (
    <Shell
      title="Register your school"
      subtitle="Pay the registration fee with M-Pesa to open your school's account"
    >
      {error != null && (
        <div className="mb-4">
          <ErrorNote error={error} />
        </div>
      )}
      {plans.data && !plans.data.paymentsEnabled && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          M-Pesa is not configured on this deployment, so no payment prompt will be sent. Your
          school will be recorded as awaiting payment.
        </div>
      )}

      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="School name" required error={errors.name?.message}>
            <input
              className="input"
              autoFocus
              placeholder="Mlimani Secondary School"
              {...register('name', { required: 'School name is required' })}
            />
          </Field>
          <Field
            label="School code"
            required
            hint="Short and alphanumeric. It appears on receipts and admission numbers."
            error={errors.code?.message}
          >
            <input
              className="input uppercase"
              placeholder="MLM"
              {...register('code', {
                required: 'School code is required',
                pattern: { value: /^[A-Za-z0-9]{2,12}$/, message: 'Two to twelve letters or digits' },
              })}
            />
          </Field>
          <Field label="School email" error={errors.email?.message}>
            <input type="email" className="input" placeholder="info@school.ac.tz" {...register('email')} />
          </Field>
          <Field label="School phone" error={errors.phone?.message}>
            <input className="input" placeholder="0222 123 456" {...register('phone')} />
          </Field>
          <Field label="City" error={errors.city?.message}>
            <input className="input" placeholder="Dar es Salaam" {...register('city')} />
          </Field>
          <Field label="Region" error={errors.region?.message}>
            <input className="input" placeholder="Dar es Salaam" {...register('region')} />
          </Field>
        </div>

        <Field label="Plan" required error={errors.plan?.message}>
          <select className="input" {...register('plan', { required: true })}>
            {(plans.data?.data ?? []).map((p) => (
              <option key={p.plan} value={p.plan}>
                {p.plan} — {money(p.amount, p.currency)} · up to {p.maxStudents} students
              </option>
            ))}
          </select>
        </Field>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Administrator first name" required error={errors.adminFirstName?.message}>
            <input className="input" {...register('adminFirstName', { required: 'Required' })} />
          </Field>
          <Field label="Administrator last name" required error={errors.adminLastName?.message}>
            <input className="input" {...register('adminLastName', { required: 'Required' })} />
          </Field>
          <Field label="Administrator email" required error={errors.adminEmail?.message}>
            <input
              type="email"
              className="input"
              placeholder="head@school.ac.tz"
              {...register('adminEmail', {
                required: 'Required',
                pattern: { value: /^\S+@\S+\.\S+$/, message: 'Enter a valid email address' },
              })}
            />
          </Field>
        </div>

        <Field
          label="M-Pesa number"
          required
          hint="The phone that will be asked for a PIN. Any format: 0754 123 456 or 255754123456."
          error={errors.msisdn?.message}
        >
          <input
            className="input"
            placeholder="0754 123 456"
            {...register('msisdn', { required: 'An M-Pesa number is required' })}
          />
        </Field>

        <button type="submit" className="btn-primary w-full" disabled={isSubmitting}>
          {isSubmitting
            ? 'Sending the payment request…'
            : chosen
              ? `Pay ${money(chosen.amount, chosen.currency)} with M-Pesa`
              : 'Continue'}
        </button>
        <p className="text-center text-xs text-slate-400">
          Your school's account opens as soon as the payment is confirmed.
        </p>
      </form>
    </Shell>
  );
}

/**
 * The "check your phone" screen.
 *
 * Polls while the payment is open: the server reconciles with M-Pesa on each
 * poll, so this settles even where the gateway cannot reach a callback URL.
 */
function PaymentStatus({ claimToken }: { claimToken: string }) {
  const [error, setError] = useState<unknown>(null);

  const status = useQuery({
    queryKey: ['registration', claimToken],
    queryFn: () => get<Registration>(`/registration/${claimToken}`),
    // Open payments are polled; a settled one stops asking.
    refetchInterval: (query) =>
      query.state.data && query.state.data.status === 'PENDING' ? 4000 : false,
  });

  const retry = useMutation({
    mutationFn: () => post<Registration>(`/registration/${claimToken}/retry`),
    onSuccess: () => {
      setError(null);
      void status.refetch();
    },
    onError: setError,
  });

  if (status.isLoading) {
    return (
      <Shell title="Registration" subtitle="Looking up your payment">
        <Spinner />
      </Shell>
    );
  }

  if (status.error || !status.data) {
    return (
      <Shell title="Registration" subtitle="We could not find that registration">
        <ErrorNote error={status.error ?? new Error('Registration not found')} />
      </Shell>
    );
  }

  const reg = status.data;

  if (reg.status === 'CONFIRMED') {
    return (
      <Shell title="Payment confirmed" subtitle={`${reg.school.name} is open for business`}>
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          We received {money(reg.amount, reg.currency)} for the {reg.plan} plan. Sign in as{' '}
          <span className="font-medium">{reg.administratorEmail}</span> with the temporary password
          you were given, and you will be asked to change it.
        </div>
        <Link to="/login" className="btn-primary mt-4 block w-full text-center">
          Sign in
        </Link>
      </Shell>
    );
  }

  const failed = reg.status === 'FAILED';

  return (
    <Shell
      title={failed ? 'Payment not completed' : 'Check your phone'}
      subtitle={`${reg.school.name} · ${money(reg.amount, reg.currency)} for the ${reg.plan} plan`}
    >
      {error != null && (
        <div className="mb-4">
          <ErrorNote error={error} />
        </div>
      )}

      <div
        className={
          failed
            ? 'rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800'
            : 'rounded-lg border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-slate-700'
        }
      >
        {failed ? (
          <p>{reg.message ?? 'M-Pesa did not complete the payment.'}</p>
        ) : (
          <>
            <p className="font-medium">Enter your M-Pesa PIN on {reg.msisdn}.</p>
            <p className="mt-1">
              This page updates itself the moment the payment goes through. Until then your school
              cannot be signed in to.
            </p>
            {reg.message && <p className="mt-2 text-xs text-slate-500">{reg.message}</p>}
          </>
        )}
      </div>

      {!failed && (
        <div className="mt-4 flex items-center gap-2 text-sm text-slate-500">
          <Spinner label="Waiting for M-Pesa…" />
        </div>
      )}

      <button
        type="button"
        className="btn-primary mt-4 w-full"
        onClick={() => retry.mutate()}
        disabled={retry.isPending}
      >
        {retry.isPending ? 'Sending another request…' : 'Send the payment request again'}
      </button>

      <p className="mt-4 text-center text-xs text-slate-400">
        Keep this link. It is the only way back to this payment until your school is open.
      </p>
    </Shell>
  );
}

export function RegisterPage() {
  const { claimToken } = useParams<{ claimToken?: string }>();
  return claimToken ? <PaymentStatus claimToken={claimToken} /> : <SignUpForm />;
}
