import { apiErrorSchema } from '@hair-lab/contracts';

/**
 * Разбор ошибки создания записи в состояние формы.
 *
 * Тексты ошибок для пользователя формируются здесь, а не берутся из ответа API:
 * сообщения API технические (в том числе из Zod) и не должны попадать в интерфейс.
 * Заодно это гарантия ПДн: в подсказках нет значения телефона — только формат.
 *
 * Три сценария, которые форма различает:
 * - ошибки полей (400 `validation_error` с `details`) — рядом с полями, фокус на первой;
 * - занятое время (409 `slot_unavailable`) — перезагрузить слоты, данные формы сохранить;
 * - сервис недоступен (сеть, 502/503) — сообщение «попробуйте позже или позвоните».
 */

/** Поля, которые пользователь заполняет сам (совпадают с полями контракта). */
export type BookingField = 'clientName' | 'clientPhone' | 'clientEmail';

/** Порядок полей на форме: по нему выбирается первое ошибочное для фокуса. */
export const BOOKING_FIELDS = [
  'clientName',
  'clientPhone',
  'clientEmail',
] as const satisfies readonly BookingField[];

export type BookingFieldErrors = Partial<Record<BookingField, string>>;

export interface BookingErrorState {
  fieldErrors: BookingFieldErrors;
  /** Общая ошибка формы над кнопкой отправки. */
  formError: string | null;
  /** Время заняли: форму не сбрасываем, но слоты нужно перезагрузить. */
  slotUnavailable: boolean;
  /** Сервис записи недоступен: повтор с теми же данными имеет смысл позже. */
  apiUnavailable: boolean;
}

/** Причина неуспеха: HTTP-ответ API (тело уже разобрано) или отсутствие связи. */
export type BookingFailure = { kind: 'network' } | { kind: 'http'; status: number; body: unknown };

/** Начальное состояние: ошибок нет. */
export const EMPTY_BOOKING_ERRORS: BookingErrorState = {
  fieldErrors: {},
  formError: null,
  slotUnavailable: false,
  apiUnavailable: false,
};

const UNAVAILABLE_MESSAGE =
  'Запись временно недоступна: сервис не отвечает. Попробуйте позже или позвоните в салон.';

const INVALID_FORM_MESSAGE = 'Проверьте данные формы и попробуйте снова.';

/** Подсказки по полям: только правила формата, без введённых значений. */
const FIELD_MESSAGES: Record<BookingField, string> = {
  clientName: 'Укажите имя — так мастер будет знать, как к вам обращаться.',
  clientPhone: 'Телефон в формате +7 XXX XXX-XX-XX или международный с +.',
  clientEmail: 'Проверьте адрес почты или оставьте поле пустым.',
};

function isBookingField(path: string): path is BookingField {
  return (BOOKING_FIELDS as readonly string[]).includes(path);
}

function state(overrides: Partial<BookingErrorState>): BookingErrorState {
  return { ...EMPTY_BOOKING_ERRORS, ...overrides };
}

/** Ошибка записи → состояние формы. Функция чистая: сеть и React не нужны. */
export function mapBookingError(failure: BookingFailure): BookingErrorState {
  if (failure.kind === 'network') {
    return state({ formError: UNAVAILABLE_MESSAGE, apiUnavailable: true });
  }

  const { status } = failure;
  const parsed = apiErrorSchema.safeParse(failure.body);
  const code = parsed.success ? parsed.data.error.code : null;

  if (status === 400) {
    const details = parsed.success ? (parsed.data.error.details ?? []) : [];
    const fieldErrors: BookingFieldErrors = {};
    let hasUnknownPath = false;

    for (const detail of details) {
      if (isBookingField(detail.path)) fieldErrors[detail.path] = FIELD_MESSAGES[detail.path];
      else hasUnknownPath = true;
    }

    // Ошибки по конкретным полям важнее общей: их видно рядом с input.
    if (Object.keys(fieldErrors).length > 0) {
      return state({
        fieldErrors,
        formError: hasUnknownPath ? INVALID_FORM_MESSAGE : null,
      });
    }
    return state({ formError: INVALID_FORM_MESSAGE });
  }

  if (status === 409) {
    if (code === 'slot_unavailable') {
      return state({
        formError: 'Это время только что заняли. Мы обновили свободные слоты — выберите другое.',
        slotUnavailable: true,
      });
    }
    return state({ formError: 'Запись не подтвердилась: начните оформление заново, пожалуйста.' });
  }

  if (status === 404) {
    return state({
      formError: 'Услуга или мастер больше недоступны. Обновите страницу и выберите заново.',
    });
  }

  if (status === 429) {
    return state({ formError: 'Слишком много попыток. Подождите минуту и попробуйте снова.' });
  }

  if (status === 502 || status === 503) {
    return state({ formError: UNAVAILABLE_MESSAGE, apiUnavailable: true });
  }

  return state({ formError: 'Не удалось создать запись. Попробуйте позже или позвоните в салон.' });
}

/** Первое ошибочное поле в порядке формы — на него ставим фокус. */
export function firstErrorField(errors: BookingFieldErrors): BookingField | null {
  for (const field of BOOKING_FIELDS) {
    if (errors[field] !== undefined) return field;
  }
  return null;
}
