export type Role =
  | 'SUPER_ADMIN'
  | 'SCHOOL_OWNER'
  | 'ADMIN'
  | 'ACCOUNTANT'
  | 'TEACHER'
  | 'STUDENT'
  | 'PARENT'
  | 'LIBRARIAN'
  | 'DRIVER'
  | 'RECEPTIONIST'
  | 'TRANSPORT_OFFICER';

export type Permission = string;

export interface School {
  id: string;
  name: string;
  code: string;
  logoUrl: string | null;
  currency: string;
  status: string;
  motto?: string | null;
}

export type DeploymentMode = 'saas' | 'standalone';

export interface Profile {
  id: string;
  email: string;
  phone: string | null;
  firstName: string;
  lastName: string;
  role: Role;
  status: string;
  schoolId: string | null;
  mustChangePassword: boolean;
  permissions: Permission[];
  /** Whether this installation is multi-school SaaS or a single owned copy. */
  deploymentMode: DeploymentMode;
  school: School | null;
  staff: { id: string; staffNumber: string; staffType: string } | null;
  student: { id: string; admissionNumber: string } | null;
  guardian: { id: string } | null;
}

export interface Paginated<T> {
  data: T[];
  meta: { page: number; pageSize: number; total: number; totalPages: number };
}

export interface Enrollment {
  id: string;
  schoolClass: { id: string; name: string; level: number };
  stream: { id: string; name: string } | null;
  academicYear: { id: string; name: string };
}

export interface Guardian {
  id: string;
  firstName: string;
  lastName: string;
  relationship: string;
  phone: string;
  email: string | null;
  occupation: string | null;
}

export interface Student {
  id: string;
  admissionNumber: string;
  firstName: string;
  middleName: string | null;
  lastName: string;
  gender: 'MALE' | 'FEMALE';
  dateOfBirth: string;
  address: string | null;
  photoUrl: string | null;
  status: 'ACTIVE' | 'SUSPENDED' | 'GRADUATED' | 'TRANSFERRED' | 'ARCHIVED';
  admissionDate: string;
  medicalConditions: string | null;
  previousSchool: string | null;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
  enrollments: Enrollment[];
  guardianLinks: Array<{ id: string; isPrimary: boolean; isFeePayer: boolean; guardian: Guardian }>;
}

export interface SchoolClass {
  id: string;
  name: string;
  level: number;
  streams: Array<{
    id: string;
    name: string;
    capacity: number;
    classTeacher: { id: string; firstName: string; lastName: string } | null;
    _count: { enrollments: number };
  }>;
  _count: { enrollments: number };
}

export interface Subject {
  id: string;
  name: string;
  code: string;
  isCore: boolean;
  passMark: number;
  department: { id: string; name: string } | null;
}

export interface AcademicYear {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  isCurrent: boolean;
  terms: Array<{ id: string; name: string; sequence: number; status: string }>;
}

export interface StaffMember {
  id: string;
  staffNumber: string;
  firstName: string;
  lastName: string;
  gender: 'MALE' | 'FEMALE';
  phone: string | null;
  email: string | null;
  staffType: 'TEACHING' | 'NON_TEACHING';
  jobTitle: string | null;
  employmentStatus: string;
  basicSalary: string | null;
  department: { id: string; name: string } | null;
  user: { id: string; email: string; role: Role; status: string } | null;
}

export type AttendanceStatus = 'PRESENT' | 'ABSENT' | 'LATE' | 'EXCUSED' | 'SICK';

export interface RegisterRow {
  id: string;
  admissionNumber: string;
  firstName: string;
  middleName: string | null;
  lastName: string;
  photoUrl: string | null;
  attendance: { status: AttendanceStatus; arrivalTime: string | null; note: string | null } | null;
}

export interface Exam {
  id: string;
  name: string;
  examType: string;
  status: 'DRAFT' | 'MARKS_ENTRY' | 'PUBLISHED';
  startDate: string | null;
  schoolClass: { id: string; name: string } | null;
  term: { id: string; name: string } | null;
  academicYear: { id: string; name: string };
  examSubjects: Array<{ id: string; maxScore: number; subject: { name: string; code: string } }>;
}

export interface ResultRow {
  studentId: string;
  admissionNumber: string;
  name: string;
  className: string | null;
  streamName: string | null;
  subjects: Array<{
    subject: string;
    code: string;
    score: number | null;
    maxScore: number;
    grade: string | null;
    points: number | null;
    isAbsent: boolean;
  }>;
  totalScore: number;
  totalMax: number;
  average: number;
  gpa: number | null;
  position: number | null;
}

export interface Invoice {
  id: string;
  invoiceNumber: string;
  issueDate: string;
  dueDate: string;
  subtotal: string;
  discountTotal: string;
  total: string;
  amountPaid: string;
  balance: string;
  status: 'DRAFT' | 'ISSUED' | 'PARTIALLY_PAID' | 'PAID' | 'CANCELLED';
  note: string | null;
  items: Array<{ id: string; category: string; name: string; amount: string }>;
  student?: { id: string; admissionNumber: string; firstName: string; lastName: string };
}

export interface Payment {
  id: string;
  receiptNumber: string;
  amount: string;
  method: string;
  provider: string | null;
  reference: string | null;
  payerName: string | null;
  status: string;
  paidAt: string;
  student?: { id: string; admissionNumber: string; firstName: string; lastName: string };
}

export interface DashboardData {
  date: string;
  widgets: {
    totalStudents: number;
    totalTeachers: number;
    totalStaff: number;
    newAdmissionsThisMonth: number;
    feeCollection: { thisMonth: string; paymentCount: number };
    outstandingFees: { total: string; invoiceCount: number };
    attendanceToday: {
      marked: number;
      notMarked: number;
      present: number;
      absent: number;
      late: number;
      rate: number | null;
    };
  };
  upcomingExams: Array<{
    id: string;
    name: string;
    examType: string;
    startDate: string | null;
    schoolClass: { name: string } | null;
  }>;
  recentPayments: Array<{
    id: string;
    receiptNumber: string;
    amount: string;
    method: string;
    paidAt: string;
    student: { firstName: string; lastName: string; admissionNumber: string };
  }>;
  announcements: Array<{
    id: string;
    title: string;
    body: string;
    publishedAt: string;
    isPinned: boolean;
  }>;
}

export interface PortalChild {
  id: string;
  admissionNumber: string;
  firstName: string;
  middleName: string | null;
  lastName: string;
  photoUrl: string | null;
  status: string;
  enrollments: Array<{
    schoolClass: { id: string; name: string };
    stream: { id: string; name: string } | null;
    academicYear: { name: string };
  }>;
}
