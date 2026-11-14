'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { AccountBooking } from '@hair-lab/contracts';
import { formatSlotDateTime } from '@/features/booking';
import { formatDuration, formatPrice } from '@/features/catalog';
import { paymentPagePath, readPaymentDraft } from '@/features/payment';
import { cancelBooking, fetchAccountBookings, fetchCurrentClient } from '../api/account-api';
import { bookingStatusLabel, isActiveStatus } from '../model/account-status';
import { mapAccountError } from '../model/map-account-error';

/**
 * Кабинет клиента: мои записи и отмена.
 *
 * Порядок загрузки: сначала `GET /auth/me` — гостя уводим на `/login`, а не показываем
 * пустой список (человек решил бы, что записей нет). Затем — страница записей выбранного
 * таба. Ответы валидируются контрактами, поэтому «сервис недоступен» и «записей нет» —
 * разные состояния экрана.
 *
 * Отмена: кнопка активна только когда сервер прислал `cancellable: true`, правило двух
 * часов клиент не дублирует. Подтверждение — второй шаг, чтобы случайное нажатие не
 * отменяло визит. После успеха элемент обновляется локально из ответа API (полного
 * рефетча нет): отменённая запись уходит из «Предстоящих» и остаётся в «Прошлых».
 *
 * ПДн: имя и маска телефона приходят с сервера, полного номера и почты в ответе нет;
 * ничего не пишем в `localStorage` и не логируем.
 *
 * Оплата: у предстоящей записи со статусом `pending` показываем ссылку на страницу оплаты
 * только если в этой вкладке лежит черновик именно этой записи (`sessionStorage`) — иначе
 * страница оплаты откроется, но кнопки провайдера на ней не будет: ссылка живёт в черновике
 * вкладки, где оформляли запись. Без черновика строка говорит, что запись ещё не подтверждена,
 * и ссылку не обещает: её может не быть вовсе (`PAYMENTS_MODE=off`), а черновик вкладки мог быть
 * перезаписан другой записью. Навигация остаётся только «Отменить». Черновик читаем после
 * монтирования: `sessionStorage` есть только в браузере, а первый клиентский рендер должен
 * совпасть с серверным.
 * Текст нейтральный, потому что `pending` значит разное: при включённой оплате — «ждёт
 * предоплаты», при `PAYMENTS_MODE=off` — «ждёт подтверждения салона» (DTO кабинета платежей
 * не различает).
 */

type Scope = 'upcoming' | 'past';

type ViewState = 'loading' | 'ready' | 'unavailable' | 'unauthorized';

const TABS: readonly { scope: Scope; label: string }[] = [
  { scope: 'upcoming', label: 'Предстоящие' },
  { scope: 'past', label: 'Прошлые' },
];

export interface AccountBookingsProps {
  /** Часовой пояс салона: время показываем в нём, а не в поясе браузера. */
  timeZone: string;
}

