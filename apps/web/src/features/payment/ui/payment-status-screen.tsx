'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { fetchPaymentStatus } from '../api/payment-api';
import { clearPaymentDraft, readPaymentDraft, type PaymentDraft } from '../model/payment-draft';
import { resolvePaymentState, type PaymentView } from '../model/payment-state';

/**
 * Экран статуса оплаты записи.
 *
 * Откуда берётся запись: `?appointmentId=` из ссылки (её показывает экран успеха записи),
 * иначе — черновик `sessionStorage` той же вкладки. Второй путь нужен после возврата с
 * платёжной страницы: `return_url` ЮKassa статичен и id не содержит. В новой вкладке id
 * взять негде — честно показываем «оплата не найдена», а не пустую страницу.
 *
 * Опрос: пока платёж `pending`, статус перезапрашивается раз в 5 секунд (вебхук приходит
 * асинхронно), терминальные состояния опрос прекращают и удаляют черновик. Запрос
 * отменяется при уходе со страницы — фоновых запросов после unmount нет.
 *
 * Таймер холда тикает раз в секунду и намеренно не лежит в live-region (`role="status"`),
 * иначе скринридер объявлял бы «осталось…» каждую секунду. Заголовок состояния меняется
 * редко и объявляется через `role="status"`.
 *
 * ПДн: на странице нет ни телефона, ни почты, ни имени — только статусы и ссылка провайдера.
 */

/** Период опроса статуса: чаще незачем, вебхук всё равно приходит с задержкой в секунды. */
const POLL_INTERVAL_MS = 5000;

/** Период обновления таймера холда. */
const TIMER_TICK_MS = 1000;

export interface PaymentStatusScreenProps {
  /** `appointmentId` из query; `null` — берём черновик вкладки. */
  appointmentId: string | null;
}

const SECONDARY_LINK_CLASS = 'w-fit text-sm underline';
const BUTTON_CLASS = 'w-fit rounded-card border border-border px-3 py-2 text-sm';
const PRIMARY_LINK_CLASS =
  'w-fit rounded-card bg-accent px-4 py-2 text-sm font-medium text-surface';

export function PaymentStatusScreen({ appointmentId }: PaymentStatusScreenProps) {
  const [view, setView] = useState<PaymentView>({ kind: 'loading' });
  const [draft, setDraft] = useState<PaymentDraft | null>(null);
  // id разрешается один раз на монтирование: смену `appointmentId` обрабатывает `key` на
  // странице (ремоунт), поэтому синхронизирующий эффект здесь не нужен.
  const [resolvedId, setResolvedId] = useState<string | null>(appointmentId);
  // Пока черновик не прочитан, запрос не начинаем: иначе первый запрос ушёл бы без
  // срока холда, и таймер появился бы только на втором опросе.
  const [draftRead, setDraftRead] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [reloadToken, setReloadToken] = useState(0);

  // `sessionStorage` есть только в браузере, поэтому читаем после монтирования: серверный
  // рендер и гидратация показывают одинаковое «Загружаем статус оплаты…».
  useEffect(() => {
    const stored = readPaymentDraft();
    setDraft(stored);
    // id из query главнее: страницу могли открыть в новой вкладке, где черновика нет.
    setResolvedId((current) => current ?? stored?.appointmentId ?? null);
    setDraftRead(true);
  }, []);

  // Черновик другой записи (во вкладке их может быть несколько) к этому экрану не относится.
  const matchingDraft = useMemo(
    () => (draft !== null && draft.appointmentId === resolvedId ? draft : null),
    [draft, resolvedId],
  );

  useEffect(() => {
    if (!draftRead) return;

    if (resolvedId === null) {
      setView({ kind: 'notFound' });
      return;
    }

    const id = resolvedId;
    const controller = new AbortController();
    let active = true;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;

    async function load(): Promise<void> {
      const result = await fetchPaymentStatus(id, controller.signal);
      if (!active) return;

      if (!result.ok) {
        setView({ kind: result.kind });
        return;
      }

      const nextView: PaymentView = {
        kind: 'ready',
        status: result.data.status,
        appointmentStatus: result.data.appointmentStatus,
      };
      setView(nextView);

      // Опрос планируем сами (а не `setInterval`): запрос никогда не накладывается на предыдущий.
      if (
        resolvePaymentState({ view: nextView, draft: matchingDraft, now: Date.now() }).shouldPoll
      ) {
        pollTimer = setTimeout(() => void load(), POLL_INTERVAL_MS);
      }
    }

    void load();

    return () => {
      active = false;
      controller.abort();
      if (pollTimer !== null) clearTimeout(pollTimer);
    };
  }, [draftRead, resolvedId, matchingDraft, reloadToken]);

  const state = useMemo(
    () => resolvePaymentState({ view, draft: matchingDraft, now }),
    [view, matchingDraft, now],
  );

  // Тикаем только пока холд жив: остальные состояния от времени не зависят.
  const timerActive = (state.remainingMs ?? 0) > 0;
  useEffect(() => {
    if (!timerActive) return;
    const interval = setInterval(() => setNow(Date.now()), TIMER_TICK_MS);
    return () => clearInterval(interval);
  }, [timerActive]);

  // Ссылка на оплату в терминальном состоянии бесполезна — черновик этой записи больше не нужен.
  // Чужой черновик (другая запись в той же вкладке) не трогаем.
  const terminal = state.terminal && matchingDraft !== null;
  useEffect(() => {
    if (terminal) clearPaymentDraft();
  }, [terminal]);

  function handleRetry() {
    setView({ kind: 'loading' });
    setNow(Date.now());
    setReloadToken((token) => token + 1);
  }

  return (
    <div className="flex flex-col gap-4">
      <p role="status" className="text-lg font-medium">
        {state.title}
      </p>
      {state.description === null ? null : (
        <p className="text-sm text-muted">{state.description}</p>
      )}

      {state.remainingLabel === null ? null : (
        <p className="text-sm">
          Ссылка действует ещё{' '}
          <span className="font-medium tabular-nums">{state.remainingLabel}</span>
        </p>
      )}

      {state.paymentUrl === null ? null : (
        <a href={state.paymentUrl} rel="noopener noreferrer" className={PRIMARY_LINK_CLASS}>
          Перейти к оплате
        </a>
      )}

      {state.retryable ? (
        <button type="button" onClick={handleRetry} className={BUTTON_CLASS}>
          Проверить ещё раз
        </button>
      ) : null}

      <nav aria-label="Дальнейшие шаги" className="flex flex-wrap gap-4">
        <Link href="/account" className={SECONDARY_LINK_CLASS}>
          Мои записи
        </Link>
        <Link href="/book" className={SECONDARY_LINK_CLASS}>
          Записаться на услугу
        </Link>
      </nav>
    </div>
  );
}
