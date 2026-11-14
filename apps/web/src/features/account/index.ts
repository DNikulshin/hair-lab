/**
 * Публичный API фичи кабинета клиента.
 *
 * Страница `app/account` рендерит `AccountBookings`; запросы (`api/`) и чистые
 * помощники (`model/`) остаются внутренними — снаружи нужен только экран.
 */
export { AccountBookings, type AccountBookingsProps } from './ui/account-bookings';
