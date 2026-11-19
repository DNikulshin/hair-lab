import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import {
  checkCompose,
  checkDockerfiles,
  COMPOSE_FILES,
  composeFiles,
  dockerfiles,
} from './lint-docker.mjs';

/** Временный «репозиторий» с заданным набором файлов. */
function createRoot(files) {
  const root = mkdtempSync(join(tmpdir(), 'hair-lab-lint-docker-'));
  for (const file of files) {
    const target = join(root, file);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, 'FROM scratch\n', 'utf8');
  }
  return root;
}

describe('lint:docker — поиск файлов', () => {
  test('находит Dockerfile и варианты Dockerfile.* в apps/<app>, но не в корне и не в node_modules', () => {
    const root = createRoot([
      'apps/api/Dockerfile',
      'apps/web/Dockerfile',
      'apps/web/Dockerfile.dev',
      'apps/api/node_modules/foo/Dockerfile',
      'Dockerfile',
    ]);
    try {
      assert.deepEqual(dockerfiles(root), [
        'apps/api/Dockerfile',
        'apps/web/Dockerfile',
        'apps/web/Dockerfile.dev',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('без каталога apps возвращает пустой список', () => {
    const root = createRoot(['package.json']);
    try {
      assert.deepEqual(dockerfiles(root), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('compose-файлы — только существующие из известного списка', () => {
    const root = createRoot(['docker-compose.yml']);
    try {
      assert.deepEqual(composeFiles(root), ['docker-compose.yml']);
      assert.equal(COMPOSE_FILES.includes('docker-compose.prod.yml'), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('lint:docker — Dockerfile', () => {
  test('нет файлов — успех без запуска линтера', () => {
    let called = false;
    const code = checkDockerfiles([], {
      ci: true,
      locate: () => {
        called = true;
        return null;
      },
    });

    assert.equal(code, 0);
    assert.equal(called, false);
  });

  test('находки линтера дают его код возврата', () => {
    const code = checkDockerfiles(['apps/api/Dockerfile'], {
      ci: true,
      locate: () => ({ command: 'hadolint', source: 'тест' }),
      run: () => {
        const error = new Error('находки');
        error.status = 1;
        throw error;
      },
    });

    assert.equal(code, 1);
  });

  test('линтер есть — команда получает файлы как аргументы', () => {
    /** @type {{ command: string, args: string[] }|null} */
    let invocation = null;
    const code = checkDockerfiles(['apps/api/Dockerfile'], {
      ci: true,
      locate: () => ({ command: 'hadolint', source: 'тест' }),
      run: (command, args) => {
        invocation = { command, args };
      },
    });

    assert.equal(code, 0);
    assert.deepEqual(invocation, { command: 'hadolint', args: ['apps/api/Dockerfile'] });
  });

  test('нет линтера: локально — предупреждение и успех, в CI — отказ', () => {
    const locate = () => null;
    const run = () => {
      throw new Error('не должно вызываться');
    };

    assert.equal(checkDockerfiles(['apps/api/Dockerfile'], { ci: false, locate, run }), 0);
    assert.equal(checkDockerfiles(['apps/api/Dockerfile'], { ci: true, locate, run }), 1);
  });
});

describe('lint:docker — compose', () => {
  test('нет docker: локально — пропуск, в CI — отказ', () => {
    const run = () => {
      throw new Error('не должно вызываться');
    };

    assert.equal(
      checkCompose('/repo', ['docker-compose.yml'], { ci: false, hasDocker: () => false, run }),
      0,
    );
    assert.equal(
      checkCompose('/repo', ['docker-compose.yml'], { ci: true, hasDocker: () => false, run }),
      1,
    );
  });

  test('каждый файл проверяется без интерполяции и относительно корня', () => {
    /** @type {Array<{ command: string, args: string[], cwd: string }>} */
    const calls = [];
    const code = checkCompose('/repo', ['docker-compose.yml', 'docker-compose.prod.yml'], {
      ci: true,
      hasDocker: () => true,
      run: (command, args, options) => {
        calls.push({ command, args, cwd: options.cwd });
      },
    });

    assert.equal(code, 0);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0]?.args, [
      'compose',
      '-f',
      'docker-compose.yml',
      'config',
      '--quiet',
      '--no-interpolate',
    ]);
    assert.deepEqual(calls[1]?.args, [
      'compose',
      '-f',
      'docker-compose.prod.yml',
      'config',
      '--quiet',
      '--no-interpolate',
    ]);
    assert.equal(calls[0]?.cwd, '/repo');
  });

  test('ошибка в одном файле не скрывается успехом другого', () => {
    let index = 0;
    const code = checkCompose('/repo', ['docker-compose.yml', 'docker-compose.prod.yml'], {
      ci: true,
      hasDocker: () => true,
      run: () => {
        index += 1;
        if (index === 2) {
          const error = new Error('схема');
          error.status = 3;
          throw error;
        }
      },
    });

    assert.equal(code, 3);
  });

  test('нет файлов — успех без docker', () => {
    const code = checkCompose('/repo', [], {
      ci: true,
      hasDocker: () => {
        throw new Error('не должно вызываться');
      },
    });

    assert.equal(code, 0);
  });
});
