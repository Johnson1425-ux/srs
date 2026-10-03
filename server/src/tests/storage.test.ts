import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { prisma } from '../db/prisma.js';
import {
  LocalStorageDriver,
  setStorageDriver,
  storageKey,
  type PutInput,
  type StorageDriver,
  type StoredObject,
} from '../lib/storage/index.js';
import { sniffMimeType } from '../lib/upload.js';
import {
  type Fixture,
  app,
  authed,
  createSchoolFixture,
  destroyFixture,
  login,
} from './fixtures.js';

/**
 * A driver that keeps objects in a Map.
 *
 * Most of what these tests check — quota arithmetic, the type allowlist, tenant
 * scoping — is about the code around storage rather than storage itself, and a
 * Map makes those assertions exact: what was stored, and what was removed.
 */
function stubDriver(): StorageDriver & { objects: Map<string, PutInput>; removed: string[] } {
  const objects = new Map<string, PutInput>();
  const removed: string[] = [];
  return {
    name: 'stub',
    objects,
    removed,
    async put(input: PutInput): Promise<StoredObject> {
      objects.set(input.key, input);
      return { key: input.key, sizeBytes: input.body.byteLength, mimeType: input.mimeType };
    },
    async signedUrl(key: string, expiresIn: number): Promise<string> {
      return `https://bucket.test/${key}?expires=${expiresIn}`;
    },
    async remove(key: string): Promise<void> {
      removed.push(key);
      objects.delete(key);
    },
  };
}

/** The smallest byte sequences that each sniff as the real thing. */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32, 7),
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 9)]);
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n', 'latin1'), Buffer.alloc(32, 3)]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF', 'latin1'),
  Buffer.alloc(4, 0),
  Buffer.from('WEBP', 'latin1'),
  Buffer.alloc(32, 1),
]);

