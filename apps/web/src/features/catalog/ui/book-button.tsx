import { ButtonLink } from '@/shared/ui/button';

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
    <ButtonLink
      href={`/book?serviceId=${encodeURIComponent(serviceId)}`}
      variant="ghost"
      size="sm"
      ariaLabel={`Записаться онлайн: ${serviceName}`}
    >
      Записаться онлайн
    </ButtonLink>
  );
}
