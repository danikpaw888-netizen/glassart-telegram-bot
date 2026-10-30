import { DurableObject } from 'cloudflare:workers';
import { timingSafeEqual } from 'node:crypto';
import { Engine, InputError } from './core.mjs';
import { setupPage } from './setup.mjs';
import { STATUS_BANNERS } from './banners.mjs';

const MAX_BODY=131072;
const encoder=new TextEncoder();
const COMMANDS=[['day','Итоги дня и повтор невыполненных заявок'],['delete','Удалить заявку по номеру (администратор)'],['menu','Главное меню'],['new','Отправить новую заявку'],['resume','Продолжить черновик'],['cancel','Отменить ввод'],['id','Мой Telegram ID'],['group','Группа сотрудников'],['admins','Администраторы']].map(([command,description])=>({command,description}));
export function safeEqual(a,b){if(typeof a!=='string'||typeof b!=='string')return false;const x=encoder.encode(a),y=encoder.encode(b);return x.length===y.length&&x.length>0&&timingSafeEqual(x,y);}
export class ApiError extends Error{constructor(code,retry=0,description=''){super('Telegram API error');this.code=code;this.retry=retry;this.notModified=/message is not modified/i.test(description);this.messageMissing=/message to edit not found/i.test(description);this.deleteMissing=/message to delete not found/i.test(description);}}
export async function boundedJSON(request,max=MAX_BODY){
 if(Number(request.headers.get('content-length')||0)>max)throw new InputError('Слишком большой запрос.');
 if(!request.body)throw new InputError('Пустой запрос.');
 const reader=request.body.getReader(),parts=[];let length=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>max){await reader.cancel();throw new InputError('Слишком большой запрос.');}parts.push(value);}}finally{reader.releaseLock();}
 const merged=new Uint8Array(length);let offset=0;for(const part of parts){merged.set(part,offset);offset+=part.length;}
 try{return JSON.parse(new TextDecoder().decode(merged));}catch{throw new InputError('Некорректный JSON.');}
}
export async function telegram(token,method,params={}){
 let result;
 try{let body,headers;
  if(params._status_banner){const key=params._status_banner,data=STATUS_BANNERS[key];if(!data||!params.rich_message)throw new Error('Banner asset unavailable');body=new FormData();for(const [k,v]of Object.entries(params))if(k!=='_status_banner')body.set(k,typeof v==='object'?JSON.stringify(v):String(v));body.set('banner',new Blob([Uint8Array.from(atob(data),c=>c.charCodeAt(0))],{type:'image/jpeg'}),key+'.jpg');}
  else {body=JSON.stringify(params);headers={'Content-Type':'application/json'};}
  const response=await fetch(`https://api.telegram.org/bot${token}/${method}`,{method:'POST',...(headers?{headers}:{}),body,signal:AbortSignal.timeout(8000)});result=await boundedJSON(response,65536);if(!result.ok)throw new ApiError(result.error_code||response.status,result.parameters?.retry_after||0,result.description||'');}
 catch(error){if(error instanceof ApiError)throw error;throw new ApiError(0);}
 return result.result;
}
const json=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}});

