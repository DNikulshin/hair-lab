/**
 * Публичный API фичи оплаты записи (страница `/booking/payment`).
 *
 * Фича отдельная от `features/booking`: у оплаты свой жизненный цикл (холд слота, вебхук
 * провайдера, возврат) и своя страница, а визарду записи и кабинету нужен минимум — перевести
 * на оплату, сохранить черновик вкладки, прочитать его (кабинет показывает ссылку на оплату
 * только там, где черновик реально есть) и собрать путь страницы. Запросы (`api/`), таймер
 * и разметка состояний (`model/payment-state`, `ui/`) остаются внутренними.
 */
export {
  paymentHandoff,
  paymentPagePath,
  readPaymentDraft,
  savePaymentDraft,
  type PaymentDraft,
  type PaymentHandoff,
} from './model/payment-draft';
export { PaymentStatusScreen, type PaymentStatusScreenProps } from './ui/payment-status-screen';
