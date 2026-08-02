import { Prisma } from '@prisma/client';

export type Money = Prisma.Decimal;

export const money = (value: Prisma.Decimal.Value): Prisma.Decimal => new Prisma.Decimal(value);

export const ZERO = money(0);

export function sum(values: Prisma.Decimal.Value[]): Prisma.Decimal {
  return values.reduce<Prisma.Decimal>((acc, v) => acc.plus(money(v)), money(0));
}

/** Number of decimal places used across the money domain (TZS uses whole shillings). */
export const SCALE = 2;

export function round(value: Prisma.Decimal.Value): Prisma.Decimal {
  return money(value).toDecimalPlaces(SCALE, Prisma.Decimal.ROUND_HALF_UP);
}

export function toNumber(value: Prisma.Decimal.Value | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return money(value).toNumber();
}

/** Formats for receipts and reports, e.g. formatMoney(150000, 'TZS') => "TZS 150,000.00". */
export function formatMoney(value: Prisma.Decimal.Value, currency = 'TZS'): string {
  const n = money(value).toFixed(SCALE);
  const [whole = '0', fraction = '00'] = n.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${currency} ${grouped}.${fraction}`;
}