// One coordination object per company register. Sessions and orders are SQL rows,
// not one large JSON value. Telegram updates and outbox writes commit atomically.
export class GlassArtRegister extends DurableObject {
 constructor(ctx,env){super(ctx,env);this.engine=new Engine(ctx.storage.sql);this.flushing=null;this.installing=null;if(this.engine.config('token')&&this.engine.config('commands_version')!==7){ctx.storage.transactionSync(()=>{this.engine.enqueue('setMyCommands',{commands:COMMANDS});this.engine.setConfig('commands_version',7);});ctx.waitUntil(this.ensureAlarm());}if(this.engine.config('group')&&this.engine.config('card_style')!==7){ctx.storage.transactionSync(()=>{this.engine.migrateBanners();this.engine.setConfig('card_style',7);});ctx.waitUntil(this.ensureAlarm());}}
 async ensureAlarm(){if(await this.ctx.storage.getAlarm()===null)await this.ctx.storage.setAlarm(Date.now()+1000);}
 async state(){
  const e=this.engine,username=e.config('username'),claim=e.config('claim'),ready=e.config('ready');
  return {version:'3.6.2',configured:!!e.config('token'),active:!!e.config('owner'),username:username||null,group:e.config('group'),
   delivery:{queued:e.one('SELECT COUNT(*) AS n FROM outbox WHERE failed=0').n,failed:e.one('SELECT COUNT(*) AS n FROM outbox WHERE failed=1').n,refreshing:e.one('SELECT COUNT(*) AS n FROM group_jobs').n,legacy_stickers:e.one('SELECT COUNT(*) AS n FROM status_reactions').n},
   claim_url:ready&&claim?`https://t.me/${username}?start=claim_${claim}`:null};
 }
 async install(token,origin){
  if(this.installing)return {error:'Подключение уже выполняется. Подождите несколько секунд.',status:409};
  const work=this.doInstall(token,origin);this.installing=work;try{return await work;}finally{this.installing=null;}
 }
 async doInstall(token,origin){
  const e=this.engine,old=e.config('token');
  if(old&&!safeEqual(old,token))return {error:'К этому серверу уже подключен другой бот. Замена заблокирована.',status:409};
  if(e.config('owner'))return this.state();
  try{
   const me=await telegram(token,'getMe');
   if(!me.is_bot||!me.username)return {error:'Токен не относится к Telegram-боту.',status:400};
   const webhook=await telegram(token,'getWebhookInfo'),url=origin+'/telegram/webhook';
   if(webhook.url&&webhook.url!==url)return {error:'Этот бот уже подключен к другому серверу. Его подключение не изменено. Используйте отдельного бота GlassArt.',status:409};
   this.ctx.storage.transactionSync(()=>{e.setConfig('token',token);e.setConfig('username',me.username);if(!e.config('claim')&&!e.config('owner'))e.setConfig('claim',crypto.randomUUID().replaceAll('-',''));});
   await telegram(token,'setWebhook',{url,secret_token:this.env.WEBHOOK_SECRET,max_connections:1,allowed_updates:['message','callback_query'],drop_pending_updates:false});
   const info=await telegram(token,'getWebhookInfo');if(info.url!==url)throw new ApiError(0);
   e.setConfig('ready',true);
   await telegram(token,'setMyCommands',{commands:COMMANDS});e.setConfig('commands_version',7);
   return this.state();
  }catch(error){if(!(error instanceof ApiError))throw error;return {error:error.code===401?'Telegram не принял токен. Проверьте его в BotFather.':`Telegram временно недоступен (код ${error.code}). Повторите подключение тем же токеном.`,status:502};}
 }
 async receive(update){
  if(!this.engine.config('token'))return false;
  const cb=update.callback_query,m=cb?.message||update.message||{},uid=(cb?.from||m.from||{}).id,access={};
  if(['group','supergroup'].includes(m.chat?.type)){
   const command=(m.text||'').trim().split(/\s+/)[0].split('@')[0].toLowerCase(),token=this.engine.config('token');
   try{
    if(command==='/bindgroup'&&this.engine.isAdmin(uid)){
     const me=await telegram(token,'getMe'),bot=await telegram(token,'getChatMember',{chat_id:m.chat.id,user_id:me.id});
     access.botAdmin=['creator','administrator'].includes(bot.status);
     if(access.botAdmin){const actor=await telegram(token,'getChatMember',{chat_id:m.chat.id,user_id:uid});access.groupMember=['creator','administrator','member'].includes(actor.status)||(actor.status==='restricted'&&actor.is_member===true);}
    }else if((cb||command==='/day')&&this.engine.config('group')?.id===m.chat.id){const member=await telegram(token,'getChatMember',{chat_id:m.chat.id,user_id:uid});access.groupMember=['creator','administrator','member'].includes(member.status)||(member.status==='restricted'&&member.is_member===true);}
   }catch(error){if(!(error instanceof ApiError)||error.code===0||error.code===429||error.code>=500)throw error;}
  }
  // Persist a recovery alarm before acknowledging the incoming Telegram update.
  if(await this.ctx.storage.getAlarm()===null)await this.ctx.storage.setAlarm(Date.now()+1000);
  this.ctx.storage.transactionSync(()=>this.engine.handle(update,access));
  this.ctx.waitUntil(this.flush());return true;
 }
 async flush(){if(this.flushing)return this.flushing;const work=this.deliver();this.flushing=work;try{await work;}finally{this.flushing=null;}}
 async alarm(){await this.flush();}
 async hydrateNames(){const e=this.engine,g=e.config('group');if(!g)return;const actors=e.q("SELECT DISTINCT ev.actor FROM group_jobs j JOIN events ev ON ev.id=(SELECT MAX(id) FROM events WHERE order_id=j.order_id AND action LIKE 'Статус:%') LEFT JOIN user_names u ON u.id=ev.actor WHERE u.id IS NULL LIMIT 5");for(const actor of actors){try{const member=await telegram(e.config('token'),'getChatMember',{chat_id:g.id,user_id:actor.actor});e.rememberUser(member.user);}catch(error){if(!(error instanceof ApiError))throw error;}}}
 async deliver(){
  const e=this.engine,token=e.config('token');if(!token)return;
  const next=e.config('next_delivery')||0;if(next>Date.now()){await this.ctx.storage.setAlarm(next);return;}
  // A watchdog ensures a hard termination cannot strand already committed work.
  await this.ctx.storage.setAlarm(Date.now()+60000);
  const start=Date.now();let delay=0;
  for(let count=0;count<20&&Date.now()-start<15000;count++){
   await this.hydrateNames();
   this.ctx.storage.transactionSync(()=>e.prepareGroupJobs());
   this.ctx.storage.transactionSync(()=>e.prepareReactions());
   const row=e.one('SELECT * FROM outbox WHERE failed=0 ORDER BY id LIMIT 1');if(!row)break;
   if(row.method==='sendPhoto'){e.q('DELETE FROM outbox WHERE id=?',row.id);continue;}
   // Access may have been revoked after this message was queued.
   if(row.recipient<0&&row.recipient!==e.config('group')?.id){const params=JSON.parse(row.params);if(!/^(Для подключения нужны|Назначьте самого бота|Отправьте \/bindgroup)/.test(params.text||'')){e.delivered(row.id,null);continue;}}
   if(row.recipient>0&&!e.allowed(row.recipient)){
    const params=JSON.parse(row.params);
    // Public /id and denial responses contain no company data.
    if(!params.text?.startsWith('Ваш Telegram ID:')&&!params.text?.startsWith('Бот GlassArt доступен')){e.q('DELETE FROM outbox WHERE id=?',row.id);continue;}
   }
   const card=e.one('SELECT * FROM outbox_meta WHERE outbox_id=?',row.id);if(card&&!e.get(card.order_id)){e.delivered(row.id,null);continue;}
   const repost=e.one('SELECT * FROM repost_deliveries WHERE outbox_id=?',row.id);if(repost){const o=e.get(repost.order_id);if(!o||o.status!==0||e.one("SELECT action FROM events WHERE order_id=? AND action LIKE 'Статус:%' ORDER BY id DESC LIMIT 1",repost.order_id)?.action!=='Статус: Не выполнено'){e.delivered(row.id,null);continue;}}
   const removal=e.one('SELECT * FROM removal_outbox WHERE outbox_id=?',row.id);
   const reaction=e.one('SELECT * FROM reaction_outbox WHERE outbox_id=?',row.id);
   if(reaction?.kind==='send'&&e.get(reaction.order_id)?.version!==reaction.version){e.delivered(row.id,null);continue;}
   try{const params=JSON.parse(row.params);
    const result=await telegram(token,row.method,params);this.ctx.storage.transactionSync(()=>e.delivered(row.id,result));}
   catch(error){
    if(!(error instanceof ApiError))throw error;
    if(error.deleteMissing&&row.method==='deleteMessage'){e.delivered(row.id,true);continue;}
    if(error.notModified){e.delivered(row.id,null);continue;}
    if(error.messageMissing&&row.method==='editMessageText'){const meta=e.one('SELECT * FROM outbox_meta WHERE outbox_id=?',row.id);if(meta){const messageId=JSON.parse(row.params).message_id;e.q('DELETE FROM group_cards WHERE chat_id=? AND message_id=?',meta.chat_id,messageId);e.q('DELETE FROM group_copies WHERE chat_id=? AND message_id=?',meta.chat_id,messageId);e.notify(meta.order_id);}e.delivered(row.id,null);continue;}
    if(error.code===0||error.code===429||error.code>=500){delay=Math.max(error.retry*1000,3000);e.setConfig('next_delivery',Date.now()+delay);break;}
    if(removal&&row.method==='deleteMessage'){this.ctx.storage.transactionSync(()=>{e.enqueue('editMessageText',{chat_id:removal.chat_id,message_id:removal.message_id,text:e.removedCardText(removal.order_id),reply_markup:{inline_keyboard:[]}});e.delivered(row.id,null);});continue;}
    if(reaction){const job=e.one('SELECT * FROM reaction_jobs WHERE order_id=?',reaction.order_id);if(reaction.kind==='delete'&&job&&e.config('group')?.id===job.chat_id)e.enqueue('sendMessage',{chat_id:job.chat_id,text:'Заявка обновлена одним сообщением с баннером. Старый отдельный стикер не удалось удалить автоматически — его можно удалить вручную.',reply_parameters:{message_id:job.reply_to,allow_sending_without_reply:true}});e.q('DELETE FROM reaction_jobs WHERE order_id=? AND version=?',reaction.order_id,reaction.version);e.q('DELETE FROM reaction_outbox WHERE outbox_id=?',row.id);}
    e.q('DELETE FROM report_reposts WHERE outbox_id=?',row.id);
    e.q('UPDATE outbox SET failed=1 WHERE id=?',row.id);
    console.warn(JSON.stringify({event:'telegram_delivery_failed',outbox_id:row.id,code:error.code}));
   }
  }
  if(e.one('SELECT id FROM outbox WHERE failed=0 LIMIT 1')||e.one('SELECT order_id FROM group_jobs LIMIT 1')||e.one('SELECT order_id FROM group_reposts LIMIT 1')||e.one('SELECT order_id FROM reaction_jobs LIMIT 1'))await this.ctx.storage.setAlarm(Date.now()+(delay||1000));
  else await this.ctx.storage.deleteAlarm();
 }
}

