import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { classify } from './changed-components.mjs';

describe('classify: каталог deploy/ не считается кодом (#127)', () => {
  test('правка только deploy/** не собирает ни один образ', () => {
    assert.deepEqual(
      classify([
        'deploy/nginx/hair-lab.conf.example',
        'deploy/staging/install.md',
        'deploy/docker-compose.prod.yml',
      ]),
      { api: false, web: false },
    );
  });

  test('deploy/** вместе с apps/api/** собирает только api', () => {
    assert.deepEqual(classify(['deploy/nginx/hair-lab.conf.example', 'apps/api/src/app/main.ts']), {
      api: true,
      web: false,
    });
  });

  test('apps/web/** по-прежнему собирает web', () => {
    assert.deepEqual(classify(['apps/web/src/app/page.tsx']), { api: false, web: true });
  });
});
