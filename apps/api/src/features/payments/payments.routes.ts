import {
  apiErrorSchema,
  okResponseSchema,
  paymentStatusResponseSchema,
  yookassaWebhookSchema,
} from '@hair-lab/contracts';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../../shared/db';
import { buildError } from '../../shared/http/error-handler';
import type { GatewayPayment, PaymentGateway } from './payment-gateway';
import {
  applyPaymentCanceled,
  applyPaymentSucceeded,
  findPaymentByAppointment,
  findPaymentByYookassaId,
  markRefunded,
  markRefundRequired,
  refundIdempotenceKey,
} from './payments.service';
import { isYookassaIp } from './yookassa-ip';

/**
 * Маршруты оплаты записи (issue #8): уведомления ЮKassa и статус платежа для страницы оплаты.
 *
 * Правила:
 * - уведомление не доверяется: IP отправителя проверяется по allowlist (`isYookassaIp`),
 *   а состояние платежа перезапрашивается у провайдера своими ключами (`gateway.getPayment`);
 *   сумме из тела не верим — сверяем с `payments.amount_kopecks`;
 * - отвечаем 200 только когда уведомление заведомо ничего не меняет: «не про нас» (ЮKassa не должна
 *   повторять его сутки), «платёж ещё не завершён» и «сумма не совпала»;
 * - если перезапрос состояния упал (сеть, 5xx провайдера), отвечаем 5xx: 200 здесь значил бы
 *   «уведомление обработано», провайдер бы его больше не повторил, а оплаченная запись осталась бы
 *   `pending` — свипер отменил бы её без возврата денег. 5xx заставляет ЮKassa повторить доставку;
 * - ответ 403 — адрес отправителя вне allowlist: уведомление не наше и не повторяется;
 * - персональные данные не читаются и не логируются: в лог идут только id платежей;
 * - rate limit не ставим: уведомления приходят пачками с адресов провайдера, а лимит превратил
 *   бы всплеск в отказы и повторные доставки.
 *
 * `GET /bookings/:id/payment` отдаёт только `{ status, appointmentStatus }`: персональных данных
 * в ответе нет, поэтому авторизация для него не нужна (страница статуса — PR2).
 */

export interface PaymentsRoutesOptions {
  /** Шлюз платежей: в тестах — поддельный, в проде — клиент ЮKassa. */
  gateway: PaymentGateway;
}

const paymentStatusParamsSchema = z.object({ id: z.uuid() });

