import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { UserStatus } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { app, type Fixture, TEST_PASSWORD, createSchoolFixture, destroyFixture } from './fixtures.js';

const login = async (email: string, password = TEST_PASSWORD) => {
  const res = await request(app).post('/api/v1/auth/login').send({ email, password });
  return res.body as { accessToken?: string; refreshToken?: string };
};

describe('user administration', () => {
  let fixture: Fixture;
  let adminToken: string;
  let adminId: string;

  beforeAll(async () => {
    fixture = await createSchoolFixture();
    const admin = fixture.users.admin!;
    adminId = admin.id;
    adminToken = (await login(admin.email)).accessToken!;
  });

  afterAll(async () => {
    await destroyFixture(fixture);
    await prisma.$disconnect();
  });

  const auth = () => ({ Authorization: `Bearer ${adminToken}` });

  it('lists users with their lock and session state', async () => {
    const res = await request(app).get('/api/v1/users').set(auth());

    expect(res.status).toBe(200);
    const me = res.body.data.find((u: { id: string }) => u.id === adminId);
    expect(me).toMatchObject({ role: 'ADMIN', status: 'ACTIVE' });
    // The administrator signed in during setup, so a live session is counted.
    expect(me._count.sessions).toBeGreaterThan(0);
    expect(me).toHaveProperty('lockedUntil');
  });

  it('creates a user with a one-time password that must be changed', async () => {
    const email = `new.teacher.${Date.now()}@example.ac.tz`;
    const res = await request(app)
      .post('/api/v1/users')
      .set(auth())
      .send({ firstName: 'Neema', lastName: 'Mbwana', email, role: 'TEACHER' });

    expect(res.status).toBe(201);
    expect(res.body.temporaryPassword).toBeTruthy();

    const created = await prisma.user.findFirstOrThrow({ where: { email } });
    expect(created.mustChangePassword).toBe(true);
  });

  it('refuses to create a super admin from inside a school', async () => {
    const res = await request(app)
      .post('/api/v1/users')
      .set(auth())
      .send({
        firstName: 'X',
        lastName: 'Y',
        email: `super.${Date.now()}@example.ac.tz`,
        role: 'SUPER_ADMIN',
      });

    expect(res.status).toBe(400);
  });

  it('signs a suspended user out and stops them signing back in', async () => {
    const librarian = fixture.users.librarian!;
    const before = await login(librarian.email);
    expect(before.accessToken).toBeTruthy();

    const res = await request(app)
      .patch(`/api/v1/users/${librarian.id}`)
      .set(auth())
      .send({ status: UserStatus.SUSPENDED });
    expect(res.status).toBe(200);

    const live = await prisma.session.count({
      where: { userId: librarian.id, revokedAt: null },
    });
    expect(live).toBe(0);

    const after = await login(librarian.email);
    expect(after.accessToken).toBeUndefined();

    // Put them back, so the rest of the suite is unaffected.
    await request(app)
      .patch(`/api/v1/users/${librarian.id}`)
      .set(auth())
      .send({ status: UserStatus.ACTIVE });
    expect((await login(librarian.email)).accessToken).toBeTruthy();
  });

  it('will not let an administrator disable or demote themselves', async () => {
    const disable = await request(app)
      .patch(`/api/v1/users/${adminId}`)
      .set(auth())
      .send({ status: UserStatus.DISABLED });
    expect(disable.status).toBe(400);

    const demote = await request(app)
      .patch(`/api/v1/users/${adminId}`)
      .set(auth())
      .send({ role: 'TEACHER' });
    expect(demote.status).toBe(400);

    // Still an active administrator, so the school is not locked out.
    const me = await prisma.user.findUniqueOrThrow({ where: { id: adminId } });
    expect(me).toMatchObject({ role: 'ADMIN', status: UserStatus.ACTIVE });
  });

  it('signs a user out of every device without touching the password', async () => {
    const teacher = fixture.users.teacher!;
    await login(teacher.email);
    await login(teacher.email); // a second device

    const res = await request(app)
      .post(`/api/v1/users/${teacher.id}/revoke-sessions`)
      .set(auth());

    expect(res.status).toBe(200);
    expect(res.body.revoked).toBeGreaterThanOrEqual(2);
    expect(
      await prisma.session.count({ where: { userId: teacher.id, revokedAt: null } }),
    ).toBe(0);

    // The password still works — only the sessions were ended.
    expect((await login(teacher.email)).accessToken).toBeTruthy();
  });

  it('unlocks an account locked by failed sign-ins, keeping the password', async () => {
    const teacher = fixture.users.teacher!;
    await prisma.user.update({
      where: { id: teacher.id },
      data: { failedLoginCount: 5, lockedUntil: new Date(Date.now() + 60_000) },
    });
    expect((await login(teacher.email)).accessToken).toBeUndefined();

    const res = await request(app).post(`/api/v1/users/${teacher.id}/unlock`).set(auth());
    expect(res.status).toBe(200);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: teacher.id } });
    expect(after.lockedUntil).toBeNull();
    expect(after.failedLoginCount).toBe(0);
    expect((await login(teacher.email)).accessToken).toBeTruthy();
  });

  it('resets a password and ends the old sessions', async () => {
    const librarian = fixture.users.librarian!;
    await login(librarian.email);

    const res = await request(app)
      .post(`/api/v1/users/${librarian.id}/reset-password`)
      .set(auth());

    expect(res.status).toBe(200);
    const temporary = res.body.temporaryPassword as string;
    expect(temporary).toBeTruthy();

    expect(
      await prisma.session.count({ where: { userId: librarian.id, revokedAt: null } }),
    ).toBe(0);
    expect((await login(librarian.email)).accessToken).toBeUndefined();
    expect((await login(librarian.email, temporary)).accessToken).toBeTruthy();
  });

  it('deletes an account that was never used', async () => {
    const email = `typo.${Date.now()}@example.ac.tz`;
    const created = await request(app)
      .post('/api/v1/users')
      .set(auth())
      .send({ firstName: 'Mis', lastName: 'Typed', email, role: 'TEACHER' });

    const res = await request(app).delete(`/api/v1/users/${created.body.id}`).set(auth());
    expect(res.status).toBe(204);
    expect(await prisma.user.findFirst({ where: { email } })).toBeNull();
  });

  it('refuses to delete an account that has been used, to protect the audit trail', async () => {
    const teacher = fixture.users.teacher!;
    // They have signed in during this suite, so history exists.
    const res = await request(app).delete(`/api/v1/users/${teacher.id}`).set(auth());

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/disable it instead/i);
    expect(await prisma.user.findUnique({ where: { id: teacher.id } })).not.toBeNull();
  });

  it('will not let an administrator delete their own account', async () => {
    const res = await request(app).delete(`/api/v1/users/${adminId}`).set(auth());
    expect(res.status).toBe(400);
  });

  it('keeps user administration away from roles that should not have it', async () => {
    const teacherToken = (await login(fixture.users.teacher!.email)).accessToken!;

    const list = await request(app)
      .get('/api/v1/users')
      .set({ Authorization: `Bearer ${teacherToken}` });
    expect(list.status).toBe(403);

    const suspend = await request(app)
      .patch(`/api/v1/users/${adminId}`)
      .set({ Authorization: `Bearer ${teacherToken}` })
      .send({ status: UserStatus.DISABLED });
    expect(suspend.status).toBe(403);
  });
});
