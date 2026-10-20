// Called only after the normal provider/session/rate-limit checks. The business
// adapter selects the private schema; callers cannot select a schema or owner.
export async function syncRevision(db, surface, actor, createError) {
  const admin = surface === 'admin';
  const access = await db.from(admin ? 'admins' : 'members')
    .select(admin ? 'role,status' : 'status').eq('line_user_id', actor).maybeSingle();
  if (access.error) throw createError(503, 'SYNC_UNAVAILABLE', '目前無法確認同步權限。');
  if (access.data?.status !== 'active' || (admin && access.data.role !== 'admin'))
    throw createError(403, admin ? 'ADMIN_REQUIRED' : 'MEMBER_DISABLED', '目前沒有同步資料的權限。');
  const latest = await db.from('realtime_events').select('id,created_at')
    .in('scope', surface === 'booking' ? ['booking','member','points','event','calendar','all'] : [surface, 'all']).order('id', {ascending:false}).limit(1).maybeSingle();
  if (latest.error) throw createError(503, 'SYNC_UNAVAILABLE', '同步服務暫時無法使用。');
  return {revision:latest.data ? String(latest.data.id) + ':' + String(latest.data.created_at) : '0'};
}
