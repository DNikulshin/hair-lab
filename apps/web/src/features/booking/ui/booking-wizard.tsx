'use client';

import Link from 'next/link';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type RefObject,
} from 'react';
import type { Booking, CreateBooking, Master, Service, Slot } from '@hair-lab/contracts';
import { formatDuration, formatPrice } from '@/features/catalog';
import { fetchSlots, submitBooking } from '../api/booking-api';
import { createIdempotencyKey } from '../model/idempotency-key';
import {
  EMPTY_BOOKING_ERRORS,
  firstErrorField,
  mapBookingError,
  type BookingErrorState,
  type BookingField,
} from '../model/map-booking-error';
import {
  buildDateOptions,
  formatSlotDateTime,
  formatSlotTime,
  groupSlotsByMaster,
  type DateOption,
} from '../model/slots-model';

/**
 * Гостевая запись: услуга → мастер → дата → время → контакты.
 *
 * Аккаунт не нужен, поэтому весь флоу живёт в одном клиентском компоненте:
 * данные каталога приходят готовыми из Server Component, слоты тянутся из `/api/slots`
 * при смене услуги, мастера или даты, запись уходит в `/api/bookings`.
 *
 * Доступность: у каждого поля есть `label`, ошибки связаны через `aria-invalid` и
 * `aria-describedby`, после неуспешной отправки фокус переходит на первое ошибочное поле,
 * кнопка отправки заблокирована на время запроса.
 *
 * ПДн: телефон не пишется в `console`, не попадает в URL и `localStorage`.
 * Ключ идемпотентности создаётся один раз на выбранный слот и переиспользуется при повторе.
 */

type BookingWizardProps = {
  services: Service[];
  masters: Master[];
  /** Часовой пояс салона: время показываем в нём, а не в поясе браузера. */
  timeZone: string;
  /** Услуга, выбранная на витрине (`/book?serviceId=…`). */
  initialServiceId?: string | undefined;
};

type SlotsStatus = 'idle' | 'loading' | 'ready' | 'unavailable';

/** Сколько ближайших дней предлагаем в форме (горизонт записи API — 30 дней). */
const DATE_OPTION_COUNT = 14;

const SELECT_CLASS =
  'w-full rounded-card border border-border bg-surface-raised px-3 py-2 text-sm disabled:opacity-60';

interface ContactFieldProps {
  id: string;
  label: string;
  type: 'text' | 'tel' | 'email';
  inputMode?: 'text' | 'tel' | 'email';
  autoComplete: string;
  placeholder?: string;
  value: string;
  error: string | undefined;
  inputRef: RefObject<HTMLInputElement | null>;
  onChange: (value: string) => void;
}