describe('object storage', () => {
  let fixture: Fixture;
  let adminToken: string;
  let driver: ReturnType<typeof stubDriver>;

  beforeAll(async () => {
    fixture = await createSchoolFixture();
    adminToken = await login(fixture.users.admin!.email);
  });

  afterAll(async () => {
    await destroyFixture(fixture);
    setStorageDriver(null);
  });

  afterEach(async () => {
    await prisma.document.deleteMany({ where: { schoolId: fixture.school.id } });
    await prisma.student.updateMany({
      where: { schoolId: fixture.school.id },
      data: { photoFileId: null },
    });
    await prisma.storedFile.deleteMany({ where: { schoolId: fixture.school.id } });
    await prisma.school.update({
      where: { id: fixture.school.id },
      data: { storageQuotaMb: 1024 },
    });
  });

  // The stub is installed fresh for each test so `objects` and `removed` only
  // ever describe that test.
  const useStub = () => {
    driver = stubDriver();
    setStorageDriver(driver);
    return driver;
  };

  describe('content sniffing', () => {
    it('identifies each accepted type from its leading bytes', () => {
      expect(sniffMimeType(PNG)).toBe('image/png');
      expect(sniffMimeType(JPEG)).toBe('image/jpeg');
      expect(sniffMimeType(PDF)).toBe('application/pdf');
      expect(sniffMimeType(WEBP)).toBe('image/webp');
    });

    it('does not identify something that only claims to be a known type', () => {
      expect(sniffMimeType(Buffer.from('MZ\x90\x00this is a windows binary'))).toBeNull();
      expect(sniffMimeType(Buffer.from('<?php echo 1; ?>                '))).toBeNull();
      expect(sniffMimeType(Buffer.alloc(4))).toBeNull();
    });
  });

  describe('keys', () => {
    it('namespaces every key under its school', () => {
      const key = storageKey('school-abc', 'documents', 'birth cert.pdf');
      expect(key.startsWith('schools/school-abc/documents/')).toBe(true);
    });

    it('keeps the extension but not the uploaded name', () => {
      const key = storageKey('s1', 'photos', 'My Holiday Photo.JPG');
      expect(key.endsWith('.jpg')).toBe(true);
      expect(key).not.toContain('Holiday');
    });

    it('drops an extension that is not a plain suffix', () => {
      expect(storageKey('s1', 'documents', 'passwd.tar.gz/../../etc')).toMatch(
        /^schools\/s1\/documents\/[0-9a-f-]+$/,
      );
    });

    it('does not reuse a key for the same filename', () => {
      expect(storageKey('s1', 'documents', 'a.pdf')).not.toBe(storageKey('s1', 'documents', 'a.pdf'));
    });
  });

  describe('document upload', () => {
    it('stores the file and records it against the student', async () => {
      const stub = useStub();
      const res = await request(app)
        .post('/api/v1/documents/upload')
        .set(authed(adminToken))
        .field('studentId', fixture.students[0]!.id)
        .field('docType', 'BIRTH_CERTIFICATE')
        .field('title', 'Birth certificate')
        .attach('file', PDF, 'birth-certificate.pdf');

      expect(res.status).toBe(201);
      expect(res.body.storedFile.mimeType).toBe('application/pdf');
      expect(res.body.storedFile.sizeBytes).toBe(PDF.byteLength);
      expect(res.body.storedFile.filename).toBe('birth-certificate.pdf');

      // One object, under this school's prefix, holding exactly the bytes sent.
      expect(stub.objects.size).toBe(1);
      const [key, stored] = [...stub.objects.entries()][0]!;
      expect(key.startsWith(`schools/${fixture.school.id}/documents/`)).toBe(true);
      expect(stored.body.equals(PDF)).toBe(true);

      const ledger = await prisma.storedFile.findMany({
        where: { schoolId: fixture.school.id },
      });
      expect(ledger).toHaveLength(1);
      expect(ledger[0]!.purpose).toBe('DOCUMENT');
      expect(ledger[0]!.uploadedById).toBe(fixture.users.admin!.id);
    });

    it('trusts the bytes over the declared content type', async () => {
      useStub();
      const res = await request(app)
        .post('/api/v1/documents/upload')
        .set(authed(adminToken))
        .field('studentId', fixture.students[0]!.id)
        .field('docType', 'ID_COPY')
        .field('title', 'Mislabelled scan')
        // Claims to be a PDF; the bytes are a PNG.
        .attach('file', PNG, { filename: 'scan.pdf', contentType: 'application/pdf' });

      expect(res.status).toBe(201);
      expect(res.body.storedFile.mimeType).toBe('image/png');
    });

    it('refuses a type that is not on the allowlist, whatever it is named', async () => {
      const stub = useStub();
      const res = await request(app)
        .post('/api/v1/documents/upload')
        .set(authed(adminToken))
        .field('studentId', fixture.students[0]!.id)
        .field('docType', 'OTHER')
        .field('title', 'Not a document')
        .attach('file', Buffer.from('MZ\x90\x00executable payload here'), {
          filename: 'invoice.pdf',
          contentType: 'application/pdf',
        });

      expect(res.status).toBe(400);
      // Nothing reached the bucket, so nothing needs cleaning up.
      expect(stub.objects.size).toBe(0);
      expect(await prisma.storedFile.count({ where: { schoolId: fixture.school.id } })).toBe(0);
    });

    it('refuses an empty file', async () => {
      useStub();
      const res = await request(app)
        .post('/api/v1/documents/upload')
        .set(authed(adminToken))
        .field('studentId', fixture.students[0]!.id)
        .field('docType', 'OTHER')
        .field('title', 'Empty')
        .attach('file', Buffer.alloc(0), 'empty.pdf');

      expect(res.status).toBe(400);
    });

    it('requires exactly one of student or staff', async () => {
      useStub();
      const both = await request(app)
        .post('/api/v1/documents/upload')
        .set(authed(adminToken))
        .field('studentId', fixture.students[0]!.id)
        .field('staffId', fixture.teacherStaffId)
        .field('docType', 'OTHER')
        .field('title', 'Ambiguous')
        .attach('file', PDF, 'a.pdf');
      expect(both.status).toBe(400);

      const neither = await request(app)
        .post('/api/v1/documents/upload')
        .set(authed(adminToken))
        .field('docType', 'OTHER')
        .field('title', 'Unattached')
        .attach('file', PDF, 'a.pdf');
      expect(neither.status).toBe(400);
    });

    it('will not file a document against another school\'s student', async () => {
      const stub = useStub();
      const other = await createSchoolFixture();
      try {
        const res = await request(app)
          .post('/api/v1/documents/upload')
          .set(authed(adminToken))
          .field('studentId', other.students[0]!.id)
          .field('docType', 'BIRTH_CERTIFICATE')
          .field('title', 'Someone else\'s child')
          .attach('file', PDF, 'a.pdf');

        expect(res.status).toBe(404);
        // The subject is checked before anything is stored.
        expect(stub.objects.size).toBe(0);
      } finally {
        await destroyFixture(other);
      }
    });

    it('rejects an upload that would exceed the quota, and stores nothing', async () => {
      const stub = useStub();
      // A quota of 1MB, already 1MB spent.
      await prisma.school.update({
        where: { id: fixture.school.id },
        data: { storageQuotaMb: 1 },
      });
      await prisma.storedFile.create({
        data: {
          schoolId: fixture.school.id,
          key: `schools/${fixture.school.id}/documents/already-there`,
          filename: 'big.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 1024 * 1024,
          purpose: 'DOCUMENT',
        },
      });

      const res = await request(app)
        .post('/api/v1/documents/upload')
        .set(authed(adminToken))
        .field('studentId', fixture.students[0]!.id)
        .field('docType', 'OTHER')
        .field('title', 'One byte too many')
        .attach('file', PDF, 'a.pdf');

      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/storage/i);
      expect(stub.objects.size).toBe(0);
    });

    it('refuses to upload when the school has no quota at all', async () => {
      useStub();
      await prisma.school.update({
        where: { id: fixture.school.id },
        data: { storageQuotaMb: 0 },
      });

      const res = await request(app)
        .post('/api/v1/documents/upload')
        .set(authed(adminToken))
        .field('studentId', fixture.students[0]!.id)
        .field('docType', 'OTHER')
        .field('title', 'No quota')
        .attach('file', PDF, 'a.pdf');

      expect(res.status).toBe(400);
    });

    it('needs permission to upload', async () => {
      useStub();
      const teacherToken = await login(fixture.users.teacher!.email);
      const res = await request(app)
        .post('/api/v1/documents/upload')
        .set(authed(teacherToken))
        .field('studentId', fixture.students[0]!.id)
        .field('docType', 'OTHER')
        .field('title', 'Not mine to file')
        .attach('file', PDF, 'a.pdf');

      expect(res.status).toBe(403);
    });
  });

  describe('download', () => {
    async function upload(): Promise<string> {
      const res = await request(app)
        .post('/api/v1/documents/upload')
        .set(authed(adminToken))
        .field('studentId', fixture.students[0]!.id)
        .field('docType', 'MEDICAL_REPORT')
        .field('title', 'Medical report')
        .attach('file', PDF, 'medical.pdf');
      expect(res.status).toBe(201);
      return res.body.id as string;
    }

    it('hands back a time-limited URL rather than the bytes', async () => {
      useStub();
      const id = await upload();

      const res = await request(app)
        .get(`/api/v1/documents/${id}/file`)
        .set(authed(adminToken));

      expect(res.status).toBe(200);
      expect(res.body.external).toBe(false);
      expect(res.body.url).toContain(`schools/${fixture.school.id}/documents/`);
      expect(res.body.filename).toBe('medical.pdf');
      expect(res.body.expiresInSeconds).toBeGreaterThan(0);
    });

    it('returns the stored link for a document that was never uploaded here', async () => {
      useStub();
      const external = await prisma.document.create({
        data: {
          schoolId: fixture.school.id,
          studentId: fixture.students[0]!.id,
          docType: 'OTHER',
          title: 'On a shared drive',
          fileUrl: 'https://drive.example.test/some-file',
        },
      });

      const res = await request(app)
        .get(`/api/v1/documents/${external.id}/file`)
        .set(authed(adminToken));

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ url: 'https://drive.example.test/some-file', external: true });
    });

    it('will not sign another school\'s document', async () => {
      useStub();
      const id = await upload();
      const other = await createSchoolFixture();
      try {
        const otherToken = await login(other.users.admin!.email);
        const res = await request(app).get(`/api/v1/documents/${id}/file`).set(authed(otherToken));
        expect(res.status).toBe(404);
      } finally {
        await destroyFixture(other);
      }
    });
  });

  describe('deletion', () => {
    it('removes the object and frees the quota', async () => {
      const stub = useStub();
      const created = await request(app)
        .post('/api/v1/documents/upload')
        .set(authed(adminToken))
        .field('studentId', fixture.students[0]!.id)
        .field('docType', 'OTHER')
        .field('title', 'To be deleted')
        .attach('file', PDF, 'temp.pdf');
      expect(created.status).toBe(201);
      const key = [...stub.objects.keys()][0]!;

      const res = await request(app)
        .delete(`/api/v1/documents/${created.body.id}`)
        .set(authed(adminToken));

      expect(res.status).toBe(204);
      expect(stub.removed).toEqual([key]);
      expect(stub.objects.size).toBe(0);
      expect(await prisma.storedFile.count({ where: { schoolId: fixture.school.id } })).toBe(0);
    });
  });

  describe('usage', () => {
    it('counts every stored object, photographs included', async () => {
      useStub();
      await request(app)
        .post('/api/v1/documents/upload')
        .set(authed(adminToken))
        .field('studentId', fixture.students[0]!.id)
        .field('docType', 'OTHER')
        .field('title', 'A document')
        .attach('file', PDF, 'doc.pdf');

      await request(app)
        .post(`/api/v1/students/${fixture.students[0]!.id}/photo`)
        .set(authed(adminToken))
        .attach('file', JPEG, 'portrait.jpg');

      const res = await request(app).get('/api/v1/documents/usage').set(authed(adminToken));

      expect(res.status).toBe(200);
      expect(res.body.files).toBe(2);
      expect(res.body.documents).toBe(1);
      expect(res.body.usedBytes).toBe(PDF.byteLength + JPEG.byteLength);
      expect(res.body.quotaMb).toBe(1024);
      expect(res.body.acceptedTypes).toContain('application/pdf');
    });
  });

  describe('student photographs', () => {
    it('stores a portrait and returns a URL for it', async () => {
      const stub = useStub();
      const res = await request(app)
        .post(`/api/v1/students/${fixture.students[0]!.id}/photo`)
        .set(authed(adminToken))
        .attach('file', JPEG, 'portrait.jpg');

      expect(res.status).toBe(201);
      expect(res.body.url).toContain(`schools/${fixture.school.id}/photos/`);
      expect(stub.objects.size).toBe(1);

      const student = await prisma.student.findUniqueOrThrow({
        where: { id: fixture.students[0]!.id },
        select: { photoFileId: true },
      });
      expect(student.photoFileId).toBe(res.body.photoFileId);
    });

    it('refuses a PDF, which no register can render', async () => {
      const stub = useStub();
      const res = await request(app)
        .post(`/api/v1/students/${fixture.students[0]!.id}/photo`)
        .set(authed(adminToken))
        .attach('file', PDF, 'portrait.pdf');

      expect(res.status).toBe(400);
      expect(stub.objects.size).toBe(0);
    });

    it('discards the previous portrait when a new one replaces it', async () => {
      const stub = useStub();
      const first = await request(app)
        .post(`/api/v1/students/${fixture.students[0]!.id}/photo`)
        .set(authed(adminToken))
        .attach('file', JPEG, 'first.jpg');
      expect(first.status).toBe(201);
      const firstKey = [...stub.objects.keys()][0]!;

      const second = await request(app)
        .post(`/api/v1/students/${fixture.students[0]!.id}/photo`)
        .set(authed(adminToken))
        .attach('file', PNG, 'second.png');
      expect(second.status).toBe(201);

      // Exactly one portrait is kept, and it is the new one.
      expect(stub.removed).toEqual([firstKey]);
      expect(stub.objects.size).toBe(1);
      expect(await prisma.storedFile.count({ where: { schoolId: fixture.school.id } })).toBe(1);
    });

    it('clears a portrait on request', async () => {
      const stub = useStub();
      await request(app)
        .post(`/api/v1/students/${fixture.students[0]!.id}/photo`)
        .set(authed(adminToken))
        .attach('file', JPEG, 'portrait.jpg');

      const res = await request(app)
        .delete(`/api/v1/students/${fixture.students[0]!.id}/photo`)
        .set(authed(adminToken));

      expect(res.status).toBe(204);
      expect(stub.objects.size).toBe(0);
      const student = await prisma.student.findUniqueOrThrow({
        where: { id: fixture.students[0]!.id },
        select: { photoFileId: true },
      });
      expect(student.photoFileId).toBeNull();
    });

    it('404s for a student with no photograph', async () => {
      useStub();
      const res = await request(app)
        .get(`/api/v1/students/${fixture.students[1]!.id}/photo`)
        .set(authed(adminToken));
      expect(res.status).toBe(404);
    });
  });
});

