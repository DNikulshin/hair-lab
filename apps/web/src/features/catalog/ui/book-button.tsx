type BookButtonProps = {
  /** Уникальный суффикс для id подсказки (обычно id услуги): на странице таких кнопок много. */
  idSuffix: string;
};

/**
 * Заглушка онлайн-записи: кнопка выключена, причина объяснена и связана через
 * `aria-describedby` — так подпись читается скринридером вместе с кнопкой.
 * Сама запись появится в отдельной задаче.
 */
export function BookButton({ idSuffix }: BookButtonProps) {
  const hintId = `booking-coming-soon-${idSuffix}`;

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        disabled
        aria-describedby={hintId}
        className="w-fit cursor-not-allowed rounded-card border border-border px-4 py-2 text-sm font-medium text-muted"
      >
        Онлайн-запись — скоро
      </button>
      <p id={hintId} className="text-xs text-muted">
        Онлайн-запись пока недоступна. Позвоните в салон, чтобы записаться.
      </p>
    </div>
  );
}
