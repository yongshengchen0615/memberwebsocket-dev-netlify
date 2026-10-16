-- LINE notifications must not describe 09/28 00:30 as 09/27 00:30.
-- The opening business date is still shown separately for operations.
do $migration$
declare
  v_def text;
  v_old text := 'E''\n時段：'' || left(latest.start_time::text,5) || ''–'' || left(latest.end_time::text,5) || ''（台北時間）''';
  v_new text := 'E''\n時段：'' || to_char(latest.start_at,''YYYY/MM/DD HH24:MI'') || ''–'' || to_char(latest.end_at,''YYYY/MM/DD HH24:MI'') || ''（台北時間）''';
begin
  v_def := pg_get_functiondef('booking_notifications.enqueue()'::regprocedure);
  if length(v_def) - length(replace(v_def,v_old,'')) <> 2 * length(v_old) then
    raise exception 'BOOKING_NOTIFICATION_FORMAT_CHANGED';
  end if;
  v_def := replace(v_def,v_old,v_new);
  v_def := replace(v_def,'E''\n日期：'' || to_char(latest.booking_date,''YYYY/MM/DD'')',
    'E''\n營業日：'' || to_char(latest.booking_date,''YYYY/MM/DD'')');
  execute v_def;
end $migration$;
