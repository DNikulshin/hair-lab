/**
 * Публичный API фичи админки.
 *
 * Страница `app/admin` рендерит `AdminScreen`; запросы (`api/`) и чистые помощники
 * (`model/`) остаются внутренними — снаружи нужен только экран.
 */
export { AdminScreen, type AdminScreenProps } from './ui/admin-screen';
