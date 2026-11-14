/**
 * Публичный API фичи PWA.
 *
 * `app/` работает только с этим файлом: регистратор для layout, сборка манифеста
 * (`app/manifest.ts`) и исходник service worker (`app/sw.js/route.ts`). Политика
 * кэширования и константы остаются внутри `lib/` — их потребитель только генеруемый SW.
 */
export { buildManifest } from './lib/build-manifest';
export { buildSwSource } from './lib/build-sw-source';
export { SwRegister } from './ui/sw-register';
