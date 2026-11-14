import { describe, expect, it } from 'vitest';
import { siteConfig } from '@/shared/config/site';
import { buildManifest } from './build-manifest';

describe('buildManifest', () => {
  it('без базы: start_url и scope от корня', () => {
    const manifest = buildManifest('');

    expect(manifest.start_url).toBe('/');
    expect(manifest.scope).toBe('/');
    expect(manifest.icons?.map((icon) => icon.src)).toEqual([
      '/icons/icon-192.png',
      '/icons/icon-512.png',
      '/icons/icon-maskable-512.png',
    ]);
  });

  it('с базой: все адреса под префиксом', () => {
    const manifest = buildManifest('/absproxy/3000');

    expect(manifest.start_url).toBe('/absproxy/3000/');
    expect(manifest.scope).toBe('/absproxy/3000/');
    expect(manifest.icons?.map((icon) => icon.src)).toEqual([
      '/absproxy/3000/icons/icon-192.png',
      '/absproxy/3000/icons/icon-512.png',
      '/absproxy/3000/icons/icon-maskable-512.png',
    ]);
  });

  it('тексты, режим и цвета — из конфига сайта и дизайн-токенов', () => {
    const manifest = buildManifest('');

    expect(manifest.name).toBe(siteConfig.name);
    expect(manifest.short_name).toBe(siteConfig.shortName);
    expect(manifest.description).toBe(siteConfig.description);
    expect(manifest.display).toBe('standalone');
    expect(manifest.lang).toBe('ru-RU');
    expect(manifest.background_color).toBe('#faf8f5');
    expect(manifest.theme_color).toBe('#faf8f5');
  });

  it('иконки: any для обычных, maskable для адаптивной', () => {
    const manifest = buildManifest('');
    const bySrc = new Map((manifest.icons ?? []).map((icon) => [icon.src, icon]));

    expect(bySrc.get('/icons/icon-192.png')?.purpose).toBe('any');
    expect(bySrc.get('/icons/icon-512.png')?.purpose).toBe('any');
    expect(bySrc.get('/icons/icon-maskable-512.png')?.purpose).toBe('maskable');
    expect(bySrc.get('/icons/icon-maskable-512.png')?.sizes).toBe('512x512');
  });
});
