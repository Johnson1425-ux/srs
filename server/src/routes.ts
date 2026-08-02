import { Router } from 'express';
import { authenticate, requireSchool } from './middleware/auth.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { schoolRouter } from './modules/schools/school.routes.js';
import { academicsRouter } from './modules/academics/academics.routes.js';
import { studentRouter } from './modules/students/student.routes.js';
import { guardianRouter } from './modules/guardians/guardian.routes.js';
import { staffRouter } from './modules/staff/staff.routes.js';
import { attendanceRouter } from './modules/attendance/attendance.routes.js';
import { examRouter, resultRouter } from './modules/exams/exam.routes.js';
import { feeRouter, invoiceRouter, paymentRouter } from './modules/fees/fee.routes.js';
import { accountingRouter } from './modules/accounting/accounting.routes.js';
import { libraryRouter } from './modules/library/library.routes.js';
import { inventoryRouter } from './modules/inventory/inventory.routes.js';
import { transportRouter } from './modules/transport/transport.routes.js';
import { hostelRouter } from './modules/hostel/hostel.routes.js';
import { communicationRouter } from './modules/communication/communication.routes.js';
import { reportRouter } from './modules/reports/report.routes.js';
import { dashboardRouter } from './modules/dashboard/dashboard.routes.js';
import { userRouter } from './modules/users/user.routes.js';
import { portalRouter } from './modules/portal/portal.routes.js';
import { platformRouter } from './modules/platform/platform.routes.js';
import { documentRouter } from './modules/documents/document.routes.js';

export const apiRouter: Router = Router();

// Public
apiRouter.use('/auth', authRouter);

// Everything below requires a valid access token.
apiRouter.use(authenticate);

// Self-service portals for students and parents (scoped to the caller).
apiRouter.use('/portal', portalRouter);

// Platform (multi-school SaaS) administration.
apiRouter.use('/platform', platformRouter);

// School-scoped resources.
apiRouter.use(requireSchool);

apiRouter.use('/settings', schoolRouter);
apiRouter.use('/users', userRouter);
apiRouter.use('/academics', academicsRouter);
apiRouter.use('/students', studentRouter);
apiRouter.use('/parents', guardianRouter);
apiRouter.use('/staff', staffRouter);
apiRouter.use('/attendance', attendanceRouter);
apiRouter.use('/exams', examRouter);
apiRouter.use('/results', resultRouter);
apiRouter.use('/fees', feeRouter);
apiRouter.use('/invoices', invoiceRouter);
apiRouter.use('/payments', paymentRouter);
apiRouter.use('/accounting', accountingRouter);
apiRouter.use('/library', libraryRouter);
apiRouter.use('/inventory', inventoryRouter);
apiRouter.use('/transport', transportRouter);
apiRouter.use('/hostel', hostelRouter);
apiRouter.use('/notifications', communicationRouter);
apiRouter.use('/documents', documentRouter);
apiRouter.use('/reports', reportRouter);
apiRouter.use('/dashboard', dashboardRouter);
