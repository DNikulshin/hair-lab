import { describe, expect, it } from 'vitest';
import {
  adminRefundAppointmentSchema,
  adminRefundItemSchema,
  adminRefundsQuerySchema,
  adminRefundsResponseSchema,
  adminRefundsScopeSchema,
} from './admin-refunds.contract';

/** Вымышленные данные: реальных клиентов, телефонов и платежей здесь нет. */
const appointment = {
  startsAt: '2030-06-15T07:00:00.000Z',
  status: 'cancelled',
  serviceName: 'Стрижка',
  masterName: 'Тестовый Мастер',
  clientName: 'Тестовая Клиентка',
  clientPhone: '+70000000001',
  cancelReason: 'cancelled_by_salon: мастер заболел',
} as const;

const refundItem = {
  paymentId: '77777777-7777-4777-8777-777777777771',
  appointmentId: '77777777-7777-4777-8777-777777777772',
  refundStatus: 'pending',
  amountKopecks: 350_000,
  createdAt: '2030-06-14T09:00:00.000Z',
  appointment,
} as const;

describe('adminRefundsScopeSchema', () => {
  it('знает ровно два списка: требуют внимания и возвращённые', () => {
    expect(adminRefundsScopeSchema.options).toEqual(['attention', 'completed']);
  });
});

describe('adminRefundsQuerySchema', () => {
  it('по умолчанию отдаёт «требуют внимания»: экран открывается на действиях', () => {
    expect(adminRefundsQuerySchema.parse({}).scope).toBe('attention');
  });

  it('принимает явный scope и календарные даты периода', () => {
    const parsed = adminRefundsQuerySchema.parse({
      scope: 'completed',
      from: '2030-06-01',
      to: '2030-06-30',
    });

    expect(parsed).toEqual({ scope: 'completed', from: '2030-06-01', to: '2030-06-30' });
  });

  it('принимает один и тот же день как период из одного дня', () => {
    expect(
      adminRefundsQuerySchema.safeParse({ from: '2030-06-15', to: '2030-06-15' }).success,
    ).toBe(true);
  });

  it('отклоняет начало периода позже конца', () => {
    const parsed = adminRefundsQuerySchema.safeParse({ from: '2030-06-16', to: '2030-06-15' });

    expect(parsed.success).toBe(false);
  });

  it('отклоняет неизвестный scope, битые даты и момент времени вместо даты', () => {
    expect(adminRefundsQuerySchema.safeParse({ scope: 'all' }).success).toBe(false);
    expect(adminRefundsQuerySchema.safeParse({ from: '2030-02-30' }).success).toBe(false);
    expect(adminRefundsQuerySchema.safeParse({ to: 'июнь' }).success).toBe(false);
    expect(adminRefundsQuerySchema.safeParse({ from: '2030-06-01T00:00:00.000Z' }).success).toBe(
      false,
    );
  });
});

describe('adminRefundAppointmentSchema', () => {
  it('отдаёт контекст записи: время, статус, услугу, мастера и контакт клиента', () => {
    const parsed = adminRefundAppointmentSchema.parse(appointment);

    expect(Object.keys(parsed).sort()).toEqual([
      'cancelReason',
      'clientName',
      'clientPhone',
      'masterName',
      'serviceName',
      'startsAt',
      'status',
    ]);
    // Администратору нужен рабочий телефон по возврату, а не маска.
    expect(parsed.clientPhone).toBe('+70000000001');
  });

  it('принимает отсутствие отмены и отклоняет неизвестный статус записи', () => {
    expect(adminRefundAppointmentSchema.parse({ ...appointment, cancelReason: null })).toEqual({
      ...appointment,
      cancelReason: null,
    });
    expect(
      adminRefundAppointmentSchema.safeParse({ ...appointment, status: 'archived' }).success,
    ).toBe(false);
  });
});

describe('adminRefundItemSchema', () => {
  it('принимает строку возврата и отдаёт ровно поля обзора', () => {
    const parsed = adminRefundItemSchema.parse(refundItem);

    expect(Object.keys(parsed).sort()).toEqual([
      'amountKopecks',
      'appointment',
      'appointmentId',
      'createdAt',
      'paymentId',
      'refundStatus',
    ]);
    expect(parsed.refundStatus).toBe('pending');
  });

  it('не отдаёт салону служебные id возврата, id провайдера и почту клиента', () => {
    const parsed = adminRefundItemSchema.parse({
      ...refundItem,
      refundId: 'refund-2f1c',
      yookassaPaymentId: '2a1b0d2f-000f-5000-9000-1f0000000000',
      appointment: { ...appointment, clientEmail: 'guest@example.invalid' },
    });

    expect(Object.keys(parsed)).not.toContain('refundId');
    expect(Object.keys(parsed)).not.toContain('yookassaPaymentId');
    expect(Object.keys(parsed.appointment)).not.toContain('clientEmail');
    // Поля нет и после сериализации: значение не просочится в тело ответа.
    expect(JSON.stringify(parsed)).not.toContain('guest@example.invalid');
    expect(JSON.stringify(parsed)).not.toContain('refund-2f1c');
  });

  it('знает только клиентские статусы возврата и отклоняет служебные коды БД', () => {
    for (const status of ['pending', 'succeeded', 'failed']) {
      expect(adminRefundItemSchema.safeParse({ ...refundItem, refundStatus: status }).success).toBe(
        true,
      );
    }
    for (const status of ['canceled', 'unknown', null]) {
      expect(adminRefundItemSchema.safeParse({ ...refundItem, refundStatus: status }).success).toBe(
        false,
      );
    }
  });

  it('требует ISO-время с зоной, uuid и целые копейки', () => {
    expect(
      adminRefundItemSchema.safeParse({ ...refundItem, createdAt: '14.06.2030' }).success,
    ).toBe(false);
    expect(
      adminRefundItemSchema.safeParse({ ...refundItem, paymentId: 'not-a-uuid' }).success,
    ).toBe(false);
    expect(adminRefundItemSchema.safeParse({ ...refundItem, amountKopecks: -1 }).success).toBe(
      false,
    );
    expect(adminRefundItemSchema.safeParse({ ...refundItem, amountKopecks: 1.5 }).success).toBe(
      false,
    );
  });
});

describe('adminRefundsResponseSchema', () => {
  it('оборачивает возвраты в items и принимает пустой список', () => {
    expect(adminRefundsResponseSchema.parse({ items: [refundItem] }).items).toHaveLength(1);
    // Пустой список — валидный ответ: «возвратов нет» отличается от ошибки.
    expect(adminRefundsResponseSchema.parse({ items: [] })).toEqual({ items: [] });
    expect(adminRefundsResponseSchema.safeParse({ items: {} }).success).toBe(false);
  });
});
