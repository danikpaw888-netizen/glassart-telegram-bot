// GlassArt order workflow. SQL adapter is synchronous; caller owns transactions.
import { timingSafeEqual } from 'node:crypto';
export const STATUSES = ['Новая', 'В работе', 'Готова', 'Завершена', 'Отменена'];
export const FIELDS = {customer:'Клиент',film:'Тип / марка пленки',lines:'Размеры стекол',processing:'Обработка всего заказа',thickness:'Толщина всего заказа',comment:'Комментарий'};
export const completionText = status => [2,3].includes(status)?'Выполнено':'Не выполнено';
const STEPS = Object.keys(FIELDS);
const PROMPTS = {
  customer:'Кто заказал тонировку? Имя клиента или название компании (до 150 символов).',
  film:'Введите тип и марку пленки, при наличии артикул (до 150 символов).',
  lines:'Введите размеры в мм: ширина × высота × количество. Можно пробелами. Несколько позиций — каждая с новой строки, например:\n1200 768 4\n12345 567 2\n\nЕсли количество не указано, считаем 1. После «Готово» бот один раз запросит обработку и толщину всего заказа. До 20 позиций. После всех размеров нажмите «Готово».',
  processing:'Есть ли обработка у стекол этого заказа? Выберите «Есть обработка» или «Без обработки».',
  thickness:'Введите общую толщину стекол заказа в мм. Например: 4, 6 или 10,5.',
  comment:'Комментарий (до 500 символов) или «Пропустить».'
};
export const SCHEMA = [
 'CREATE TABLE IF NOT EXISTS deletion_requests(token TEXT PRIMARY KEY,order_id INTEGER NOT NULL,version INTEGER NOT NULL,actor INTEGER NOT NULL,chat_id INTEGER NOT NULL,expires INTEGER NOT NULL)',
 'CREATE TABLE IF NOT EXISTS deleted_orders(order_id INTEGER PRIMARY KEY,actor INTEGER NOT NULL,name TEXT NOT NULL,at TEXT NOT NULL)',
 'CREATE TABLE IF NOT EXISTS removal_outbox(outbox_id INTEGER PRIMARY KEY,order_id INTEGER NOT NULL,chat_id INTEGER NOT NULL,message_id INTEGER NOT NULL)',
 'CREATE TABLE IF NOT EXISTS report_reposts(outbox_id INTEGER PRIMARY KEY,chat_id INTEGER NOT NULL)',
 'CREATE TABLE IF NOT EXISTS repost_deliveries(outbox_id INTEGER PRIMARY KEY,order_id INTEGER NOT NULL)',
 'CREATE TABLE IF NOT EXISTS config(key TEXT PRIMARY KEY,value TEXT NOT NULL)',
 'CREATE TABLE IF NOT EXISTS staff(id INTEGER PRIMARY KEY,added TEXT NOT NULL)',
 'CREATE TABLE IF NOT EXISTS admins(id INTEGER PRIMARY KEY,added TEXT NOT NULL,added_by INTEGER NOT NULL)',
 'CREATE TABLE IF NOT EXISTS user_names(id INTEGER PRIMARY KEY,name TEXT NOT NULL)',
 'CREATE TABLE IF NOT EXISTS status_reactions(order_id INTEGER PRIMARY KEY,chat_id INTEGER NOT NULL,message_id INTEGER NOT NULL,status INTEGER NOT NULL,version INTEGER NOT NULL)',
 'CREATE TABLE IF NOT EXISTS reaction_jobs(order_id INTEGER PRIMARY KEY,chat_id INTEGER NOT NULL,reply_to INTEGER NOT NULL,status INTEGER NOT NULL,version INTEGER NOT NULL)',
 'CREATE TABLE IF NOT EXISTS reaction_outbox(outbox_id INTEGER PRIMARY KEY,order_id INTEGER NOT NULL,version INTEGER NOT NULL,status INTEGER NOT NULL,kind TEXT NOT NULL,message_id INTEGER)',
 'CREATE TABLE IF NOT EXISTS sessions(id INTEGER PRIMARY KEY,data TEXT NOT NULL)',
 `CREATE TABLE IF NOT EXISTS orders(id INTEGER PRIMARY KEY AUTOINCREMENT,token TEXT UNIQUE NOT NULL,data TEXT NOT NULL,search_text TEXT NOT NULL,status INTEGER NOT NULL DEFAULT 0,created TEXT NOT NULL,updated TEXT NOT NULL,creator INTEGER NOT NULL,author TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1)`,
 'CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY,order_id INTEGER NOT NULL,actor INTEGER NOT NULL,action TEXT NOT NULL,at TEXT NOT NULL)',
 'CREATE INDEX IF NOT EXISTS events_order ON events(order_id,id)',
 'CREATE TABLE IF NOT EXISTS processed(id INTEGER PRIMARY KEY,at INTEGER NOT NULL)',
 'CREATE TABLE IF NOT EXISTS outbox(id INTEGER PRIMARY KEY,method TEXT NOT NULL,params TEXT NOT NULL,recipient INTEGER,failed INTEGER NOT NULL DEFAULT 0)'
 ,'CREATE TABLE IF NOT EXISTS group_copies(order_id INTEGER NOT NULL,chat_id INTEGER NOT NULL,part INTEGER NOT NULL,message_id INTEGER NOT NULL,PRIMARY KEY(chat_id,message_id))'
 ,'CREATE TABLE IF NOT EXISTS group_reposts(order_id INTEGER PRIMARY KEY,chat_id INTEGER NOT NULL,thread_id INTEGER)'
 ,'CREATE TABLE IF NOT EXISTS group_cards(order_id INTEGER NOT NULL,chat_id INTEGER NOT NULL,part INTEGER NOT NULL,message_id INTEGER NOT NULL,PRIMARY KEY(order_id,chat_id,part))'
 ,'CREATE TABLE IF NOT EXISTS group_jobs(order_id INTEGER PRIMARY KEY,chat_id INTEGER NOT NULL,thread_id INTEGER)'
 ,'CREATE TABLE IF NOT EXISTS outbox_meta(outbox_id INTEGER PRIMARY KEY,order_id INTEGER NOT NULL,chat_id INTEGER NOT NULL,part INTEGER NOT NULL)'
];
export class InputError extends Error {}
export const now = () => new Date().toISOString();
export const numberId = v => Number.isSafeInteger(v) && v > 0;
export const code = id => 'GA-' + String(id).padStart(6,'0');
export const displayName=user=>[user?.first_name,user?.last_name].filter(Boolean).join(' ').trim().slice(0,150)||(user?.username?'@'+user.username:'Сотрудник');
export const markup = rows => ({inline_keyboard:rows.map(row=>row.map(([text,callback_data])=>({text,callback_data})))});
export function splitText(text){const chunks=[];let part='';for(const line of text.split('\n')){if(part.length+line.length>3400){chunks.push(part.trim());part='';}part+=line+'\n';}chunks.push(part.trim()||'—');return chunks;}

