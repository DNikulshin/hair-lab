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
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#faf8f5' },
    { media: '(prefers-color-scheme: dark)', color: '#12100e' },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru">
      <body>
        <SwRegister />
        <header className="border-b border-border">
          <Container className="flex flex-wrap items-center justify-between gap-3 py-4">
            <Link href="/" className="font-semibold tracking-tight">
              {siteConfig.name}
            </Link>
            <nav aria-label="Основная навигация">
              <ul className="flex flex-wrap gap-4 text-sm">
                <li>
                  <Link href="/">Главная</Link>
                </li>
                <li>
                  <Link href="/services">Услуги</Link>
                </li>
                <li>
                  <Link href="/masters">Мастера</Link>
                </li>
                <li>
                  <Link href="/account">Кабинет</Link>
                </li>
                <li>
                  <Link href="/login">Войти</Link>
                </li>
              </ul>
            </nav>
          </Container>
        </header>
        {children}
      </body>
    </html>
  );
}
