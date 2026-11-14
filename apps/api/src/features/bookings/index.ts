/** Публичный API фичи онлайн-записи: наружу отдаём маршруты и шаблон письма. */
export { accountBookingsRoutes } from './account-bookings.routes';
export {
  CANCEL_MIN_LEAD_MS,
  CANCEL_REASON,
  cancelAccountBooking,
  listAccountBookings,
} from './account-bookings.service';
export { bookingRoutes } from './bookings.routes';
export {
  BOOKING_CANCELLATION_TYPE,
  createBookingCancellationTemplate,
  type BookingCancellationContext,
} from './booking-cancellation.email';
export {
  BOOKING_CONFIRMATION_TYPE,
  createBookingConfirmationTemplate,
  type BookingConfirmationContext,
} from './booking-confirmation.email';
