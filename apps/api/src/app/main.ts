import { buildServer } from './build-server';
import { env } from '../shared/config/env';

const app = await buildServer();

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'завершаем работу');
  await app.close();
  process.exit(0);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void shutdown(signal);
  });
}

try {
  await app.listen({ host: env.API_HOST, port: env.API_PORT });
} catch (error) {
  app.log.error({ err: error }, 'не удалось запустить сервер');
  process.exit(1);
}