export default {
 async fetch(request,env){
  const url=new URL(request.url),path=url.pathname;
  try{
   if(request.method==='GET'&&path==='/health')return json({service:'GlassArt Telegram Bot',status:'ok',version:'3.6.2'});
   if(request.method==='GET'&&(path==='/'||path==='/setup')){
    const nonce=crypto.randomUUID().replaceAll('-','');
    return new Response(setupPage(nonce),{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Content-Security-Policy':`default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`}});
   }
   if(path==='/api/status'||path==='/api/setup'){
    if(!safeEqual(request.headers.get('X-Setup-Key'),env.SETUP_KEY))return json({error:'Нужна персональная ссылка настройки из чата.'},403);
    const register=env.REGISTERS.getByName('company:glassart');
    if(path==='/api/status'&&request.method==='GET')return json(await register.state());
    if(path==='/api/setup'&&request.method==='POST'){
     const data=await boundedJSON(request,2048);
     if(!data||typeof data.token!=='string'||!/^\d+:[A-Za-z0-9_-]{20,}$/.test(data.token))return json({error:'Вставьте полный токен, выданный BotFather.'},400);
     const result=await register.install(data.token,url.origin);return json(result,result.status||200);
    }
    return json({error:'Метод не поддерживается.'},405);
   }
   if(path==='/telegram/webhook'&&request.method==='POST'){
    if(!safeEqual(request.headers.get('X-Telegram-Bot-Api-Secret-Token'),env.WEBHOOK_SECRET))return json({error:'Forbidden'},403);
    const update=await boundedJSON(request);
    if(!update||!Number.isSafeInteger(update.update_id)||update.update_id<0)return json({error:'Invalid update'},400);
    const accepted=await env.REGISTERS.getByName('company:glassart').receive(update);
    return json({ok:accepted},accepted?200:503);
   }
   return json({error:'Not found'},404);
  }catch(error){if(error instanceof InputError)return json({error:error.message},400);console.error(JSON.stringify({event:'request_failed',path}));return json({error:'Временная ошибка сервера. Повторите попытку.'},500);}
 }
};