/** Имя ошибки без текста: сообщение исключения может содержать значения из ответа провайдера. */
function errorNameOf(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

/**
 * Применение подтверждённой оплаты. Если подтвердить запись уже нельзя (она отменена: холд истёк
 * или её сняли до оплаты), деньги возвращаются через шлюз, а платёж фиксируется как `refunded`.
 *
 * Ветка нужна потому, что «платёж отменён» у нас может значить только «холд истёк»: сам платёж
 * в этот момент ещё `pending` у провайдера, и клиент может успеть заплатить.
 *
 * Сбой возврата не роняет обработчик: платёж остаётся `succeeded` (деньги действительно получены),
 * а обязанность вернуть их фиксируется флагом `refund_required`. Ретраить возврат прямо здесь
 * бессмысленно: ответ ЮKassa должен быть 200 в течение 24 часов, повтор уведомления идемпотентен
 * и уже не содержит требования возврата (`applyPaymentSucceeded` — no-op), а сам вызов шлюза
 * удлинял бы ответ, пока он недоступен. Поэтому возврат добивает свипер: он видит флаг и шлёт
 * тот же ключ идемпотентности `refund-<paymentId>`, так что деньги не вернутся дважды.
 *
 * Завершённым возврат считается только при `succeeded`: `pending` (деньги ещё в пути),
 * `canceled` (провайдер отказал) и `unknown` (ответ не распознан) оставляют флаг в БД —
 * иначе обязанность вернуть деньги потерялась бы вместе с флагом.
 */
async function applySucceeded(
  request: FastifyRequest,
  db: Db,
  gateway: PaymentGateway,
  input: { paymentId: string; yookassaPaymentId: string; amountKopecks: number },
): Promise<void> {
  const transition = await applyPaymentSucceeded(db, input.paymentId, {
    amountKopecks: input.amountKopecks,
  });
  if (transition === null) return;

  request.log.info(
    {
      paymentId: transition.paymentId,
      appointmentId: transition.appointmentId,
      status: transition.status,
      appointmentStatus: transition.appointmentStatus,
      changed: transition.changed,
    },
    transition.changed
      ? 'оплата записи подтверждена'
      : 'уведомление об оплате: состояние уже было применено',
  );

  // Деньги пришли по уже отменённому платежу (холд истёк — платёж снят свипером, или запись
  // отменили до оплаты): подтвердить запись нельзя, но деньги надо вернуть — исход тот же.
  const refundRequired = transition.needsRefund || transition.status === 'canceled';
  if (!refundRequired) return;

  try {
    const refund = await gateway.createRefund({
      yookassaPaymentId: input.yookassaPaymentId,
      amountKopecks: input.amountKopecks,
      idempotenceKey: refundIdempotenceKey(input.paymentId),
    });

    // Возврат завершён только при `succeeded`: `pending`/`canceled`/`unknown` деньгами не являются.
    if (refund.status === 'succeeded') {
      await markRefunded(db, input.paymentId, refund.refundId);
      request.log.info(
        { paymentId: input.paymentId, refundId: refund.refundId },
        'деньги по неактуальной оплате возвращены клиенту',
      );
      return;
    }

    // Флаг возврата не снимаем: обязанность вернуть деньги переживёт этот ответ, а свипер
    // повторит возврат с тем же ключом идемпотентности — второй раз деньги не уйдут.
    await markRefundRequired(db, input.paymentId);
    request.log.error(
      { paymentId: input.paymentId, refundId: refund.refundId, refundStatus: refund.status },
      refund.status === 'canceled'
        ? 'возврат отклонён провайдером, нужна ручная проверка'
        : 'возврат не завершён, повторим',
    );
  } catch (error) {
    // Флаг вместо ретрая: обязанность вернуть деньги переживёт сбой шлюза и перезапуск API.
    // Сбой самой записи флага не гасим: без него долг клиенту потерян, а 500 заставит
    // провайдера повторить уведомление — это лучше, чем тихая потеря.
    await markRefundRequired(db, input.paymentId);
    request.log.error(
      { paymentId: input.paymentId, errorName: errorNameOf(error) },
      'не удалось вернуть деньги по неактуальной оплате: возврат помечен обязательным и будет повторён',
    );
  }
}

export const paymentsRoutes: FastifyPluginAsyncZod<PaymentsRoutesOptions> = async (
  app,
  options,
) => {
  const { gateway } = options;

  app.post(
    '/payments/webhooks/yookassa',
    {
      schema: {
        tags: ['payments'],
        summary: 'HTTP-уведомление ЮKassa об изменении статуса платежа',
        body: yookassaWebhookSchema,
        response: { 200: okResponseSchema, 403: apiErrorSchema, 500: apiErrorSchema },
      },
    },
    async (request, reply) => {
      const webhook = request.body;
      const yookassaPaymentId = webhook.object.id;

      // Allowlist IP — единственная аутентификация уведомления: подписи ЮKassa не присылает.
      // В лог попадает только id платежа: ни адреса, ни тела уведомления.
      if (!isYookassaIp(request.ip)) {
        request.log.warn(
          { yookassaPaymentId },
          'уведомление ЮKassa отклонено: адрес отправителя вне allowlist',
        );
        return reply.status(403).send(buildError('forbidden', request.id));
      }

      const payment = await findPaymentByYookassaId(app.db, yookassaPaymentId);
      if (payment === null) {
        // Уведомление не про нас: 200, чтобы провайдер не повторял его сутки.
        request.log.warn(
          { yookassaPaymentId },
          'уведомление о неизвестном платеже проигнорировано',
        );
        return { ok: true as const };
      }

      // Состояние перезапрашиваем своими ключами: тело уведомления доказательством не является.
      let actual: GatewayPayment;
      try {
        actual = await gateway.getPayment(yookassaPaymentId);
      } catch (error) {
        // 500, а не 200: уведомление не обработано. С ответом 200 ЮKassa больше не повторит его,
        // а оплаченная запись останется `pending` — свипер отменит её без возврата денег.
        request.log.error(
          { yookassaPaymentId, paymentId: payment.paymentId, errorName: errorNameOf(error) },
          'не удалось перезапросить платёж у ЮKassa: просим провайдера повторить уведомление',
        );
        return reply.status(500).send(buildError('internal_error', request.id));
      }

      // Сумма — только наша: расхождение значит, что деньги приняты не по нашему расчёту.
      if (actual.amountKopecks !== payment.amountKopecks) {
        request.log.error(
          {
            yookassaPaymentId,
            paymentId: payment.paymentId,
            expectedKopecks: payment.amountKopecks,
            actualKopecks: actual.amountKopecks,
          },
          'сумма платежа не совпадает с ожидаемой: состояние не изменено',
        );
        return { ok: true as const };
      }

      // Действуем по фактическому статусу провайдера, а не по событию из тела: `succeeded`
      // без `paid` деньгами не считается, а незавершённый платёж ничего не меняет.
      if (actual.status === 'succeeded' && actual.paid) {
        await applySucceeded(request, app.db, gateway, {
          paymentId: payment.paymentId,
          yookassaPaymentId,
          amountKopecks: actual.amountKopecks,
        });
      } else if (actual.status === 'canceled') {
        const transition = await applyPaymentCanceled(app.db, payment.paymentId);
        if (transition !== null) {
          request.log.info(
            {
              paymentId: transition.paymentId,
              appointmentId: transition.appointmentId,
              status: transition.status,
              appointmentStatus: transition.appointmentStatus,
              changed: transition.changed,
            },
            'платёж отменён, запись освобождена',
          );
        }
      } else {
        request.log.info(
          { yookassaPaymentId, paymentId: payment.paymentId, event: webhook.event },
          'уведомление не меняет состояние: платёж ещё не завершён',
        );
      }

      return { ok: true as const };
    },
  );

  app.get(
    '/bookings/:id/payment',
    {
      schema: {
        tags: ['payments'],
        summary: 'Статус оплаты записи (без персональных данных)',
        params: paymentStatusParamsSchema,
        response: { 200: paymentStatusResponseSchema, 404: apiErrorSchema },
      },
    },
    async (request, reply) => {
      const payment = await findPaymentByAppointment(app.db, request.params.id);
      if (payment === null) return reply.status(404).send(buildError('not_found', request.id));
      return { status: payment.status, appointmentStatus: payment.appointmentStatus };
    },
  );
};
