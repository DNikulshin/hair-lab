import type { BookingStatus, PaymentStatus } from '@hair-lab/contracts';
import type { PaymentDraft } from './payment-draft';

/**
 * Чистая модель экрана оплаты: из ответа API (статус платежа + статус записи) и черновика
 * получается всё, что показывает страница. Рендер ничего не решает сам — состояния
 * перечислены здесь и покрыты тестами.
 *
 * Откуда берутся состояния:
 * - `pending` — платёж ждёт оплату: держим холд слота, показываем таймер и ссылку провайдера.
 *   Остаток холда считается по `expiresAt` черновика: сервер срок не отдаёт, поэтому таймер —
 *   только подсказка по часам клиента. Ссылку он не запирает: пока сервер отдаёт `pending`,
 *   заплатить можно, даже если сбитые часы уже показали нуль (иначе живой серверный холд
 *   остался бы без кнопки оплаты). Просроченный по клиентским часам таймер значит не «ссылка
 *   истекла», а «проверяем статус»; «холд истёк» приходит только от сервера;
 * - `paid` — деньги получены и запись подтверждена;
 * - `refundPending` — деньги получены, но запись уже отменена: возврат в пути;
 * - `canceled` — платёж снят или холд истёк (у платежа `canceled`, либо `pending` у отменённой
 *   записи: свипер снимает платёж с задержкой до ~30 с, и это уже не «ждём оплату»);
 * - `refunded` — деньги вернулись клиенту;
 * - `notFound` — платежа нет: при `PAYMENTS_MODE=off` оплата не подключается, плюс битый id;
 * - `unavailable` — сеть, 5xx или ответ не по контракту: статус неизвестен, нужен повтор.
 *
 * Опрос (`shouldPoll`) включаем только для «ждём оплату»: остальные состояния меняются
 * вебхуком или свипером редко, а лишние запросы видит клиент с мобильным интернетом.
 * Терминальные состояния (`terminal`) — повод удалить черновик: ссылка на оплату больше
 * не нужна, а хранить её в вкладке дольше необходимого незачем.
 */

/** Что известно о платеже на текущий момент. */
export type PaymentView =
  | { kind: 'loading' }
  | { kind: 'notFound' }
  | { kind: 'unavailable' }
  | { kind: 'ready'; status: PaymentStatus; appointmentStatus: BookingStatus };

/** Состояние экрана. */
export type PaymentStateKind =
  | 'loading'
  | 'pending'
  | 'paid'
  | 'refundPending'
  | 'canceled'
  | 'refunded'
  | 'notFound'
  | 'unavailable';

export interface PaymentState {
  kind: PaymentStateKind;
  /** Заголовок экрана: что происходит с оплатой. */
  title: string;
  /** Пояснение; `null` — добавить нечего. */
  description: string | null;
  /** Остаток холда в мс; `null` — не ждём оплату или срок неизвестен. */
  remainingMs: number | null;
  /** Остаток холда «ММ:СС»; `null` — таймер показывать нечего. */
  remainingLabel: string | null;
  /** Ссылка на страницу оплаты провайдера: пока сервер отдаёт `pending`, а не по клиентским часам. */
  paymentUrl: string | null;
  /** Опрашивать статус автоматически; от клиентских часов не зависит. */
  shouldPoll: boolean;
  /** Терминальное состояние: опрос прекращаем, черновик удаляем. */
  terminal: boolean;
  /** Показать «Проверить ещё раз»: статус не получен, но запрос имеет смысл повторить. */
  retryable: boolean;
}

export interface PaymentStateInput {
  view: PaymentView;
  /** Черновик вкладки: из него берём срок холда и ссылку на оплату. */
  draft: PaymentDraft | null;
  /** Текущее время в мс: таймер детерминирован в тестах. */
  now: number;
}

