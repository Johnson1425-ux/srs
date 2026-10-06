import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { get, post } from '../lib/api';
import { money } from '../lib/format';
import { ErrorNote, Field, Spinner } from '../components/ui';
import {
  type PaymentStep,
  PaymentSteps,
  WaitMeter,
  useElapsedSeconds,
} from '../components/PaymentSteps';

type Plan = 'BASIC' | 'STANDARD' | 'PREMIUM';
type Provider = 'MPESA' | 'AIRTEL_MONEY';

interface ProviderOffer {
  provider: Provider;
  label: string;
  enabled: boolean;
}

/**
 * What to put in the number box, per network.
 *
 * Airtel and Vodacom own different prefixes in Tanzania, and the gateway that
 * refuses a number from the other network says so in a code nobody can read.
 * A worked example in the hint is cheaper than that refusal.
 */
const NUMBER_HINT: Record<Provider, string> = {
  MPESA: 'The phone that will be asked for a PIN. Any format: 0754 123 456 or 255754123456.',
  AIRTEL_MONEY:
    'The Airtel phone that will get the payment prompt. Any format: 0784 123 456 or 255784123456.',
};

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
  provider: Provider;
  providerLabel: string;
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
  provider: Provider;
  msisdn: string;
  adminFirstName: string;
  adminLastName: string;
  adminEmail: string;
}

/**
 * How long a prompt is normally answered within, per network.
 *
 * M-Pesa's push is held open server-side for 110 seconds, and Airtel settles
 * through the status poll a little sooner. Past this the wait is not an error —
 * the prompt may still be sitting unread on the handset — but it is long
 * enough that offering to send it again is more use than another spinner.
 */
const PROMPT_WINDOW_SECONDS: Record<Provider, number> = {
  MPESA: 110,
  AIRTEL_MONEY: 90,
};

/**
 * The payment as a list of steps.
 *
 * Every state here is read off the payment record. The two steps after
 * approval cannot be observed separately — the gateway tells us the payment
 * settled and the school opened in the same breath — so they settle together
 * rather than being animated apart on a guess.
 */
