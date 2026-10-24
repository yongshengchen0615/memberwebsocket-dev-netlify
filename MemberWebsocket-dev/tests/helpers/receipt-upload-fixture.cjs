const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const root = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'supabase/functions/booking-receipt-api/index.ts'), 'utf8');
const adapter = fs.readFileSync(path.join(root, 'supabase/functions/_shared/business-runtime.ts'), 'utf8');

// Execute the production prepare function and storage namespace adapter. Only the
// database/Storage transport is synthetic; signing binds each token to one path.
module.exports = function fixture(tenantId = '', { status = 'pending_upload', signingError = false } = {}) {
  const context = vm.createContext({
    asText: value => String(value || ''), ALLOWED_MIME: new Set(['image/jpeg', 'image/png']),
    MAX_FILE_BYTES: 5242880, BUCKET: 'booking-receipts', crypto: require('node:crypto').webcrypto,
    extensionFor: mime => mime === 'image/png' ? 'png' : 'jpg',
    normalizeAccessibleBenefits: value => value || [], dbError: error => error,
    ApiError: class extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } },
  });
  vm.runInContext(stripTypeScriptTypes(adapter.slice(adapter.indexOf('const relative='), adapter.indexOf('export function createClient('))), context);
  vm.runInContext(stripTypeScriptTypes(source.slice(source.indexOf('async function prepare('), source.indexOf('async function finalize('))), context);
  const signed = new Map(), calls = [], uploaded = new Map(); let storedPath = '';
  const storage = { from: bucket => ({ createSignedUploadUrl: async (objectPath, options) => {
    calls.push({ bucket, objectPath, options });
    if (signingError) return { data: null, error: new Error('signing unavailable') };
    const token = 'synthetic-signed-' + signed.size;
    signed.set(token, objectPath);
    return { data: { path: objectPath, token }, error: null };
  } }) };
  const db = {
    storage: tenantId ? context.storageAdapter(storage, { id: tenantId }) : storage,
    rpc: async (name, params) => {
      if (name === 'fail_booking_receipt_request') return { data: {}, error: null };
      storedPath = params.p_object_path;
      return { data: { status, receiptId: 'QA-RECEIPT', objectPath: storedPath, alreadyPrepared: status !== 'pending_upload' }, error: null };
    },
  };
  return {
    calls, signed, uploaded, storedPath: () => storedPath,
    prepare: body => context.prepare(db, { lineUserId: 'synthetic-member' }, { id: '30000000-0000-4000-8000-000000000003' }, {
      requestId: 'qa-snapshot-request', mimeType: 'image/jpeg', sizeBytes: 100, ...body,
    }),
    upload(objectPath, token, bytes) {
      if (!signed.has(token) || signed.get(token) !== objectPath) throw new Error('Invalid upload signature');
      if (uploaded.has(objectPath)) throw new Error('Asset Already Exists');
      uploaded.set(objectPath, bytes);
    },
  };
};
