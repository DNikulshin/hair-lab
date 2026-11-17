'use client';

import { calendarDateSchema, type AdminAppointment, type StaffAccount } from '@hair-lab/contracts';
import { useEffect, useState } from 'react';
import { Button } from '@/shared/ui/button';
import {
  fetchAdminAppointments,
  fetchCurrentStaff,
  logoutStaff,
  runAdminAction,
  type AdminAction,
} from '../api/admin-api';
import { formatDayLabel, salonToday, shiftDate } from '../model/day-model';
import { mapAdminError } from '../model/map-admin-error';
import { AdminAppointmentRow } from './admin-appointment-row';
import { StaffLoginForm } from './staff-login-form';

/**
 * Рабочее место сотрудника: вход, записи выбранного дня и действия над ними.
 *
 * Порядок загрузки: сначала `GET /api/staff/me` — без сессии показываем форму входа,
 * а не пустой список (сотрудник решил бы, что записей нет). Дата берётся из `?date=`
 * или из сегодняшнего дня в поясе салона; вычисляется в эффекте после монтирования,
 * потому что `window` есть только в браузере, а первый рендер должен совпасть с серверным.
 *
 * Переключение дня — без навигации: дата в состоянии, адрес обновляется
 * `history.replaceState`, поэтому «←»/«→»/«Сегодня» не перезагружают страницу.
 *
 * Действия: `pendingAction` блокирует все кнопки на время запроса, guard в обработчике
 * не даёт второму клику отправить второй запрос. Ответ API — обновлённая запись, поэтому
 * строка правится локально без рефетча. `409` — состояние изменилось (сообщение +
 * перечитать список), `404` — строку убираем, `401` — экран возвращается к форме входа.
 *
 * ПДн: в адресе страницы живёт только дата; ничего не пишем в `localStorage` и не логируем.
 */

export interface AdminScreenProps {
  /** Часовой пояс салона: день и время считаем в нём, а не в поясе браузера. */
  timeZone: string;
}

type Phase = 'checking' | 'login' | 'day';
type ListState = 'loading' | 'ready' | 'unavailable';

/** Результат действия: сообщение живёт дольше, чем перезагрузка списка. */
interface Feedback {
  kind: 'ok' | 'error';
  text: string;
}

const ACTION_DONE: Record<AdminAction, string> = {
  confirm: 'Запись подтверждена.',
  cancel: 'Запись отменена. Причина сохранена и видна клиенту.',
  complete: 'Визит отмечен завершённым.',
  'no-show': 'Отмечено: клиент не пришёл.',
};