function paymentSteps(reg: Registration, sending: boolean): PaymentStep[] {
  const confirmed = reg.status === 'CONFIRMED';
  const failed = reg.status === 'FAILED' || reg.status === 'REVERSED';

  const approving: PaymentStep['state'] = confirmed
    ? 'done'
    : failed
      ? 'failed'
      : sending
        ? 'upcoming'
        : 'active';

  return [
    {
      key: 'request',
      label: sending
        ? `Sending the ${reg.providerLabel} prompt again`
        : `Payment request sent to ${reg.providerLabel}`,
      detail: sending ? undefined : `${money(reg.amount, reg.currency)} · ${reg.msisdn}`,
      state: sending ? 'active' : 'done',
    },
    {
      key: 'approve',
      label: confirmed
        ? 'Approved on your phone'
        : failed
          ? 'The prompt was not approved'
          : `Enter your ${reg.providerLabel} PIN on ${reg.msisdn}`,
      state: approving,
    },
    {
      key: 'settle',
      label: confirmed
        ? `${reg.providerLabel} confirmed the payment`
        : `${reg.providerLabel} confirms the payment`,
      state: confirmed ? 'done' : 'upcoming',
    },
    {
      key: 'open',
      label: confirmed ? `${reg.school.name} is open` : "Your school's account opens",
      state: confirmed ? 'done' : 'upcoming',
    },
  ];
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
      get<{
        currency: string;
        paymentsEnabled: boolean;
        providers?: ProviderOffer[];
        data: PlanOffer[];
      }>('/registration/plans'),
  });

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<RegisterForm>({ defaultValues: { plan: 'BASIC', provider: 'MPESA' } });

  const chosen = plans.data?.data.find((p) => p.plan === watch('plan'));
  const provider = watch('provider');

  // Only the networks this deployment actually has credentials for: offering
  // one it cannot push to sends a school to a "check your phone" screen for a
  // prompt that was never sent.
  const providers = (plans.data?.providers ?? []).filter((p) => p.enabled);
  const providerLabel =
    providers.find((p) => p.provider === provider)?.label ?? 'mobile money';

  // The form opens on M-Pesa because that is the common case and the price
  // list has not arrived yet. A deployment that has only configured Airtel
  // would otherwise push to a gateway it has no credentials for, so the choice
  // moves to the first network that can actually take money.
  useEffect(() => {
    if (providers.length > 0 && !providers.some((p) => p.provider === provider)) {
      setValue('provider', providers[0]!.provider);
    }
  }, [providers, provider, setValue]);

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
        provider: values.provider,
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
      subtitle="Pay the registration fee with mobile money to open your school's account"
    >
      {error != null && (
        <div className="mb-4">
          <ErrorNote error={error} />
        </div>
      )}
      {plans.data && !plans.data.paymentsEnabled && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Mobile money is not configured on this deployment, so no payment prompt will be sent.
          Your school will be recorded as awaiting payment.
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

        {providers.length > 1 && (
          <Field label="Pay with" required error={errors.provider?.message}>
            <div className="grid gap-2 sm:grid-cols-2">
              {providers.map((p) => (
                <label
                  key={p.provider}
                  className={`flex cursor-pointer items-center gap-3 rounded-lg border px-4 py-3 text-sm ${
                    provider === p.provider
                      ? 'border-brand-500 bg-brand-50 text-slate-900'
                      : 'border-slate-200 text-slate-600 hover:border-slate-300'
                  }`}
                >
                  <input
                    type="radio"
                    value={p.provider}
                    className="h-4 w-4"
                    {...register('provider', { required: true })}
                  />
                  <span className="font-medium">{p.label}</span>
                </label>
              ))}
            </div>
          </Field>
        )}

        <Field
          label={`${providerLabel} number`}
          required
          hint={NUMBER_HINT[provider] ?? NUMBER_HINT.MPESA}
          error={errors.msisdn?.message}
        >
          <input
            className="input"
            placeholder={provider === 'AIRTEL_MONEY' ? '0784 123 456' : '0754 123 456'}
            {...register('msisdn', { required: `A ${providerLabel} number is required` })}
          />
        </Field>

        <button type="submit" className="btn-primary w-full" disabled={isSubmitting}>
          {isSubmitting
            ? 'Sending the payment request…'
            : chosen
              ? `Pay ${money(chosen.amount, chosen.currency)} with ${providerLabel}`
              : 'Continue'}
        </button>
        {isSubmitting ? (
          /*
           * The same list the next screen opens on, so the wait does not start
           * over when the prompt is on its way. Only the step actually being
           * waited on is marked active: the rest are what is coming.
           */
          <div className="panel-enter rounded-lg border border-slate-200 bg-slate-50 px-4 py-4">
            <PaymentSteps
              steps={[
                {
                  key: 'request',
                  label: `Sending the payment request to ${providerLabel}`,
                  state: 'active',
                },
                {
                  key: 'approve',
                  label: `Enter your ${providerLabel} PIN on the phone you gave`,
                  state: 'upcoming',
                },
                { key: 'open', label: "Your school's account opens", state: 'upcoming' },
              ]}
            />
          </div>
        ) : (
          <p className="text-center text-xs text-slate-400">
            Your school's account opens as soon as the payment is confirmed.
          </p>
        )}
      </form>
    </Shell>
  );
}

/**
 * The "check your phone" screen.
 *
 * Polls while the payment is open: the server reconciles with the gateway on
 * each poll, so this settles even where it cannot reach a callback URL. What
 * the school sees is the step list, which redraws itself as the record moves.
 */
