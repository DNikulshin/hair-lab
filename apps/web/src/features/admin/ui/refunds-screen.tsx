'use client';

import {
  calendarDateSchema,
  type AdminRefundItem,
  type AdminRefundsScope,
  type StaffAccount,
} from '@hair-lab/contracts';
import { useEffect, useState } from 'react';
import { formatSlotDateTime } from '@/features/booking';
import { formatPrice } from '@/features/catalog';
import { Button, ButtonLink } from '@/shared/ui/button';
import { Field, TextInput } from '@/shared/ui/field';
import { fetchAdminRefunds, fetchCurrentStaff, logoutStaff } from '../api/admin-api';
import { adminStatusLabel, formatAdminCancelReason, salonToday } from '../model/day-model';
import { mapAdminError } from '../model/map-admin-error';
import { refundDefaultPeriod, refundStatusLabel } from '../model/refund-status';
import { StaffLoginForm } from './staff-login-form';

/**
 * Рабочее место сотрудника: обзор возвратов (#298).
 *
 * Порядок загрузки тот же, что у `AdminScreen`: сначала `GET /api/staff/me` — без сессии
 * показываем форму входа, а не пустой список (сотрудник решил бы, что возвратов нет).
 * `401` возвращает экран к форме входа, сбой сервиса — отдельное сообщение с «Повторить»:
 * пустой обзор и недоступный сервис выглядят по-разному и требуют разных действий.
 *
 * Две вкладки — это два списка API (`scope`): «Требуют внимания» (по умолчанию) и
 * «Возвращённые». На второй есть период `from`/`to` с дефолтом «последние 30 дней»: список
 * отдаёт не больше 50 строк старыми первыми, и «за всё время» спрятало бы свежие возвраты.
 * Период считается по дате платежа в часовом поясе салона — его считает API.
 *
 * ПДн: в адресе страницы нет ничего, кроме `scope` и дат; `localStorage` не используем,
 * данные клиента не логируем.
 */

export interface RefundsScreenProps {
  /** Часовой пояс салона: время показываем в нём, а не в поясе браузера. */
  timeZone: string;
}

type Phase = 'checking' | 'login' | 'list';
type ListState = 'loading' | 'ready' | 'unavailable';

interface Period {
  from: string;
  to: string;
}

const SCOPE_LABELS: Record<AdminRefundsScope, string> = {
  attention: 'Требуют внимания',
  completed: 'Возвращённые',
};

/** Пустые состояния раздельные: «нет долга» и «за период не возвращали» — разные факты. */
const EMPTY_LABELS: Record<AdminRefundsScope, string> = {
  attention: 'Возвратов, требующих внимания, нет.',
  completed: 'За выбранный период возвращённых платежей нет.',
};

/** Строка возврата: запись, за которую вернули деньги, сумма и статус. */
function RefundRow({ item, timeZone }: { item: AdminRefundItem; timeZone: string }) {
  return (
    <li className="flex flex-col gap-2 rounded-card border border-border p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-medium">
          {formatSlotDateTime(item.appointment.startsAt, timeZone)} · {item.appointment.serviceName}
        </p>
        <p className="text-sm text-muted">{refundStatusLabel(item.refundStatus)}</p>
      </div>
      <p className="text-sm">
        {formatPrice(item.amountKopecks)} · платёж от {formatSlotDateTime(item.createdAt, timeZone)}
      </p>
      <p className="text-sm text-muted">
        {item.appointment.masterName} · {adminStatusLabel(item.appointment.status)}
      </p>
      <p className="text-sm">
        {item.appointment.clientName} · <span>{item.appointment.clientPhone}</span>
      </p>
      {item.appointment.cancelReason === null ? null : (
        <p className="text-sm text-muted">
          {formatAdminCancelReason(item.appointment.cancelReason)}
        </p>
      )}
    </li>
  );
}