export function AccountBookings({ timeZone }: AccountBookingsProps) {
  const router = useRouter();
  const [scope, setScope] = useState<Scope>('upcoming');
  const [state, setState] = useState<ViewState>('loading');
  const [items, setItems] = useState<AccountBooking[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  // id записи из черновика оплаты этой вкладки: `sessionStorage` читаем только после
  // монтирования, поэтому стартовое значение — `null` «черновика нет» (и на сервере, и в браузере).
  const [paymentDraftId, setPaymentDraftId] = useState<string | null>(null);

  useEffect(() => {
    setPaymentDraftId(readPaymentDraft()?.appointmentId ?? null);
  }, []);

  // Сессия проверяется при каждой загрузке списка: так истёкшая сессия сразу уводит
  // на вход, а не превращается в «нет записей».
  useEffect(() => {
    let active = true;
    setState('loading');
    setError(null);
    setConfirmId(null);

    void (async () => {
      const session = await fetchCurrentClient();
      if (!active) return;
      if (!session.ok) {
        if (session.failure.kind === 'http' && session.failure.status === 401) {
          setState('unauthorized');
          router.replace('/login');
          return;
        }
        setState('unavailable');
        setError(mapAccountError(session.failure));
        return;
      }

      const result = await fetchAccountBookings({ scope });
      if (!active) return;
      if (!result.ok) {
        if (result.failure.kind === 'http' && result.failure.status === 401) {
          setState('unauthorized');
          router.replace('/login');
          return;
        }
        setState('unavailable');
        setError(mapAccountError(result.failure));
        return;
      }

      setItems(result.data.items);
      setState('ready');
    })();

    return () => {
      active = false;
    };
  }, [router, scope, reloadToken]);

  function handleScopeChange(nextScope: Scope) {
    if (nextScope === scope) return;
    setScope(nextScope);
    setItems([]);
    setNotice(null);
  }

  function handleRetry() {
    setReloadToken((token) => token + 1);
  }

  async function handleCancel(id: string) {
    setConfirmId(null);
    setCancellingId(id);
    setError(null);
    setNotice(null);

    const result = await cancelBooking(id);

    setCancellingId(null);

    if (!result.ok) {
      if (result.failure.kind === 'http' && result.failure.status === 401) {
        setState('unauthorized');
        router.replace('/login');
        return;
      }
      setError(mapAccountError(result.failure));
      // 409 — правило не изменится: кнопку больше не показываем, состояние берём с сервера.
      if (result.failure.kind === 'http' && result.failure.status === 409) {
        setItems((current) =>
          current.map((item) => (item.id === id ? { ...item, cancellable: false } : item)),
        );
      }
      // 404 — записи нет (уже отменили в другой вкладке): убираем её из списка.
      if (result.failure.kind === 'http' && result.failure.status === 404) {
        setItems((current) => current.filter((item) => item.id !== id));
      }
      return;
    }

    setNotice('Запись отменена.');
    setItems((current) =>
      current
        .map((item) => (item.id === id ? result.data : item))
        // Отменённая запись принадлежит истории: в «Предстоящих» её больше нет.
        .filter((item) => (scope === 'upcoming' ? item.status !== 'cancelled' : true)),
    );
  }

  function renderCancelAction(booking: AccountBooking) {
    if (!isActiveStatus(booking.status)) return null;

    if (confirmId === booking.id) {
      return (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm">Отменить эту запись?</p>
          <button
            type="button"
            onClick={() => void handleCancel(booking.id)}
            disabled={cancellingId === booking.id}
            className="rounded-card border border-border px-3 py-1 text-sm text-red-600 disabled:opacity-60"
          >
            {cancellingId === booking.id ? 'Отменяем…' : 'Да, отменить'}
          </button>
          <button
            type="button"
            onClick={() => setConfirmId(null)}
            className="rounded-card border border-border px-3 py-1 text-sm"
          >
            Оставить
          </button>
        </div>
      );
    }

    return (
      <div className="flex flex-col gap-1">
        <button
          type="button"
          onClick={() => setConfirmId(booking.id)}
          disabled={!booking.cancellable || cancellingId === booking.id}
          aria-describedby={booking.cancellable ? undefined : `cancel-hint-${booking.id}`}
          className="w-fit rounded-card border border-border px-3 py-1 text-sm disabled:opacity-60"
        >
          {cancellingId === booking.id ? 'Отменяем…' : 'Отменить'}
        </button>
        {booking.cancellable ? null : (
          <p id={`cancel-hint-${booking.id}`} className="text-xs text-muted">
            Отмена недоступна: до визита меньше двух часов. Позвоните в салон.
          </p>
        )}
      </div>
    );
  }

  function renderPaymentAction(booking: AccountBooking) {
    // Без черновика ссылку не показываем и не обещаем: её может не быть вовсе
    // (`PAYMENTS_MODE=off`), а черновик вкладки мог быть перезаписан другой записью.
    if (paymentDraftId !== booking.id) {
      return (
        <p className="text-sm">
          Запись ещё не подтверждена. Ссылка на оплату — в той вкладке, где вы записывались (если
          оплата включена).
        </p>
      );
    }

    return (
      <div className="flex flex-col gap-1">
        <p className="text-sm">Запись ещё не подтверждена.</p>
        <Link href={paymentPagePath(booking.id)} className="w-fit text-sm underline">
          Перейти к оплате
        </Link>
      </div>
    );
  }

  function renderList() {
    if (state === 'loading') {
      return (
        <p role="status" className="text-sm text-muted">
          Загружаем записи…
        </p>
      );
    }
    if (state === 'unauthorized') {
      return (
        <p role="status" className="text-sm text-muted">
          Нужно войти в аккаунт. Открываем страницу входа…
        </p>
      );
    }
    if (state === 'unavailable') {
      return (
        <div className="flex flex-col gap-2">
          <p role="alert" className="text-sm text-red-600">
            {error ?? 'Не удалось загрузить записи. Попробуйте позже.'}
          </p>
          <button
            type="button"
            onClick={handleRetry}
            className="w-fit rounded-card border border-border px-3 py-2 text-sm"
          >
            Повторить
          </button>
        </div>
      );
    }
    if (items.length === 0) {
      return (
        <div className="flex flex-col gap-3 text-sm text-muted">
          <p>
            {scope === 'upcoming'
              ? 'Предстоящих записей нет.'
              : 'Прошлых записей пока нет — здесь появится история визитов.'}
          </p>
          {scope === 'upcoming' ? (
            <Link href="/book" className="w-fit underline">
              Записаться на услугу
            </Link>
          ) : null}
        </div>
      );
    }

    return (
      <ul className="flex flex-col gap-3">
        {items.map((booking) => (
          <li
            key={booking.id}
            className="flex flex-col gap-3 rounded-card border border-border bg-surface-raised p-4"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="font-medium">{booking.serviceName}</p>
              <p className="text-sm text-muted">{bookingStatusLabel(booking.status)}</p>
            </div>
            <p className="text-sm">{formatSlotDateTime(booking.startsAt, timeZone)}</p>
            <p className="text-sm text-muted">
              {booking.masterName} · {formatDuration(booking.durationMin)} ·{' '}
              {formatPrice(booking.price.amountMinor)}
            </p>
            {booking.clientPhoneMasked === undefined ? null : (
              <p className="text-xs text-muted">Телефон для связи: {booking.clientPhoneMasked}</p>
            )}
            {scope === 'upcoming' && booking.status === 'pending'
              ? renderPaymentAction(booking)
              : null}
            {renderCancelAction(booking)}
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap gap-2" role="group" aria-label="Мои записи">
        {TABS.map((tab) => (
          <button
            key={tab.scope}
            type="button"
            aria-pressed={scope === tab.scope}
            onClick={() => handleScopeChange(tab.scope)}
            className={[
              'rounded-card border px-4 py-2 text-sm',
              scope === tab.scope ? 'border-accent bg-accent text-surface' : 'border-border',
            ].join(' ')}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {error !== null && state !== 'unavailable' ? (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      ) : null}
      {notice !== null ? (
        <p role="status" className="text-sm text-muted">
          {notice}
        </p>
      ) : null}

      {renderList()}
    </div>
  );
}
