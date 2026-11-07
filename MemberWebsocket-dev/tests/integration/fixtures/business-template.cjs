// The notification schema is part of the business domain, not a shared queue.
const base=require('./business-runtime-schema.json'),notice=require('./business-notification-schema.json');
const scope=sql=>sql.replace(/\bbooking_notifications\.([a-z_]+)/g,'public.notice_$1').replaceAll("'booking_notifications'","'public'");
const template=structuredClone(base);
for(const kind of ['tables','functions','constraints','indexes','triggers'])for(const original of notice[kind]||[]){
 const obj=structuredClone(original);
 if(obj.name)obj.name='notice_'+obj.name;
 if(obj.table)obj.table='notice_'+obj.table;
 if(obj.definition){obj.definition=scope(obj.definition);if(kind==='indexes')obj.definition=obj.definition.replace(/(CREATE (?:UNIQUE )?INDEX )([a-z_]+)/,'$1notice_$2');}
 template[kind].push(obj);
}
for(const kind of ['functions','constraints','indexes','triggers'])for(const obj of template[kind])obj.definition=scope(obj.definition);
module.exports=template;