export function RefundsScreen({ timeZone }: RefundsScreenProps) {
  const [phase, setPhase] = useState<Phase>('checking');
  const [staff, setStaff] = useState<StaffAccount | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [scope, setScope] = useState<AdminRefundsScope>('attention');
  const [period, setPeriod] = useState<Period | null>(null);
  const [listState, setListState] = useState<ListState>('loading');
  const [items, setItems] = useState<AdminRefundItem[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  // Счётчики перезапускают эффекты: отдельно проверку сессии и загрузку списка.
  const [sessionToken, setSessionToken] = useState(0);
  const [reloadToken, setReloadToken] = useState(0);
  const [loggingOut, setLoggingOut] = useState(false);

  // Период по умолчанию — после монтирования: до него `window` нет, а «сегодня» зависит от TZ.
  useEffect(() => {
    const today = salonToday(new Date(), timeZone);
    setPeriod((current) => current ?? refundDefaultPeriod(today));
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
        setPhase('list');
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

  /** На «Возвращённых» нужен период; на «Требующих внимания» — весь долг целиком. */
  const queryPeriod = scope === 'completed' ? period : null;
  const periodError =
    queryPeriod !== null && queryPeriod.from > queryPeriod.to
      ? 'Начало периода позже конца: выберите другой день.'
      : null;

  useEffect(() => {
    if (phase !== 'list') return;
    // Незаполненный или противоречивый период не отправляем: сообщение уже на экране.
    const activePeriod = scope === 'completed' ? period : null;
    if (scope === 'completed' && (activePeriod === null || activePeriod.from > activePeriod.to)) {
      return;
    }

    let active = true;
    setListState('loading');
    setListError(null);

    void (async () => {
      const result = await fetchAdminRefunds(
        activePeriod === null ? { scope } : { scope, from: activePeriod.from, to: activePeriod.to },
      );
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
  }, [phase, scope, period, reloadToken]);

  function changeScope(next: AdminRefundsScope) {
    if (next === scope) return;
    setScope(next);
    setItems([]);
    setListError(null);
    setListState('loading');
  }

  function changePeriod(next: Period) {
    setPeriod(next);
    setListError(null);
  }

  function changePeriodDate(field: keyof Period, value: string) {
    // Неполный или несуществующий день (например, 30 февраля) не применяем вовсе.
    if (period === null || !calendarDateSchema.safeParse(value).success) return;
    changePeriod({ ...period, [field]: value });
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
      setListError(mapAdminError(result.failure));
      return;
    }

    setStaff(null);
    setItems([]);
    setListError(null);
    setPhase('login');
  }

  function renderList() {
    if (periodError !== null) {
      return (
        <p role="alert" className="text-sm text-danger">
          {periodError}
        </p>
      );
    }
    if (listState === 'loading') {
      return (
        <p role="status" className="text-sm text-muted">
          Загружаем возвраты…
        </p>
      );
    }
    if (listState === 'unavailable') {
      return (
        <div className="flex flex-col gap-2">
          <p role="alert" className="text-sm text-danger">
            {listError ?? 'Не удалось загрузить возвраты. Попробуйте позже.'}
          </p>
          <Button type="button" variant="ghost" size="sm" onClick={handleRetryList}>
            Повторить
          </Button>
        </div>
      );
    }
    if (items.length === 0) {
      return <p className="text-sm text-muted">{EMPTY_LABELS[scope]}</p>;
    }

    return (
      <ul className="flex flex-col gap-3">
        {items.map((item) => (
          <RefundRow key={item.paymentId} item={item} timeZone={timeZone} />
        ))}
      </ul>
    );
  }

  function renderListScreen() {
    return (
      <div className="flex flex-col gap-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <p className="text-xs text-muted">Обзор возвратов</p>
            <h2 className="text-xl font-light">{SCOPE_LABELS[scope]}</h2>
            {staff === null ? null : (
              <p className="text-xs text-muted">Вы вошли как {staff.email}</p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <ButtonLink href="/admin" variant="ghost" size="sm">
              К записям дня
            </ButtonLink>
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
        </div>

        <div role="tablist" aria-label="Списки возвратов" className="flex flex-wrap gap-2">
          {(Object.keys(SCOPE_LABELS) as AdminRefundsScope[]).map((value) => (
            <Button
              key={value}
              type="button"
              size="sm"
              variant={value === scope ? 'primary' : 'ghost'}
              role="tab"
              aria-selected={value === scope}
              onClick={() => changeScope(value)}
            >
              {SCOPE_LABELS[value]}
            </Button>
          ))}
        </div>

        {scope === 'completed' && period !== null ? (
          <div className="flex flex-wrap gap-4">
            <Field label="С даты">
              {(control) => (
                <TextInput
                  {...control}
                  type="date"
                  value={period.from}
                  onChange={(event) => changePeriodDate('from', event.target.value)}
                />
              )}
            </Field>
            <Field label="По дату">
              {(control) => (
                <TextInput
                  {...control}
                  type="date"
                  value={period.to}
                  onChange={(event) => changePeriodDate('to', event.target.value)}
                />
              )}
            </Field>
          </div>
        ) : null}

        {renderList()}
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
            Обзор возвратов доступен только сотрудникам салона. Вход клиента здесь не работает.
          </p>
        </div>
        <StaffLoginForm
          onSuccess={(account) => {
            setStaff(account);
            setListError(null);
            setPhase('list');
          }}
        />
      </div>
    );
  }

  return renderListScreen();
}
