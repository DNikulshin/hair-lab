import type { RefundClientStatus } from '@hair-lab/contracts';
import { shiftDate } from './day-model';

/**
 * Возвраты в админке: подписи статусов и период по умолчанию.
 *
 * Чистые функции без React и сети: их проверяют обычные unit-тесты. Словарь статусов — тот же,
 * что в контракте (`refundClientStatusSchema`): служебные коды БД и провайдера наружу не
 * выходят, второй словарь не заводим.
 *
 * ПДн здесь нет: только статусы и календарные даты.
 */

/** Подписи статусов возврата для сотрудника. */
const REFUND_STATUS_LABELS: Record<RefundClientStatus, string> = {
  pending: 'Ожидается возврат',
  succeeded: 'Возвращён',
  failed: 'Возврат не удался',
};

/**
 * Подпись статуса; неизвестный код не роняет рендер (набор статусов живёт в контракте,
 * и новый статус в старом web не должен ломать список).
 */
export function refundStatusLabel(status: RefundClientStatus): string {
  return REFUND_STATUS_LABELS[status] ?? 'Статус возврата неизвестен';
}

/** Сколько дней показывает период по умолчанию на вкладке «Возвращённые». */
export const REFUND_PERIOD_DAYS = 30;

/**
 * Период по умолчанию для вкладки «Возвращённые»: последние 30 дней включительно (`to` — сегодня).
 *
 * Зачем: список отдаёт не больше 50 строк, старые первыми, без пагинации. «За всё время»
 * показало бы самые старые возвраты и спрятало свежие — те, которые сотрудник и ищет.
 * Арифметика по календарю (`shiftDate`), поэтому переход на летнее/зимнее время день не двигает.
 */
export function refundDefaultPeriod(today: string): { from: string; to: string } {
  return { from: shiftDate(today, -(REFUND_PERIOD_DAYS - 1)), to: today };
}
