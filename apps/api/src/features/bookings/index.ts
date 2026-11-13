/** Публичный API фичи онлайн-записи: наружу отдаём маршруты и шаблон письма. */
export { bookingRoutes } from './bookings.routes';
export {
  BOOKING_CONFIRMATION_TYPE,
  createBookingConfirmationTemplate,
  type BookingConfirmationContext,
} from './booking-confirmation.email';
