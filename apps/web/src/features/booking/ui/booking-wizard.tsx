'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
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
import { Button } from '@/shared/ui/button';
import { Card } from '@/shared/ui/card';
import { Field, TextInput } from '@/shared/ui/field';
import { paymentHandoff, savePaymentDraft } from '@/features/payment';
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
  isSameSlot,
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
 *
 * Оплата: если сервер вернул `booking.payment` (оплата включена), клиент уходит на
 * `/booking/payment?appointmentId=…`, а данные ссылки кладём в черновик `sessionStorage` этой
 * вкладки: без него на странице оплаты не будет кнопки провайдера (ссылку по одному id не
 * восстановить). Сам статус открывается и без черновика — `return_url` ЮKassa теперь тоже несёт
 * id записи. Поля `payment` нет (режим `off`) — показываем прежний экран «Запись создана»
 * без редиректа.
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
  'w-full rounded-none border-0 border-b border-ink bg-transparent py-2 text-base text-ink disabled:opacity-60';

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
  return (
    <Field label={label} {...(error === undefined ? {} : { error })}>
      {(control) => (
        <TextInput
          {...control}
          id={id}
          ref={inputRef}
          type={type}
          {...(inputMode === undefined ? {} : { inputMode })}
          autoComplete={autoComplete}
          {...(placeholder === undefined ? {} : { placeholder })}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </Field>
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
  const [redirecting, setRedirecting] = useState(false);
  const [paymentFallbackUrl, setPaymentFallbackUrl] = useState<string | null>(null);

  const router = useRouter();

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
      attemptKeyRef.current = '';

      const handoff = paymentHandoff(result.booking);
      if (handoff !== null) {
        // Черновик нужен, чтобы после возврата с платёжной страницы страница оплаты
        // опознала запись. Не сохранился (приватный режим) — даём прямую ссылку провайдера.
        if (savePaymentDraft(handoff.draft)) {
          setRedirecting(true);
          router.replace(handoff.path);
          return;
        }
        setPaymentFallbackUrl(handoff.draft.confirmationUrl);
      }

      setBooking(result.booking);
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
          <Button type="button" variant="ghost" size="sm" onClick={handleRetrySlots}>
            Повторить
          </Button>
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
              <p className="text-xs text-muted">{masterNames.get(group.masterId) ?? 'Мастер'}</p>
            ) : null}
            <ul className="flex flex-wrap gap-2">
              {group.slots.map((item) => {
                // Мастер в сравнении обязателен: при «Любом свободном мастере» одно и то же
                // время есть в нескольких группах, и подсветка только по времени давала
                // два «выбранных» слота (#258).
                const selected = slot !== null && isSameSlot(slot, item);
                return (
                  <li key={`${item.masterId}-${item.startsAt}`}>
                    <button
                      type="button"
                      aria-pressed={selected}
                      onClick={() => handleSlotSelect(item)}
                      className={[
                        'rounded-card border px-3 py-2 text-sm transition-colors',
                        selected
                          ? 'border-accent bg-accent text-on-accent'
                          : 'border-border hover:border-ink',
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

  if (redirecting) {
    return (
      <Card className="gap-4 p-6">
        <h2 className="text-xl font-light">Переходим к оплате…</h2>
        <p role="status" className="text-sm text-muted">
          Открываем страницу оплаты. Черновик записи останется в этой вкладке — по нему страница
          поймёт, какую запись оплачивать.
        </p>
      </Card>
    );
  }

  if (booking !== null) {
    return (
      <Card className="gap-4 p-6">
        <h2 className="text-xl font-light">Запись создана</h2>
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
        {paymentFallbackUrl === null ? null : (
          <p className="text-sm">
            Чтобы запись подтвердили, её нужно оплатить.{' '}
            <a
              href={paymentFallbackUrl}
              rel="noopener noreferrer"
              className="underline hover:text-accent"
            >
              Перейти к оплате
            </a>
          </p>
        )}
        <p className="text-sm text-muted">
          Аккаунт для записи не обязателен. Посмотреть и отменить визит можно в{' '}
          <Link href="/account" className="underline hover:text-accent">
            кабинете
          </Link>
          : вход — по ссылке, которую присылаем на почту; если вы уже вошли, запись там сразу.
          Отмена — не позже чем за два часа до начала.
        </p>
        <Link href="/" className="w-fit text-sm underline hover:text-accent">
          Вернуться на главную
        </Link>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-2">
        <label htmlFor="booking-service" className="text-xs text-muted">
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
        <label htmlFor="booking-master" className="text-xs text-muted">
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
        <label htmlFor="booking-date" className="text-xs text-muted">
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
        <h2 id="booking-slots" className="text-xs font-normal text-muted">
          4. Время
        </h2>
        {renderSlots()}
      </section>

      <form noValidate onSubmit={handleSubmit} className="flex flex-col gap-4">
        {/*
          legend не участвует во flex-раскладке: с `flex` на fieldset подпись прилипала к первому
          полю. Поэтому группировка — fieldset + внутренний flex-контейнер, а зазор задаёт `mb-3`.
        */}
        <fieldset className="border-0 p-0">
          <legend className="mb-3 text-xs text-muted">5. Контакты</legend>
          <div className="flex flex-col gap-4">
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
          </div>
        </fieldset>

        {errors.formError !== null ? (
          <p role="alert" className="text-sm text-danger">
            {errors.formError}
          </p>
        ) : null}

        <Button type="submit" disabled={slot === null || submitting}>
          {submitting ? 'Отправляем…' : 'Записаться'}
        </Button>

        {slot === null ? (
          <p className="text-xs text-muted">
            Выберите свободное время — после этого заявку можно отправить.
          </p>
        ) : (
          // Выбор называем словами: при «Любом свободном мастере» подсвеченный слот сам
          // по себе не говорит, к какому мастеру уйдёт запись.
          <p role="status" className="text-xs text-muted">
            Выбрано: {formatSlotDateTime(slot.startsAt, timeZone)} —{' '}
            {masterNames.get(slot.masterId) ?? 'мастер салона'}.
          </p>
        )}
      </form>
    </div>
  );
}
