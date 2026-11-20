-- Display the same per-person booking information as the LINE booking notice.
-- This projection is only invoked by the existing approved review-staff RPC.
-- Do not alter LINE outbox formatting, booking state transitions or tenant grants.
create or replace function platform_private.frontdesk_booking_json(p_schema text,p_id uuid)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare v jsonb;
begin
 if p_schema !~ '^business_[0-9a-f]{32}$' then raise exception 'FRONTDESK_UNAVAILABLE'; end if;
 execute format($query$
 select jsonb_build_object(
   'id',b.id,'status',b.status,'updatedAt',b.updated_at,
   'bookingDate',b.booking_date,'startAt',b.start_at,'endAt',b.end_at,
   'startTime',left(b.start_time::text,5),'endTime',left(b.end_time::text,5),
   'name',coalesce(nullif(b.contact_surname,''),nullif(m.surname,''),'會員') ||
     case coalesce(nullif(b.contact_salutation,''),nullif(m.salutation,''),'')
       when 'mr' then '先生' when 'ms' then '小姐' else '' end,
   'phone',coalesce(nullif(b.contact_phone,''),m.phone,''),
   'partySize',b.party_size,'note',b.member_note,
   'cancellationPending',b.cancellation_requested_at is not null and b.cancellation_reviewed_at is null,
   'services',coalesce((select jsonb_agg(jsonb_build_object('title',i.service_title,'quantity',i.quantity)
                    order by i.created_at,i.id)
       from %1$I.booking_items i where i.booking_id=b.id),'[]'::jsonb),
   'participants',coalesce((
      select jsonb_agg(jsonb_build_object(
        'position',bp.position,
        'technician',coalesce(nullif(bt.name,''),'現場安排'),
        'note',bp.member_note,
        'services',coalesce((
          select jsonb_agg(jsonb_build_object('title',bpi.service_title,'quantity',bpi.quantity)
                    order by bpi.created_at,bpi.id)
          from %1$I.booking_participant_items bpi where bpi.participant_id=bp.id
        ),'[]'::jsonb)
      ) order by bp.position)
      from %1$I.booking_participants bp
      left join %1$I.booking_technicians bt on bt.id=bp.technician_id
      where bp.booking_id=b.id
   ),'[]'::jsonb),
   'fallbackTechnician',coalesce(nullif(fbt.name,''),'現場安排')
 )
 from %1$I.bookings b
 left join %1$I.members m on m.id=b.member_id
 left join %1$I.booking_technicians fbt on fbt.id=b.technician_id
 where b.id=$1
 $query$,p_schema) into v using p_id;
 return v;
end $$;