/**
 * The school-wide register: what is on file, and who is still missing something.
 *
 * These are the two queries the per-student view cannot answer, and the
 * "missing" one in particular is easy to get subtly wrong — it has to count
 * students with *no* matching document, not documents that happen to be absent
 * from a join.
 */
describe('school-wide document register', () => {
  let fixture: Fixture;
  let adminToken: string;

  beforeAll(async () => {
    setStorageDriver(stubDriver());
    fixture = await createSchoolFixture();
    adminToken = await login(fixture.users.admin!.email);
  });

  afterAll(async () => {
    await destroyFixture(fixture);
    setStorageDriver(null);
  });

  afterEach(async () => {
    await prisma.document.deleteMany({ where: { schoolId: fixture.school.id } });
    await prisma.storedFile.deleteMany({ where: { schoolId: fixture.school.id } });
  });

  /** Files a document without going through an upload, to keep these focused. */
  async function file(options: {
    studentId?: string;
    staffId?: string;
    docType: string;
    title: string;
  }) {
    return prisma.document.create({
      data: {
        schoolId: fixture.school.id,
        studentId: options.studentId ?? null,
        staffId: options.staffId ?? null,
        docType: options.docType,
        title: options.title,
        fileUrl: 'https://example.test/x',
      },
    });
  }

  describe('listing', () => {
    it('matches a search against the document title', async () => {
      await file({ studentId: fixture.students[0]!.id, docType: 'OTHER', title: 'Transfer letter' });
      await file({ studentId: fixture.students[1]!.id, docType: 'OTHER', title: 'Bursary form' });

      const res = await request(app)
        .get('/api/v1/documents?search=transfer')
        .set(authed(adminToken));

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].title).toBe('Transfer letter');
    });

    it('matches a search against the person it is filed against', async () => {
      await file({
        studentId: fixture.students[0]!.id,
        docType: 'BIRTH_CERTIFICATE',
        title: 'Certificate',
      });
      await file({ staffId: fixture.teacherStaffId, docType: 'CONTRACT', title: 'Contract' });

      // Student1 is the fixture's first student; the staff member is "Teacher".
      const byStudent = await request(app)
        .get('/api/v1/documents?search=Student1')
        .set(authed(adminToken));
      expect(byStudent.body.data).toHaveLength(1);
      expect(byStudent.body.data[0].title).toBe('Certificate');

      const byStaff = await request(app)
        .get('/api/v1/documents?search=Teacher')
        .set(authed(adminToken));
      expect(byStaff.body.data).toHaveLength(1);
      expect(byStaff.body.data[0].title).toBe('Contract');
    });

    it('searches without regard to case', async () => {
      await file({ studentId: fixture.students[0]!.id, docType: 'OTHER', title: 'Bursary Form' });

      const res = await request(app)
        .get('/api/v1/documents?search=BURSARY')
        .set(authed(adminToken));
      expect(res.body.data).toHaveLength(1);
    });

    it('separates documents filed against students from those against staff', async () => {
      await file({ studentId: fixture.students[0]!.id, docType: 'ID_COPY', title: 'Student ID' });
      await file({ staffId: fixture.teacherStaffId, docType: 'ID_COPY', title: 'Staff ID' });

      const students = await request(app)
        .get('/api/v1/documents?subject=student')
        .set(authed(adminToken));
      expect(students.body.data.map((d: { title: string }) => d.title)).toEqual(['Student ID']);

      const staff = await request(app)
        .get('/api/v1/documents?subject=staff')
        .set(authed(adminToken));
      expect(staff.body.data.map((d: { title: string }) => d.title)).toEqual(['Staff ID']);

      const both = await request(app).get('/api/v1/documents').set(authed(adminToken));
      expect(both.body.data).toHaveLength(2);
    });

    it('does not show another school\'s documents', async () => {
      await file({ studentId: fixture.students[0]!.id, docType: 'OTHER', title: 'Ours' });
      const other = await createSchoolFixture();
      try {
        const otherToken = await login(other.users.admin!.email);
        const res = await request(app).get('/api/v1/documents').set(authed(otherToken));
        expect(res.body.data).toHaveLength(0);
      } finally {
        await destroyFixture(other);
      }
    });
  });

  describe('missing documents', () => {
    it('lists every student without one, and drops them as they are filed', async () => {
      const before = await request(app)
        .get('/api/v1/documents/missing?docType=BIRTH_CERTIFICATE')
        .set(authed(adminToken));

      expect(before.status).toBe(200);
      // All three fixture students start with nothing on file.
      expect(before.body.meta.total).toBe(3);

      await file({
        studentId: fixture.students[0]!.id,
        docType: 'BIRTH_CERTIFICATE',
        title: 'Certificate',
      });

      const after = await request(app)
        .get('/api/v1/documents/missing?docType=BIRTH_CERTIFICATE')
        .set(authed(adminToken));

      expect(after.body.meta.total).toBe(2);
      expect(after.body.data.map((s: { id: string }) => s.id)).not.toContain(
        fixture.students[0]!.id,
      );
    });

    it('counts a different type independently', async () => {
      await file({
        studentId: fixture.students[0]!.id,
        docType: 'BIRTH_CERTIFICATE',
        title: 'Certificate',
      });

      // The birth certificate is on file; the medical report is not.
      const medical = await request(app)
        .get('/api/v1/documents/missing?docType=MEDICAL_REPORT')
        .set(authed(adminToken));
      expect(medical.body.meta.total).toBe(3);
    });

    it('leaves archived students out — they have left', async () => {
      await prisma.student.update({
        where: { id: fixture.students[2]!.id },
        data: { status: 'ARCHIVED' },
      });
      try {
        const res = await request(app)
          .get('/api/v1/documents/missing?docType=BIRTH_CERTIFICATE')
          .set(authed(adminToken));
        expect(res.body.meta.total).toBe(2);
      } finally {
        await prisma.student.update({
          where: { id: fixture.students[2]!.id },
          data: { status: 'ACTIVE' },
        });
      }
    });

    it('narrows to a class', async () => {
      const inClass = await request(app)
        .get(`/api/v1/documents/missing?docType=BIRTH_CERTIFICATE&classId=${fixture.classId}`)
        .set(authed(adminToken));
      expect(inClass.body.meta.total).toBe(3);

      const elsewhere = await request(app)
        .get('/api/v1/documents/missing?docType=BIRTH_CERTIFICATE&classId=no-such-class')
        .set(authed(adminToken));
      expect(elsewhere.body.meta.total).toBe(0);
    });

    it('reports the class each student is in, so the list is actionable', async () => {
      const res = await request(app)
        .get('/api/v1/documents/missing?docType=BIRTH_CERTIFICATE')
        .set(authed(adminToken));

      expect(res.body.data[0].admissionNumber).toBeTruthy();
      expect(res.body.data[0].enrollments[0].schoolClass.name).toBe('Form 1');
    });

    it('counts only its own school', async () => {
      const other = await createSchoolFixture();
      try {
        const res = await request(app)
          .get('/api/v1/documents/missing?docType=BIRTH_CERTIFICATE')
          .set(authed(adminToken));
        // Three here, not six.
        expect(res.body.meta.total).toBe(3);
      } finally {
        await destroyFixture(other);
      }
    });

    it('requires a document type to ask about', async () => {
      const res = await request(app).get('/api/v1/documents/missing').set(authed(adminToken));
      expect(res.status).toBe(400);
    });

    it('is not confused for a document id', async () => {
      // `/missing` and `/usage` are literal paths that must not be captured by
      // the `/:id/file` route beside them.
      const res = await request(app)
        .get('/api/v1/documents/missing?docType=OTHER')
        .set(authed(adminToken));
      expect(res.status).toBe(200);
      expect(res.body.meta).toBeTruthy();
    });
  });
});

