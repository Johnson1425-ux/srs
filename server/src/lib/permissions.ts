import { Role } from '@prisma/client';

/**
 * Permission catalogue. Named `resource:action` so route guards read plainly,
 * e.g. requirePermission('fees:manage').
 */
export const PERMISSIONS = [
  'school:read',
  'school:manage',
  'users:read',
  'users:manage',
  'academics:read',
  'academics:manage',
  'students:read',
  'students:manage',
  'students:promote',
  'guardians:read',
  'guardians:manage',
  'staff:read',
  'staff:manage',
  'attendance:read',
  'attendance:record',
  'exams:read',
  'exams:manage',
  'exams:enter_marks',
  'exams:publish',
  'fees:read',
  'fees:manage',
  'payments:read',
  'payments:create',
  'payments:reverse',
  'accounting:read',
  'accounting:manage',
  'payroll:read',
  'payroll:manage',
  'library:read',
  'library:manage',
  'inventory:read',
  'inventory:manage',
  'transport:read',
  'transport:manage',
  'hostel:read',
  'hostel:manage',
  'communication:read',
  'communication:send',
  'documents:read',
  'documents:manage',
  'reports:read',
  'audit:read',
  'platform:manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const READ_ONLY: Permission[] = PERMISSIONS.filter((p) =>
  p.endsWith(':read'),
) as unknown as Permission[];

/** Everything a school-level administrator can do (i.e. all but platform ops). */
const SCHOOL_ADMIN: Permission[] = PERMISSIONS.filter(
  (p) => p !== 'platform:manage',
) as unknown as Permission[];

/**
 * Role → permission matrix, mirroring PRD section 4.
 * SUPER_ADMIN is handled separately as an implicit allow-all.
 */
export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  SUPER_ADMIN: [...PERMISSIONS],

  // "Read all reports" — visibility across the school, no write access.
  SCHOOL_OWNER: [...READ_ONLY],

  ADMIN: SCHOOL_ADMIN,

  // Finance roles need to read the academic structure (classes, terms, years)
  // because fee structures, invoicing and reports are all scoped by it.
  ACCOUNTANT: [
    'school:read',
    'academics:read',
    'students:read',
    'guardians:read',
    'staff:read',
    'fees:read',
    'fees:manage',
    'payments:read',
    'payments:create',
    'payments:reverse',
    'accounting:read',
    'accounting:manage',
    'payroll:read',
    'payroll:manage',
    'reports:read',
    'communication:read',
    'communication:send',
    'documents:read',
  ],

  TEACHER: [
    'school:read',
    'academics:read',
    'students:read',
    'guardians:read',
    'attendance:read',
    'attendance:record',
    'exams:read',
    'exams:enter_marks',
    'reports:read',
    'communication:read',
    'documents:read',
  ],

  // Students and parents reach their data through /portal/* routes, which are
  // scoped to the caller rather than gated on school-wide permissions.
  STUDENT: [],
  PARENT: [],

  LIBRARIAN: [
    'school:read',
    'academics:read',
    'students:read',
    'library:read',
    'library:manage',
    'reports:read',
  ],

  DRIVER: ['school:read', 'transport:read'],

  // Admissions are impossible without reading classes and streams.
  RECEPTIONIST: [
    'school:read',
    'academics:read',
    'students:read',
    'students:manage',
    'guardians:read',
    'guardians:manage',
    'communication:read',
    'communication:send',
    'documents:read',
    'documents:manage',
  ],

  TRANSPORT_OFFICER: [
    'school:read',
    'academics:read',
    'students:read',
    'transport:read',
    'transport:manage',
    'staff:read',
    'reports:read',
  ],
};

export function permissionsForRole(role: Role): Permission[] {
  return ROLE_PERMISSIONS[role] ?? [];
}

export function roleHasPermission(role: Role, permission: Permission): boolean {
  if (role === Role.SUPER_ADMIN) return true;
  return permissionsForRole(role).includes(permission);
}
