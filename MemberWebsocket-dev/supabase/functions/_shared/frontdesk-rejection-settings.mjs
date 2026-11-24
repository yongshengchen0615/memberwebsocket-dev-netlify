// Issue #425: shared rejection-settings contract. No storage or authorization bypass.
// Callers must load settings from the authenticated tenant, not from request bodies.
const DEFAULT_REJECTION_SETTINGS = {
  "dropdownTitle": "請選擇拒絕原因",
  "reasons": [
    {
      "id": "technician_leave",
      "label": "預約中有休假技師",
      "requiresConflictTime": false,
      "memberDescription": "預約中有休假技師",
      "enabled": true
    },
    {
      "id": "unrecorded_phone_booking",
      "label": "該時段已被現場人員預約但未登記",
      "requiresConflictTime": true,
      "memberDescription": "該時段已被現場人員預約但未登記",
      "enabled": true
    }
  ]
};
function defaultRejectionSettings(){return {dropdownTitle:DEFAULT_REJECTION_SETTINGS.dropdownTitle,reasons:DEFAULT_REJECTION_SETTINGS.reasons.map(reason=>({...reason}))};}

function invalid(message){throw new TypeError(message);}

function boundedText(value,max,field,{optional=false,multiline=false}={}){
 if(typeof value!=="string")invalid(field);
 const text=value.trim();
 if((!optional&&!text)||[...text].length>max||(multiline?/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/:/[\u0000-\u001f\u007f]/).test(value))invalid(field);
 return text.replace(/\r\n?/g,"\n");
}

function normalizeRejectionSettings(input){
 if(!input||typeof input!=="object"||Array.isArray(input)||Object.keys(input).some(key=>!["dropdownTitle","reasons"].includes(key)))invalid("INVALID_REJECTION_SETTINGS");
 const dropdownTitle=boundedText(input.dropdownTitle,60,"INVALID_REJECTION_TITLE",{optional:true})||DEFAULT_REJECTION_SETTINGS.dropdownTitle;
 if(!Array.isArray(input.reasons)||input.reasons.length<1||input.reasons.length>30)invalid("INVALID_REJECTION_REASONS");
 const ids=new Set(),labels=new Set();
 const reasons=input.reasons.map(row=>{
  if(!row||typeof row!=="object"||Array.isArray(row)||Object.keys(row).some(key=>!["id","label","requiresConflictTime","memberDescription","enabled"].includes(key)))invalid("INVALID_REJECTION_REASON");
  const {id,requiresConflictTime,enabled}=row;
  if(typeof id!=="string"||!(/^(technician_leave|unrecorded_phone_booking)$/.test(id)||/^custom_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id))||ids.has(id)||typeof requiresConflictTime!=="boolean"||typeof enabled!=="boolean")invalid("INVALID_REJECTION_REASON");
  const label=boundedText(row.label,120,"INVALID_REJECTION_LABEL");
  const memberDescription=boundedText(row.memberDescription,400,"INVALID_REJECTION_DESCRIPTION",{multiline:true});
  if(enabled&&labels.has(label))invalid("DUPLICATE_REJECTION_LABEL");
  ids.add(id);if(enabled)labels.add(label);
  return {id,label,requiresConflictTime,memberDescription,enabled};
 });
 if(!reasons.some(reason=>reason.enabled))invalid("REJECTION_REASON_REQUIRED");
 return {dropdownTitle,reasons};
}

function validateRejectionSettingsUpdate(previous,input){
 const before=normalizeRejectionSettings(previous),next=normalizeRejectionSettings(input);
 const retained=new Set(next.reasons.map(reason=>reason.id));
 if(before.reasons.some(reason=>!retained.has(reason.id)))invalid("REJECTION_REASON_DELETE_FORBIDDEN");
 return next;
}

function resolveRejectionReason(settings,id,route){
 const normalized=normalizeRejectionSettings(settings);
 const reason=normalized.reasons.find(item=>item.id===id&&item.enabled);
 if(!reason)invalid("BOOKING_REJECTION_REASON_REQUIRED");
 if(route!==(reason.requiresConflictTime?"booking.reject_phone":"booking.update"))invalid("REJECTION_ROUTE_MISMATCH");
 return {id:reason.id,label:reason.label,memberDescription:reason.memberDescription,requiresConflictTime:reason.requiresConflictTime};
}

export { defaultRejectionSettings, normalizeRejectionSettings, validateRejectionSettingsUpdate, resolveRejectionReason };