/**
 * The local driver, exercised for real against a temporary directory.
 *
 * This is the path a development machine and a single-server installation take,
 * and the only one where the app mints and then checks its own signatures — so
 * it is tested end to end rather than stubbed.
 */
describe('local storage driver', () => {
  let fixture: Fixture;
  let adminToken: string;
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'sms-storage-'));
    setStorageDriver(new LocalStorageDriver(dir));

    fixture = await createSchoolFixture();
    adminToken = await login(fixture.users.admin!.email);
  });

  afterAll(async () => {
    await destroyFixture(fixture);
    setStorageDriver(null);
    await rm(dir, { recursive: true, force: true });
  });

  async function uploadPhoto(): Promise<string> {
    const res = await request(app)
      .post(`/api/v1/students/${fixture.students[0]!.id}/photo`)
      .set(authed(adminToken))
      .attach('file', PNG, 'portrait.png');
    expect(res.status).toBe(201);
    return res.body.url as string;
  }

  it('writes under the directory it was given, and nowhere else', async () => {
    await uploadPhoto();
    const written = await readdir(path.join(dir, 'schools'), { recursive: true });
    expect(written.some((f) => String(f).endsWith('.png'))).toBe(true);
  });

  it('serves the stored bytes back through a signed URL', async () => {
    const url = await uploadPhoto();
    // The URL is absolute; supertest wants the path and query.
    const target = url.slice(url.indexOf('/api/v1/'));

    const res = await request(app).get(target);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');
    expect(res.headers['cache-control']).toContain('private');
    expect(Buffer.from(res.body).equals(PNG)).toBe(true);
  });

  it('serves it without a session, since the signature is the credential', async () => {
    const url = await uploadPhoto();
    const target = url.slice(url.indexOf('/api/v1/'));

    // No Authorization header at all.
    expect((await request(app).get(target)).status).toBe(200);
  });

  it('refuses a tampered key', async () => {
    const url = await uploadPhoto();
    const target = url.slice(url.indexOf('/api/v1/'));
    const parsed = new URL(url);
    const forged = target.replace(
      encodeURIComponent(parsed.searchParams.get('key')!),
      encodeURIComponent(`schools/${fixture.school.id}/photos/someone-elses.png`),
    );

    expect((await request(app).get(forged)).status).toBe(404);
  });

  it('refuses a tampered expiry', async () => {
    const url = await uploadPhoto();
    const parsed = new URL(url);
    parsed.searchParams.set('expires', String(Date.now() + 86_400_000));
    const target = `${parsed.pathname}${parsed.search}`;

    expect((await request(app).get(target)).status).toBe(404);
  });

  it('refuses an expired URL', async () => {
    const url = await uploadPhoto();
    const parsed = new URL(url);
    // A signature that was valid, for a moment that has passed.
    parsed.searchParams.set('expires', String(Date.now() - 1000));
    const target = `${parsed.pathname}${parsed.search}`;

    expect((await request(app).get(target)).status).toBe(404);
  });

  it('refuses a key that climbs out of the storage directory', async () => {
    const driver = new LocalStorageDriver(dir);
    await expect(
      driver.put({
        key: '../../etc/passwd',
        body: PNG,
        mimeType: 'image/png',
      }),
    ).rejects.toThrow(/unsafe storage key/i);
  });

  it('treats removing a key that is already gone as done', async () => {
    const driver = new LocalStorageDriver(dir);
    await expect(driver.remove('schools/none/photos/missing.png')).resolves.toBeUndefined();
  });
});

/**
 * A bucket that is only half set up.
 *
 * The likely misconfiguration is not "no storage at all" — the local driver
 * covers that and always works — but a bucket named with a credential or an
 * endpoint missing. That must fail with something a deployer can act on, not
 * a signing error on the first upload.
 */
describe('bucket misconfiguration', () => {
  it('names what is missing rather than failing on first use', async () => {
    // The test environment sets none of the R2 variables, so constructing the
    // S3 driver directly exercises exactly that case.
    const { S3StorageDriver } = await import('../lib/storage/s3.js');
    expect(() => new S3StorageDriver()).toThrow(/R2_ACCOUNT_ID|S3_ENDPOINT/);
  });
});
