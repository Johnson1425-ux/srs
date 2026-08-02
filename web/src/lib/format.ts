export function money(value: string | number | null | undefined, currency = 'TZS'): string {
  const n = Number(value ?? 0);
  return `${currency} ${n.toLocaleString('en-TZ', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

/** Compact form for dashboard tiles, e.g. 12.4M. */
export function compactMoney(value: string | number | null | undefined, currency = 'TZS'): string {
  const n = Number(value ?? 0);
  if (Math.abs(n) >= 1_000_000) return `${currency} ${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${currency} ${(n / 1_000).toFixed(0)}K`;
  return `${currency} ${n.toLocaleString()}`;
}

export function date(value: string | Date | null | undefined): string {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

export function dateTime(value: string | Date | null | undefined): string {
  if (!value) return '—';
  return new Date(value).toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** ISO date (yyyy-mm-dd) for date inputs and API query params. */
export function isoDate(value: Date = new Date()): string {
  return value.toISOString().slice(0, 10);
}

export function fullName(person: {
  firstName: string;
  middleName?: string | null;
  lastName: string;
}): string {
  return [person.firstName, person.middleName, person.lastName].filter(Boolean).join(' ');
}

export function initials(person: { firstName: string; lastName: string }): string {
  return `${person.firstName[0] ?? ''}${person.lastName[0] ?? ''}`.toUpperCase();
}

export function titleCase(value: string): string {
  return value
    .toLowerCase()
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

const STATUS_TONES: Record<string, string> = {
  ACTIVE: 'bg-emerald-100 text-emerald-800',
  PRESENT: 'bg-emerald-100 text-emerald-800',
  PAID: 'bg-emerald-100 text-emerald-800',
  PUBLISHED: 'bg-emerald-100 text-emerald-800',
  CONFIRMED: 'bg-emerald-100 text-emerald-800',
  APPROVED: 'bg-emerald-100 text-emerald-800',
  LATE: 'bg-amber-100 text-amber-800',
  PARTIALLY_PAID: 'bg-amber-100 text-amber-800',
  PENDING: 'bg-amber-100 text-amber-800',
  MARKS_ENTRY: 'bg-amber-100 text-amber-800',
  ISSUED: 'bg-sky-100 text-sky-800',
  BORROWED: 'bg-sky-100 text-sky-800',
  ABSENT: 'bg-red-100 text-red-800',
  SUSPENDED: 'bg-red-100 text-red-800',
  OVERDUE: 'bg-red-100 text-red-800',
  REVERSED: 'bg-red-100 text-red-800',
  CANCELLED: 'bg-red-100 text-red-800',
  REJECTED: 'bg-red-100 text-red-800',
  LOST: 'bg-red-100 text-red-800',
};

export function statusTone(status: string): string {
  return STATUS_TONES[status] ?? 'bg-slate-100 text-slate-700';
}
