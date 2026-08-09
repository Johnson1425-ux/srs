import type { ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AppLayout } from './components/AppLayout';
import { Spinner } from './components/ui';
import { useAuth } from './lib/auth';
import type { Permission } from './lib/types';

import { LoginPage } from './pages/LoginPage';
import { DashboardPage } from './pages/DashboardPage';
import { StudentsPage } from './pages/StudentsPage';
import { StudentDetailPage } from './pages/StudentDetailPage';
import { ParentsPage } from './pages/ParentsPage';
import { StaffPage } from './pages/StaffPage';
import { AttendancePage } from './pages/AttendancePage';
import { ExamsPage } from './pages/ExamsPage';
import { MarksEntryPage } from './pages/MarksEntryPage';
import { ResultsPage } from './pages/ResultsPage';
import { AcademicsPage } from './pages/AcademicsPage';
import { TimetablePage } from './pages/TimetablePage';
import { FeesPage } from './pages/FeesPage';
import { PaymentsPage } from './pages/PaymentsPage';
import { AccountingPage } from './pages/AccountingPage';
import { LibraryPage } from './pages/LibraryPage';
import { InventoryPage } from './pages/InventoryPage';
import { TransportPage } from './pages/TransportPage';
import { CommunicationPage } from './pages/CommunicationPage';
import { ReportsPage } from './pages/ReportsPage';
import { SettingsPage } from './pages/SettingsPage';
import { UsersPage } from './pages/UsersPage';
import { PlatformPage } from './pages/PlatformPage';
import { PortalPage } from './pages/PortalPage';
import { NotFoundPage } from './pages/NotFoundPage';

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) return <Spinner label="Checking your session…" />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <>{children}</>;
}

function RequirePermission({
  permissions,
  children,
}: {
  permissions: Permission[];
  children: ReactNode;
}) {
  const { can } = useAuth();
  if (!can(...permissions)) {
    return (
      <div className="card p-8 text-center">
        <h1 className="text-lg font-semibold text-slate-900">Not available to your role</h1>
        <p className="mt-2 text-sm text-slate-500">
          You do not have permission to view this section. Contact your school administrator if you
          believe this is a mistake.
        </p>
      </div>
    );
  }
  return <>{children}</>;
}

/**
 * Families land on the portal, school staff on the dashboard.
 *
 * A super admin belongs to no school, so the dashboard has no tenant to load
 * until they pick one — send them to platform administration instead.
 */
function HomeRedirect() {
  const { hasRole, activeSchoolId } = useAuth();
  if (hasRole('PARENT', 'STUDENT')) return <Navigate to="/portal" replace />;
  if (hasRole('SUPER_ADMIN') && !activeSchoolId) return <Navigate to="/platform" replace />;
  return <DashboardPage />;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />

      <Route
        element={
          <RequireAuth>
            <AppLayout />
          </RequireAuth>
        }
      >
        <Route index element={<HomeRedirect />} />

        <Route path="portal" element={<PortalPage />} />
        <Route path="portal/:studentId" element={<PortalPage />} />

        <Route
          path="students"
          element={
            <RequirePermission permissions={['students:read']}>
              <StudentsPage />
            </RequirePermission>
          }
        />
        <Route
          path="students/:id"
          element={
            <RequirePermission permissions={['students:read']}>
              <StudentDetailPage />
            </RequirePermission>
          }
        />
        <Route
          path="parents"
          element={
            <RequirePermission permissions={['guardians:read']}>
              <ParentsPage />
            </RequirePermission>
          }
        />
        <Route
          path="staff"
          element={
            <RequirePermission permissions={['staff:read']}>
              <StaffPage />
            </RequirePermission>
          }
        />
        <Route
          path="attendance"
          element={
            <RequirePermission permissions={['attendance:read']}>
              <AttendancePage />
            </RequirePermission>
          }
        />
        <Route
          path="exams"
          element={
            <RequirePermission permissions={['exams:read']}>
              <ExamsPage />
            </RequirePermission>
          }
        />
        <Route
          path="exams/subjects/:examSubjectId/marks"
          element={
            <RequirePermission permissions={['exams:enter_marks', 'exams:read']}>
              <MarksEntryPage />
            </RequirePermission>
          }
        />
        <Route
          path="exams/:examId/results"
          element={
            <RequirePermission permissions={['exams:read']}>
              <ResultsPage />
            </RequirePermission>
          }
        />
        <Route
          path="academics"
          element={
            <RequirePermission permissions={['academics:read']}>
              <AcademicsPage />
            </RequirePermission>
          }
        />
        <Route
          path="timetable"
          element={
            <RequirePermission permissions={['academics:read']}>
              <TimetablePage />
            </RequirePermission>
          }
        />
        <Route
          path="fees"
          element={
            <RequirePermission permissions={['fees:read']}>
              <FeesPage />
            </RequirePermission>
          }
        />
        <Route
          path="payments"
          element={
            <RequirePermission permissions={['payments:read']}>
              <PaymentsPage />
            </RequirePermission>
          }
        />
        <Route
          path="accounting"
          element={
            <RequirePermission permissions={['accounting:read']}>
              <AccountingPage />
            </RequirePermission>
          }
        />
        <Route
          path="library"
          element={
            <RequirePermission permissions={['library:read']}>
              <LibraryPage />
            </RequirePermission>
          }
        />
        <Route
          path="inventory"
          element={
            <RequirePermission permissions={['inventory:read']}>
              <InventoryPage />
            </RequirePermission>
          }
        />
        <Route
          path="transport"
          element={
            <RequirePermission permissions={['transport:read']}>
              <TransportPage />
            </RequirePermission>
          }
        />
        <Route
          path="communication"
          element={
            <RequirePermission permissions={['communication:read']}>
              <CommunicationPage />
            </RequirePermission>
          }
        />
        <Route
          path="reports"
          element={
            <RequirePermission permissions={['reports:read']}>
              <ReportsPage />
            </RequirePermission>
          }
        />
        <Route
          path="users"
          element={
            <RequirePermission permissions={['users:read']}>
              <UsersPage />
            </RequirePermission>
          }
        />
        <Route
          path="settings"
          element={
            <RequirePermission permissions={['school:read']}>
              <SettingsPage />
            </RequirePermission>
          }
        />
        <Route path="platform" element={<PlatformPage />} />

        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
