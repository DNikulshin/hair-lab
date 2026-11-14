import type { Metadata } from 'next';
import { PaymentStatusScreen } from '@/features/payment';
import { siteConfig } from '@/shared/config/site';
import { Container } from '@/shared/ui/container';

/**
 * Статус оплаты записи: `/booking/payment` — сюда же ведёт `return_url` ЮKassa.
 *
 * Страница тонкая: id записи приходит из query (его ставит визард записи) или из черновика
 * `sessionStorage` вкладки (`return_url` провайдера статичен и id не содержит) — разбирается
 * клиентский экран фичи. `force-dynamic`: статус меняется вебхуком, кэшировать нечего.
 *
 * `robots: noindex`: ссылка ведёт на оплату конкретной записи, в поиске ей не место.
 * ПДн: в query передаётся только uuid, на странице нет ни телефона, ни почты, ни имени.
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Оплата записи',
  description: `Статус оплаты записи в салон ${siteConfig.name}.`,
  robots: { index: false, follow: false },
};

type PaymentPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/** Первое значение query-параметра: массивы (`?appointmentId=a&appointmentId=b`) не поддерживаем. */
function firstParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

export default async function PaymentPage({ searchParams }: PaymentPageProps) {
  const params = await searchParams;
  const appointmentId = firstParam(params.appointmentId);

  return (
    <main className="py-12">
      <Container className="max-w-lg">
        <section className="flex flex-col gap-4 rounded-card border border-border bg-surface-raised p-6">
          <h1 className="text-2xl font-semibold">Оплата записи</h1>
          {/*
            `key` по id: при переходе между двумя `/booking/payment?appointmentId=…` App Router
            не перемонтирует страницу, и экран продолжил бы опрос прежней записи. Ремоунт проще
            синхронизирующего эффекта: сбрасывает сразу всё состояние экрана (статус, ошибку,
            черновик, разрешённый id) и заново читает `sessionStorage` — добавить новое поле
            состояния и забыть его сбросить нельзя.
          */}
          <PaymentStatusScreen key={appointmentId ?? 'draft'} appointmentId={appointmentId} />
        </section>
      </Container>
    </main>
  );
}