/** Поле контактов: label, подсказка об ошибке и связь ошибки с input для скринридера. */
function ContactField({
  id,
  label,
  type,
  inputMode,
  autoComplete,
  placeholder,
  value,
  error,
  inputRef,
  onChange,
}: ContactFieldProps) {
  const errorId = `${id}-error`;
  const invalid = error !== undefined;

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <input
        id={id}
        ref={inputRef}
        type={type}
        {...(inputMode === undefined ? {} : { inputMode })}
        autoComplete={autoComplete}
        {...(placeholder === undefined ? {} : { placeholder })}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={invalid}
        aria-describedby={invalid ? errorId : undefined}
        className={[
          'w-full rounded-card border bg-surface-raised px-3 py-2 text-sm',
          invalid ? 'border-red-600' : 'border-border',
        ].join(' ')}
      />
      {error !== undefined ? (
        <p id={errorId} className="text-sm text-red-600">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function BookingWizard({
  services,
  masters,
  timeZone,
  initialServiceId,
}: BookingWizardProps) {
  const initialService = useMemo(
    () => services.find((service) => service.id === initialServiceId) ?? null,
    [services, initialServiceId],
  );

  const [serviceId, setServiceId] = useState(initialService?.id ?? '');
  const [masterId, setMasterId] = useState('');
  const [date, setDate] = useState('');
  const [dateOptions, setDateOptions] = useState<DateOption[]>([]);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [slotsStatus, setSlotsStatus] = useState<SlotsStatus>('idle');
  const [slotItems, setSlotItems] = useState<Slot[]>([]);
  const [reloadToken, setReloadToken] = useState(0);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [errors, setErrors] = useState<BookingErrorState>(EMPTY_BOOKING_ERRORS);
  const [submitting, setSubmitting] = useState(false);
  const [booking, setBooking] = useState<Booking | null>(null);

  const attemptKeyRef = useRef('');
  const nameRef = useRef<HTMLInputElement>(null);
  const phoneRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);

  // Даты строим только на клиенте: серверные и браузерные `Intl` могут разойтись
  // в названиях месяцев, и разметка при гидратации не совпала бы.
  useEffect(() => {
    const options = buildDateOptions(new Date(), timeZone, DATE_OPTION_COUNT);
    setDateOptions(options);
    setDate((current) => (current === '' ? (options[0]?.date ?? '') : current));
  }, [timeZone]);

  // Слоты перезагружаются при смене услуги, мастера или даты, а также после 409
  // (`reloadToken`): данные формы при этом сохраняются.
  useEffect(() => {
    if (serviceId === '' || date === '') {
      setSlotsStatus('idle');
      setSlotItems([]);
      return;
    }

    const controller = new AbortController();
    let active = true;

    setSlotsStatus('loading');
    setSlotItems([]);

    void fetchSlots(
      { serviceId, date, ...(masterId === '' ? {} : { masterId }) },
      controller.signal,
    ).then((result) => {
      if (!active) return;
      setSlotItems(result.ok ? result.slots : []);
      setSlotsStatus(result.ok ? 'ready' : 'unavailable');
    });

    return () => {
      active = false;
      controller.abort();
    };
  }, [serviceId, masterId, date, reloadToken]);

  const eligibleMasters = useMemo(
    () =>
      serviceId === ''
        ? []
        : masters.filter((master) => master.services.some((item) => item.id === serviceId)),
    [masters, serviceId],
  );

  const masterNames = useMemo(
    () => new Map(masters.map((master) => [master.id, master.fullName])),
    [masters],
  );

  const selectedService = useMemo(
    () => services.find((service) => service.id === serviceId) ?? null,
    [services, serviceId],
  );

  const slotGroups = useMemo(() => groupSlotsByMaster(slotItems), [slotItems]);

  const focusField = useCallback((field: BookingField) => {
    if (field === 'clientName') nameRef.current?.focus();
    else if (field === 'clientPhone') phoneRef.current?.focus();
    else emailRef.current?.focus();
  }, []);

  /** Смена выбора обнуляет попытку: старый слот и его ключ идемпотентности больше не нужны. */
  function resetAttempt() {
    setSlot(null);
    setErrors(EMPTY_BOOKING_ERRORS);
    attemptKeyRef.current = '';
  }

  function handleServiceChange(nextServiceId: string) {
    setServiceId(nextServiceId);
    setMasterId('');
    resetAttempt();
  }

  function handleMasterChange(nextMasterId: string) {
    setMasterId(nextMasterId);
    resetAttempt();
  }

  function handleDateChange(nextDate: string) {
    setDate(nextDate);
    resetAttempt();
  }

  function handleSlotSelect(nextSlot: Slot) {
    setSlot(nextSlot);
    setErrors(EMPTY_BOOKING_ERRORS);
    attemptKeyRef.current = createIdempotencyKey();
  }

  function handleRetrySlots() {
    setReloadToken((token) => token + 1);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (slot === null || serviceId === '' || submitting) return;

    // Повтор после сетевой ошибки идёт с тем же ключом: дубль не создастся.
    if (attemptKeyRef.current === '') attemptKeyRef.current = createIdempotencyKey();

    const trimmedEmail = email.trim();
    const body: CreateBooking = {
      masterId: slot.masterId,
      serviceId,
      startsAt: slot.startsAt,
      clientName: name.trim(),
      clientPhone: phone.trim(),
      ...(trimmedEmail === '' ? {} : { clientEmail: trimmedEmail }),
      idempotencyKey: attemptKeyRef.current,
    };

    setSubmitting(true);
    setErrors(EMPTY_BOOKING_ERRORS);

    const result = await submitBooking(body);

    setSubmitting(false);

    if (result.ok) {
      setBooking(result.booking);
      attemptKeyRef.current = '';
      return;
    }

    const nextErrors = mapBookingError(result.failure);
    setErrors(nextErrors);

    const firstField = firstErrorField(nextErrors.fieldErrors);
    if (firstField !== null) focusField(firstField);

    if (nextErrors.slotUnavailable) {
      // Введённые контакты остаются: пользователь выбирает другое время и отправляет снова.
      setSlot(null);
      setReloadToken((token) => token + 1);
    }
  }

  function renderSlots() {
    if (serviceId === '' || date === '') {
      return <p className="text-sm text-muted">Сначала выберите услугу и дату.</p>;
    }
    if (slotsStatus === 'loading') {
      return (
        <p role="status" className="text-sm text-muted">
          Загружаем свободное время…
        </p>
      );
    }
    if (slotsStatus === 'unavailable') {
      return (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-muted">
            Не удалось загрузить свободное время. Попробуйте ещё раз или позвоните в салон.
          </p>
          <button
            type="button"
            onClick={handleRetrySlots}
            className="w-fit rounded-card border border-border px-3 py-2 text-sm"
          >
            Повторить
          </button>
        </div>
      );
    }
    if (slotItems.length === 0) {
      return (
        <p className="text-sm text-muted">
          На эту дату свободного времени нет. Выберите другую дату или другого мастера.
        </p>
      );
    }

    return (
      <div className="flex flex-col gap-4">
        {slotGroups.map((group) => (
          <div key={group.masterId} className="flex flex-col gap-2">
            {masterId === '' ? (
              <p className="text-xs uppercase tracking-wide text-muted">
                {masterNames.get(group.masterId) ?? 'Мастер'}
              </p>
            ) : null}
            <ul className="flex flex-wrap gap-2">
              {group.slots.map((item) => {
                const selected = slot?.startsAt === item.startsAt;
                return (
                  <li key={`${item.masterId}-${item.startsAt}`}>
                    <button
                      type="button"
                      aria-pressed={selected}
                      onClick={() => handleSlotSelect(item)}
                      className={[
                        'rounded-card border px-3 py-2 text-sm',
                        selected ? 'border-accent bg-accent text-surface' : 'border-border',
                      ].join(' ')}
                    >
                      {formatSlotTime(item.startsAt, timeZone)}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    );
  }

  if (booking !== null) {
    return (
      <section className="flex flex-col gap-4 rounded-card border border-border bg-surface-raised p-6">
        <h2 className="text-xl font-semibold">Запись создана</h2>
        <p className="text-sm">
          {formatSlotDateTime(booking.startsAt, timeZone)}. Мы позвоним, чтобы подтвердить визит.
        </p>
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-muted">Услуга</dt>
            <dd>{selectedService?.name ?? 'Услуга салона'}</dd>
          </div>
          <div>
            <dt className="text-muted">Мастер</dt>
            <dd>{masterNames.get(booking.masterId) ?? 'Мастер салона'}</dd>
          </div>
          <div>
            <dt className="text-muted">Длительность</dt>
            <dd>{formatDuration(booking.durationMin)}</dd>
          </div>
          <div>
            <dt className="text-muted">Стоимость</dt>
            <dd>{formatPrice(booking.price.amountMinor)}</dd>
          </div>
          {booking.clientPhoneMasked ? (
            <div>
              <dt className="text-muted">Телефон для связи</dt>
              <dd>{booking.clientPhoneMasked}</dd>
            </div>
          ) : null}
        </dl>
        <p className="text-sm text-muted">
          Аккаунт не нужен: запись оформлена как гостевая. Кабинет клиента с историей визитов
          появится позже — тогда записью можно будет управлять самостоятельно.
        </p>
        <Link href="/" className="w-fit text-sm underline">
          Вернуться на главную
        </Link>
      </section>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-2">
        <label htmlFor="booking-service" className="text-sm font-medium">
          1. Услуга
        </label>
        <select
          id="booking-service"
          value={serviceId}
          onChange={(event) => handleServiceChange(event.target.value)}
          className={SELECT_CLASS}
        >
          <option value="">Выберите услугу</option>
          {services.map((service) => (
            <option key={service.id} value={service.id}>
              {service.name} — {formatPrice(service.price.amountMinor)},{' '}
              {formatDuration(service.durationMin)}
            </option>
          ))}
        </select>
      </section>

      <section className="flex flex-col gap-2">
        <label htmlFor="booking-master" className="text-sm font-medium">
          2. Мастер
        </label>
        <select
          id="booking-master"
          value={masterId}
          disabled={serviceId === ''}
          onChange={(event) => handleMasterChange(event.target.value)}
          className={SELECT_CLASS}
        >
          <option value="">Любой свободный мастер</option>
          {eligibleMasters.map((master) => (
            <option key={master.id} value={master.id}>
              {master.fullName}
            </option>
          ))}
        </select>
      </section>

      <section className="flex flex-col gap-2">
        <label htmlFor="booking-date" className="text-sm font-medium">
          3. Дата
        </label>
        <select
          id="booking-date"
          value={date}
          disabled={serviceId === ''}
          onChange={(event) => handleDateChange(event.target.value)}
          className={SELECT_CLASS}
        >
          {dateOptions.length === 0 ? <option value="">Загрузка дат…</option> : null}
          {dateOptions.map((option) => (
            <option key={option.date} value={option.date}>
              {option.label}
            </option>
          ))}
        </select>
      </section>

      <section aria-labelledby="booking-slots" className="flex flex-col gap-3">
        <h2 id="booking-slots" className="text-sm font-medium">
          4. Время
        </h2>
        {renderSlots()}
      </section>

      <form noValidate onSubmit={handleSubmit} className="flex flex-col gap-4">
        <fieldset className="flex flex-col gap-3">
          <legend className="text-sm font-medium">5. Контакты</legend>
          <ContactField
            id="booking-name"
            label="Имя"
            type="text"
            autoComplete="name"
            value={name}
            error={errors.fieldErrors.clientName}
            inputRef={nameRef}
            onChange={setName}
          />
          <ContactField
            id="booking-phone"
            label="Телефон"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            placeholder="+7 900 000-00-00 или +1 202 555 0143"
            value={phone}
            error={errors.fieldErrors.clientPhone}
            inputRef={phoneRef}
            onChange={setPhone}
          />
          <ContactField
            id="booking-email"
            label="Электронная почта (необязательно)"
            type="email"
            inputMode="email"
            autoComplete="email"
            value={email}
            error={errors.fieldErrors.clientEmail}
            inputRef={emailRef}
            onChange={setEmail}
          />
        </fieldset>

        {errors.formError !== null ? (
          <p role="alert" className="text-sm text-red-600">
            {errors.formError}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={slot === null || submitting}
          className="w-fit rounded-card bg-accent px-4 py-2 text-sm font-medium text-surface disabled:opacity-60"
        >
          {submitting ? 'Отправляем…' : 'Записаться'}
        </button>

        {slot === null ? (
          <p className="text-xs text-muted">
            Выберите свободное время — после этого заявку можно отправить.
          </p>
        ) : null}
      </form>
    </div>
  );
}
