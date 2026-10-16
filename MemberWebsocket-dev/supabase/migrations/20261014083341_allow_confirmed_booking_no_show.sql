-- Allow administrators to mark a completed-time, non-snapshot confirmed booking as no-show.
-- Preserve the existing admin authorization, cancellation review, optimistic lock,
-- service-end time guard, ticket reservation release, and audit event semantics.
begin;
create or replace function public.admin_mark_booking_no_show(p_actor text,p_booking_id uuid,p_expected_updated_at timestamptz,p_note text default '')
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare b public.bookings%rowtype;
begin
 perform 1 from public.admins where line_user_id=p_actor and role='admin' and status='active' for share;
 if not found then raise exception 'ADMIN_REQUIRED'; end if;
 select * into b from public.bookings where id=p_booking_id for update;
 if not found then raise exception 'BOOKING_NOT_FOUND'; end if;
 if b.receipt_submission_id is not null or b.request_id like 'receipt-register:%' then raise exception 'BOOKING_NO_SHOW_NOT_ALLOWED'; end if;
 if b.status='no_show' then return jsonb_build_object('alreadyApplied',true); end if;
 if b.status not in ('pending','confirmed') then raise exception 'BOOKING_NO_SHOW_NOT_ALLOWED'; end if;
 if b.cancellation_requested_at is not null and b.cancellation_reviewed_at is null then raise exception 'BOOKING_CANCELLATION_PENDING'; end if;
 if p_expected_updated_at is null or b.updated_at<>p_expected_updated_at then raise exception 'BOOKING_CONFLICT'; end if;
 if b.end_at is null or b.end_at>=(clock_timestamp() at time zone 'Asia/Taipei') then raise exception 'BOOKING_NO_SHOW_TOO_EARLY'; end if;
 if p_note is null or length(p_note)>500 then raise exception 'INVALID_ADMIN_NOTE'; end if;
 update public.bookings set status='no_show',no_show_at=clock_timestamp(),no_show_by=p_actor,admin_note=p_note where id=b.id;
 -- No settlement, point debit, ticket redemption or member LINE notification.
 insert into public.booking_audit_events(actor_line_user_id,actor_role,action,target_type,target_id,result,metadata)
 values(p_actor,'admin','BOOKING_NO_SHOW','booking',b.id::text,'success',jsonb_build_object('previousStatus',b.status,'nextStatus','no_show'));
 return jsonb_build_object('alreadyApplied',false);
end $$;
revoke all on function public.admin_mark_booking_no_show(text,uuid,timestamptz,text) from public,anon,authenticated;
grant execute on function public.admin_mark_booking_no_show(text,uuid,timestamptz,text) to service_role;
commit;
