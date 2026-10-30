// Exercise the actual Worker and Durable Object against SQLite and a fake Telegram API.
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import assert from 'node:assert/strict';
registerHooks({resolve(specifier,context,next){if(specifier==='cloudflare:workers')return {url:'data:text/javascript,'+encodeURIComponent('export class DurableObject { constructor(ctx,env){this.ctx=ctx;this.env=env;} }'),shortCircuit:true};return next(specifier,context);}});
const {default:worker,GlassArtRegister,boundedJSON,safeEqual,telegram}=await import('./worker.mjs');

function fixture(){
 const db=new DatabaseSync(':memory:');let alarm=null;const waits=[];
 const ctx={storage:{sql:{exec(query,...args){const stmt=db.prepare(query);if(stmt.columns().length){const rows=stmt.all(...args);return {toArray:()=>rows};}stmt.run(...args);return {toArray:()=>[]};}},
  transactionSync(fn){db.exec('BEGIN');try{const result=fn();db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}},async getAlarm(){return alarm},async setAlarm(value){alarm=value},async deleteAlarm(){alarm=null}},waitUntil(promise){waits.push(promise)}};
 const env={SETUP_KEY:'a'.repeat(64),WEBHOOK_SECRET:'b'.repeat(64)};
 const register=new GlassArtRegister(ctx,env);env.REGISTERS={getByName(name){assert.equal(name,'company:glassart');return register;}};
 return {env,register,ctx,waits,getAlarm:()=>alarm};
}
test('constant-time secret matcher and bounded request reader',async()=>{
 assert.equal(safeEqual('aaa','aaa'),true);for(const value of ['aab','',null])assert.equal(safeEqual(value,'aaa'),false);
 assert.deepEqual(await boundedJSON(new Request('https://x',{method:'POST',body:'{"a":1}'}),20),{a:1});
 await assert.rejects(()=>boundedJSON(new Request('https://x',{method:'POST',body:'x'.repeat(50)}),20));
});
test('public endpoints do not expose configuration or accept forged webhooks',async()=>{
 const f=fixture();
 let response=await worker.fetch(new Request('https://example/health'),f.env);assert.equal(response.status,200);
 response=await worker.fetch(new Request('https://example/api/status'),f.env);assert.equal(response.status,403);
 response=await worker.fetch(new Request('https://example/telegram/webhook',{method:'POST',body:'{"update_id":1}'}),f.env);assert.equal(response.status,403);
 response=await worker.fetch(new Request('https://example/api/status',{headers:{'X-Setup-Key':f.env.SETUP_KEY}}),f.env);assert.equal(response.status,200);assert.equal((await response.json()).configured,false);
 response=await worker.fetch(new Request('https://example/setup'),f.env);assert.ok(response.headers.get('Content-Security-Policy').includes("frame-ancestors 'none'"));const page=await response.text();assert.ok(!page.includes(f.env.SETUP_KEY));
});
test('activation installs webhook, owner claims once, messages deliver and token stays private',async()=>{
 const f=fixture(),realFetch=globalThis.fetch,requests=[];let webhook='';
 globalThis.fetch=async (url,options)=>{const method=url.split('/').at(-1),params=options.body instanceof FormData?Object.fromEntries(options.body):JSON.parse(options.body);requests.push({method,params});let result=true;if(method==='getMe')result={id:123,is_bot:true,username:'glassart_example_bot'};if(method==='getWebhookInfo')result={url:webhook};if(method==='setWebhook')webhook=params.url;return Response.json({ok:true,result});};
 try{
  const token='123456:'+'C'.repeat(35),request=new Request('https://glassart.example/api/setup',{method:'POST',headers:{'X-Setup-Key':f.env.SETUP_KEY,'Content-Type':'application/json'},body:JSON.stringify({token})});
  let response=await worker.fetch(request,f.env),state=await response.json();assert.equal(response.status,200);assert.equal(state.configured,true);assert.match(state.claim_url,/claim_[a-f0-9]{32}/);assert.ok(!JSON.stringify(state).includes(token));assert.equal(webhook,'https://glassart.example/telegram/webhook');assert.equal(requests.find(x=>x.method==='setWebhook').params.secret_token,f.env.WEBHOOK_SECRET);
  const claim=new URL(state.claim_url).searchParams.get('start');const update={update_id:1,message:{from:{id:100,first_name:'Владелец'},chat:{id:100,type:'private'},text:'/start '+claim}};
  response=await worker.fetch(new Request('https://glassart.example/telegram/webhook',{method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':f.env.WEBHOOK_SECRET},body:JSON.stringify(update)}),f.env);assert.equal(response.status,200);await Promise.all(f.waits);state=await f.register.state();assert.equal(state.active,true);assert.equal(state.claim_url,null);assert.ok(requests.some(x=>x.method==='sendMessage'&&x.params.text.includes('администратор GlassArt')));assert.equal(f.register.engine.q('SELECT * FROM outbox').length,0);
  const count=requests.length;await f.register.receive(update);await Promise.all(f.waits);assert.equal(requests.length,count);
  const different=await f.register.install('444444:'+'D'.repeat(35),'https://glassart.example');assert.equal(different.status,409);
 }finally{globalThis.fetch=realFetch;}
});
test('existing external webhook is preserved',async()=>{
 const f=fixture(),realFetch=globalThis.fetch;globalThis.fetch=async url=>Response.json({ok:true,result:url.endsWith('getMe')?{is_bot:true,username:'existing_bot'}:{url:'https://other.example/webhook'}});
 try{const result=await f.register.install('123456:'+'C'.repeat(35),'https://glassart.example');assert.equal(result.status,409);assert.equal(f.register.engine.config('token'),null);}finally{globalThis.fetch=realFetch;}
});
test('rate limits preserve outbox and future alarm, revoked staff get no queued business card',async()=>{
 const f=fixture(),realFetch=globalThis.fetch;f.register.engine.setConfig('owner',100);f.register.engine.setConfig('token','test-token');f.register.engine.send(100,'Тест');let calls=0;
 globalThis.fetch=async()=>{calls++;return Response.json({ok:false,error_code:429,parameters:{retry_after:60}},{status:429});};
 try{await f.register.flush();assert.equal(f.register.engine.q('SELECT id FROM outbox').length,1);assert.ok(f.getAlarm()>Date.now()+50000);await f.register.flush();assert.equal(calls,1);}finally{globalThis.fetch=realFetch;}
 f.register.engine.setConfig('next_delivery',0);f.register.engine.q('DELETE FROM outbox');f.register.engine.send(200,'Секретная заявка');globalThis.fetch=async()=>{throw Error('must not send')};
 try{await f.register.flush();assert.equal(f.register.engine.q('SELECT id FROM outbox').length,0);}finally{globalThis.fetch=realFetch;}
});
test('live API membership checks bind a group, publish backlog and edit the same card',async()=>{
 const f=fixture(),e=f.register.engine,realFetch=globalThis.fetch,requests=[];let messageId=2000,member='left';e.setConfig('owner',100);e.setConfig('token','test-token');
 const data={customer:'Клиент',film:'Матовая',lines:[{width:'1000',height:'1000',count:1,processing:false,thickness:'4'}],comment:''};e.q('INSERT INTO orders(token,data,search_text,created,updated,creator,author) VALUES (?,?,?,?,?,?,?)','token',JSON.stringify(data),'клиент',new Date().toISOString(),new Date().toISOString(),100,'Анна');
 globalThis.fetch=async(url,options)=>{const method=url.split('/').at(-1),params=options.body instanceof FormData?Object.fromEntries(options.body):JSON.parse(options.body);requests.push({method,params});let result=true;if(method==='getMe')result={id:123,is_bot:true,username:'glassart_bot'};if(method==='getChatMember')result={status:params.user_id===500?member:params.user_id===100?'member':'administrator'};if(['sendMessage','sendRichMessage','editMessageText'].includes(method))result={message_id:Number(params.message_id)||++messageId,sticker:method==='sendSticker'?{file_id:'cached-sticker'}:undefined};return Response.json({ok:true,result});};
 try{
  await f.register.receive({update_id:1,message:{from:{id:100},chat:{id:-1001,type:'supergroup',title:'Сотрудники'},text:'/bindgroup'}});await Promise.all(f.waits);assert.equal(e.config('group').id,-1001);const card=e.one('SELECT * FROM group_cards WHERE order_id=1');assert.ok(card);assert.ok(requests.some(x=>x.method==='sendRichMessage'&&x.params.chat_id===-1001&&x.params.rich_message.html.includes('📋 Заявка GA-')));
  const callback={from:{id:500},message:{message_id:card.message_id,chat:{id:-1001,type:'supergroup'}},data:'g:1:1:3'};
  await f.register.receive({update_id:2,callback_query:{id:'2',...callback}});await Promise.all(f.waits);assert.equal(e.get(1).status,0);
  member='member';await f.register.receive({update_id:3,callback_query:{id:'3',...callback}});await Promise.all(f.waits);assert.equal(e.get(1).status,3);const edit=requests.find(x=>x.method==='editMessageText');assert.equal(Number(edit.params.message_id),card.message_id);assert.match(JSON.parse(edit.params.rich_message).html,/Статус: Выполнено/);assert.equal(e.allowed(500),false);
 }finally{globalThis.fetch=realFetch;}
});
test('unchanged Telegram edits are acknowledged and deleted group messages are restored',async()=>{
 const f=fixture(),e=f.register.engine,realFetch=globalThis.fetch;let missing=false;e.setConfig('owner',100);e.setConfig('token','test-token');e.setConfig('group',{id:-1001,title:'Сотрудники'});e.q('INSERT INTO orders(token,data,search_text,created,updated,creator,author) VALUES (?,?,?,?,?,?,?)','token',JSON.stringify({customer:'Клиент',film:'Пленка',lines:[],comment:''}),'',new Date().toISOString(),new Date().toISOString(),100,'Анна');e.q('INSERT INTO group_cards VALUES (?,?,?,?)',1,-1001,0,2000);e.notify(1);
 globalThis.fetch=async(url,options)=>{const method=url.split('/').at(-1);if(method==='editMessageText')return Response.json({ok:false,error_code:400,description:missing?'Bad Request: message to edit not found':'Bad Request: message is not modified'},{status:400});return Response.json({ok:true,result:{message_id:3000}});};
 try{await f.register.flush();assert.equal(e.q('SELECT id FROM outbox').length,0);missing=true;e.notify(1);await f.register.flush();assert.equal(e.one('SELECT message_id FROM group_cards WHERE order_id=1').message_id,3000);assert.equal(e.q('SELECT id FROM outbox').length,0);}finally{globalThis.fetch=realFetch;}
});
test('old status author IDs are resolved to Telegram names before refreshing cards',async()=>{
 const f=fixture(),e=f.register.engine,realFetch=globalThis.fetch;e.setConfig('owner',100);e.setConfig('token','test-token');e.setConfig('group',{id:-1001,title:'Цех'});e.q('INSERT INTO orders(token,data,search_text,created,updated,creator,author) VALUES (?,?,?,?,?,?,?)','old',JSON.stringify({customer:'Клиент',film:'Пленка',lines:[],comment:''}),'',new Date().toISOString(),new Date().toISOString(),100,'Анна');e.event(1,500,'Статус: Выполнено');e.notify(1);
 globalThis.fetch=async url=>Response.json({ok:true,result:url.endsWith('getChatMember')?{user:{id:500,first_name:'Руслан',last_name:'Иванов'},status:'member'}:{message_id:3000}});
 try{await f.register.flush();assert.match(e.groupText(e.get(1)),/Отметил: Руслан Иванов/);assert.doesNotMatch(e.groupText(e.get(1)),/Отметил: ID/);}finally{globalThis.fetch=realFetch;}
});
test('single rich card uploads JPEG banner and full text in one API call',async()=>{
 const f=fixture(),e=f.register.engine,realFetch=globalThis.fetch;let calls=0;const o={id:1,status:3,data:{customer:'<Клиент>',film:'Матовая',lines:[]},author:'Анна',created:new Date().toISOString()};
 globalThis.fetch=async(url,options)=>{calls++;assert.ok(/sendRichMessage|editMessageText/.test(url));assert.ok(options.body instanceof FormData);const file=options.body.get('banner');assert.equal(file.type,'image/jpeg');assert.ok(file.size>1000&&file.size<1024*1024);assert.equal(options.body.has('_status_banner'),false);const rich=JSON.parse(options.body.get('rich_message'));assert.equal(rich.media[0].media.media,'attach://banner');assert.match(rich.html,/&lt;Клиент&gt;/);assert.equal(options.body.has('text'),false);return Response.json({ok:true,result:{message_id:4000}});};
 try{for(const method of ['sendRichMessage','editMessageText'])await telegram('test-token',method,{chat_id:-1001,_status_banner:'done',rich_message:e.groupRich(o)});assert.equal(calls,2);}finally{globalThis.fetch=realFetch;}
});
test('Telegram says legacy sticker is already absent: cleanup completes without a new message',async()=>{
 const f=fixture(),e=f.register.engine,realFetch=globalThis.fetch;e.setConfig('owner',100);e.setConfig('token','test-token');e.setConfig('group',{id:-1001,title:'Цех'});e.setConfig('sticker_file_done','done-file');e.q('INSERT INTO orders(token,data,search_text,created,updated,creator,author,status,version) VALUES (?,?,?,?,?,?,?,?,?)','old',JSON.stringify({customer:'Клиент',film:'Пленка',lines:[],comment:''}),'',new Date().toISOString(),new Date().toISOString(),100,'Анна',3,2);e.q('INSERT INTO status_reactions VALUES (?,?,?,?,?)',1,-1001,5000,0,1);e.queueReaction(1,-1001,99,3,2);
 const methods=[];globalThis.fetch=async(url)=>{const method=url.split('/').at(-1);methods.push(method);return method==='deleteMessage'?Response.json({ok:false,error_code:400,description:'Bad Request: message to delete not found'},{status:400}):Response.json({ok:true,result:{message_id:5001,sticker:{file_id:'done-file'}}});};
 try{await f.register.flush();assert.deepEqual(methods,['deleteMessage']);assert.equal(e.one('SELECT message_id FROM status_reactions'),undefined);}finally{globalThis.fetch=realFetch;}
});
test('day report rate limits block reposts until the group report is delivered',async()=>{
 const f=fixture(),e=f.register.engine,realFetch=globalThis.fetch;e.setConfig('owner',100);e.setConfig('token','test-token');e.setConfig('group',{id:-1001,title:'Цех'});e.q('INSERT INTO orders(token,data,search_text,created,updated,creator,author) VALUES (?,?,?,?,?,?,?)','pending',JSON.stringify({customer:'Клиент',film:'Пленка',lines:[{width:'1000',height:'1000',count:1,processing:false,thickness:'4'}]}),'',new Date().toISOString(),new Date().toISOString(),100,'Анна');e.event(1,100,'Статус: Не выполнено');e.privateDay(100,'/day');const calls=[];let limited=true;
 globalThis.fetch=async(url,options)=>{const method=url.split('/').at(-1),params=options.body instanceof FormData?Object.fromEntries(options.body):JSON.parse(options.body);calls.push({method,params});if(limited)return Response.json({ok:false,error_code:429,parameters:{retry_after:1}},{status:429});return Response.json({ok:true,result:{message_id:5000+calls.length}});};
 try{await f.register.flush();assert.equal(calls.length,1);assert.equal(Number(calls[0].params.chat_id),-1001);assert.equal(e.q('SELECT * FROM group_reposts').length,0);assert.equal(e.q('SELECT * FROM repost_deliveries').length,0);limited=false;e.setConfig('next_delivery',0);await f.register.flush();const html=x=>typeof x.params.rich_message==='string'?JSON.parse(x.params.rich_message).html:x.params.rich_message?.html;const report=calls.findIndex((x,i)=>i>0&&x.method==='sendRichMessage'&&Number(x.params.chat_id)===-1001&&html(x)?.includes('📊')),repost=calls.findIndex(x=>html(x)?.includes('📋 Заявка'));assert.ok(report>=0&&repost>report);assert.ok(calls.some(x=>x.method==='sendRichMessage'&&Number(x.params.chat_id)===100));}finally{globalThis.fetch=realFetch;}
});
test('permanently failed group report does not trigger pending reposts',async()=>{
 const f=fixture(),e=f.register.engine,realFetch=globalThis.fetch;e.setConfig('owner',100);e.setConfig('token','test-token');e.setConfig('group',{id:-1001,title:'Цех'});e.queueDayReport('📊 Итоги',null);const methods=[];globalThis.fetch=async url=>{methods.push(url.split('/').at(-1));return Response.json({ok:false,error_code:403,description:'Forbidden'},{status:403});};
 try{await f.register.flush();assert.deepEqual(methods,['sendRichMessage']);assert.equal(e.q('SELECT * FROM report_reposts').length,0);assert.equal(e.q('SELECT * FROM group_reposts').length,0);}finally{globalThis.fetch=realFetch;}
});
test('old order cards that Telegram refuses to delete are replaced by a deletion notice without buttons',async()=>{
 const f=fixture(),e=f.register.engine,realFetch=globalThis.fetch;e.setConfig('owner',100);e.setConfig('token','test-token');e.setConfig('group',{id:-1001,title:'Цех'});e.q('INSERT INTO deleted_orders VALUES (?,?,?,?)',1,100,'Анна',new Date().toISOString());e.queueRemoval(1,-1001,3000);const calls=[];
 globalThis.fetch=async(url,options)=>{const method=url.split('/').at(-1),params=JSON.parse(options.body);calls.push({method,params});return method==='deleteMessage'?Response.json({ok:false,error_code:400,description:'Bad Request: message can not be deleted'},{status:400}):Response.json({ok:true,result:{message_id:params.message_id}});};
 try{await f.register.flush();assert.deepEqual(calls.map(x=>x.method),['deleteMessage','editMessageText']);assert.equal(calls[1].params.message_id,3000);assert.match(calls[1].params.text,/GA-000001 удалена администратором Анна/);assert.deepEqual(calls[1].params.reply_markup,{inline_keyboard:[]});assert.equal(e.q('SELECT * FROM removal_outbox').length,0);assert.equal(e.q('SELECT * FROM outbox').length,0);}finally{globalThis.fetch=realFetch;}
});

test('daily banner uploads as JPEG with rich report text, without a second photo message',async()=>{
 const f=fixture(),e=f.register.engine,realFetch=globalThis.fetch;let calls=0;globalThis.fetch=async(url,options)=>{calls++;assert.ok(url.endsWith('/sendRichMessage'));assert.ok(options.body instanceof FormData);const photo=options.body.get('banner');assert.equal(photo.name,'day.jpg');assert.equal(photo.type,'image/jpeg');assert.ok(photo.size>1000&&photo.size<1024*1024);assert.equal(options.body.has('_status_banner'),false);const r=JSON.parse(options.body.get('rich_message'));assert.match(r.html,/tg:\/\/photo\?id=day/);assert.match(r.html,/📊 Итоги/);assert.match(r.html,/&lt;тест&gt;/);return Response.json({ok:true,result:{message_id:5000}});};
 try{await telegram('test-token','sendRichMessage',{chat_id:100,rich_message:e.dayRich('📊 Итоги\n<тест>'),_status_banner:'day'});assert.equal(calls,1);}finally{globalThis.fetch=realFetch;}
});
