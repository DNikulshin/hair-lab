'use client';

import { useEffect } from 'react';

/**
 * Регистрация service worker. Монтируется в корневом layout, ничего не рендерит.
 *
 * Только production: в dev SW кэшировал бы HMR-ассеты и ломал разработку.
 * Ошибки регистрации не роняют интерфейс — сайт продолжает работать без PWA
 * (приватные страницы, кабинет и запись от SW не зависят).
 *
 * Обновлений в UI нет: `/sw.js` отдаётся с `no-store`, браузер сам проверяет новую
 * версию на навигациях, а `skipWaiting` мы не вызываем — старые вкладки доживают
 * на своей версии и не получают несовместимый код.
 */
export function SwRegister(): null {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return;
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

    navigator.serviceWorker.register('/sw.js').catch((error: unknown) => {
      console.warn('[pwa] не удалось зарегистрировать service worker', error);
    });
  }, []);

  return null;
}
