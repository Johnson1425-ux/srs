import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { get } from '../lib/api';
import { useAuth } from '../lib/auth';
import { initials, titleCase } from '../lib/format';
import type { Permission, Role } from '../lib/types';

interface NavItem {
  label: string;
  to: string;
  icon: string;
  /** Visible when the user holds any of these permissions. */
  permissions?: Permission[];
  /** Or when they hold one of these roles (used for the family portals). */
  roles?: Role[];
}

const NAV: Array<{ section: string; items: NavItem[] }> = [
  {
    section: 'Overview',
    items: [
      { label: 'Dashboard', to: '/', icon: '▦', permissions: ['school:read'] },
      { label: 'My children', to: '/portal', icon: '👪', roles: ['PARENT'] },
      { label: 'My school', to: '/portal', icon: '🎒', roles: ['STUDENT'] },
    ],
  },
  {
    section: 'People',
    items: [
      { label: 'Students', to: '/students', icon: '🎓', permissions: ['students:read'] },
      { label: 'Parents', to: '/parents', icon: '👥', permissions: ['guardians:read'] },
      { label: 'Staff', to: '/staff', icon: '🧑‍🏫', permissions: ['staff:read'] },
    ],
  },
  {
    section: 'Academics',
    items: [
      { label: 'Attendance', to: '/attendance', icon: '✓', permissions: ['attendance:read'] },
      { label: 'Examinations', to: '/exams', icon: '📝', permissions: ['exams:read'] },
      { label: 'Timetable', to: '/timetable', icon: '🗓', permissions: ['academics:read'] },
      { label: 'Classes & subjects', to: '/academics', icon: '📚', permissions: ['academics:read'] },
    ],
  },
  {
    section: 'Finance',
    items: [
      { label: 'Fees', to: '/fees', icon: '💰', permissions: ['fees:read'] },
      { label: 'Payments', to: '/payments', icon: '🧾', permissions: ['payments:read'] },
      { label: 'Accounting', to: '/accounting', icon: '📊', permissions: ['accounting:read'] },
    ],
  },
  {
    section: 'Operations',
    items: [
      { label: 'Library', to: '/library', icon: '📖', permissions: ['library:read'] },
      { label: 'Inventory', to: '/inventory', icon: '📦', permissions: ['inventory:read'] },
      { label: 'Transport', to: '/transport', icon: '🚌', permissions: ['transport:read'] },
      { label: 'Communication', to: '/communication', icon: '📣', permissions: ['communication:read'] },
    ],
  },
  {
    section: 'Administration',
    items: [
      { label: 'Reports', to: '/reports', icon: '📈', permissions: ['reports:read'] },
      { label: 'Settings', to: '/settings', icon: '⚙', permissions: ['school:read'] },
      { label: 'Schools (SaaS)', to: '/platform', icon: '🏫', roles: ['SUPER_ADMIN'] },
    ],
  },
];

export function AppLayout() {
  const { user, signOut, can, hasRole, activeSchoolId, setActiveSchool, isStandalone } = useAuth();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);

  // A standalone installation has no tenants to administer, so platform staff
  // are a SaaS-only concept there.
  const isPlatformStaff = hasRole('SUPER_ADMIN') && !isStandalone;

  // Only platform staff can list tenants, and only they need the switcher.
  const schools = useQuery({
    queryKey: ['platform', 'schools', 'switcher'],
    queryFn: () =>
      get<{ data: Array<{ id: string; name: string; code: string }> }>(
        '/platform/schools?pageSize=100',
      ),
    enabled: isPlatformStaff,
  });

  const activeSchool = schools.data?.data.find((s) => s.id === activeSchoolId);

  const visibleSections = NAV.map((section) => ({
    ...section,
    items: section.items.filter((item) => {
      // Platform administration does not exist on a standalone installation.
      if (isStandalone && item.to === '/platform') return false;
      // A super admin with no school selected can only reach platform routes;
      // every other page would fail server-side for want of a tenant.
      if (isPlatformStaff && !activeSchoolId && item.to !== '/platform') return false;
      if (item.roles && hasRole(...item.roles)) return true;
      if (item.permissions && can(...item.permissions)) return true;
      return false;
    }),
  })).filter((section) => section.items.length > 0);

  const handleSignOut = async () => {
    await signOut();
    navigate('/login', { replace: true });
  };

  return (
    <div className="min-h-screen lg:flex">
      {/* Mobile top bar */}
      <div className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3 lg:hidden">
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm"
          aria-expanded={menuOpen}
          aria-controls="main-nav"
        >
          ☰ Menu
        </button>
        <span className="truncate text-sm font-semibold">{user?.school?.name ?? 'SMS'}</span>
      </div>

      <aside
        id="main-nav"
        className={`${menuOpen ? 'block' : 'hidden'} w-full shrink-0 border-r border-slate-200 bg-white lg:block lg:w-64`}
      >
        <div className="flex h-full flex-col">
          <div className="hidden items-center gap-3 border-b border-slate-200 px-5 py-4 lg:flex">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-600 text-sm font-bold text-white">
              {(activeSchool?.code ?? user?.school?.code)?.slice(0, 2) ?? 'SM'}
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-slate-900">
                {activeSchool?.name ?? user?.school?.name ?? 'Platform'}
              </p>
              <p className="truncate text-xs text-slate-500">
                {activeSchool?.code ?? user?.school?.code ?? 'Super admin'}
              </p>
            </div>
          </div>

          {isPlatformStaff && (
            <div className="border-b border-slate-200 px-5 py-3">
              <label
                className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-slate-400"
                htmlFor="school-switcher"
              >
                Working in
              </label>
              <select
                id="school-switcher"
                className="input py-1.5 text-sm"
                value={activeSchoolId ?? ''}
                onChange={(e) => {
                  const next = e.target.value || null;
                  setActiveSchool(next);
                  // Leaving a school has nowhere school-scoped to land.
                  navigate(next ? '/' : '/platform');
                }}
              >
                <option value="">— No school selected —</option>
                {schools.data?.data.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.code})
                  </option>
                ))}
              </select>
              {!activeSchoolId && (
                <p className="mt-1.5 text-xs text-slate-500">
                  Pick a school to open its records.
                </p>
              )}
            </div>
          )}

          <nav className="flex-1 overflow-y-auto px-3 py-4">
            {visibleSections.map((section) => (
              <div key={section.section} className="mb-5">
                <p className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  {section.section}
                </p>
                <ul className="space-y-0.5">
                  {section.items.map((item) => (
                    <li key={item.to + item.label}>
                      <NavLink
                        to={item.to}
                        end={item.to === '/'}
                        onClick={() => setMenuOpen(false)}
                        className={({ isActive }) =>
                          `flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
                            isActive
                              ? 'bg-brand-50 font-medium text-brand-700'
                              : 'text-slate-600 hover:bg-slate-100'
                          }`
                        }
                      >
                        <span aria-hidden="true" className="w-4 text-center">
                          {item.icon}
                        </span>
                        {item.label}
                      </NavLink>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>

          <div className="border-t border-slate-200 p-4">
            <div className="mb-3 flex items-center gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-200 text-xs font-semibold text-slate-700">
                {user ? initials(user) : '?'}
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-slate-900">
                  {user?.firstName} {user?.lastName}
                </p>
                <p className="truncate text-xs text-slate-500">
                  {user ? titleCase(user.role) : ''}
                </p>
              </div>
            </div>
            <button type="button" onClick={handleSignOut} className="btn-secondary w-full">
              Sign out
            </button>
          </div>
        </div>
      </aside>

      <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8">
        <Outlet />
      </main>
    </div>
  );
}
