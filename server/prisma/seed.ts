/**
 * Seeds a demo tenant: Mlimani Secondary School, Dar es Salaam.
 *
 * Idempotent — re-running resets the demo school and rebuilds it, leaving any
 * other tenant untouched.
 */
import {
  AttendanceStatus,
  ExamStatus,
  ExamType,
  FeeCategory,
  Gender,
  MessageChannel,
  PaymentMethod,
  PrismaClient,
  Role,
  SchoolStatus,
  StaffType,
  SubscriptionPlan,
  TermStatus,
} from '@prisma/client';
import argon2 from 'argon2';

const prisma = new PrismaClient();

const SCHOOL_CODE = 'MLM';
const DEMO_PASSWORD = 'Passw0rd!';

const FIRST_NAMES_M = ['Juma', 'Baraka', 'Emmanuel', 'Hamisi', 'Frank', 'Joseph', 'Rashid', 'Elias', 'Peter', 'Iddi', 'Godfrey', 'Musa'];
const FIRST_NAMES_F = ['Neema', 'Amina', 'Grace', 'Zawadi', 'Halima', 'Upendo', 'Rehema', 'Sophia', 'Anna', 'Fatuma', 'Devota', 'Mwajuma'];
const SURNAMES = ['Mwakasege', 'Kimaro', 'Shirima', 'Mbwana', 'Nyerere', 'Mushi', 'Massawe', 'Lyimo', 'Kileo', 'Ndosi', 'Mrema', 'Sanga', 'Chuwa', 'Makame', 'Kessy'];

/** Deterministic pseudo-random so re-seeding produces the same demo data. */
let seedState = 42;
function rand(): number {
  seedState = (seedState * 1103515245 + 12345) % 2147483648;
  return seedState / 2147483648;
}
function pick<T>(items: T[]): T {
  return items[Math.floor(rand() * items.length)]!;
}
function randInt(min: number, max: number): number {
  return Math.floor(rand() * (max - min + 1)) + min;
}

