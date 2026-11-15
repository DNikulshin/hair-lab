import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { SwRegister } from '@/features/pwa';
import { withBasePath } from '@/shared/config/api';
import { siteConfig } from '@/shared/config/site';
import { Container } from '@/shared/ui/container';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL(siteConfig.url),
  title: {
    default: siteConfig.name,
    template: `%s — ${siteConfig.name}`,
  },
  description: siteConfig.description,
  openGraph: {
    type: 'website',
    locale: siteConfig.locale,
    siteName: siteConfig.name,
    title: siteConfig.name,
    description: siteConfig.description,
  },
  // PWA: установка на домашний экран iOS. Ссылку на manifest Next добавляет сам
  // (файл `app/manifest.ts`), `themeColor` живёт здесь ниже в `viewport`.
  appleWebApp: {
    capable: true,
    title: siteConfig.shortName,
  },
  // Next не префиксует иконки метаданных базой — добавляем сами (dev за прокси).
  icons: {
    icon: [
      { url: withBasePath('/icons/icon-192.png'), sizes: '192x192', type: 'image/png' },
      { url: withBasePath('/icons/icon-512.png'), sizes: '512x512', type: 'image/png' },
    ],
    apple: [
      { url: withBasePath('/icons/apple-touch-icon.png'), sizes: '180x180', type: 'image/png' },
    ],
  },
};

export const viewport: Viewport = {
  // Значения совпадают с `--surface` системы «Разметка» (docs/design/README.md).
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#efede6' },
    { media: '(prefers-color-scheme: dark)', color: '#131518' },
  ],
};

const navigation = [
  { href: '/', label: 'Главная' },
  { href: '/services', label: 'Услуги' },
  { href: '/masters', label: 'Мастера' },
  { href: '/account', label: 'Кабинет' },
] as const;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru">
      <body>
        <SwRegister />
        <header className="border-b border-ink">
          <Container className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 py-4">
            <Link
              href="/"
              className="inline-block py-1 font-display text-[15px] font-medium leading-5 tracking-tight text-ink transition-colors hover:text-accent"
            >
              {siteConfig.name}
            </Link>
            <nav aria-label="Основная навигация">
              <ul className="flex flex-wrap items-center gap-x-6 text-sm">
                {navigation.map((item) => (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className="inline-block py-1.5 text-muted transition-colors hover:text-ink"
                    >
                      {item.label}
                    </Link>
                  </li>
                ))}
                <li>
                  <Link
                    href="/book"
                    className="inline-block rounded-card border border-ink px-3 py-1.5 text-ink transition-colors hover:border-accent hover:bg-accent hover:text-on-accent"
                  >
                    Записаться
                  </Link>
                </li>
              </ul>
            </nav>
          </Container>
        </header>
        {children}
        <footer className="mt-16 border-t border-border">
          <Container className="flex flex-wrap items-baseline justify-between gap-3 py-6 text-xs text-muted">
            <span>
              {siteConfig.name} · {siteConfig.city}
            </span>
            {siteConfig.phone ? (
              <a href={`tel:${siteConfig.phone.replace(/[^+\d]/g, '')}`} className="hover:text-ink">
                {siteConfig.phone}
              </a>
            ) : null}
          </Container>
        </footer>
      </body>
    </html>
  );
}