/** Дата из `?date=`: невалидное значение игнорируем и показываем сегодня. */
function readDateFromUrl(): string | null {
  const value = new URLSearchParams(window.location.search).get('date');
  if (value === null) return null;
  const parsed = calendarDateSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function AdminScreen({ timeZone }: AdminScreenProps) {
  const [phase, setPhase] = useState<Phase>('checking');
  const [staff, setStaff] = useState<StaffAccount | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [today, setToday] = useState<string | null>(null);
  const [date, setDate] = useState<string | null>(null);
  const [listState, setListState] = useState<ListState>('loading');
  const [items, setItems] = useState<AdminAppointment[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  // Счётчики перезапускают эффекты: отдельно проверку сессии и загрузку списка.
  const [sessionToken, setSessionToken] = useState(0);
  const [reloadToken, setReloadToken] = useState(0);
  const [pendingAction, setPendingAction] = useState<{ id: string; action: AdminAction } | null>(
    null,
  );
  const [loggingOut, setLoggingOut] = useState(false);

  // Дата и «сегодня» — после монтирования: до него `window` нет, а значения зависят от TZ.
  useEffect(() => {
    const todayDate = salonToday(new Date(), timeZone);
    setToday(todayDate);
    setDate((current) => current ?? readDateFromUrl() ?? todayDate);
  }, [timeZone]);

  // Сессия: 401 — форма входа, сеть — ошибка с повтором.
  useEffect(() => {
    let active = true;
    setSessionError(null);

    void (async () => {
      const session = await fetchCurrentStaff();
      if (!active) return;

      if (session.ok) {
        setStaff(session.data);
        setPhase('day');
        return;
      }
      if (session.failure.kind === 'http' && session.failure.status === 401) {
        setStaff(null);
        setPhase('login');
        return;
      }

      setSessionError(mapAdminError(session.failure));
      setPhase('checking');
    })();

    return () => {
      active = false;
    };
  }, [sessionToken]);

  // Записи дня: грузим только когда известна дата и сотрудник вошёл.
  useEffect(() => {
    if (phase !== 'day' || date === null) return;

    let active = true;
    setListState('loading');
    setListError(null);

    void (async () => {
      const result = await fetchAdminAppointments(date);
      if (!active) return;

      if (!result.ok) {
        if (result.failure.kind === 'http' && result.failure.status === 401) {
          setStaff(null);
          setPhase('login');
          return;
        }
        setListState('unavailable');
        setListError(mapAdminError(result.failure));
        return;
      }

      setItems(result.data.items);
      setListState('ready');
    })();

    return () => {
      active = false;
    };
  }, [phase, date, reloadToken]);

  function changeDate(next: string) {
    if (next === date) return;
    setDate(next);
    setFeedback(null);

    // Навигации нет: меняем адрес, чтобы день можно было переслать ссылкой.
    const url = new URL(window.location.href);
    url.searchParams.set('date', next);
    window.history.replaceState(null, '', url);
  }

  function handleRetryList() {
    setReloadToken((token) => token + 1);
  }

  function handleRetrySession() {
    setPhase('checking');
    setSessionToken((token) => token + 1);
  }

  async function handleLogout() {
    if (loggingOut) return;
    setLoggingOut(true);
    const result = await logoutStaff();
    setLoggingOut(false);

    if (!result.ok) {
      setFeedback({ kind: 'error', text: mapAdminError(result.failure) });
      return;
    }

    setStaff(null);
    setItems([]);
    setFeedback(null);
    setPhase('login');
  }

  /** Выполнить действие над строкой. `true` — запись обновлена и строка уже перерисована. */
  async function runAction(
    item: AdminAppointment,
    action: AdminAction,
    reason?: string,
  ): Promise<boolean> {
    // Guard: второй клик во время запроса ничего не отправляет.
    if (pendingAction !== null) return false;

    setPendingAction({ id: item.id, action });
    setFeedback(null);

    const result = await runAdminAction(item.id, action, reason);
    setPendingAction(null);

    if (!result.ok) {
      if (result.failure.kind === 'http' && result.failure.status === 401) {
        setStaff(null);
        setPhase('login');
        return false;
      }
      // 404 — записи нет: строке нечего показывать.
      if (result.failure.kind === 'http' && result.failure.status === 404) {
        setItems((current) => current.filter((row) => row.id !== item.id));
        setFeedback({ kind: 'error', text: mapAdminError(result.failure) });
        return false;
      }
      setFeedback({ kind: 'error', text: mapAdminError(result.failure) });
      // 409 — состояние на сервере другое: перечитываем день, а не спорим с ним.
      if (result.failure.kind === 'http' && result.failure.status === 409) {
        setReloadToken((token) => token + 1);
      }
      return false;
    }

    setItems((current) => current.map((row) => (row.id === item.id ? result.data : row)));
    setFeedback({ kind: 'ok', text: ACTION_DONE[action] });
    return true;
  }

  function renderItems() {
    if (listState === 'loading') {
      return (
        <p role="status" className="text-sm text-muted">
          Загружаем записи…
        </p>
      );
    }
    if (listState === 'unavailable') {
      return (
        <div className="flex flex-col gap-2">
          <p role="alert" className="text-sm text-danger">
            {listError ?? 'Не удалось загрузить записи. Попробуйте позже.'}
          </p>
          <Button type="button" variant="ghost" size="sm" onClick={handleRetryList}>
            Повторить
          </Button>
        </div>
      );
    }
    if (items.length === 0) {
      return <p className="text-sm text-muted">На этот день записей нет.</p>;
    }

    return (
      <ul className="flex flex-col gap-3">
        {items.map((item) => (
          <AdminAppointmentRow
            key={item.id}
            item={item}
            timeZone={timeZone}
            busy={pendingAction !== null}
            currentAction={pendingAction?.id === item.id ? pendingAction.action : null}
            onAction={(action, reason) => runAction(item, action, reason)}
          />
        ))}
      </ul>
    );
  }

  function renderDay() {
    if (date === null) {
      return (
        <p role="status" className="text-sm text-muted">
          Загружаем день…
        </p>
      );
    }

    return (
      <div className="flex flex-col gap-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <p className="text-xs text-muted">Записи на день</p>
            <h2 className="text-xl font-light">{formatDayLabel(date)}</h2>
            {staff === null ? null : (
              <p className="text-xs text-muted">Вы вошли как {staff.email}</p>
            )}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void handleLogout()}
            disabled={loggingOut}
          >
            {loggingOut ? 'Выходим…' : 'Выйти'}
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label="Предыдущий день"
            onClick={() => changeDate(shiftDate(date, -1))}
          >
            ←
          </Button>
          {today === null || today === date ? null : (
            <Button type="button" variant="ghost" size="sm" onClick={() => changeDate(today)}>
              Сегодня
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label="Следующий день"
            onClick={() => changeDate(shiftDate(date, 1))}
          >
            →
          </Button>
        </div>

        {feedback === null ? null : (
          <p
            role={feedback.kind === 'error' ? 'alert' : 'status'}
            className={feedback.kind === 'error' ? 'text-sm text-danger' : 'text-sm text-muted'}
          >
            {feedback.text}
          </p>
        )}

        {renderItems()}
      </div>
    );
  }

  if (phase === 'checking') {
    return sessionError === null ? (
      <p role="status" className="text-sm text-muted">
        Проверяем сессию…
      </p>
    ) : (
      <div className="flex flex-col gap-2">
        <p role="alert" className="text-sm text-danger">
          {sessionError}
        </p>
        <Button type="button" variant="ghost" size="sm" onClick={handleRetrySession}>
          Повторить
        </Button>
      </div>
    );
  }

  if (phase === 'login') {
    return (
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <h2 className="text-lg font-light">Вход для сотрудников</h2>
          <p className="text-sm text-muted">
            Админка доступна только сотрудникам салона. Вход клиента здесь не работает.
          </p>
        </div>
        <StaffLoginForm
          onSuccess={(account) => {
            setStaff(account);
            setFeedback(null);
            setPhase('day');
          }}
        />
      </div>
    );
  }

  return renderDay();
}
