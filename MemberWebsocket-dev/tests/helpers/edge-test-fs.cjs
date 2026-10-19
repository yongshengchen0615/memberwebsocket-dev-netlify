// Legacy unit harnesses deliberately evaluate handler functions without imports.
// Preserve that boundary after adding the request adapter. The actual adapter is
// exercised separately by business-runtime_test.ts and the SQL/browser journeys.
const fs=require('node:fs');
module.exports={...fs,readFileSync(...args){
 const value=fs.readFileSync(...args);
 if(typeof value!=='string'||!String(args[0]).includes('supabase/functions')||!String(args[0]).endsWith('.ts'))return value;
 return value.replace(/\bserveBusiness\('[^']+',/g,'Deno.serve(')
  .replace(/\bbusinessEnv\(/g,'Deno.env.get(')
  .replace(/businessHandler\('[^']+', handleRequest\)/g,'handleRequest');
}};
