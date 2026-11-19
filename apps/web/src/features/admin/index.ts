/**
 * Публичный API фичи админки.
 *
 * Страницы `app/admin` и `app/admin/refunds` рендерят `AdminScreen` и `RefundsScreen`;
 * запросы (`api/`) и чистые помощники (`model/`) остаются внутренними — снаружи нужны
 * только экраны.
 */
export { AdminScreen, type AdminScreenProps } from './ui/admin-screen';
export { RefundsScreen, type RefundsScreenProps } from './ui/refunds-screen';
