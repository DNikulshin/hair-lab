import { describe, expect, it } from 'vitest';
import {
  adminAppointmentResponseSchema,
  adminAppointmentSchema,
  adminAppointmentsQuerySchema,
  adminAppointmentsResponseSchema,
  adminCancelRequestSchema,
} from './admin-appointments.contract';

/** Вымышленные данные: реальных клиентов, телефонов и записей здесь нет. */
const appointment = {
  id: '77777777-7777-4777-8777-777777777777',
  startsAt: '2030-06-15T07:00:00.000Z',
  endsAt: '2030-06-15T08:00:00.000Z',
  status: 'confirmed',
  priceKopecks: 350_000,
  durationMin: 60,
  serviceName: 'Стрижка',
  masterName: 'Тестовый Мастер',
  clientName: 'Тестовая Клиентка',
  clientPhone: '+70000000001',
} as const;

describe('adminAppointmentSchema', () => {
  it('принимает запись дня и отдаёт ровно поля админки', () => {
    const parsed = adminAppointmentSchema.parse(appointment);

    expect(Object.keys(parsed).sort()).toEqual([
      'clientName',
      'clientPhone',
      'durationMin',
      'endsAt',
      'id',
      'masterName',
      'priceKopecks',
      'serviceName',
      'startsAt',
      'status',
    ]);
    // Администратору нужен рабочий телефон, а не маска.
    expect(parsed.clientPhone).toBe('+70000000001');
  });

  it('не отдаёт служебные поля, даже если они пришли в объекте', () => {
    const parsed = adminAppointmentSchema.parse({
      ...appointment,
      clientEmail: 'guest@example.invalid',
      cancelReason: 'cancelled_by_salon: тест',
      paymentDeadlineAt: '2030-06-15T06:30:00.000Z',
    });

    expect(Object.keys(parsed)).not.toContain('clientEmail');
    expect(Object.keys(parsed)).not.toContain('cancelReason');
    expect(Object.keys(parsed)).not.toContain('paymentDeadlineAt');
  });

  it('требует ISO-время с зоной, известный статус и целые числа', () => {
    expect(
      adminAppointmentSchema.safeParse({ ...appointment, startsAt: '15.06.2030' }).success,
    ).toBe(false);
    expect(adminAppointmentSchema.safeParse({ ...appointment, status: 'archived' }).success).toBe(
      false,
    );
    expect(adminAppointmentSchema.safeParse({ ...appointment, priceKopecks: -1 }).success).toBe(
      false,
    );
    expect(adminAppointmentSchema.safeParse({ ...appointment, durationMin: 0 }).success).toBe(
      false,
    );
    expect(adminAppointmentSchema.safeParse({ ...appointment, clientPhone: '' }).success).toBe(
      false,
    );
  });
});

describe('adminAppointmentsQuerySchema', () => {
  it('принимает календарную дату в TZ салона', () => {
    expect(adminAppointmentsQuerySchema.parse({ date: '2030-06-15' }).date).toBe('2030-06-15');
  });

  it('отклоняет несуществующую дату, момент времени и пустой запрос', () => {
    expect(adminAppointmentsQuerySchema.safeParse({ date: '2030-02-30' }).success).toBe(false);
    expect(
      adminAppointmentsQuerySchema.safeParse({ date: '2030-06-15T07:00:00.000Z' }).success,
    ).toBe(false);
    expect(adminAppointmentsQuerySchema.safeParse({}).success).toBe(false);
  });
});

describe('adminAppointmentsResponseSchema', () => {
  it('оборачивает записи в items', () => {
    const parsed = adminAppointmentsResponseSchema.parse({ items: [appointment] });

    expect(parsed.items).toHaveLength(1);
    expect(adminAppointmentsResponseSchema.safeParse({ items: {} }).success).toBe(false);
  });
});

describe('adminCancelRequestSchema', () => {
  it('обрезает пробелы по краям причины', () => {
    expect(adminCancelRequestSchema.parse({ reason: '  клиент просил перенести  ' }).reason).toBe(
      'клиент просил перенести',
    );
  });

  it('требует непустую причину не длиннее 1000 символов', () => {
    expect(adminCancelRequestSchema.safeParse({ reason: '' }).success).toBe(false);
    expect(adminCancelRequestSchema.safeParse({ reason: '   ' }).success).toBe(false);
    expect(adminCancelRequestSchema.safeParse({}).success).toBe(false);
    expect(adminCancelRequestSchema.safeParse({ reason: 'a'.repeat(1001) }).success).toBe(false);
    expect(adminCancelRequestSchema.safeParse({ reason: 'a'.repeat(1000) }).success).toBe(true);
  });
});

describe('adminAppointmentResponseSchema', () => {
  it('оборачивает запись в booking', () => {
    const parsed = adminAppointmentResponseSchema.parse({ booking: appointment });

    expect(parsed.booking.id).toBe(appointment.id);
    expect(adminAppointmentResponseSchema.safeParse({ items: [appointment] }).success).toBe(false);
  });
});
