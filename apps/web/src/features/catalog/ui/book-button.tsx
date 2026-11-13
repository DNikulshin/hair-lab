import Link from 'next/link';

type BookButtonProps = {
  serviceId: string;
  /** Название услуги для доступного имени ссылки: на странице много похожих кнопок. */
  serviceName: string;
};

/**
 * Переход к гостевой записи: услуга уже выбрана, дальше — мастер, дата, время и контакты.
 * Гостевой флоу не требует аккаунта, поэтому это ссылка, а не кнопка с действием.
 */
export function BookButton({ serviceId, serviceName }: BookButtonProps) {
  return (
    <Link
      href={{ pathname: '/book', query: { serviceId } }}
      aria-label={`Записаться онлайн: ${serviceName}`}
      className="w-fit rounded-card bg-accent px-4 py-2 text-sm font-medium text-surface transition-opacity hover:opacity-90"
    >
      Записаться онлайн
    </Link>
  );
}