export function parseLine(text) {
 const parts=text.trim().toLowerCase().split(/\s*[xх×*;]\s*|\s+/);
 if(parts.length<2||parts.length>3) throw new InputError('Нужны ширина, высота и количество: 1200 × 1500 × 2.');
 if(!parts.every(x=>/^\d+(?:[.,]\d{1,2})?$/.test(x))) throw new InputError('Введите положительные числа, размеры с точностью до 0,01 мм.');
 const [width,height,count=1]=parts.map(x=>Number(x.replace(',','.')));
 if(width<=0||height<=0||width>20000||height>20000) throw new InputError('Ширина и высота — больше 0 и не больше 20 000 мм.');
 if(!Number.isInteger(count)||count<1||count>10000) throw new InputError('Количество — целое число от 1 до 10 000.');
 return {width:String(width),height:String(height),count};
}
export function areaUnits(lines){let units=0n;for(const x of lines){const piece=BigInt(Math.round(Number(x.width)*100))*BigInt(Math.round(Number(x.height)*100));units+=(piece<3000000000n?3000000000n:piece)*BigInt(x.count);}return units;}
export function areaText(lines){const n=(areaUnits(lines)+5000000n)/10000000n;return `${n/1000n},${String(n%1000n).padStart(3,'0')}`;}
export function areaDisplay(lines){const n=(areaUnits(lines)+500000n)/1000000n;const tail=String(n%10000n).padStart(4,'0').replace(/0+$/,'');return String(n/10000n)+(tail?'.'+tail:'');}
// Exact real edge length in metres; the minimum billable area does not apply.
export function perimeterDisplay(lines){let units=0n;for(const x of lines)units+=2n*(BigInt(Math.round(Number(x.width)*100))+BigInt(Math.round(Number(x.height)*100)))*BigInt(x.count);const tail=String(units%100000n).padStart(5,'0').replace(/0+$/,'');return String(units/100000n)+(tail?'.'+tail:'');}
export const localDay=value=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Oral',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));
export function parseThickness(text) {
 if(!/^\d+(?:[.,]\d{1,2})?$/.test(text)||!Number.isFinite(Number(text.replace(',','.'))))throw new InputError('Введите толщину числом в мм, например 4 или 10,5.');
 const value=Number(text.replace(',','.'));
 if(value<=0||value>1000)throw new InputError('Толщина должна быть больше 0 и не больше 1000 мм.');
 return String(value);
}
export class Engine {
 constructor(sql){this.sql=sql;for(const statement of SCHEMA) this.q(statement);this.ensureAdmins();}
 q(query,...args){return this.sql.exec(query,...args).toArray();}
 one(query,...args){return this.q(query,...args)[0];}
 config(key){const row=this.one('SELECT value FROM config WHERE key=?',key);return row?JSON.parse(row.value):null;}
 setConfig(key,value){this.q('INSERT OR REPLACE INTO config VALUES (?,?)',key,JSON.stringify(value));}
 session(uid){
  const row=this.one('SELECT data FROM sessions WHERE id=?',uid);if(!row)return null;
  const s=JSON.parse(row.data);
  if(s.mode==='draft'&&s.schemaVersion!==4){
   if(['phone','object'].includes(s.step))s.step='film';
   if(s.step==='deadline')s.step='comment';
   if(s.step==='photos'){s.step='preview';delete s.returnPreview;}
   if(s.data.lines?.length){const first=s.data.lines[0];if(s.data.lines.every(x=>x.processing===first.processing)&&typeof first.processing==='boolean')s.data.processing=first.processing;if(s.data.lines.every(x=>x.thickness===first.thickness)&&first.thickness)s.data.thickness=first.thickness;}delete s.lineIndex;delete s.lineReturn;delete s.pendingGlass;s.schemaVersion=4;this.put(uid,s);
   Object.defineProperty(s,'migrated',{value:true});
  }
  return s;
 }
 put(uid,s){s.rev=(s.rev||0)+1;this.q('INSERT OR REPLACE INTO sessions VALUES (?,?)',uid,JSON.stringify(s));}
 clear(uid){this.q('DELETE FROM sessions WHERE id=?',uid);}
 ensureAdmins(){const owner=this.config('owner');if(numberId(owner)&&!this.config('admins_initialized')){this.q('INSERT OR IGNORE INTO admins VALUES (?,?,?)',owner,now(),owner);this.setConfig('admins_initialized',true);}}
 adminIds(){this.ensureAdmins();return this.q('SELECT id FROM admins ORDER BY id').map(x=>x.id);}
 isAdmin(uid){this.ensureAdmins();return !!this.one('SELECT id FROM admins WHERE id=?',uid);}
 allowed(uid){return this.isAdmin(uid)||!!this.one('SELECT id FROM staff WHERE id=?',uid);}
 rememberUser(user){if(numberId(user?.id))this.q('INSERT OR REPLACE INTO user_names VALUES (?,?)',user.id,displayName(user));}
 enqueue(method,params){return this.one('INSERT INTO outbox(method,params,recipient) VALUES (?,?,?) RETURNING id',method,JSON.stringify(params),params.chat_id||null).id;}
 send(uid,text,rows){
  const chunks=[];let part='';
  for(const line of text.split('\n')){if(part.length+line.length>3400){chunks.push(part);part='';}part+=line+'\n';}chunks.push(part);
  chunks.forEach((text,index)=>{const params={chat_id:uid,text:text.trim()||'—'};if(rows&&index===chunks.length-1)params.reply_markup={inline_keyboard:rows.map(row=>row.map(([text,callback_data])=>({text,callback_data})))};this.enqueue('sendMessage',params);});
 }
 menu(uid){const rows=[[['＋ Новая заявка','new']],[['📝 Продолжить черновик','resume']]];if(this.isAdmin(uid))rows.push([['👥 Администраторы','manage_admins']],[['🗑 Удалить заявку','delete_help']],[['Группа сотрудников','group_help']]);this.send(uid,'GlassArt · Отправка заявок\nЗаполните заявку здесь. Все заявки и кнопки выполнения находятся в группе сотрудников.\nЧерновик сохраняется автоматически. /cancel — отменить ввод.\n/day — площадь заявок за день; заявки со статусом «Не выполнено» повторяются в группе сотрудников.',rows);}
 groupHelp(uid){if(!this.isAdmin(uid))return;const g=this.config('group');this.send(uid,(g?`Группа: ${g.title}\n`:'Группа сотрудников пока не подключена.\n')+'Добавьте @'+(this.config('username')||'GlassArtWork_bot')+' в нужную группу и назначьте администратором. Затем от своего аккаунта отправьте в группе /bindgroup. Вы должны быть администратором этого бота и участником группы. Сохраненные заявки тоже поступят туда.');}
 adminPanel(uid){if(!this.isAdmin(uid))return this.send(uid,'Управление администраторами доступно только администраторам.');this.send(uid,`Администраторы GlassArt:\n${this.adminIds().map(id=>'• ID '+id).join('\n')}\n\nДля назначения нужен числовой Telegram ID. Будущий администратор может получить его командой /id у этого бота.`,[[['＋ Добавить администратора','admin_add']],[['Снять права администратора','admin_remove']],[['Главное меню','menu']]]);}
 drows(s,rows){return rows.map(row=>row.map(([label,action])=>[label,`d:${s.token}:${s.rev}:${action}`]));}
 glassLine(x,i){return `${i+1}. ${x.width} × ${x.height} мм × ${x.count}\n   Обработка: ${x.processing===true?'есть':x.processing===false?'нет':'не указана'} · Толщина: ${x.thickness?x.thickness.replace('.',',')+' мм':'не указана'}`;}
 card(d,title){const lines=d.lines||[],shared=lines.length&&lines.every(x=>x.thickness===lines[0].thickness&&x.processing===lines[0].processing),first=lines[0]||{},processing=x=>x.processing===true?'Есть обработка':x.processing===false?'Без обработки':'Не указана';return [title,'',`🧊 Толщина стекла: ${shared?(first.thickness?first.thickness.replace('.',',')+' мм':'не указана'):'указана по позициям'}`,`📦 Плёнка: ${d.film||'—'}`,`🪟 Обработка края: ${shared?processing(first):'указана по позициям'}`,`📏 Общий периметр: ${perimeterDisplay(lines)} м`,'',...lines.map(x=>`${x.width}x${x.height} мм — ${x.count} шт, площадь ${areaDisplay([x])} м²`+(!shared?`\n   Толщина: ${x.thickness?x.thickness.replace('.',',')+' мм':'не указана'} · ${processing(x)}`:'')),'','────────────────',`✅ Стёкол: ${lines.reduce((n,x)=>n+x.count,0)}`,`📐 Площадь: ${areaDisplay(lines)} м²`,'Минимум за одно стекло — 0,3 м².','',`👤 Заказчик: ${d.customer||'—'}`,...(d.comment?[`💬 ${d.comment}`]:[])].join('\n');}
 prompt(uid,s){
  const step=s.step;
  if(step==='preview')return this.send(uid,this.card(s.data,'📋 Ваш расчёт:'),this.drows(s,[[['✅ Отправить заявку','save']],[['✏️ Исправить','edit']],[['Отменить ввод','cancel']]]));
  if(step==='edit_menu')return this.send(uid,'Какое поле исправить? При замене стекол прежний список заменяется.',this.drows(s,[...Object.entries(FIELDS).map(([k,label])=>[[label,'field_'+k]]),[['Вернуться к проверке','preview']]]));
  const rows=[];
  if(step==='comment')rows.push([['Пропустить','skip']]);
  if(step==='processing')rows.push([['Есть обработка','processing_yes'],['Без обработки','processing_no']]);
  if(step==='lines'){rows.push([['Готово','done']]);if(s.data.lines.length)rows.push([['Убрать последнее','remove']]);}
  rows.push([['Отменить ввод','cancel']]);this.send(uid,(step==='thickness'?`📏 Общий периметр стёкол: ${perimeterDisplay(s.data.lines)} м (с учётом количества).\n\n`:'')+PROMPTS[step],this.drows(s,rows));
 }
 start(uid,author,order){
  const s={mode:'draft',schemaVersion:4,token:crypto.randomUUID().replaceAll('-','').slice(0,10),rev:0,step:'customer',data:{lines:[]},author};
  if(order)Object.assign(s,{data:order.data,step:'edit_menu',editId:order.id,version:order.version});
  this.put(uid,s);this.prompt(uid,s);
 }
 next(uid,s){if(s.returnPreview){s.step='preview';delete s.returnPreview;}else s.step=STEPS[STEPS.indexOf(s.step)+1]||'preview';this.put(uid,s);this.prompt(uid,s);}
 completeLines(uid,s){
  if(typeof s.data.processing!=='boolean')s.step='processing';
  else if(!s.data.thickness)s.step='thickness';
  else {for(const line of s.data.lines){line.processing=s.data.processing;line.thickness=s.data.thickness;}s.step=s.returnPreview?'preview':'comment';delete s.returnPreview;}
  delete s.lineIndex;delete s.lineReturn;delete s.pendingGlass;this.put(uid,s);this.prompt(uid,s);
 }
 notify(oid){const g=this.config('group');if(g)this.q('INSERT OR REPLACE INTO group_jobs VALUES (?,?,?)',oid,g.id,g.thread_id||null);}
 bindGroup(chat,threadId){const old=this.config('group'),g={id:chat.id,title:chat.title||'Группа сотрудников',thread_id:threadId||null};if(old?.id===g.id&&old.thread_id!==g.thread_id){this.q('DELETE FROM group_cards WHERE chat_id=?',g.id);this.q('DELETE FROM group_copies WHERE chat_id=?',g.id);}this.q('DELETE FROM outbox_meta WHERE outbox_id IN (SELECT id FROM outbox WHERE recipient<0)');this.q('DELETE FROM outbox WHERE recipient<0');this.pruneDeliveryMetadata();this.setConfig('group',g);this.q('DELETE FROM group_jobs');this.q('DELETE FROM group_reposts');this.q('INSERT INTO group_jobs SELECT id,?,? FROM orders',g.id,g.thread_id);this.send(g.id,'✅ Группа подключена к GlassArt. Заявки будут появляться здесь с кнопками «Выполнено» и «Не выполнено». Сохраненные заявки добавлены в очередь отправки.');}
 groupText(o){const event=this.one("SELECT e.actor,u.name FROM events e LEFT JOIN user_names u ON u.id=e.actor WHERE e.order_id=? AND e.action LIKE 'Статус:%' ORDER BY e.id DESC LIMIT 1",o.id);return this.card(o.data,`📋 Заявка ${code(o.id)}`)+`\n👤 Отправил: ${o.author}\n🕒 ${new Date(o.created).toLocaleString('ru-RU',{timeZone:'Asia/Oral'})}\n\nСтатус: ${completionText(o.status)}`+(event?`\nОтметил: ${event.name||'Сотрудник'}`:'');}
 completionButtons(o){const decided=this.one("SELECT id FROM events WHERE order_id=? AND action LIKE 'Статус:%' LIMIT 1",o.id);return (decided||[2,3].includes(o.status))?[[[o.status===3||o.status===2?'✅ Заказ выполнен':'❌ Заказ не выполнен',`r:${o.id}:${o.version}`]]]:[[['✅ Выполнено',`g:${o.id}:${o.version}:3`],['❌ Не выполнено',`g:${o.id}:${o.version}:0`]]];}
 dayReport(argument=''){let day=localDay(Date.now());if(argument){const m=/^(\d{2})\.(\d{2})\.(\d{4})$/.exec(argument);if(!m)throw new InputError('Формат: /day или /day ДД.ММ.ГГГГ');const date=new Date(Date.UTC(+m[3],+m[2]-1,+m[1]));if(date.getUTCFullYear()!==+m[3]||date.getUTCMonth()!==+m[2]-1||date.getUTCDate()!==+m[1])throw new InputError('Укажите существующую дату.');day=`${m[3]}-${m[2]}-${m[1]}`;}const date=new Date(day+'T00:00:00Z'),rows=this.q('SELECT data,status,created FROM orders WHERE created>=? AND created<?',new Date(+date-86400000).toISOString(),new Date(+date+86400000).toISOString()).filter(o=>localDay(o.created)===day),done=rows.filter(o=>[2,3].includes(o.status)),pending=rows.filter(o=>![2,3].includes(o.status)),lines=list=>list.flatMap(o=>JSON.parse(o.data).lines||[]);return `📊 Итоги за ${day.split('-').reverse().join('.')}\nПо дате отправки заявки · время Казахстана\n\n📋 Заявок: ${rows.length}\n✅ Стёкол: ${lines(rows).reduce((n,x)=>n+x.count,0)}\n📐 Общая площадь: ${areaDisplay(lines(done))} м² (только выполненные)\n\n✅ Выполнено: ${done.length} заявок · ${areaDisplay(lines(done))} м²\n❌ Не выполнено: ${pending.length} заявок · ${areaDisplay(lines(pending))} м²`;}
 repostPending(){const g=this.config('group');if(!g)return 0;this.q("INSERT OR IGNORE INTO group_reposts SELECT id,?,? FROM orders o WHERE status=0 AND (SELECT action FROM events e WHERE e.order_id=o.id AND e.action LIKE 'Статус:%' ORDER BY id DESC LIMIT 1)='Статус: Не выполнено'",g.id,g.thread_id||null);return this.one('SELECT COUNT(*) AS n FROM group_reposts WHERE chat_id=?',g.id).n;}
 pendingCount(){return this.one("SELECT COUNT(*) AS n FROM orders o WHERE status=0 AND (SELECT action FROM events e WHERE e.order_id=o.id AND e.action LIKE 'Статус:%' ORDER BY id DESC LIMIT 1)='Статус: Не выполнено'").n;}
 dayRich(text){const escape=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');return {html:'<img src="tg://photo?id=day"/>'+text.split('\n\n').map(p=>'<p>'+escape(p).replaceAll('\n','<br>')+'</p>').join(''),media:[{id:'day',media:{type:'photo',media:'attach://banner'}}],skip_entity_detection:true};}
 queueDayReport(report,threadId){const g=this.config('group');if(!g)return;const id=this.enqueue('sendRichMessage',{chat_id:g.id,rich_message:this.dayRich(report),_status_banner:'day',...(threadId?{message_thread_id:threadId}:{})});this.q('INSERT INTO report_reposts VALUES (?,?)',id,g.id);}
 privateDay(uid,text){const report=this.dayReport(text.trim().split(/\s+/).slice(1).join(' ')),g=this.config('group'),count=this.pendingCount();if(g)this.queueDayReport(report,g.thread_id);const summary=report+(g?`\n\n🔁 После отчёта в группе «${g.title}» будут повторно отправлены заявки со статусом «Не выполнено»: ${count}.`:'\n\nГруппа сотрудников пока не подключена. Повторная отправка заявок недоступна.');this.enqueue('sendRichMessage',{chat_id:uid,rich_message:this.dayRich(summary),_status_banner:'day'});}
 requestDeletion(uid,text){
  if(!this.isAdmin(uid))return this.send(uid,'Удалять заявки может только администратор бота.');
  const match=/^\/delete(?:@\w+)?\s+(?:GA-)?(\d+)$/i.exec(text.trim());if(!match)return this.send(uid,'🗑 Для удаления заявки отправьте /delete GA-000003 (или /delete 3). Бот покажет заявку и попросит подтвердить удаление.');
  const oid=Number(match[1]),o=numberId(oid)?this.get(oid):null;if(!o)return this.send(uid,'Заявка не найдена или уже удалена.');
  const token=crypto.randomUUID().replaceAll('-','');this.q('DELETE FROM deletion_requests WHERE expires<?',Date.now());this.q('INSERT INTO deletion_requests VALUES (?,?,?,?,?,?)',token,oid,o.version,uid,uid,Date.now()+600000);
  this.send(uid,`🗑 Удалить заявку ${code(oid)}?\nЗаказчик: ${o.data.customer}\nПлёнка: ${o.data.film}\n📐 Площадь: ${areaDisplay(o.data.lines||[])} м²\n\nЗаявка исчезнет из отчётов и повторных отправок. Все её карточки в группе будут удалены или помечены удалёнными.`,[[['🗑 Подтвердить удаление','del:yes:'+token]],[['Отмена','del:no:'+token]]]);
 }
 queueRemoval(oid,chatId,messageId){const id=this.enqueue('deleteMessage',{chat_id:chatId,message_id:messageId});this.q('INSERT INTO removal_outbox VALUES (?,?,?,?)',id,oid,chatId,messageId);}
 deletionCallback(uid,value,m,from){
  if(!this.isAdmin(uid))return this.send(uid,'Удалять заявки может только администратор бота.');
  const match=/^del:(yes|no):([a-f0-9]{32})$/.exec(value),r=match&&this.one('SELECT * FROM deletion_requests WHERE token=?',match[2]);
  if(!r||r.actor!==uid||r.chat_id!==m.chat.id||r.expires<Date.now())return this.send(uid,'Подтверждение удаления устарело. Повторите /delete с номером заявки.');
  this.q('DELETE FROM deletion_requests WHERE token=?',match[2]);
  const respond=text=>this.enqueue('editMessageText',{chat_id:m.chat.id,message_id:m.message_id,text,reply_markup:markup([])});
  if(match[1]==='no')return respond('Удаление отменено.');
  const o=this.get(r.order_id);if(!o)return respond('Заявка уже удалена.');if(o.version!==r.version)return respond('Заявка изменилась. Проверьте её заново командой /delete '+code(o.id)+'.');
  this.rememberUser(from);this.q('INSERT INTO deleted_orders VALUES (?,?,?,?)',o.id,uid,displayName(from),now());
  const cards=this.q('SELECT chat_id,message_id FROM group_cards WHERE order_id=? UNION SELECT chat_id,message_id FROM group_copies WHERE order_id=? UNION SELECT chat_id,message_id FROM status_reactions WHERE order_id=?',o.id,o.id,o.id);
  this.q('UPDATE outbox SET failed=2 WHERE id IN (SELECT outbox_id FROM outbox_meta WHERE order_id=?) OR id IN (SELECT outbox_id FROM reaction_outbox WHERE order_id=?) OR id IN (SELECT outbox_id FROM repost_deliveries WHERE order_id=?)',o.id,o.id,o.id);
  for(const table of ['group_jobs','group_reposts','group_cards','group_copies','status_reactions','reaction_jobs','deletion_requests'])this.q(`DELETE FROM ${table} WHERE order_id=?`,o.id);
  this.q('DELETE FROM orders WHERE id=?',o.id);this.q('DELETE FROM events WHERE order_id=?',o.id);
  for(const card of cards)if(card.chat_id===this.config('group')?.id)this.queueRemoval(o.id,card.chat_id,card.message_id);
  respond(`🗑 Заявка ${code(o.id)} удалена. Исключена из отчётов и повторных отправок.`);
 }
 removedCardText(oid){const r=this.one('SELECT name FROM deleted_orders WHERE order_id=?',oid);return `🗑 Заявка ${code(oid)} удалена администратором${r?.name?' '+r.name:''}.`;}
 bannerKey(o){return this.one("SELECT id FROM events WHERE order_id=? AND action LIKE 'Статус:%' LIMIT 1",o.id)||[2,3].includes(o.status)?([2,3].includes(o.status)?'done':'pending'):null;}
 groupRich(o){const key=this.bannerKey(o),escape=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');return {html:(key?'<img src="tg://photo?id=status"/>':'')+this.groupText(o).split('\n\n').map(p=>'<p>'+escape(p).replaceAll('\n','<br>')+'</p>').join(''),...(key?{media:[{id:'status',media:{type:'photo',media:'attach://banner'}}]}:{}),skip_entity_detection:true};}
 pruneDeliveryMetadata(){for(const table of ['report_reposts','repost_deliveries','removal_outbox','reaction_outbox'])this.q(`DELETE FROM ${table} WHERE outbox_id NOT IN (SELECT id FROM outbox)`);}
 migrateBanners(){
  // Cancel old card deliveries before rebuilding their single-message format.
  this.q('DELETE FROM outbox WHERE id IN (SELECT outbox_id FROM outbox_meta)');this.q('DELETE FROM outbox_meta');
  // Cancel queued standalone stickers; retain their known IDs for cleanup.
  this.q("DELETE FROM outbox WHERE method='sendSticker'");this.pruneDeliveryMetadata();
  const g=this.config('group');if(g){this.q('INSERT OR REPLACE INTO group_jobs SELECT id,?,? FROM orders',g.id,g.thread_id||null);for(const r of this.q('SELECT * FROM status_reactions WHERE chat_id=?',g.id))this.queueReaction(r.order_id,r.chat_id,r.message_id,r.status,r.version);}
 }
 queueGroupCard(o,g,fresh=false){
  // Each copy has exactly one rich message, even with twenty glass positions.
  const cards=fresh?[]:this.q('SELECT message_id FROM group_cards WHERE order_id=? AND chat_id=? AND part=0 UNION SELECT message_id FROM group_copies WHERE order_id=? AND chat_id=? AND part=0',o.id,g.id,o.id,g.id);
  if(!fresh){for(const old of this.q('SELECT message_id FROM group_cards WHERE order_id=? AND chat_id=? AND part>0 UNION SELECT message_id FROM group_copies WHERE order_id=? AND chat_id=? AND part>0',o.id,g.id,o.id,g.id))this.enqueue('deleteMessage',{chat_id:g.id,message_id:old.message_id});this.q('DELETE FROM group_cards WHERE order_id=? AND chat_id=? AND part>0',o.id,g.id);this.q('DELETE FROM group_copies WHERE order_id=? AND chat_id=? AND part>0',o.id,g.id);}
  for(const card of cards.length?cards:[null]){const key=this.bannerKey(o),params={chat_id:g.id,rich_message:this.groupRich(o),...(key?{_status_banner:key}:{}),reply_markup:markup(this.completionButtons(o))};if(card)params.message_id=card.message_id;else if(g.thread_id)params.message_thread_id=g.thread_id;
   const queued=this.enqueue(card?'editMessageText':'sendRichMessage',params);this.q('INSERT INTO outbox_meta VALUES (?,?,?,?)',queued,o.id,g.id,0);if(fresh)this.q('INSERT INTO repost_deliveries VALUES (?,?)',queued,o.id);
  }
 }
 prepareGroupJobs(limit=5){const g=this.config('group');if(!g)return;
  for(const table of ['group_jobs','group_reposts'])for(const job of this.q(`SELECT * FROM ${table} ORDER BY order_id LIMIT ?`,limit)){
   if(job.chat_id===g.id){const o=this.get(job.order_id);if(o&&(table==='group_jobs'||(o.status===0&&this.one("SELECT action FROM events WHERE order_id=? AND action LIKE 'Статус:%' ORDER BY id DESC LIMIT 1",o.id)?.action==='Статус: Не выполнено')))this.queueGroupCard(o,g,table==='group_reposts');}
   this.q(`DELETE FROM ${table} WHERE order_id=?`,job.order_id);
  }
 }
 queueReaction(orderId,chatId,replyTo,status,version){this.q('INSERT OR REPLACE INTO reaction_jobs VALUES (?,?,?,?,?)',orderId,chatId,replyTo,status,version);}
 prepareReactions(limit=5){const g=this.config('group');if(!g)return;for(const job of this.q('SELECT * FROM reaction_jobs ORDER BY order_id LIMIT ?',limit)){
  if(job.chat_id!==g.id){this.q('DELETE FROM reaction_jobs WHERE order_id=?',job.order_id);continue;}
  if(this.one('SELECT r.outbox_id FROM reaction_outbox r JOIN outbox o ON o.id=r.outbox_id WHERE r.order_id=? AND o.failed=0 LIMIT 1',job.order_id))continue;
  const old=this.one('SELECT * FROM status_reactions WHERE order_id=?',job.order_id);
  if(!old){this.q('DELETE FROM reaction_jobs WHERE order_id=?',job.order_id);continue;}
  const id=this.enqueue('deleteMessage',{chat_id:old.chat_id,message_id:old.message_id});this.q('INSERT INTO reaction_outbox VALUES (?,?,?,?,?,?)',id,job.order_id,job.version,job.status,'delete',old.message_id);
 }}
 reactionDelivered(outboxId,result){const meta=this.one('SELECT * FROM reaction_outbox WHERE outbox_id=?',outboxId);if(!meta)return;
  const row=this.one('SELECT params FROM outbox WHERE id=?',outboxId),params=JSON.parse(row.params);
  if(meta.kind==='delete'){this.q('DELETE FROM status_reactions WHERE order_id=? AND message_id=?',meta.order_id,meta.message_id);this.q('DELETE FROM reaction_jobs WHERE order_id=? AND version=?',meta.order_id,meta.version);}

  this.q('DELETE FROM reaction_outbox WHERE outbox_id=?',outboxId);
 }
 delivered(outboxId,result){
  this.reactionDelivered(outboxId,result);const report=this.one('SELECT * FROM report_reposts WHERE outbox_id=?',outboxId);if(report&&result?.message_id&&this.config('group')?.id===report.chat_id)this.repostPending();this.q('DELETE FROM report_reposts WHERE outbox_id=?',outboxId);
  const meta=this.one('SELECT * FROM outbox_meta WHERE outbox_id=?',outboxId);if(meta&&result?.message_id){if(!this.get(meta.order_id)){if(this.one('SELECT order_id FROM deleted_orders WHERE order_id=?',meta.order_id))this.queueRemoval(meta.order_id,meta.chat_id,result.message_id);}else {this.q('INSERT OR REPLACE INTO group_cards VALUES (?,?,?,?)',meta.order_id,meta.chat_id,meta.part,result.message_id);this.q('INSERT OR REPLACE INTO group_copies VALUES (?,?,?,?)',meta.order_id,meta.chat_id,meta.part,result.message_id);}}
  for(const table of ['outbox_meta','removal_outbox','repost_deliveries'])this.q(`DELETE FROM ${table} WHERE outbox_id=?`,outboxId);this.q('DELETE FROM outbox WHERE id=?',outboxId);
 }
 groupHandle(update,access={}){
  const cb=update.callback_query,m=cb?.message||update.message||{},uid=(cb?.from||m.from||{}).id,g=this.config('group');
  if(cb){
   const match=/^(g|r):(\d+):(\d+)(?::([03]))?$/.exec(String(cb.data||''));
   const ack=text=>this.enqueue('answerCallbackQuery',{callback_query_id:cb.id,text,show_alert:!access.groupMember});
   if(!match||g?.id!==m.chat.id||!access.groupMember)return ack('Кнопка доступна только участникам подключенной группы.');
   this.rememberUser(cb.from);
   const oid=Number(match[2]),version=Number(match[3]),state=Number(match[4]);if(!numberId(oid)||!numberId(version))return ack('Некорректная кнопка.');
   const card=this.one('SELECT order_id FROM group_cards WHERE order_id=? AND chat_id=? AND message_id=? UNION SELECT order_id FROM group_copies WHERE order_id=? AND chat_id=? AND message_id=?',oid,m.chat.id,m.message_id,oid,m.chat.id,m.message_id);
   if(!card)return ack('Эта карточка не относится к подключенной группе.');
   const o=this.get(oid);if(!o)return ack('Заявка не найдена.');
   if(o.version!==version){this.notify(oid);return ack('Карточка обновилась. Используйте ее актуальную версию.');}
   if(match[1]==='r'){this.enqueue('editMessageReplyMarkup',{chat_id:m.chat.id,message_id:m.message_id,reply_markup:markup([[['✅ Выполнено',`g:${oid}:${version}:3`],['❌ Не выполнено',`g:${oid}:${version}:0`]]])});return ack('Выберите статус заказа.');}
   if(![0,3].includes(state))return ack('Некорректный статус.');
   if(o.status===state&&this.one("SELECT id FROM events WHERE order_id=? AND action LIKE 'Статус:%' LIMIT 1",oid)){this.queueReaction(oid,m.chat.id,m.message_id,state,version);this.notify(oid);return ack('Этот статус уже установлен.');}
   this.q('UPDATE orders SET status=?,version=version+1,updated=? WHERE id=? AND version=?',state,now(),oid,version);this.event(oid,uid,'Статус: '+completionText(state));this.queueReaction(oid,m.chat.id,m.message_id,state,version+1);this.notify(oid);return ack(completionText(state));
  }
  const command=(m.text||'').trim().split(/\s+/)[0].split('@')[0].toLowerCase();
  if(command==='/day'&&g?.id===m.chat.id&&access.groupMember){try{this.queueDayReport(this.dayReport((m.text||'').trim().split(/\s+/).slice(1).join(' ')),m.message_thread_id||g.thread_id);}catch(error){if(!(error instanceof InputError))throw error;this.send(g.id,error.message);}return;}
  if(command==='/bindgroup'){
   if(!this.isAdmin(uid))return this.send(m.chat.id,'Для подключения нужны права администратора бота GlassArt. Узнайте свой ID командой /id в личном чате с ботом и попросите действующего администратора выполнить /addadmin ID.');
   if(!access.botAdmin)return this.send(m.chat.id,'Назначьте самого бота GlassArt администратором этой группы, затем повторите /bindgroup.');
   if(!access.groupMember)return this.send(m.chat.id,'Отправьте /bindgroup от своего аккаунта участника группы, а не от имени группы или канала.');
   this.bindGroup(m.chat,m.message_thread_id);
  }
 }
 get(oid){const order=this.one('SELECT * FROM orders WHERE id=?',oid);if(order)order.data=JSON.parse(order.data);return order;}
 event(oid,uid,action){this.q('INSERT INTO events(order_id,actor,action,at) VALUES (?,?,?,?)',oid,uid,action,now());}
 save(uid,s){
  const d=s.data;
  if(!d.customer||!d.film||!d.lines.length)throw new InputError('Заполните клиента, пленку и хотя бы один размер.');
  if(!s.editId&&(typeof d.processing!=='boolean'||!d.thickness)){s.returnPreview=true;return this.completeLines(uid,s);}
  const clean={customer:d.customer,film:d.film,lines:d.lines,processing:d.processing,thickness:d.thickness,comment:d.comment||''};
  if(Array.isArray(d.photos)&&d.photos.length)clean.photos=d.photos;
  const data=JSON.stringify(clean),search=['customer','film','comment'].map(k=>d[k]||'').join(' ').toLowerCase();let oid=s.editId;
  if(oid){const changed=this.q('UPDATE orders SET data=?,search_text=?,updated=?,version=version+1 WHERE id=? AND version=? RETURNING id',data,search,now(),oid,s.version);if(!changed.length)return this.send(uid,'Заявка уже изменилась в группе. Черновик сохранен. При необходимости отмените его и отправьте новую заявку.');this.event(oid,uid,'Изменение полей');}
  else {oid=this.one('INSERT INTO orders(token,data,search_text,created,updated,creator,author) VALUES (?,?,?,?,?,?,?) RETURNING id',s.token,data,search,now(),now(),uid,s.author).id;this.event(oid,uid,'Создание');}
  this.clear(uid);this.send(uid,`✅ Заявка ${code(oid)} сохранена. ${this.config('group')?'Поставлена в очередь отправки в группу сотрудников.':'Будет отправлена после подключения группы сотрудников.'}`,[[['＋ Следующая заявка','new']]]);this.notify(oid);
 }
 draftAction(uid,value){
  const [,token,rev,action]=value.split(':'),s=this.session(uid);
  if(!s||s.mode!=='draft'||s.token!==token||String(s.rev)!==rev)return this.send(uid,'Эта кнопка устарела. /resume — текущий черновик.');
  const step=s.step;
  if(action==='cancel'){this.clear(uid);this.send(uid,'Ввод отменен. Сохраненные заявки не изменены.');return this.menu(uid);}
  if(action==='save'&&step==='preview')return this.save(uid,s);
  if(['edit','preview'].includes(action)&&['preview','edit_menu'].includes(step)){s.step=action==='edit'?'edit_menu':'preview';this.put(uid,s);return this.prompt(uid,s);}
  if(action==='field_photos')return this.prompt(uid,s);
  if(action.startsWith('field_')&&step==='edit_menu'&&Object.hasOwn(FIELDS,action.slice(6))){s.step=action.slice(6);s.returnPreview=true;if(s.step==='lines')s.data.lines=[];this.put(uid,s);return this.prompt(uid,s);}
  if(action==='skip'&&step==='comment'){s.data[step]='';return this.next(uid,s);}
  if(['processing_yes','processing_no'].includes(action)&&step==='processing'){s.data.processing=action==='processing_yes';return this.completeLines(uid,s);}
  if(action==='done'&&step==='lines'){if(!s.data.lines.length)throw new InputError('Добавьте хотя бы один размер стекла.');return this.completeLines(uid,s);}
  if(action==='remove'&&step==='lines'){s.data.lines.pop();this.put(uid,s);this.prompt(uid,s);}
 }
 callback(uid,value,author){
  if(/^(?:s:|g:|list:|results:|view:|edit:|status:|history:|photos:)/.test(value)||value==='search')return this.send(uid,'Заявки и статусы находятся в группе сотрудников. В личном чате можно заполнить и отправить новую заявку.');
  if(value.startsWith('d:'))return this.draftAction(uid,value);
  if(value==='menu')return this.menu(uid);
  if(value==='delete_help')return this.requestDeletion(uid,'/delete');
  if(value==='group_help')return this.groupHelp(uid);
  if(value==='manage_admins')return this.adminPanel(uid);
  if(value==='admin_add'||value==='admin_remove'){
   if(!this.isAdmin(uid))return this.send(uid,'Управление администраторами доступно только администраторам.');
   if(this.session(uid)?.mode==='draft')return this.send(uid,'Сначала сохраните или отмените текущий черновик. Для назначения без прерывания черновика используйте /addadmin ID.');
   this.put(uid,{mode:value});return this.send(uid,value==='admin_add'?'Отправьте числовой Telegram ID нового администратора. Его можно узнать командой /id у этого бота. /cancel — отмена.':'Отправьте числовой Telegram ID администратора, с которого нужно снять права. Он останется сотрудником. /cancel — отмена.');
  }
  if(value==='resume'){const s=this.session(uid);return s?.mode==='draft'?this.prompt(uid,s):this.send(uid,'Черновика нет. Создайте новую заявку.');}
  if(value==='new'){
   if(this.session(uid)?.mode==='draft')return this.send(uid,'Сначала отправьте или отмените текущий черновик. /resume — продолжить.');
   return this.start(uid,author);
  }
 }
 input(uid,s,message){
  const text=(message.text||'').trim(),step=s.step;
  if(message.photo?.length)throw new InputError('Добавление фотографий отключено. Продолжите заполнение заявки текстом или кнопками.');
  if(step==='processing')throw new InputError('Выберите «Есть обработка» или «Без обработки» кнопками под вопросом.');
  if(step==='thickness'){
   s.data.thickness=parseThickness(text);return this.completeLines(uid,s);
  }
  if(step==='lines'){
   if(s.data.lines.length>=20)throw new InputError('Добавлено 20 позиций. Нажмите «Готово».');
   const rows=text.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
   if(!rows.length)throw new InputError('Введите размеры стекол, каждую позицию с новой строки.');
   if(s.data.lines.length+rows.length>20)throw new InputError(`В заявке может быть до 20 позиций. Уже добавлено: ${s.data.lines.length}, в сообщении: ${rows.length}.`);
   const batch=rows.map((row,i)=>{try{return parseLine(row);}catch(error){if(error instanceof InputError)throw new InputError(`Строка ${i+1}: ${error.message} Сообщение целиком не добавлено — исправьте и отправьте его заново.`);throw error;}});
   s.data.lines.push(...batch);this.put(uid,s);return this.send(uid,`Добавлено позиций: ${batch.length}. Всего позиций: ${s.data.lines.length}. Площадь: ${areaDisplay(s.data.lines)} м².\nОтправьте следующие размеры или нажмите «Готово».`,this.drows(s,[[['Готово','done'],['Убрать последнее','remove']]]));
  }
  if(Object.hasOwn(FIELDS,step)){
   const limit={customer:150,film:150,comment:500}[step];
   if(!text||text.length>limit)throw new InputError(`Введите текст от 1 до ${limit} символов.`);
   s.data[step]=text;return this.next(uid,s);
  }
  this.send(uid,'Используйте кнопки под карточкой. /resume — показать их снова.');
 }
 staff(uid,command,text){
  if(!this.isAdmin(uid))return this.send(uid,'Управление доступом доступно администратору.');
  if(command==='/admins')return this.adminPanel(uid);
  if(command==='/staff')return this.send(uid,`Администраторы: ${this.adminIds().join(', ')}\nСотрудники: ${this.q('SELECT id FROM staff WHERE id NOT IN (SELECT id FROM admins) ORDER BY id').map(x=>x.id).join(', ')||'не добавлены'}`);
  const parts=text.split(/\s+/),target=Number(parts[1]);if(parts.length!==2||!numberId(target))throw new InputError(`Пример: ${command} 123456789`);
  if(command==='/addadmin'){
   this.q('INSERT OR IGNORE INTO admins VALUES (?,?,?)',target,now(),uid);
   this.q('INSERT OR IGNORE INTO staff VALUES (?,?)',target,now());
   if(this.session(uid)?.mode==='admin_add')this.clear(uid);
   return this.send(uid,`✅ ID ${target} назначен администратором. Он может открыть /menu и управлять сотрудниками и администраторами.`);
  }
  if(command==='/removeadmin'){
   if(!this.isAdmin(target))throw new InputError('У этого пользователя нет прав администратора.');
   if(this.adminIds().length<=1)throw new InputError('Нельзя снять права последнего администратора. Сначала назначьте другого.');
   this.q('INSERT OR IGNORE INTO staff VALUES (?,?)',target,now());
   this.q('DELETE FROM admins WHERE id=?',target);
   if(this.session(uid)?.mode==='admin_remove')this.clear(uid);
   return this.send(uid,`Права администратора у ID ${target} сняты. Доступ сотрудника сохранен. Для полного закрытия доступа используйте /revoke ${target}.`);
  }
  if(this.isAdmin(target)){if(command==='/allow')return this.send(uid,'У этого пользователя уже есть доступ администратора.');throw new InputError('Сначала снимите права администратора командой /removeadmin ID.');}
  if(command==='/allow'){this.q('INSERT OR IGNORE INTO staff VALUES (?,?)',target,now());this.send(uid,`Доступ для ID ${target} открыт. Сотрудник может нажать /start.`);}
  else{this.q('DELETE FROM staff WHERE id=?',target);this.clear(target);this.q('DELETE FROM outbox WHERE recipient=?',target);this.send(uid,`Доступ для ID ${target} закрыт.`);}
 }
 handle(update,access={}){
  const id=update.update_id;if(!Number.isSafeInteger(id)||id<0)throw new InputError('Некорректное обновление.');
  if(this.one('SELECT id FROM processed WHERE id=?',id))return;
  const cb=update.callback_query,m=cb?.message||update.message||{},from=cb?.from||m.from||{},uid=from.id;
  if(['group','supergroup'].includes(m.chat?.type)&&numberId(uid))this.groupHandle(update,access);
  if(numberId(uid)&&m.chat?.type==='private'&&m.chat.id===uid){
   const text=cb?'':(m.text||'').trim(),command=text.startsWith('/')?text.split(/\s+/)[0].split('@')[0].toLowerCase():'',author=[from.first_name,from.last_name].filter(Boolean).join(' ').slice(0,150)||String(uid);
   if(cb)this.enqueue('answerCallbackQuery',{callback_query_id:cb.id});
   const claim=/^\/start(?:@\w+)? claim_([a-f0-9]{32})$/.exec(text);
   const expectedClaim=this.config('claim');
   if(claim&&!this.config('owner')&&typeof expectedClaim==='string'&&expectedClaim.length===32&&timingSafeEqual(new TextEncoder().encode(claim[1]),new TextEncoder().encode(expectedClaim))){this.setConfig('owner',uid);this.ensureAdmins();this.setConfig('claim',null);this.send(uid,'✅ Вы — администратор GlassArt. Бот подключен и готов принимать заявки.');this.menu(uid);this.send(uid,'Чтобы назначить сотрудника: пусть он откроет этого бота и отправит /id. Затем введите здесь /allow ID.\n/staff — список, /revoke ID — отозвать доступ.\n/addadmin ID — назначить администратора, /admins — управление администраторами.');}
   else if(command==='/id')this.send(uid,`Ваш Telegram ID: ${uid}. Передайте его администратору GlassArt.`);
   else if(!this.allowed(uid))this.send(uid,`Бот GlassArt доступен только сотрудникам. Ваш ID: ${uid}. Передайте его администратору.`);
   else try{
    if(cb&&String(cb.data||'').startsWith('del:'))this.deletionCallback(uid,String(cb.data),m,from);
    else if(cb)this.callback(uid,String(cb.data||''),author);
    else if(['/start','/menu','/help'].includes(command)){this.menu(uid);if(this.isAdmin(uid))this.send(uid,'Администратор: /allow ID — добавить отправителя; /revoke ID — убрать; /staff — список.\n/addadmin ID — назначить администратора; /removeadmin ID — снять права; /admins — управление; /group — подключение группы; /delete GA-000003 — удалить заявку.');}
    else if(command==='/group')this.groupHelp(uid);
    else if(command==='/day')this.privateDay(uid,text);
    else if(command==='/delete')this.requestDeletion(uid,text);
    else if(['/allow','/revoke','/staff','/addadmin','/removeadmin','/admins'].includes(command))this.staff(uid,command,text);
    else if(command==='/cancel'){this.clear(uid);this.send(uid,'Ввод отменен. Сохраненные заявки не изменены.');this.menu(uid);}
    else if(['/new','/resume','/search','/list'].includes(command))this.callback(uid,{'/new':'new','/resume':'resume','/search':'search','/list':'list:0'}[command],author);
    else if(command)this.send(uid,'Команда не найдена. /menu — главное меню.');
    else{const s=this.session(uid);if(s?.mode==='draft'){if(s.migrated){this.send(uid,'Форма заявки обновлена. Продолжите с текущего вопроса ниже.');this.prompt(uid,s);}else this.input(uid,s,m);}else if(s?.mode==='admin_add'||s?.mode==='admin_remove')this.staff(uid,s.mode==='admin_add'?'/addadmin':'/removeadmin',`${s.mode==='admin_add'?'/addadmin':'/removeadmin'} ${text}`);else {if(s?.mode==='search'||s?.mode==='results')this.clear(uid);this.menu(uid);}}
   }catch(e){if(e instanceof InputError)this.send(uid,e.message);else throw e;}
  }
  this.q('INSERT INTO processed VALUES (?,?)',id,Date.now());
  if(id%100===0)this.q('DELETE FROM processed WHERE at<?',Date.now()-14*86400000);
 }
}
