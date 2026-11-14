/**
 * Шлюз платежей: контракт между доменной логикой оплаты и провайдером (ЮKassa).
 *
 * Фича зависит от этого интерфейса, а не от HTTP-клиента: в тестах шлюз подменяется
 * поддельным объектом, а живой ЮKassa подключается адаптером (`yookassa.client.ts`).
 * Типы результата не содержат персональных данных клиента и не содержат секретов:
 * в шлюз уходят только id записи, сумма, описание и адрес возврата.
 */

/** Статус платежа в терминах домена: `waiting_for_capture` и прочие состояния — `pending`. */
export type GatewayPaymentStatus = 'pending' | 'succeeded' | 'canceled';

/**
 * Статус возврата в терминах домена.
 *
 * `succeeded` — деньги вернулись клиенту; `pending` — возврат в процессе (провайдер ещё
 * не подтвердил его завершение); `canceled` — провайдер отказал в возврате; `unknown` — ответ
 * не распознан. Завершённым считается только `succeeded`: остальные статусы оставляют
 * обязанность вернуть деньги в БД, иначе флаг снимался бы при несостоявшемся возврате.
 */
export type GatewayRefundStatus = 'succeeded' | 'pending' | 'canceled' | 'unknown';

export interface CreatePaymentInput {
  /** Внутренний id записи: уходит только в `metadata`, ПДн клиента в шлюз не передаются. */
  appointmentId: string;
  /** Сумма в копейках. Конвертацию в рубли делает клиент шлюза целочисленной арифметикой. */
  amountKopecks: number;
  /** Описание операции для клиента (`Оплата записи: Стрижка`) — без имени, телефона и почты. */
  description: string;
  /** Куда вернуть клиента после оплаты. */
  returnUrl: string;
  /**
   * Ключ идемпотентности провайдера (`Idempotence-Key`): повтор с тем же ключом
   * возвращает тот же платёж, а не создаёт второй.
   */
  idempotenceKey: string;
}

export interface CreatedPayment {
  /** id платежа в ЮKassa: по нему приходит уведомление и делается перезапрос состояния. */
  yookassaPaymentId: string;
  /** Ссылка на страницу оплаты, которую показываем клиенту. */
  confirmationUrl: string;
  /** Срок действия ссылки (ISO 8601 с зоной), если провайдер его вернул. */
  expiresAt?: string;
}

export interface GatewayPayment {
  id: string;
  status: GatewayPaymentStatus;
  /** Деньги фактически получены: `true` только у `succeeded` с `paid: true`. */
  paid: boolean;
  /** Сумма платежа в копейках — для сверки с суммой в нашей БД. */
  amountKopecks: number;
}

export interface CreateRefundInput {
  yookassaPaymentId: string;
  amountKopecks: number;
  /** Ключ идемпотентности возврата: повтор не возвращает деньги дважды. */
  idempotenceKey: string;
}

export interface CreatedRefund {
  refundId: string;
  /** Статус возврата в терминах домена: завершённым считается только `succeeded`. */
  status: GatewayRefundStatus;
}

/**
 * Адаптер провайдера. Реализация бросает ошибку (`YookassaRequestError` и подобные) на сетевой
 * сбой и не-2xx: доменная логика решает, ретраить операцию или оставить платёж в текущем статусе.
 */
export interface PaymentGateway {
  createPayment(input: CreatePaymentInput): Promise<CreatedPayment>;
  getPayment(id: string): Promise<GatewayPayment>;
  createRefund(input: CreateRefundInput): Promise<CreatedRefund>;
}
