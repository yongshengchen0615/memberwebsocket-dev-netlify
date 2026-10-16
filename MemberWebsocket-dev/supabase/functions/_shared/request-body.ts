type ApiErrorConstructor = new (status: number, code: string, message: string) => Error;

// 在讀取期間限制實際位元組數，不能只信任可省略／偽造的 Content-Length。
export async function readJsonObject(
  request: Request,
  maxBytes: number,
  ApiError: ApiErrorConstructor,
  timeoutMs = 10_000,
): Promise<Record<string, unknown>> {
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > maxBytes) {
    void request.body?.cancel().catch(() => {});
    throw new ApiError(413, "REQUEST_TOO_LARGE", "請求內容過大。");
  }
  if (!request.body) throw new ApiError(400, "INVALID_JSON", "請求內容必須是 JSON。");

  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let raw = "";
  let complete = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ApiError(408, "REQUEST_TIMEOUT", "請求傳送逾時。")), timeoutMs);
  });
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) { complete = true; break; }
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new ApiError(413, "REQUEST_TOO_LARGE", "請求內容過大。");
      try { raw += decoder.decode(value, { stream: true }); }
      catch { throw new ApiError(400, "INVALID_JSON", "請求必須使用 UTF-8 JSON。"); }
    }
    let body: unknown;
    try { body = JSON.parse(raw + decoder.decode()); }
    catch { throw new ApiError(400, "INVALID_JSON", "請求內容必須是有效 JSON。"); }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new ApiError(400, "INVALID_REQUEST", "請求內容必須是 JSON 物件。");
    }
    return body as Record<string, unknown>;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    // 不等待不受信任的串流完成取消，避免取消動作拖住錯誤回應。
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
