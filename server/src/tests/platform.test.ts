import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Role, SchoolStatus, UserStatus } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { app, TEST_PASSWORD, uid } from './fixtures.js';
import { hashPassword } from '../lib/tokens.js';

/**
 * Platform administration: subscriptions, and the deletion of a whole tenant —
 * the most destructive thing the system can do, so most of this is about what
 * it refuses.
 */
describe('platform administration', () => {
  let token: string;
  let rootEmail: string;

  const authed = () => ({ Authorization: `Bearer ${token}` });

  const makeSchool = async (status: SchoolStatus = SchoolStatus.SUSPENDED) => {
    const suffix = uid().slice(-6).toUpperCase();
    return prisma.school.create({
      data: { name: `Doomed ${suffix}`, code: `DEL${suffix}`, status },
    });
  };

  beforeAll(async () => {
    rootEmail = `platform.${uid()}@example.test`;
    await prisma.user.create({
      data: {
        schoolId: null,
        email: rootEmail,
        firstName: 'Platform',
        lastName: 'Admin',
        role: Role.SUPER_ADMIN,
        passwordHash: await hashPassword(TEST_PASSWORD),
      },
    });
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: rootEmail, password: TEST_PASSWORD });
    token = res.body.accessToken;
  });

  afterAll(async () => {
    await prisma.school.deleteMany({ where: { code: { startsWith: 'DEL' } } });
    await prisma.user.deleteMany({ where: { email: rootEmail } });
    await prisma.$disconnect();
  });

  it('changes a subscription and moves the limits with the plan', async () => {
    const school = await makeSchool(SchoolStatus.ACTIVE);

    const res = await request(app)
      .patch(`/api/v1/platform/schools/${school.id}`)
      .set(authed())
      .send({ plan: 'PREMIUM' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ plan: 'PREMIUM', maxStudents: 5000, storageQuotaMb: 51200 });
  });

  it('keeps an explicit limit even when the plan would set another', async () => {
    const school = await makeSchool(SchoolStatus.ACTIVE);

    const res = await request(app)
      .patch(`/api/v1/platform/schools/${school.id}`)
      .set(authed())
      .send({ plan: 'BASIC', maxStudents: 750 });

    expect(res.status).toBe(200);
    // The plan's own default is 500, so the explicit figure must survive.
    expect(res.body).toMatchObject({ plan: 'BASIC', maxStudents: 750 });
  });

  it('sets a renewal date', async () => {
    const school = await makeSchool(SchoolStatus.ACTIVE);

    const res = await request(app)
      .patch(`/api/v1/platform/schools/${school.id}`)
      .set(authed())
      .send({ planEndsAt: '2027-12-31' });

    expect(res.status).toBe(200);
    expect(new Date(res.body.planEndsAt).getFullYear()).toBe(2027);
  });

  it('will not delete a school that is still running', async () => {
    const school = await makeSchool(SchoolStatus.ACTIVE);

    const res = await request(app)
      .delete(`/api/v1/platform/schools/${school.id}`)
      .set(authed())
      .send({ confirmCode: school.code });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/suspend it first/i);
    expect(await prisma.school.findUnique({ where: { id: school.id } })).not.toBeNull();
  });

  it('will not delete without the school code quoted back', async () => {
    const school = await makeSchool();

    const wrong = await request(app)
      .delete(`/api/v1/platform/schools/${school.id}`)
      .set(authed())
      .send({ confirmCode: 'NOPE' });
    expect(wrong.status).toBe(400);

    const missing = await request(app)
      .delete(`/api/v1/platform/schools/${school.id}`)
      .set(authed())
      .send({});
    expect(missing.status).toBe(400);

    expect(await prisma.school.findUnique({ where: { id: school.id } })).not.toBeNull();
  });

  it('deletes a suspended school and everything belonging to it', async () => {
    const school = await makeSchool();
    const user = await prisma.user.create({
      data: {
        schoolId: school.id,
        email: `head.${uid()}@example.test`,
        firstName: 'Head',
        lastName: 'Teacher',
        role: Role.ADMIN,
        passwordHash: await hashPassword(TEST_PASSWORD),
      },
    });

    const res = await request(app)
      .delete(`/api/v1/platform/schools/${school.id}`)
      .set(authed())
      .send({ confirmCode: school.code.toLowerCase() }); // case must not matter

    expect(res.status).toBe(204);
    expect(await prisma.school.findUnique({ where: { id: school.id } })).toBeNull();
    // The tenant's rows go with it rather than being orphaned.
    expect(await prisma.user.findUnique({ where: { id: user.id } })).toBeNull();
  });

  it('adds a platform administrator with a one-time password', async () => {
    const email = `newroot.${uid()}@example.test`;
    const res = await request(app)
      .post('/api/v1/platform/users')
      .set(authed())
      .send({ firstName: 'Second', lastName: 'Admin', email });

    expect(res.status).toBe(201);
    expect(res.body.temporaryPassword).toBeTruthy();

    // They can sign in straight away, with no school of their own.
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password: res.body.temporaryPassword });
    expect(login.body.accessToken).toBeTruthy();

    const created = await prisma.user.findFirstOrThrow({ where: { email } });
    expect(created).toMatchObject({ role: Role.SUPER_ADMIN, schoolId: null, mustChangePassword: true });
  });

  it('refuses a duplicate platform email', async () => {
    const email = `dupe.${uid()}@example.test`;
    await request(app)
      .post('/api/v1/platform/users')
      .set(authed())
      .send({ firstName: 'First', lastName: 'Admin', email });

    const again = await request(app)
      .post('/api/v1/platform/users')
      .set(authed())
      .send({ firstName: 'Second', lastName: 'Admin', email });

    expect(again.status).toBe(400);
  });

  it('will not let an administrator disable or delete their own account', async () => {
    const me = await prisma.user.findFirstOrThrow({ where: { email: rootEmail } });

    const disable = await request(app)
      .patch(`/api/v1/platform/users/${me.id}`)
      .set(authed())
      .send({ status: UserStatus.DISABLED });
    expect(disable.status).toBe(400);

    const remove = await request(app).delete(`/api/v1/platform/users/${me.id}`).set(authed());
    expect(remove.status).toBe(400);

    // Still able to administer the platform, so nobody is locked out of it.
    const after = await prisma.user.findUniqueOrThrow({ where: { id: me.id } });
    expect(after.status).toBe(UserStatus.ACTIVE);
  });

  it('disables another administrator and ends their sessions', async () => {
    const email = `retiring.${uid()}@example.test`;
    const created = await request(app)
      .post('/api/v1/platform/users')
      .set(authed())
      .send({ firstName: 'Retiring', lastName: 'Admin', email });

    await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password: created.body.temporaryPassword });

    const res = await request(app)
      .patch(`/api/v1/platform/users/${created.body.id}`)
      .set(authed())
      .send({ status: UserStatus.DISABLED });

    expect(res.status).toBe(200);
    expect(
      await prisma.session.count({ where: { userId: created.body.id, revokedAt: null } }),
    ).toBe(0);

    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password: created.body.temporaryPassword });
    expect(login.body.accessToken).toBeUndefined();
  });

  it('resets an administrator password and ends their sessions', async () => {
    const email = `resettable.${uid()}@example.test`;
    const created = await request(app)
      .post('/api/v1/platform/users')
      .set(authed())
      .send({ firstName: 'Reset', lastName: 'Me', email });

    await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password: created.body.temporaryPassword });

    const res = await request(app)
      .post(`/api/v1/platform/users/${created.body.id}/reset-password`)
      .set(authed());

    expect(res.status).toBe(200);
    expect(
      await prisma.session.count({ where: { userId: created.body.id, revokedAt: null } }),
    ).toBe(0);

    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password: res.body.temporaryPassword });
    expect(login.body.accessToken).toBeTruthy();
  });

  it('keeps platform administration away from a school administrator', async () => {
    // Active, because a suspended school's users cannot sign in at all — which
    // would prove nothing about the platform routes.
    const school = await makeSchool(SchoolStatus.ACTIVE);
    const email = `intruder.${uid()}@example.test`;
    await prisma.user.create({
      data: {
        schoolId: school.id,
        email,
        firstName: 'School',
        lastName: 'Admin',
        role: Role.ADMIN,
        passwordHash: await hashPassword(TEST_PASSWORD),
      },
    });
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password: TEST_PASSWORD });

    const res = await request(app)
      .delete(`/api/v1/platform/schools/${school.id}`)
      .set({ Authorization: `Bearer ${login.body.accessToken}` })
      .send({ confirmCode: school.code });

    expect(res.status).toBe(403);
    expect(await prisma.school.findUnique({ where: { id: school.id } })).not.toBeNull();
  });
});
