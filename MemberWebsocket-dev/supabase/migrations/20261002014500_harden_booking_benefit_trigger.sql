-- Prevent direct API invocation of the internal booking-benefit trigger function.
revoke all on function public.cancel_booking_benefit_selections_on_terminal_status() from public, anon, authenticated;
grant execute on function public.cancel_booking_benefit_selections_on_terminal_status() to service_role;