function PaymentStatus({ claimToken }: { claimToken: string }) {
  const [error, setError] = useState<unknown>(null);
  const [waitingSince, setWaitingSince] = useState(() => waitStart(claimToken));

  const status = useQuery({
    queryKey: ['registration', claimToken],
    queryFn: () => get<Registration>(`/registration/${claimToken}`),
    // Open payments are polled; a settled one stops asking.
    refetchInterval: (query) =>
      query.state.data && query.state.data.status === 'PENDING' ? 4000 : false,
    // Paying means picking up the handset, which blurs this tab — and polling
    // pauses on a blurred tab by default, so the screen would sit on "check
    // your phone" through the one moment it is waiting for and only catch up
    // when the customer came back to it.
    refetchIntervalInBackground: true,
  });

  const retry = useMutation({
    mutationFn: () => post<Registration>(`/registration/${claimToken}/retry`),
    onSuccess: () => {
      setError(null);
      // A retry is a genuinely new prompt, so the clock under it starts again.
      setWaitingSince(restartWait(claimToken));
      void status.refetch();
    },
    onError: setError,
  });

  const reg = status.data;
  const pending = reg?.status === 'PENDING';
  const seconds = useElapsedSeconds(waitingSince, pending === true && !retry.isPending);

  if (status.isLoading) {
    return (
      <Shell title="Registration" subtitle="Looking up your payment">
        <Spinner />
      </Shell>
    );
  }

  if (status.error || !reg) {
    return (
      <Shell title="Registration" subtitle="We could not find that registration">
        <ErrorNote error={status.error ?? new Error('Registration not found')} />
      </Shell>
    );
  }

  const confirmed = reg.status === 'CONFIRMED';
  const failed = reg.status === 'FAILED' || reg.status === 'REVERSED';
  const steps = paymentSteps(reg, retry.isPending);
  const overdue = pending && seconds > (PROMPT_WINDOW_SECONDS[reg.provider] ?? 110);

  if (confirmed) {
    return (
      <Shell title="Payment confirmed" subtitle={`${reg.school.name} is open for business`}>
        <div className="panel-enter">
          <div className="mb-5">
            <PaymentSteps steps={steps} />
          </div>
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
            We received {money(reg.amount, reg.currency)} for the {reg.plan} plan. Sign in as{' '}
            <span className="font-medium">{reg.administratorEmail}</span> with the temporary
            password you were given, and you will be asked to change it.
          </div>
          <Link to="/login" className="btn-primary mt-4 block w-full text-center">
            Sign in
          </Link>
        </div>
      </Shell>
    );
  }

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

      {/* Polite, because this changes under a reader who is looking at their phone. */}
      <div aria-live="polite">
        <PaymentSteps steps={steps} />

        {pending && !retry.isPending && (
          /* Aligned under the step labels rather than the card, so it reads as
             belonging to the step being waited on. */
          <div className="pl-[34px]">
            <WaitMeter
              seconds={seconds}
              overdue={overdue}
              label={`Waiting for ${reg.providerLabel}`}
            />
          </div>
        )}
      </div>

      <div
        className={`mt-5 rounded-lg border px-4 py-3 text-sm transition-colors duration-500 ${
          failed
            ? 'border-rose-200 bg-rose-50 text-rose-800'
            : overdue
              ? 'border-amber-200 bg-amber-50 text-amber-800'
              : 'border-brand-200 bg-brand-50 text-slate-700'
        }`}
      >
        {failed ? (
          <p>{reg.message ?? `${reg.providerLabel} did not complete the payment.`}</p>
        ) : overdue ? (
          <>
            <p className="font-medium">The prompt is taking longer than usual.</p>
            <p className="mt-1">
              It may still be sitting unread on {reg.msisdn}. If it never arrived, send the request
              again — your school is only ever opened once.
            </p>
          </>
        ) : (
          <>
            <p className="font-medium">
              Approve the {reg.providerLabel} prompt on {reg.msisdn}.
            </p>
            <p className="mt-1">
              This page updates itself the moment the payment goes through. Until then your school
              cannot be signed in to.
            </p>
          </>
        )}
        {reg.message && !failed && <p className="mt-2 text-xs opacity-80">{reg.message}</p>}
      </div>

      <button
        type="button"
        className={`mt-4 w-full ${failed || overdue ? 'btn-primary' : 'btn-secondary'}`}
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

/**
 * When the prompt the school is waiting on was sent.
 *
 * The payment row does not record the moment of the push, and the clock on
 * this screen has to survive a reload: a school that comes back to the tab
 * after two minutes must not be told the prompt is seconds old and promised it
 * is on its way. Kept per claim token for the life of the tab.
 */
function waitStart(claimToken: string): number {
  const key = waitKey(claimToken);
  try {
    const stored = Number(window.sessionStorage.getItem(key));
    if (Number.isFinite(stored) && stored > 0) return stored;
    const now = Date.now();
    window.sessionStorage.setItem(key, String(now));
    return now;
  } catch {
    // Private browsing, or storage the browser will not hand out. The clock is
    // decoration over a screen that polls regardless.
    return Date.now();
  }
}

function restartWait(claimToken: string): number {
  try {
    window.sessionStorage.removeItem(waitKey(claimToken));
  } catch {
    // Nothing to clear.
  }
  return waitStart(claimToken);
}

function waitKey(claimToken: string): string {
  return `registration-wait:${claimToken}`;
}

export function RegisterPage() {
  const { claimToken } = useParams<{ claimToken?: string }>();
  return claimToken ? <PaymentStatus claimToken={claimToken} /> : <SignUpForm />;
}
