// The database owns authorization, revocation and the atomic relational cleanup.
// Storage deletion precedes finalization and is retryable; a database trigger
// rejects late signed uploads once removal has begun.
export async function removeMember(supabase: any, actor: string, body: Record<string, unknown>, errorFactory: (status: number, code: string, message: string) => Error): Promise<unknown> {
  const target = String(body.lineUserId || '').trim();
  const confirmation = String(body.confirmMemberCode || '').trim();
  if (!target || target.length > 120 || !confirmation || confirmation.length > 40) {
    throw errorFactory(400, 'MEMBER_REMOVAL_CONFIRMATION_REQUIRED', '請輸入欲移除會員的完整會員編號。');
  }
  const started = await supabase.rpc('begin_member_removal', { p_actor: actor, p_target: target, p_confirm_code: confirmation });
  if (started.error) {
    const message = String(started.error.message || '');
    if (message.includes('ADMIN_PROTECTED')) throw errorFactory(403, 'ADMIN_PROTECTED', '不能移除管理員本人或管理員帳號。');
    if (message.includes('CONFIRMATION_MISMATCH')) throw errorFactory(400, 'CONFIRMATION_MISMATCH', '會員編號不符，尚未開始移除。');
    if (message.includes('E2E_ACTIVE')) throw errorFactory(409, 'E2E_ACTIVE', '請先停止執行中的測試，再移除測試會員。');
    throw errorFactory(409, 'MEMBER_REMOVAL_UNAVAILABLE', '目前無法開始移除會員。');
  }
  const job = started.data;
  if (job.state === 'complete') return { jobId: job.jobId, state: 'complete', alreadyApplied: true };
  const prefix = String(job.memberId || '');
  if (!/^[a-f0-9-]{36}$/.test(prefix)) throw errorFactory(503, 'MEMBER_REMOVAL_PENDING', '帳號已阻斷，資料清理待重試。');
  // Read only Storage metadata; physical files are removed exclusively through Storage API.
  for (let round = 0; round < 100; round++) {
    const paths = await supabase.rpc('member_removal_storage_paths', { p_actor: actor, p_job_id: job.jobId });
    if (paths.error) throw errorFactory(503, 'MEMBER_REMOVAL_PENDING', '帳號已阻斷，無法確認收據檔案，請重試移除。');
    const batch = (paths.data || []).slice(0, 100);
    if (!batch.length) break;
    for (const bucket of ['booking-receipts', 'e2e-failure-artifacts']) {
      const names = batch.filter((item: any) => item.bucket === bucket && typeof item.path === 'string').map((item: any) => item.path);
      if (!names.length) continue;
      const removed = await supabase.storage.from(bucket).remove(names);
      if (removed.error) throw errorFactory(503, 'MEMBER_REMOVAL_PENDING', '帳號已阻斷，私人檔案尚未清除，請重試移除。');
    }
  }
  const finished = await supabase.rpc('finish_member_removal', { p_actor: actor, p_job_id: job.jobId });
  if (finished.error) throw errorFactory(503, 'MEMBER_REMOVAL_PENDING', '帳號已阻斷，部分資料尚未清除，請重試移除。');
  return finished.data;
}
