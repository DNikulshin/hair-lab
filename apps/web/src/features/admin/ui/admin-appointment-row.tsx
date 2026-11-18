'use client';

import type { AdminAppointment } from '@hair-lab/contracts';
import { useState, type FormEvent } from 'react';
import { formatSlotTime } from '@/features/booking';
import { formatDuration, formatPrice } from '@/features/catalog';
import { Button } from '@/shared/ui/button';
import { Field } from '@/shared/ui/field';
import type { AdminAction } from '../api/admin-api';
import { adminStatusLabel, formatAdminCancelReason, isActiveAdminStatus } from '../model/day-model';

/**
 * Строка записи дня и действия над ней.
 *
 * Состояние формы отмены (открыта/закрыта, текст причины) — локальное для строки: две
 * строки не делят черновик причины, а закрытие формы не трогает остальные. Родитель
 * сообщает только то, что знает он: запрос в полёте (`busy`) и какое действие выполняется
 * именно в этой строке (`currentAction`) — по нему подпись кнопки меняется на «Отменяем…».
 *
 * `canCancel` — матрица ролей админки (#252): отмена салоном доступна только роли `admin`.
 * Правило обеспечивает API (403 `forbidden`), здесь — только удобство: менеджер не видит
 * кнопку, которая всё равно не сработает.
 *
 * Пока запрос в полёте, все кнопки строки disabled: второй клик не отправит второй запрос.
 *
 * ПДн: имя и телефон клиента — только текстом (ссылок `tel:` нет: номер не должен попадать
 * в URL, историю и логи). Причина отмены — данные экрана сотрудника, не для ссылок.
 *
 * `cancelReason` в контракте необязательное (ответ API прежней версии его не содержит):
 * отсутствие поля трактуем как `null` — «причины нет» — и подпись не рисуем.
 */

/** Предел причины отмены — тот же, что в контракте `adminCancelRequestSchema`. */
const CANCEL_REASON_MAX = 1000;

const ACTION_LABELS: Record<AdminAction, string> = {
  confirm: 'Подтвердить',
  cancel: 'Отменить запись',
  complete: 'Завершилась',
  'no-show': 'Не пришёл',
};

const ACTION_PENDING_LABELS: Record<AdminAction, string> = {
  confirm: 'Подтверждаем…',
  cancel: 'Отменяем…',
  complete: 'Завершаем…',
  'no-show': 'Отмечаем…',
};

export interface AdminAppointmentRowProps {
  item: AdminAppointment;
  /** Часовой пояс салона: время показываем в нём, а не в поясе браузера. */
  timeZone: string;
  /** Запрос в полёте (в любой строке): кнопки заблокированы. */
  busy: boolean;
  /** Действие, выполняемое в этой строке, или `null`. */
  currentAction: AdminAction | null;
  /** Отмена салоном доступна только роли `admin` (#252); менеджер кнопку не видит. */
  canCancel: boolean;
  /** Выполнить действие. `true` — запись обновлена, форму отмены можно закрыть. */
  onAction: (action: AdminAction, reason?: string) => Promise<boolean>;
}

export function AdminAppointmentRow({
  item,
  timeZone,
  busy,
  currentAction,
  canCancel,
  onAction,
}: AdminAppointmentRowProps) {
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);

  function label(action: AdminAction): string {
    return currentAction === action ? ACTION_PENDING_LABELS[action] : ACTION_LABELS[action];
  }

  function openCancel() {
    setCancelOpen(true);
    setCancelReason('');
    setReasonError(null);
  }

  function closeCancel() {
    setCancelOpen(false);
    setCancelReason('');
    setReasonError(null);
  }

  async function submitCancel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;

    const reason = cancelReason.trim();
    if (reason === '') {
      setReasonError('Укажите причину отмены: её увидит клиент.');
      return;
    }
    if (reason.length > CANCEL_REASON_MAX) {
      setReasonError(`Причина длиннее ${CANCEL_REASON_MAX} символов.`);
      return;
    }

    setReasonError(null);
    const done = await onAction('cancel', reason);
    if (done) closeCancel();
  }

  function renderActions() {
    if (!isActiveAdminStatus(item.status)) return null;

    if (cancelOpen) {
      return (
        <form onSubmit={(event) => void submitCancel(event)} className="flex flex-col gap-3">
          <Field
            label="Причина отмены"
            error={reasonError ?? undefined}
            hint="Коротко: мастер заболел, клиент просил перенести."
          >
            {(control) => (
              <textarea
                {...control}
                name="cancelReason"
                rows={2}
                required
                maxLength={CANCEL_REASON_MAX}
                value={cancelReason}
                onChange={(event) => setCancelReason(event.target.value)}
                disabled={busy}
                className="w-full rounded-none border-0 border-b border-ink bg-transparent px-0 py-2 text-base text-ink placeholder:text-muted aria-[invalid=true]:border-danger"
              />
            )}
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              size="sm"
              variant="ghost"
              disabled={busy}
              className="border-danger text-danger hover:border-danger hover:text-danger"
            >
              {label('cancel')}
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={closeCancel}>
              Оставить
            </Button>
          </div>
        </form>
      );
    }

    return (
      <div className="flex flex-wrap gap-2">
        {item.status === 'pending' ? (
          <Button type="button" size="sm" disabled={busy} onClick={() => void onAction('confirm')}>
            {label('confirm')}
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => void onAction('complete')}
        >
          {label('complete')}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => void onAction('no-show')}
        >
          {label('no-show')}
        </Button>
        {canCancel ? (
          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={openCancel}>
            Отменить
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <li className="flex flex-col gap-3 rounded-card border border-border p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-medium">
          {formatSlotTime(item.startsAt, timeZone)} · {item.serviceName}
        </p>
        <p className="text-sm text-muted">{adminStatusLabel(item.status)}</p>
      </div>
      <p className="text-sm text-muted">
        {item.masterName} · {formatDuration(item.durationMin)} · {formatPrice(item.priceKopecks)}
      </p>
      <p className="text-sm">
        {item.clientName} · <span>{item.clientPhone}</span>
      </p>
      {item.cancelReason === null || item.cancelReason === undefined ? null : (
        <p className="text-sm text-muted">{formatAdminCancelReason(item.cancelReason)}</p>
      )}
      {renderActions()}
    </li>
  );
}
