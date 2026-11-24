// The super-admin grant and the merchant's configured frontdesk must both be active.
// Do not accept a mode flag from browser payloads or stale LINE tokens.
export function directFrontdeskCancellationEnabled(tenant) {
  return tenant?.features?.booking === true
    && tenant?.features?.frontdesk === true
    && tenant?.module_line?.booking?.frontdesk?.enabled === true;
}
