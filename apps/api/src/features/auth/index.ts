/** Публичный API фичи аккаунта клиента. */
export {
  authRoutes,
  LOGIN_RATE_LIMIT,
  MAGIC_LINK_RATE_LIMIT,
  REGISTER_RATE_LIMIT,
} from './auth.routes';
export { createMagicLinkTemplate, MAGIC_LINK_TYPE } from './magic-link.email';
export { createTokenDeliveryRegistry } from './token-delivery';