/** Остаток в «ММ:СС». Секунды округляем вверх: 14:59.4 показывает «15:00», а не «14:59». */
export function formatRemaining(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/** Срок действия ссылки в мс; `null` — черновика нет или срок битый. */
function expiresAtMs(draft: PaymentDraft | null): number | null {
  if (draft === null) return null;
  const parsed = Date.parse(draft.expiresAt);
  return Number.isNaN(parsed) ? null : parsed;
}

function stateOf(
  kind: PaymentStateKind,
  title: string,
  description: string | null,
  extra: Partial<PaymentState> = {},
): PaymentState {
  return {
    kind,
    title,
    description,
    remainingMs: null,
    remainingLabel: null,
    paymentUrl: null,
    shouldPoll: false,
    terminal: false,
    retryable: false,
    ...extra,
  };
}

/**
 * Состояние экрана оплаты.
 *
 * Приоритет ветвей: сначала «что знаем» (загрузка/404/сеть), потом статус платежа — так
 * `canceled` у отменённой записи не превращается в «ждём оплату» из-за задержки свипера.
 */
export function resolvePaymentState({ view, draft, now }: PaymentStateInput): PaymentState {
  if (view.kind === 'loading') {
    return stateOf('loading', 'Загружаем статус оплаты…', null);
  }

  if (view.kind === 'notFound') {
    return stateOf(
      'notFound',
      'Оплата не найдена',
      'Для этой записи оплата не требуется или ссылка устарела. Если вы ждали ссылку на оплату — позвоните в салон.',
      { terminal: true },
    );
  }

  if (view.kind === 'unavailable') {
    return stateOf(
      'unavailable',
      'Не удалось получить статус оплаты',
      'Сервис оплаты временно недоступен. Проверьте статус ещё раз через минуту.',
      { retryable: true },
    );
  }

  const { status, appointmentStatus } = view;

  if (status === 'succeeded') {
    // Запись отменили (холд истёк или клиент снял визит) уже после оплаты: деньги вернутся.
    if (appointmentStatus === 'cancelled') {
      return stateOf(
        'refundPending',
        'Оплата возвращается',
        'Запись отменена, деньги вернутся на карту в течение нескольких дней.',
        { terminal: true },
      );
    }
    return stateOf('paid', 'Оплачено', 'Оплата получена, запись подтверждена.', {
      terminal: true,
    });
  }

  if (status === 'refunded') {
    return stateOf(
      'refunded',
      'Деньги возвращены',
      'Возврат выполнен. Если время визита всё ещё нужно — запишитесь заново.',
      { terminal: true },
    );
  }

  if (status === 'canceled') {
    return stateOf(
      'canceled',
      'Оплата не состоялась',
      'Время на оплату истекло или платёж отменён. Запишитесь заново — свободное время покажем сразу.',
      { terminal: true },
    );
  }

  // Осталось `pending`: платёж создан, деньги ещё не пришли.
  // Отменённая запись при `pending` платеже — истёкший холд: свипер снимет платёж в ближайшие
  // полминуты, но «ждём оплату» здесь было бы неправдой.
  if (appointmentStatus === 'cancelled') {
    return stateOf(
      'canceled',
      'Оплата не состоялась',
      'Время на оплату истекло или запись отменена. Запишитесь заново — свободное время покажем сразу.',
      { terminal: true },
    );
  }

  const expiresAt = expiresAtMs(draft);
  const remainingMs = expiresAt === null ? null : Math.max(0, expiresAt - now);
  // Нуль по клиентским часам — не повод прятать ссылку: срок холда знает только сервер, а часы
  // устройства могут убежать вперёд. Живой холд без кнопки оплаты хуже, чем ссылка, которая
  // уже не сработает; истёкший холд сервер отметит сам (`canceled` / `cancelled`).
  const paymentUrl = draft === null ? null : draft.confirmationUrl;
  const expiredByClock = remainingMs === 0;

  return stateOf('pending', 'Ожидаем оплату', pendingDescription(paymentUrl, expiredByClock), {
    remainingMs,
    // На нуле таймер молчит: «действует ещё 00:00» противоречило бы тексту о том, что время вышло.
    remainingLabel: remainingMs === null || expiredByClock ? null : formatRemaining(remainingMs),
    paymentUrl,
    // Пока запись `pending`, ждём вебхук или свипер: опрос идёт по серверному статусу,
    // а не по часам клиента, поэтому прекращается только вместе с записью.
    shouldPoll: appointmentStatus === 'pending',
  });
}

/**
 * Пояснение к «ждём оплату»: ссылка в черновике есть, её нет, или клиентские часы уже вышли
 * за `expiresAt` — в последнем случае честно говорим, что проверяем статус у сервера.
 */
function pendingDescription(paymentUrl: string | null, expiredByClock: boolean): string {
  if (paymentUrl === null) {
    return 'Ссылка на оплату открывается в той же вкладке, где оформлялась запись. Если оплатить не получается — позвоните в салон.';
  }
  if (expiredByClock) {
    return 'Время ссылки истекло — проверяем статус оплаты. Если холд ещё действует, заплатить по ссылке ниже можно; статус обновится сам.';
  }
  return 'Запись держим за вами, пока действует ссылка на оплату.';
}
