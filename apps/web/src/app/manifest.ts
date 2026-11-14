import type { MetadataRoute } from 'next';
import { buildManifest } from '@/features/pwa';
import { normalizeBasePath } from '@/shared/config/base-path';

/**
 * Web App Manifest. Next отдаёт его по `/manifest.webmanifest` и сам вставляет
 * `<link rel="manifest">` в `<head>`, поэтому страницы про манифест ничего не знают.
 *
 * База читается из `NEXT_BASE_PATH` (dev-прокси code-server); в проде её нет и все
 * адреса манифеста начинаются с корня.
 */
export default function manifest(): MetadataRoute.Manifest {
  return buildManifest(normalizeBasePath(process.env.NEXT_BASE_PATH));
}
