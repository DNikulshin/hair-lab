/** Публичный API фичи онлайн-записи: наружу отдаём маршруты и шаблон письма. */
export { accountBookingsRoutes } from './account-bookings.routes';
export {
  CANCEL_MIN_LEAD_MS,
  CANCEL_REASON,
  cancelAccountBooking,
  listAccountBookings,
} from './account-bookings.service';
export { bookingRoutes, type BookingRoutesOptions } from './bookings.routes';
export {
  createBooking,
  PaymentCreationFailedError,
  type CreateBookingOptions,
  type CreateBookingPaymentsOptions,
  type CreateBookingResult,
} from './bookings.service';
export {
  BOOKING_CANCELLATION_TYPE,
  createBookingCancellationTemplate,
  type BookingCancellationContext,
} from './booking-cancellation.email';
export {
  BOOKING_CONFIRMATION_TYPE,
  buildBookingConfirmationPayload,
  createBookingConfirmationTemplate,
  type BookingConfirmationContext,
  type BookingConfirmationPayload,
  type BookingConfirmationSnapshot,
} from './booking-confirmation.email';