async function main(): Promise<void> {
  console.log('Seeding demo data...');
  const passwordHash = await argon2.hash(DEMO_PASSWORD, { type: argon2.argon2id });

  // Wipe only the demo tenant; cascades clear its dependent rows.
  await prisma.school.deleteMany({ where: { code: SCHOOL_CODE } });

  // --- Platform super admin -------------------------------------------------
  await prisma.user.deleteMany({ where: { role: Role.SUPER_ADMIN, schoolId: null } });
  await prisma.user.create({
    data: {
      email: 'superadmin@sms.co.tz',
      firstName: 'Platform',
      lastName: 'Administrator',
      role: Role.SUPER_ADMIN,
      passwordHash,
    },
  });

  // --- School ---------------------------------------------------------------
  const school = await prisma.school.create({
    data: {
      name: 'Mlimani Secondary School',
      code: SCHOOL_CODE,
      motto: 'Elimu ni Ufunguo wa Maisha',
      email: 'info@mlimani.ac.tz',
      phone: '+255 22 245 1200',
      address: 'P.O. Box 35091, Ubungo',
      city: 'Dar es Salaam',
      region: 'Dar es Salaam',
      registrationNo: 'S.0912',
      status: SchoolStatus.ACTIVE,
      plan: SubscriptionPlan.STANDARD,
      planStartsAt: new Date('2026-01-01'),
      planEndsAt: new Date('2026-12-31'),
      maxStudents: 2000,
      storageQuotaMb: 10240,
      smsSenderId: 'MLIMANI',
    },
  });

  // --- Academic year and terms ---------------------------------------------
  const year = await prisma.academicYear.create({
    data: {
      schoolId: school.id,
      name: '2026',
      startDate: new Date('2026-01-12'),
      endDate: new Date('2026-12-04'),
      isCurrent: true,
      terms: {
        create: [
          { name: 'Term 1', sequence: 1, startDate: new Date('2026-01-12'), endDate: new Date('2026-04-10'), status: TermStatus.CLOSED },
          { name: 'Term 2', sequence: 2, startDate: new Date('2026-05-04'), endDate: new Date('2026-08-14'), status: TermStatus.ACTIVE },
          { name: 'Term 3', sequence: 3, startDate: new Date('2026-09-07'), endDate: new Date('2026-12-04'), status: TermStatus.UPCOMING },
        ],
      },
    },
    include: { terms: { orderBy: { sequence: 'asc' } } },
  });
  const [term1, term2] = year.terms;

  // --- Grading scale --------------------------------------------------------
  const gradeScale = await prisma.gradeScale.create({
    data: {
      schoolId: school.id,
      name: 'NECTA O-Level',
      isDefault: true,
      bands: {
        create: [
          { grade: 'A', minScore: 75, maxScore: 100, points: 5, remark: 'Excellent' },
          { grade: 'B', minScore: 65, maxScore: 74.99, points: 4, remark: 'Very Good' },
          { grade: 'C', minScore: 45, maxScore: 64.99, points: 3, remark: 'Good' },
          { grade: 'D', minScore: 30, maxScore: 44.99, points: 2, remark: 'Satisfactory' },
          { grade: 'F', minScore: 0, maxScore: 29.99, points: 1, remark: 'Fail' },
        ],
      },
    },
  });

  // --- Departments and subjects --------------------------------------------
  const departments = await Promise.all(
    ['Sciences', 'Languages', 'Humanities', 'Mathematics'].map((name) =>
      prisma.department.create({ data: { schoolId: school.id, name } }),
    ),
  );
  const [sciences, languages, humanities, maths] = departments;

  const subjectSpecs = [
    { name: 'Mathematics', code: 'MTH', departmentId: maths!.id },
    { name: 'Physics', code: 'PHY', departmentId: sciences!.id },
    { name: 'Chemistry', code: 'CHE', departmentId: sciences!.id },
    { name: 'Biology', code: 'BIO', departmentId: sciences!.id },
    { name: 'English Language', code: 'ENG', departmentId: languages!.id },
    { name: 'Kiswahili', code: 'KIS', departmentId: languages!.id },
    { name: 'History', code: 'HIS', departmentId: humanities!.id },
    { name: 'Geography', code: 'GEO', departmentId: humanities!.id },
    { name: 'Civics', code: 'CIV', departmentId: humanities!.id },
  ];
  const subjects = await Promise.all(
    subjectSpecs.map((s) => prisma.subject.create({ data: { ...s, schoolId: school.id } })),
  );

  // --- Classes and streams --------------------------------------------------
  const classes = [];
  for (let level = 1; level <= 4; level += 1) {
    const created = await prisma.schoolClass.create({
      data: {
        schoolId: school.id,
        name: `Form ${level}`,
        level,
        streams: { create: [{ name: 'A', capacity: 45 }, { name: 'B', capacity: 45 }] },
      },
      include: { streams: true },
    });
    classes.push(created);
  }

  // --- Staff ----------------------------------------------------------------
  async function createStaff(opts: {
    firstName: string;
    lastName: string;
    gender: Gender;
    role: Role;
    jobTitle: string;
    staffType?: StaffType;
    departmentId?: string;
    basicSalary: number;
    index: number;
  }) {
    const email = `${opts.firstName}.${opts.lastName}`.toLowerCase() + '@mlimani.ac.tz';
    const user = await prisma.user.create({
      data: {
        schoolId: school.id,
        email,
        phone: `+2557${randInt(10, 89)}${randInt(100000, 999999)}`,
        firstName: opts.firstName,
        lastName: opts.lastName,
        role: opts.role,
        passwordHash,
      },
    });
    return prisma.staff.create({
      data: {
        schoolId: school.id,
        userId: user.id,
        staffNumber: `EMP-${String(opts.index).padStart(4, '0')}`,
        firstName: opts.firstName,
        lastName: opts.lastName,
        gender: opts.gender,
        email,
        phone: user.phone,
        staffType: opts.staffType ?? StaffType.TEACHING,
        jobTitle: opts.jobTitle,
        departmentId: opts.departmentId ?? null,
        qualification: opts.staffType === StaffType.NON_TEACHING ? 'Diploma' : 'B.Ed',
        hireDate: new Date(`20${randInt(15, 24)}-0${randInt(1, 9)}-15`),
        basicSalary: opts.basicSalary,
        bankName: 'CRDB Bank',
        bankAccount: `015${randInt(1000000000, 1999999999)}`,
      },
    });
  }

  await prisma.user.create({
    data: {
      schoolId: school.id,
      email: 'owner@mlimani.ac.tz',
      firstName: 'Salma',
      lastName: 'Mwinyi',
      role: Role.SCHOOL_OWNER,
      passwordHash,
    },
  });

  const headTeacher = await createStaff({
    firstName: 'Daniel', lastName: 'Mwakalinga', gender: Gender.MALE, role: Role.ADMIN,
    jobTitle: 'Head Teacher', basicSalary: 2_400_000, index: 1,
  });
  await createStaff({
    firstName: 'Regina', lastName: 'Kessy', gender: Gender.FEMALE, role: Role.ACCOUNTANT,
    jobTitle: 'Bursar', staffType: StaffType.NON_TEACHING, basicSalary: 1_300_000, index: 2,
  });
  await createStaff({
    firstName: 'Yusuf', lastName: 'Ally', gender: Gender.MALE, role: Role.LIBRARIAN,
    jobTitle: 'Librarian', staffType: StaffType.NON_TEACHING, basicSalary: 780_000, index: 3,
  });
  await createStaff({
    firstName: 'Christina', lastName: 'Mbogo', gender: Gender.FEMALE, role: Role.RECEPTIONIST,
    jobTitle: 'Receptionist', staffType: StaffType.NON_TEACHING, basicSalary: 650_000, index: 4,
  });
  const driver = await createStaff({
    firstName: 'Salum', lastName: 'Mohamed', gender: Gender.MALE, role: Role.DRIVER,
    jobTitle: 'Driver', staffType: StaffType.NON_TEACHING, basicSalary: 600_000, index: 5,
  });

  const teacherSpecs = [
    { firstName: 'Anna', lastName: 'Shirima', gender: Gender.FEMALE, dept: maths!.id, subject: 'MTH' },
    { firstName: 'John', lastName: 'Mushi', gender: Gender.MALE, dept: sciences!.id, subject: 'PHY' },
    { firstName: 'Peter', lastName: 'Lyimo', gender: Gender.MALE, dept: sciences!.id, subject: 'CHE' },
    { firstName: 'Esther', lastName: 'Massawe', gender: Gender.FEMALE, dept: sciences!.id, subject: 'BIO' },
    { firstName: 'Grace', lastName: 'Kimaro', gender: Gender.FEMALE, dept: languages!.id, subject: 'ENG' },
    { firstName: 'Hassan', lastName: 'Mbwana', gender: Gender.MALE, dept: languages!.id, subject: 'KIS' },
    { firstName: 'Joyce', lastName: 'Ndosi', gender: Gender.FEMALE, dept: humanities!.id, subject: 'HIS' },
    { firstName: 'Michael', lastName: 'Sanga', gender: Gender.MALE, dept: humanities!.id, subject: 'GEO' },
  ];

  const teachers = [];
  for (const [i, spec] of teacherSpecs.entries()) {
    teachers.push(
      await createStaff({
        firstName: spec.firstName, lastName: spec.lastName, gender: spec.gender,
        role: Role.TEACHER, jobTitle: 'Teacher', departmentId: spec.dept,
        basicSalary: randInt(850, 1400) * 1000, index: 10 + i,
      }),
    );
  }

  // Class teachers and subject allocation
  for (const [i, schoolClass] of classes.entries()) {
    for (const [j, stream] of schoolClass.streams.entries()) {
      await prisma.stream.update({
        where: { id: stream.id },
        data: { classTeacherId: teachers[(i * 2 + j) % teachers.length]!.id },
      });
    }
    for (const [j, subject] of subjects.entries()) {
      const spec = teacherSpecs.findIndex((t) => t.subject === subject.code);
      await prisma.classSubject.create({
        data: {
          classId: schoolClass.id,
          subjectId: subject.id,
          teacherId: teachers[spec >= 0 ? spec : j % teachers.length]!.id,
        },
      });
    }
  }

  // --- Timetable (Monday–Friday, 8 periods) ---------------------------------
  const periods = ['08:00', '08:40', '09:20', '10:20', '11:00', '11:40', '13:00', '13:40'];
  for (const schoolClass of classes) {
    for (const stream of schoolClass.streams) {
      for (let day = 1; day <= 5; day += 1) {
        for (const [p, start] of periods.entries()) {
          const subject = subjects[(day + p) % subjects.length]!;
          const link = await prisma.classSubject.findUnique({
            where: { classId_subjectId: { classId: schoolClass.id, subjectId: subject.id } },
          });
          const [h, m] = start.split(':').map(Number);
          const end = `${String(h!).padStart(2, '0')}:${String(m! + 40 >= 60 ? m! - 20 : m! + 40).padStart(2, '0')}`;
          await prisma.timetableSlot.create({
            data: {
              schoolId: school.id,
              academicYearId: year.id,
              classId: schoolClass.id,
              streamId: stream.id,
              subjectId: subject.id,
              teacherId: link?.teacherId ?? null,
              dayOfWeek: day,
              startTime: start,
              endTime: end,
              room: `${schoolClass.name}${stream.name}`,
            },
          });
        }
      }
    }
  }

  // --- Students, guardians and enrolments -----------------------------------
  console.log('Creating students...');
  const students = [];
  let admissionSeq = 1;

  for (const schoolClass of classes) {
    for (const stream of schoolClass.streams) {
      for (let n = 0; n < 18; n += 1) {
        const gender = rand() > 0.5 ? Gender.MALE : Gender.FEMALE;
        const firstName = gender === Gender.MALE ? pick(FIRST_NAMES_M) : pick(FIRST_NAMES_F);
        const lastName = pick(SURNAMES);
        const middleName = pick(gender === Gender.MALE ? FIRST_NAMES_M : FIRST_NAMES_F);
        const birthYear = 2026 - (13 + schoolClass.level);

        const student = await prisma.student.create({
          data: {
            schoolId: school.id,
            admissionNumber: `${SCHOOL_CODE}/2026/${String(admissionSeq).padStart(4, '0')}`,
            firstName,
            middleName,
            lastName,
            gender,
            dateOfBirth: new Date(`${birthYear}-${String(randInt(1, 12)).padStart(2, '0')}-${String(randInt(1, 28)).padStart(2, '0')}`),
            address: `${pick(['Ubungo', 'Kinondoni', 'Temeke', 'Ilala', 'Kigamboni'])}, Dar es Salaam`,
            emergencyContactName: `${pick(FIRST_NAMES_F)} ${lastName}`,
            emergencyContactPhone: `+2556${randInt(10, 89)}${randInt(100000, 999999)}`,
            admissionDate: new Date(`2026-01-${String(randInt(12, 20)).padStart(2, '0')}`),
            enrollments: {
              create: { academicYearId: year.id, classId: schoolClass.id, streamId: stream.id, rollNumber: n + 1 },
            },
          },
        });

        // Guardian with a parent-portal login for the first student in each stream.
        const guardianGender = rand() > 0.5;
        const guardianFirst = guardianGender ? pick(FIRST_NAMES_M) : pick(FIRST_NAMES_F);
        const phone = `+2557${randInt(10, 89)}${randInt(100000, 999999)}`;
        const withPortal = n === 0;

        let guardianUserId: string | null = null;
        if (withPortal) {
          const user = await prisma.user.create({
            data: {
              schoolId: school.id,
              email: `parent.${schoolClass.level}${stream.name.toLowerCase()}@mlimani.ac.tz`,
              phone,
              firstName: guardianFirst,
              lastName,
              role: Role.PARENT,
              passwordHash,
            },
          });
          guardianUserId = user.id;
        }

        const guardian = await prisma.guardian.create({
          data: {
            schoolId: school.id,
            userId: guardianUserId,
            firstName: guardianFirst,
            lastName,
            relationship: guardianGender ? 'Father' : 'Mother',
            phone,
            email: withPortal ? `parent.${schoolClass.level}${stream.name.toLowerCase()}@mlimani.ac.tz` : null,
            occupation: pick(['Farmer', 'Teacher', 'Trader', 'Nurse', 'Engineer', 'Driver', 'Tailor']),
            address: `${pick(['Ubungo', 'Kinondoni', 'Temeke'])}, Dar es Salaam`,
          },
        });
        await prisma.studentGuardian.create({
          data: { studentId: student.id, guardianId: guardian.id, isPrimary: true, isFeePayer: true },
        });

        // Student portal login for the first student in each stream.
        if (withPortal) {
          const user = await prisma.user.create({
            data: {
              schoolId: school.id,
              email: `student.${schoolClass.level}${stream.name.toLowerCase()}@mlimani.ac.tz`,
              firstName,
              lastName,
              role: Role.STUDENT,
              passwordHash,
            },
          });
          await prisma.student.update({ where: { id: student.id }, data: { userId: user.id } });
        }

        students.push({ ...student, classId: schoolClass.id, streamId: stream.id, level: schoolClass.level });
        admissionSeq += 1;
      }
    }
  }
  console.log(`  ${students.length} students created`);

  // --- Attendance for the last 20 school days -------------------------------
  console.log('Recording attendance...');
  const attendanceRows: Array<{
    schoolId: string; studentId: string; streamId: string; date: Date; status: AttendanceStatus;
  }> = [];

  const cursor = new Date('2026-07-31T00:00:00.000Z');
  const days: Date[] = [];
  while (days.length < 20) {
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) days.push(new Date(cursor));
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }

  for (const date of days) {
    for (const student of students) {
      const roll = rand();
      const status =
        roll > 0.94 ? AttendanceStatus.ABSENT
        : roll > 0.90 ? AttendanceStatus.LATE
        : roll > 0.88 ? AttendanceStatus.SICK
        : AttendanceStatus.PRESENT;
      attendanceRows.push({
        schoolId: school.id, studentId: student.id, streamId: student.streamId, date, status,
      });
    }
  }
  await prisma.attendanceRecord.createMany({ data: attendanceRows });
  console.log(`  ${attendanceRows.length} attendance records`);

  // --- Exams and results ----------------------------------------------------
  console.log('Creating exams and results...');
  for (const schoolClass of classes) {
    const exam = await prisma.exam.create({
      data: {
        schoolId: school.id,
        academicYearId: year.id,
        termId: term1!.id,
        classId: schoolClass.id,
        gradeScaleId: gradeScale.id,
        name: `Term 1 Terminal Examination — ${schoolClass.name}`,
        examType: ExamType.TERMINAL,
        startDate: new Date('2026-03-23'),
        endDate: new Date('2026-04-03'),
        status: ExamStatus.PUBLISHED,
        publishedAt: new Date('2026-04-08'),
        examSubjects: {
          create: subjects.map((s) => ({ subjectId: s.id, maxScore: 100, examDate: new Date('2026-03-25') })),
        },
      },
      include: { examSubjects: true },
    });

    const bands = await prisma.gradeBand.findMany({
      where: { gradeScaleId: gradeScale.id },
      orderBy: { minScore: 'desc' },
    });

    const classStudents = students.filter((s) => s.classId === schoolClass.id);
    const results = [];
    for (const examSubject of exam.examSubjects) {
      for (const student of classStudents) {
        const absent = rand() > 0.97;
        const score = absent ? null : Math.min(100, Math.max(8, Math.round(randInt(28, 92) + (rand() - 0.5) * 12)));
        const band = score === null ? null : bands.find((b) => score >= b.minScore && score <= b.maxScore);
        results.push({
          examId: exam.id,
          examSubjectId: examSubject.id,
          studentId: student.id,
          score,
          isAbsent: absent,
          grade: band?.grade ?? null,
          points: band?.points ?? null,
          remark: band?.remark ?? null,
        });
      }
    }
    await prisma.examResult.createMany({ data: results });

    // Term 2 midterm still open for marks entry.
    await prisma.exam.create({
      data: {
        schoolId: school.id,
        academicYearId: year.id,
        termId: term2!.id,
        classId: schoolClass.id,
        gradeScaleId: gradeScale.id,
        name: `Term 2 Midterm — ${schoolClass.name}`,
        examType: ExamType.MIDTERM,
        startDate: new Date('2026-08-17'),
        endDate: new Date('2026-08-21'),
        status: ExamStatus.DRAFT,
        examSubjects: { create: subjects.map((s) => ({ subjectId: s.id, maxScore: 50 })) },
      },
    });
  }

  // --- Fees -----------------------------------------------------------------
  console.log('Billing fees...');
  const tuitionByLevel: Record<number, number> = { 1: 450_000, 2: 450_000, 3: 520_000, 4: 560_000 };
  let invoiceSeq = 1;
  let receiptSeq = 1;

  for (const schoolClass of classes) {
    const structure = await prisma.feeStructure.create({
      data: {
        schoolId: school.id,
        academicYearId: year.id,
        termId: term2!.id,
        classId: schoolClass.id,
        name: `${schoolClass.name} — Term 2 2026`,
        items: {
          create: [
            { category: FeeCategory.TUITION, name: 'Tuition', amount: tuitionByLevel[schoolClass.level]! },
            { category: FeeCategory.MEALS, name: 'Lunch programme', amount: 120_000 },
            { category: FeeCategory.EXAMINATION, name: 'Examination fee', amount: 35_000 },
            { category: FeeCategory.LIBRARY, name: 'Library', amount: 15_000 },
          ],
        },
      },
      include: { items: true },
    });

    const subtotal = structure.items.reduce((acc, i) => acc + Number(i.amount), 0);
    const classStudents = students.filter((s) => s.classId === schoolClass.id);

    for (const student of classStudents) {
      const invoice = await prisma.invoice.create({
        data: {
          schoolId: school.id,
          studentId: student.id,
          academicYearId: year.id,
          termId: term2!.id,
          invoiceNumber: `INV-2026-${String(invoiceSeq).padStart(5, '0')}`,
          issueDate: new Date('2026-05-06'),
          dueDate: new Date('2026-06-15'),
          subtotal,
          total: subtotal,
          balance: subtotal,
          note: structure.name,
          items: {
            create: structure.items.map((i) => ({ category: i.category, name: i.name, amount: i.amount })),
          },
        },
      });
      invoiceSeq += 1;

      // ~72% of families have paid something.
      const roll = rand();
      if (roll > 0.28) {
        const full = roll > 0.55;
        const amount = full ? subtotal : Math.round((subtotal * randInt(30, 80)) / 100 / 1000) * 1000;
        const method = pick([
          PaymentMethod.MOBILE_MONEY, PaymentMethod.MOBILE_MONEY, PaymentMethod.BANK, PaymentMethod.CASH,
        ]);

        const payment = await prisma.payment.create({
          data: {
            schoolId: school.id,
            studentId: student.id,
            receiptNumber: `RCT-2026-${String(receiptSeq).padStart(5, '0')}`,
            amount,
            method,
            provider: method === PaymentMethod.MOBILE_MONEY
              ? pick(['MPESA', 'AIRTEL_MONEY', 'MIXX_BY_YAS', 'HALOPESA'] as const)
              : null,
            reference: method === PaymentMethod.CASH ? null : `TXN${randInt(100000000, 999999999)}`,
            payerName: `${student.firstName} ${student.lastName} (guardian)`,
            paidAt: new Date(`2026-0${randInt(5, 7)}-${String(randInt(1, 28)).padStart(2, '0')}`),
            allocations: { create: { invoiceId: invoice.id, amount } },
          },
        });
        receiptSeq += 1;

        await prisma.invoice.update({
          where: { id: invoice.id },
          data: {
            amountPaid: amount,
            balance: subtotal - amount,
            status: amount >= subtotal ? 'PAID' : 'PARTIALLY_PAID',
          },
        });

        await prisma.ledgerEntry.create({
          data: {
            schoolId: school.id,
            entryType: 'INCOME',
            category: 'Fees',
            description: `Fee payment ${payment.receiptNumber}`,
            amount,
            entryDate: payment.paidAt,
            reference: payment.receiptNumber,
            paymentId: payment.id,
          },
        });
      }
    }
  }

  // --- Operating expenses ---------------------------------------------------
  const expenses = [
    { category: 'Utilities', description: 'TANESCO electricity — June', amount: 1_850_000 },
    { category: 'Utilities', description: 'DAWASA water — June', amount: 640_000 },
    { category: 'Supplies', description: 'Laboratory reagents', amount: 2_300_000 },
    { category: 'Transport', description: 'Fuel — school buses', amount: 3_100_000 },
    { category: 'Maintenance', description: 'Classroom block repainting', amount: 4_500_000 },
    { category: 'Salaries', description: 'Payroll June 2026', amount: 22_400_000 },
  ];
  await prisma.ledgerEntry.createMany({
    data: expenses.map((e, i) => ({
      schoolId: school.id,
      entryType: 'EXPENSE' as const,
      ...e,
      entryDate: new Date(`2026-06-${String(5 + i * 3).padStart(2, '0')}`),
    })),
  });

  // --- Library --------------------------------------------------------------
  const books = [
    { title: 'Physics for Secondary Schools Book 3', author: 'TIE', category: 'Sciences', totalCopies: 40 },
    { title: 'Basic Mathematics Form 4', author: 'TIE', category: 'Mathematics', totalCopies: 45 },
    { title: 'Kiswahili Kidato cha Tatu', author: 'TIE', category: 'Languages', totalCopies: 38 },
    { title: 'Things Fall Apart', author: 'Chinua Achebe', category: 'Literature', totalCopies: 25 },
    { title: 'Shamba la Wanyama', author: 'George Orwell', category: 'Literature', totalCopies: 30 },
    { title: 'History of Tanzania', author: 'I. N. Kimambo', category: 'Humanities', totalCopies: 20 },
    { title: 'Biology Form 2', author: 'TIE', category: 'Sciences', totalCopies: 42 },
    { title: 'An Introduction to Chemistry', author: 'J. Mkumbwa', category: 'Sciences', totalCopies: 28 },
  ];
  for (const [i, b] of books.entries()) {
    const book = await prisma.book.create({
      data: {
        schoolId: school.id,
        ...b,
        isbn: `978-9987-${randInt(10, 99)}-${randInt(100, 999)}-${randInt(0, 9)}`,
        barcode: `MLM-BK-${String(i + 1).padStart(4, '0')}`,
        shelf: `S${randInt(1, 8)}`,
        availableCopies: b.totalCopies,
      },
    });

    // A handful of loans, some already overdue.
    for (let n = 0; n < 3; n += 1) {
      const student = pick(students);
      const overdue = n === 0;
      await prisma.bookLoan.create({
        data: {
          schoolId: school.id,
          bookId: book.id,
          studentId: student.id,
          borrowedAt: new Date(overdue ? '2026-06-20' : '2026-07-25'),
          dueDate: new Date(overdue ? '2026-07-04' : '2026-08-08'),
          status: overdue ? 'OVERDUE' : 'BORROWED',
        },
      });
      await prisma.book.update({ where: { id: book.id }, data: { availableCopies: { decrement: 1 } } });
    }
  }

  // --- Inventory ------------------------------------------------------------
  const supplier = await prisma.supplier.create({
    data: {
      schoolId: school.id,
      name: 'Kariakoo Stationers Ltd',
      phone: '+255 754 221 900',
      email: 'sales@kariakoostationers.co.tz',
      tin: '112-345-678',
    },
  });
  await prisma.inventoryItem.createMany({
    data: [
      { schoolId: school.id, name: 'Exercise books (96 pages)', category: 'STATIONERY', unit: 'piece', quantity: 1200, reorderLevel: 300, unitCost: 900 },
      { schoolId: school.id, name: 'Whiteboard markers', category: 'STATIONERY', unit: 'piece', quantity: 85, reorderLevel: 100, unitCost: 2500 },
      { schoolId: school.id, name: 'Student desks', category: 'FURNITURE', unit: 'piece', quantity: 340, reorderLevel: 20, unitCost: 65000 },
      { schoolId: school.id, name: 'Microscopes', category: 'LAB_EQUIPMENT', unit: 'piece', quantity: 12, reorderLevel: 4, unitCost: 480000 },
      { schoolId: school.id, name: 'Bunsen burners', category: 'LAB_EQUIPMENT', unit: 'piece', quantity: 24, reorderLevel: 8, unitCost: 55000 },
      { schoolId: school.id, name: 'Desktop computers', category: 'ASSET', unit: 'piece', quantity: 22, reorderLevel: 5, unitCost: 900000 },
    ],
  });
  await prisma.purchaseOrder.create({
    data: {
      schoolId: school.id,
      supplierId: supplier.id,
      orderNumber: 'PO-2026-0001',
      status: 'SENT',
      total: 750_000,
      lines: { create: [{ description: 'Whiteboard markers (box of 10)', quantity: 30, unitPrice: 25_000 }] },
    },
  });

  // --- Transport ------------------------------------------------------------
  const bus = await prisma.vehicle.create({
    data: {
      schoolId: school.id,
      plateNumber: 'T 123 ABC',
      model: 'Toyota Coaster',
      capacity: 30,
      driverId: driver.id,
      insuranceExpiry: new Date('2027-02-28'),
    },
  });
  const route = await prisma.transportRoute.create({
    data: {
      schoolId: school.id,
      name: 'Ubungo — Mbezi',
      vehicleId: bus.id,
      fare: 180_000,
      stops: [
        { name: 'Ubungo Terminal', pickupTime: '06:15' },
        { name: 'Kimara Mwisho', pickupTime: '06:35' },
        { name: 'Mbezi Beach', pickupTime: '06:55' },
      ],
    },
  });
  for (const student of students.slice(0, 22)) {
    await prisma.transportAllocation.create({
      data: { routeId: route.id, studentId: student.id, pickupStop: pick(['Ubungo Terminal', 'Kimara Mwisho', 'Mbezi Beach']) },
    });
  }
  await prisma.fuelLog.create({
    data: { vehicleId: bus.id, litres: 120, cost: 372_000, odometer: 148_920, filledAt: new Date('2026-07-28') },
  });

  // --- Hostel ---------------------------------------------------------------
  for (const [name, gender] of [['Kilimanjaro House', Gender.MALE], ['Meru House', Gender.FEMALE]] as const) {
    await prisma.hostel.create({
      data: {
        schoolId: school.id,
        name,
        gender,
        rooms: { create: Array.from({ length: 6 }, (_, i) => ({ roomNumber: `${name[0]}${i + 1}`, bedCount: 6 })) },
      },
    });
  }

  // --- Communication --------------------------------------------------------
  await prisma.announcement.createMany({
    data: [
      {
        schoolId: school.id,
        title: 'Term 2 parents meeting',
        body: 'All parents and guardians are invited to the Term 2 academic review meeting on Saturday 16 August 2026 at 09:00 in the school hall.',
        audience: ['ALL'],
        isPinned: true,
        publishedAt: new Date('2026-07-28'),
      },
      {
        schoolId: school.id,
        title: 'Midterm examinations timetable',
        body: 'Term 2 midterm examinations run from 17 to 21 August 2026. Students should report by 07:30 each day.',
        audience: ['STUDENT', 'PARENT', 'TEACHER'],
        publishedAt: new Date('2026-07-30'),
      },
      {
        schoolId: school.id,
        title: 'Staff briefing',
        body: 'Weekly staff briefing moved to Monday 08:00 in the staff room.',
        audience: ['TEACHER', 'ADMIN'],
        publishedAt: new Date('2026-08-01'),
      },
    ],
  });
  await prisma.messageTemplate.createMany({
    data: [
      {
        schoolId: school.id,
        name: 'Fee reminder',
        channel: MessageChannel.SMS,
        body: 'Dear {{guardianName}}, the outstanding balance for {{studentName}} is TZS {{balance}} (invoice {{invoiceNumber}}). Kindly settle before the due date. Mlimani Secondary School.',
      },
      {
        schoolId: school.id,
        name: 'Absence alert',
        channel: MessageChannel.SMS,
        body: 'Dear {{guardianName}}, your child {{studentName}} was marked absent on {{date}}. Please contact the school office.',
      },
    ],
  });

  // --- Assignments ----------------------------------------------------------
  for (const schoolClass of classes.slice(0, 2)) {
    for (const subject of subjects.slice(0, 3)) {
      const link = await prisma.classSubject.findUnique({
        where: { classId_subjectId: { classId: schoolClass.id, subjectId: subject.id } },
      });
      await prisma.assignment.create({
        data: {
          schoolId: school.id,
          classId: schoolClass.id,
          subjectId: subject.id,
          teacherId: link?.teacherId ?? null,
          title: `${subject.name} — exercise set ${randInt(1, 9)}`,
          instructions: 'Complete all questions in your exercise book and submit before the due date.',
          maxScore: 20,
          dueDate: new Date(`2026-08-${String(randInt(6, 28)).padStart(2, '0')}`),
        },
      });
    }
  }

  // --- Head teacher owns the Form 1A stream --------------------------------
  await prisma.stream.update({
    where: { id: classes[0]!.streams[0]!.id },
    data: { classTeacherId: headTeacher.id },
  });

  console.log('\nSeed complete.\n');
  console.log('  Sign in at /login with password:', DEMO_PASSWORD);
  console.log('  ─────────────────────────────────────────────');
  console.log('  Super admin   superadmin@sms.co.tz');
  console.log('  School owner  owner@mlimani.ac.tz');
  console.log('  Administrator daniel.mwakalinga@mlimani.ac.tz');
  console.log('  Accountant    regina.kessy@mlimani.ac.tz');
  console.log('  Teacher       anna.shirima@mlimani.ac.tz');
  console.log('  Librarian     yusuf.ally@mlimani.ac.tz');
  console.log('  Parent        parent.1a@mlimani.ac.tz');
  console.log('  Student       student.1a@mlimani.ac.tz');
  console.log('  ─────────────────────────────────────────────');
  console.log(`  School code: ${SCHOOL_CODE}\n`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
