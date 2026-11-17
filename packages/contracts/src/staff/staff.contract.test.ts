import { describe, expect, it } from 'vitest';
import {
  staffAccountSchema,
  staffAuthResponseSchema,
  staffLoginRequestSchema,
  staffRoleSchema,
} from './staff.contract';

/** Вымышленные данные: реальных сотрудников, почт и паролей здесь нет. */
const staffId = '55555555-5555-4555-8555-555555555555';
const email = 'staff@example.invalid';
const password = 'test-password-0001';

describe('staffRoleSchema', () => {
  it('принимает только admin и manager', () => {
    expect(staffRoleSchema.parse('admin')).toBe('admin');
    expect(staffRoleSchema.parse('manager')).toBe('manager');
    expect(staffRoleSchema.safeParse('owner').success).toBe(false);
    expect(staffRoleSchema.safeParse('ADMIN').success).toBe(false);
    expect(staffRoleSchema.safeParse(42).success).toBe(false);
  });
});

describe('staffLoginRequestSchema', () => {
  it('нормализует почту и не трогает пароль', () => {
    const parsed = staffLoginRequestSchema.parse({
      email: '  Staff@Example.INVALID ',
      password: ` ${password} `,
    });

    expect(parsed.email).toBe(email);
    expect(parsed.password).toBe(` ${password} `);
  });

  it('требует пароль длиной 10–128 символов, как у клиента', () => {
    expect(staffLoginRequestSchema.safeParse({ email, password: 'short' }).success).toBe(false);
    expect(staffLoginRequestSchema.safeParse({ email, password: 'a'.repeat(129) }).success).toBe(
      false,
    );
  });

  it('в ошибке нет введённого пароля', () => {
    const result = staffLoginRequestSchema.safeParse({
      email: 'не-почта@',
      password: 'secret-0001',
    });

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.success ? {} : result.error.issues)).not.toContain('secret-0001');
  });
});

describe('staffAccountSchema', () => {
  it('содержит только id, email и роль', () => {
    const parsed = staffAccountSchema.parse({ id: staffId, email, role: 'manager' });

    expect(Object.keys(parsed).sort()).toEqual(['email', 'id', 'role']);
  });

  it('отклоняет не-uuid, не-роль и лишние поля пароля', () => {
    expect(staffAccountSchema.safeParse({ id: 'staff-1', email, role: 'admin' }).success).toBe(
      false,
    );
    expect(staffAccountSchema.safeParse({ id: staffId, email, role: 'owner' }).success).toBe(false);
    // Лишние поля отбрасываются, а не попадают в DTO: хеш пароля наружу не уходит.
    expect(
      staffAccountSchema.parse({ id: staffId, email, role: 'admin', passwordHash: 'x' }),
    ).toEqual({ id: staffId, email, role: 'admin' });
  });
});

describe('staffAuthResponseSchema', () => {
  it('оборачивает сотрудника в объект staff', () => {
    const parsed = staffAuthResponseSchema.parse({
      staff: { id: staffId, email, role: 'admin' },
    });

    expect(parsed.staff.role).toBe('admin');
    expect(staffAuthResponseSchema.safeParse({ client: { id: staffId, email } }).success).toBe(
      false,
    );
  });
});
