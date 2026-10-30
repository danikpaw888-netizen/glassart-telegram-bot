import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Engine, InputError, parseLine, areaText, areaDisplay, parseThickness, completionText, perimeterDisplay } from './core.mjs';

function fixture(){
 const db=new DatabaseSync(':memory:');
 const sql={exec(query,...args){const stmt=db.prepare(query);if(stmt.columns().length){const rows=stmt.all(...args);return {toArray:()=>rows};}stmt.run(...args);return {toArray:()=>[]};}};
 const engine=new Engine(sql);engine.setConfig('owner',100);let seq=0;
 const transaction=fn=>{db.exec('BEGIN');try{const result=fn();db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}};
 function send(text,options={}){const uid=options.uid||100,from={id:uid,first_name:'Анна'},message={message_id:options.messageId||seq+1,chat:{id:options.group?(options.chatId||-1001):uid,type:options.group?'supergroup':'private',title:'GlassArt'},from};if(text!==null)message.text=text;if(options.photo)message.photo=[{file_id:options.photo}];const update={update_id:++seq,...(options.callback?{callback_query:{id:String(seq),from,message,data:options.callback}}:{message})};transaction(()=>engine.handle(update,options.access||{}));return update;}
 function action(name,uid=100){const s=engine.session(uid),value=`d:${s.token}:${s.rev}:${name}`;send(null,{uid,callback:value});return value;}
 function fill(save=true,uid=100){send('/new',{uid});send('ТОО Стекло',{uid});send('Солнцезащитная Silver 20',{uid});send('1200 × 1500 × 2\n500 800',{uid});action('done',uid);action('processing_yes',uid);send('4',{uid});send('Позвонить перед приездом',{uid});if(save)return action('save',uid);}
 const plain=p=>p.text??p.rich_message?.html.replaceAll('<br>','\n').replaceAll('</p>','\n\n').replace(/<[^>]*>/g,'').replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&amp;','&');
 const messages=()=>engine.q("SELECT params FROM outbox WHERE method IN ('sendMessage','sendRichMessage') ORDER BY id").map(x=>{const p=JSON.parse(x.params);return {...p,text:plain(p)};});
 let messageId=1000;
 function deliver(){const sent=[];for(let turn=0;turn<20;turn++){transaction(()=>engine.prepareGroupJobs());const rows=engine.q('SELECT * FROM outbox WHERE failed=0 ORDER BY id');if(!rows.length)break;for(const row of rows){const params=JSON.parse(row.params);const id=params.message_id||++messageId;sent.push({method:row.method,...params,text:plain(params),message_id:id});transaction(()=>engine.delivered(row.id,{message_id:id}));}}return sent;}
 return {db,engine,send,action,fill,messages,transaction,deliver};
}
test('dimensions and exact area',()=>{
 for(const text of ['1200 × 1500 × 2','1200x1500x2','1200х1500х2','1200 1500 2'])assert.equal(areaText([parseLine(text)]),'3,600');
 assert.equal(areaText([parseLine('100,5 200 3')]),'0,900');
 assert.equal(areaText([parseLine('20000 20000 10000'),parseLine('20000 20000 10000')]),'8000000,000');
 for(const text of ['NaN 2','Infinity 2','0 2','20001 1','1 2 1.5','1.001 2','1 2 10001','1','1 2 3 4'])assert.throws(()=>parseLine(text),InputError);
});
test('glass thickness validation',()=>{assert.equal(parseThickness('10,5'),'10.5');assert.equal(parseThickness('4'),'4');for(const x of ['0','-4','1001','4 мм','NaN','1.001','1e1',''])assert.throws(()=>parseThickness(x),InputError);});
test('full workflow, exact totals and duplicate event/button',()=>{
 const f=fixture(),oldSave=f.fill(),o=f.engine.get(1);assert.equal(o.data.customer,'ТОО Стекло');assert.equal(areaText(o.data.lines),'4,000');assert.equal('photos' in o.data,false);assert.equal(f.engine.session(100),null);
 const count=f.messages().length;f.engine.handle({update_id:1});assert.equal(f.messages().length,count);
 f.send(null,{callback:oldSave});assert.equal(f.engine.q('SELECT id FROM orders').length,1);
});
test('owner claim can be redeemed once, only in private chat',()=>{
 const f=fixture(),claim='a'.repeat(32);f.engine.setConfig('owner',null);f.engine.setConfig('claim',claim);
 f.send('/start claim_'+claim,{group:true});assert.equal(f.engine.config('owner'),null);
 f.send('/start claim_'+claim);assert.equal(f.engine.config('owner'),100);assert.equal(f.engine.config('claim'),null);
 f.send('/start claim_'+claim,{uid:200});assert.equal(f.engine.allowed(200),false);
});
test('access control, grant, revoke and queued data removal',()=>{
 const f=fixture();f.send('/new',{uid:200});assert.equal(f.engine.session(200),null);f.send('/allow 200');f.fill(true,200);assert.equal(f.engine.get(1).creator,200);
 f.send('/allow 300',{uid:200});assert.equal(f.engine.allowed(300),false);f.send('/revoke 200');assert.equal(f.engine.allowed(200),false);assert.equal(f.engine.q('SELECT id FROM outbox WHERE recipient=200').length,0);
 const count=f.messages().length;f.send('/list',{group:true});assert.equal(f.messages().length,count);
});
test('draft survives engine reconstruction and stale buttons',()=>{
 const f=fixture();f.fill(false);const old=f.engine.session(100);f.action('edit');f.send(null,{callback:`d:${old.token}:${old.rev}:save`});assert.equal(f.engine.get(1),undefined);
 const e2=new Engine(f.engine.sql);assert.equal(e2.session(100).step,'edit_menu');f.action('preview');f.action('save');assert.ok(e2.get(1));
});
test('draft fields can be corrected before sending',()=>{
 const f=fixture();f.fill(false);f.action('edit');f.action('field_film');f.send('Матовая белая');f.action('save');assert.equal(f.engine.get(1).data.film,'Матовая белая');assert.equal(f.engine.get(1).version,1);
});

test('private chat only accepts submissions and rejects old browse and status buttons',()=>{
 const f=fixture();f.fill();for(const value of ['list:0','view:1','edit:1','history:1','s:1:1:3','g:1:1:3','search']){f.send(null,{callback:value});assert.match(f.messages().at(-1).text,/Заявки и статусы находятся в группе/);assert.doesNotMatch(f.messages().at(-1).text,/ТОО Стекло/);}assert.equal(f.engine.get(1).status,0);f.send('/menu');assert.ok(!f.messages().at(-2).reply_markup.inline_keyboard.flat().some(x=>/list|search/.test(x.callback_data)));
});

test('binding queues every existing order and batches its publication',()=>{
 const f=fixture();for(let i=0;i<7;i++)f.fill();assert.equal(f.engine.q('SELECT * FROM group_jobs').length,0);f.engine.bindGroup({id:-1001,title:'Сотрудники'});assert.equal(f.engine.q('SELECT * FROM group_jobs').length,7);f.engine.prepareGroupJobs(2);assert.equal(f.engine.q('SELECT * FROM group_jobs').length,5);const sent=f.deliver();assert.equal(f.engine.q('SELECT * FROM group_cards').length,7);assert.equal(sent.filter(x=>x.chat_id<0&&x.text?.includes('📋 Заявка GA-')).length,7);
});

test('optional comment and required glass metadata',()=>{
 const f=fixture();f.send('/new');f.send('Клиент');assert.equal(f.engine.session(100).step,'film');f.send('Пленка');f.action('done');assert.equal(f.engine.session(100).step,'lines');f.send('1000 1000');assert.equal(f.engine.session(100).step,'lines');f.action('done');assert.equal(f.engine.session(100).step,'processing');f.send('нет');assert.equal(f.engine.session(100).step,'processing');f.action('processing_no');f.send('0');assert.equal(f.engine.session(100).step,'thickness');f.send('4');assert.equal(f.engine.session(100).step,'comment');f.action('skip');f.action('save');const d=f.engine.get(1).data;assert.equal('photos' in d,false);assert.equal(d.lines[0].processing,false);assert.equal(d.lines[0].thickness,'4');assert.equal('phone' in d,false);assert.equal('object' in d,false);assert.equal('deadline' in d,false);
});
test('photos are rejected and removed from cards and edit controls',()=>{
 const f=fixture();f.fill(false);assert.equal(f.engine.session(100).step,'preview');f.send(null,{photo:'rejected-file-id'});assert.equal(f.engine.session(100).step,'preview');assert.equal('photos' in f.engine.session(100).data,false);f.action('edit');assert.ok(!f.messages().at(-1).reply_markup.inline_keyboard.flat().some(x=>x.callback_data.includes('photos')));f.action('preview');f.action('save');f.send(null,{callback:'photos:1'});assert.equal(f.engine.q("SELECT id FROM outbox WHERE method='sendPhoto'").length,0);
 for(const m of f.messages()){assert.ok(m.text.length<=4096);for(const b of m.reply_markup?.inline_keyboard.flat()||[])assert.ok(new TextEncoder().encode(b.callback_data).length<=64);}
});
test('transaction rollback does not acknowledge a failed event',()=>{
 const f=fixture();assert.throws(()=>f.transaction(()=>{f.engine.handle({update_id:500,message:{from:{id:100},chat:{id:100,type:'private'},text:'/new'}});throw Error('fail');}));assert.equal(f.engine.session(100),null);assert.equal(f.engine.one('SELECT id FROM processed WHERE id=500'),undefined);
});
test('only the group receives full cards and group members set both completion states',()=>{
 const f=fixture();f.engine.bindGroup({id:-1001,title:'Сотрудники'});f.send('/allow 200');f.send('/addadmin 300');f.fill();const sent=f.deliver(),card=sent.find(x=>x.chat_id===-1001&&x.text.includes('📋 Заявка GA-'));assert.ok(card);assert.match(card.text,/Толщина стекла: 4 мм/);assert.match(card.text,/Обработка края: Есть обработка/);assert.doesNotMatch(card.text,/Телефон:|Объект:|Срок:|Фото:/);assert.ok(!sent.some(x=>x.chat_id>0&&x.text?.includes('📋 Заявка GA-')));const buttons=card.reply_markup.inline_keyboard.flat();assert.equal(buttons.length,2);assert.equal(buttons[0].callback_data,'g:1:1:3');
 f.send(null,{group:true,uid:500,messageId:card.message_id,callback:'g:1:1:3',access:{groupMember:true}});assert.equal(f.engine.get(1).status,3);const edits=f.deliver().filter(x=>x.method==='editMessageText');assert.equal(edits[0].message_id,card.message_id);assert.match(edits[0].text,/Отметил: Анна/);assert.match(edits[0].text,/Статус: Выполнено/);f.send(null,{group:true,uid:500,messageId:card.message_id,callback:'g:1:2:0',access:{groupMember:true}});assert.equal(f.engine.get(1).status,0);assert.equal(f.engine.allowed(500),false);
});

test('legacy saved records keep their data while group cards omit retired fields',()=>{
 const f=fixture();f.fill();const o=f.engine.get(1),old={customer:o.data.customer,film:o.data.film,lines:[{width:'1200',height:'1500',count:2}],photos:[],phone:'secret-phone',object:'legacy-address',deadline:'30.10.2026'};f.engine.q('UPDATE orders SET data=?,status=2 WHERE id=1',JSON.stringify(old));const card=f.engine.groupText(f.engine.get(1));assert.match(card,/Толщина стекла: не указана/);assert.match(card,/Статус: Выполнено/);assert.doesNotMatch(card,/secret-phone|legacy-address|30\.10\.2026/);assert.equal(f.engine.get(1).data.phone,'secret-phone');for(const x of [0,1,4])assert.equal(completionText(x),'Не выполнено');for(const x of [2,3])assert.equal(completionText(x),'Выполнено');
});

test('legacy drafts on removed questions migrate without consuming old answers',()=>{
 for(const [oldStep,newStep] of [['phone','film'],['object','film'],['deadline','comment']]){
  const f=fixture(),s={mode:'draft',token:'oldtoken',rev:4,step:oldStep,data:{customer:'Старый клиент',film:'Пленка',lines:[],photos:[]},author:'Анна'};f.engine.q('INSERT INTO sessions VALUES (?,?)',100,JSON.stringify(s));f.send('Ответ на прежний вопрос');assert.equal(f.engine.session(100).step,newStep);assert.equal(f.engine.session(100).data.film,'Пленка');assert.equal(f.engine.session(100).schemaVersion,4);assert.match(f.messages().at(-2).text,/Форма заявки обновлена/);
 }
});
test('legacy unsaved preview must collect treatment and thickness before saving',()=>{
 const f=fixture(),s={mode:'draft',token:'legacy',rev:1,step:'preview',data:{customer:'Клиент',film:'Пленка',lines:[{width:'1000',height:'1000',count:1}],photos:[]},author:'Анна'};f.engine.q('INSERT INTO sessions VALUES (?,?)',100,JSON.stringify(s));f.send('/resume');f.action('save');assert.equal(f.engine.session(100).step,'processing');assert.equal(f.engine.get(1),undefined);f.action('processing_no');f.send('8');assert.equal(f.engine.session(100).step,'preview');f.action('save');assert.equal(f.engine.get(1).data.lines[0].thickness,'8');
});
test('editing glass positions replaces dimensions and metadata together',()=>{
 const f=fixture();f.fill(false);f.action('edit');f.action('field_lines');f.send('1000 1500 3');f.action('done');assert.equal(f.engine.session(100).step,'preview');f.action('save');const lines=f.engine.get(1).data.lines;assert.equal(lines.length,1);assert.deepEqual(lines[0],{width:'1000',height:'1500',count:3,processing:true,thickness:'4'});
});

test('drafts on the removed photo step resume at preview without losing saved data',()=>{
 const f=fixture();f.fill(false);const s=f.engine.session(100);s.schemaVersion=2;s.step='photos';s.data.photos=['legacy-photo'];f.engine.q('UPDATE sessions SET data=? WHERE id=?',JSON.stringify(s),100);f.send('/resume');assert.equal(f.engine.session(100).step,'preview');assert.doesNotMatch(f.messages().at(-1).text,/Фото:/);f.action('save');assert.deepEqual(f.engine.get(1).data.photos,['legacy-photo']);f.send(null,{callback:'edit:1'});assert.deepEqual(f.engine.get(1).data.photos,['legacy-photo']);assert.equal(f.engine.q("SELECT id FROM outbox WHERE method='sendPhoto'").length,0);
});
test('additional administrators can manage access, with idempotent grants',()=>{
 const f=fixture();f.send('/addadmin 200');f.send('/addadmin 200');assert.deepEqual(f.engine.adminIds(),[100,200]);assert.equal(f.engine.allowed(200),true);
 f.send('/allow 300',{uid:200});assert.equal(f.engine.allowed(300),true);f.send('/addadmin 400',{uid:200});assert.equal(f.engine.isAdmin(400),true);f.send('/admins',{uid:200});assert.match(f.messages().at(-1).text,/ID 100/);assert.match(f.messages().at(-1).text,/ID 400/);
});
test('ordinary staff cannot grant or remove admin rights through commands or buttons',()=>{
 const f=fixture();f.send('/allow 200');f.send('/addadmin 300',{uid:200});f.send('/removeadmin 100',{uid:200});f.send(null,{uid:200,callback:'admin_add'});f.send(null,{uid:200,callback:'manage_admins'});assert.deepEqual(f.engine.adminIds(),[100]);assert.equal(f.engine.session(200),null);f.send('/menu',{uid:200});assert.ok(!f.messages().at(-1).reply_markup.inline_keyboard.flat().some(x=>x.callback_data==='manage_admins'));
});
test('last admin cannot be removed and demotion retains only employee access',()=>{
 const f=fixture();f.send('/removeadmin 100');assert.equal(f.engine.isAdmin(100),true);assert.match(f.messages().at(-1).text,/последнего администратора/);f.send('/revoke 100');assert.equal(f.engine.isAdmin(100),true);f.send('/addadmin 200');f.send('/removeadmin 100',{uid:200});assert.equal(f.engine.isAdmin(100),false);assert.equal(f.engine.allowed(100),true);f.send('/addadmin 300');assert.equal(f.engine.isAdmin(300),false);f.send('/removeadmin 200',{uid:200});assert.equal(f.engine.isAdmin(200),true);f.send('/revoke 100',{uid:200});assert.equal(f.engine.allowed(100),false);
 const restarted=new Engine(f.engine.sql);assert.deepEqual(restarted.adminIds(),[200]);assert.equal(restarted.allowed(100),false);
});
test('admin panel adds and removes by ID, rejects invalid input and preserves drafts',()=>{
 const f=fixture();f.send('/menu');assert.ok(f.messages().at(-2).reply_markup.inline_keyboard.flat().some(x=>x.callback_data==='manage_admins'));f.send(null,{callback:'admin_add'});f.send('не число');assert.equal(f.engine.session(100).mode,'admin_add');f.send('200');assert.equal(f.engine.isAdmin(200),true);assert.equal(f.engine.session(100),null);f.send(null,{callback:'admin_remove'});f.send('200');assert.equal(f.engine.isAdmin(200),false);assert.equal(f.engine.allowed(200),true);f.send('/new');const token=f.engine.session(100).token;f.send(null,{callback:'admin_add'});assert.equal(f.engine.session(100).token,token);assert.equal(f.engine.session(100).mode,'draft');
});
test('legacy owner migrates once and admins do not receive private order broadcasts',()=>{
 const f=fixture();const migrated=new Engine(f.engine.sql);assert.deepEqual(migrated.adminIds(),[100]);assert.equal(migrated.config('admins_initialized'),true);f.send('/addadmin 200');f.fill();assert.ok(!f.messages().some(m=>m.chat_id===200&&m.text.includes('📋 Заявка GA-')));
});

test('binding requires bot admin plus group membership and cannot be forged by ordinary staff',()=>{
 const f=fixture();f.send('/allow 200');f.send('/bindgroup',{group:true,uid:200,access:{groupMember:true,botAdmin:true}});assert.equal(f.engine.config('group'),null);f.send('/bindgroup',{group:true,access:{botAdmin:true}});assert.equal(f.engine.config('group'),null);f.send('/bindgroup',{group:true,access:{botAdmin:true,groupMember:true}});assert.equal(f.engine.config('group').id,-1001);
});
test('nonmembers, wrong groups, wrong message IDs and stale buttons cannot overwrite status',()=>{
 const f=fixture();f.engine.bindGroup({id:-1001,title:'Сотрудники'});f.fill();const card=f.deliver().find(x=>x.chat_id<0&&x.text.includes('📋 Заявка GA-'));
 for(const options of [{},{access:{groupMember:true},chatId:-1002},{access:{groupMember:true},messageId:888}]){f.send(null,{group:true,uid:500,messageId:card.message_id,callback:'g:1:1:3',...options});assert.equal(f.engine.get(1).status,0);}
 f.send(null,{group:true,uid:500,messageId:card.message_id,callback:'g:1:1:3',access:{groupMember:true}});assert.equal(f.engine.get(1).status,3);f.send(null,{group:true,uid:500,messageId:card.message_id,callback:'g:1:1:0',access:{groupMember:true}});assert.equal(f.engine.get(1).status,3);
});
test('twenty positions and long comments remain in one rich message with editable banner',()=>{
 const f=fixture();f.engine.bindGroup({id:-1001,title:'Сотрудники'});f.fill();const o=f.engine.get(1);o.data.comment='Я'.repeat(2000);o.data.customer='<Клиент & компания>';o.data.film='П'.repeat(150);o.data.lines=Array.from({length:20},()=>({width:'20000',height:'20000',count:10000,processing:true,thickness:'10'}));f.engine.q('UPDATE orders SET data=? WHERE id=1',JSON.stringify(o.data));f.engine.notify(1);const sent=f.deliver().filter(x=>x.chat_id<0&&x.rich_message);assert.equal(sent.length,1);assert.ok(sent[0].text.includes(o.data.comment));assert.match(sent[0].rich_message.html,/&lt;Клиент &amp; компания&gt;/);assert.equal(sent[0]._status_banner,undefined);const rows=f.engine.q('SELECT * FROM group_cards');assert.equal(rows.length,1);
 f.send(null,{group:true,uid:500,messageId:rows[0].message_id,callback:'g:1:1:3',access:{groupMember:true}});const edits=f.deliver().filter(x=>x.method==='editMessageText');assert.equal(edits.length,1);assert.equal(edits[0]._status_banner,'done');assert.ok(edits[0].text.includes(o.data.comment));assert.match(edits[0].rich_message.html,/tg:\/\/photo\?id=status/);for(const b of edits[0].reply_markup.inline_keyboard.flat())assert.ok(Buffer.byteLength(b.callback_data)<=64);
});
test('changing group or topic cancels unsent old publications and restores backlog',()=>{
 const f=fixture();f.engine.bindGroup({id:-1001,title:'А'},11);f.fill();f.engine.prepareGroupJobs();f.engine.bindGroup({id:-1002,title:'Б'},22);assert.equal(f.engine.q('SELECT * FROM outbox WHERE recipient=-1001').length,0);const sent=f.deliver();const card=sent.find(x=>x.chat_id===-1002&&x.reply_markup?.inline_keyboard.flat().some(b=>b.callback_data.startsWith('g:')));assert.equal(card.message_thread_id,22);f.engine.bindGroup({id:-1002,title:'Б'},33);const rebound=f.deliver().find(x=>x.chat_id===-1002&&x.reply_markup?.inline_keyboard.flat().some(b=>b.callback_data.startsWith('g:')));assert.equal(rebound.message_thread_id,33);
});
test('old private search sessions return to submission menu without crashing',()=>{
 const f=fixture();f.engine.put(100,{mode:'search'});f.send('старый поиск');assert.equal(f.engine.session(100),null);assert.match(f.messages().at(-1).text,/Отправка заявок/);
});
test('chosen status collapses into one button and may be reopened for correction',()=>{
 const f=fixture();f.engine.bindGroup({id:-1001,title:'Цех'});f.fill();const card=f.deliver().find(x=>x.chat_id<0&&x.text?.includes('📋 Заявка GA-'));
 f.send(null,{group:true,uid:500,messageId:card.message_id,callback:'g:1:1:0',access:{groupMember:true}});let edited=f.deliver().find(x=>x.method==='editMessageText');assert.equal(edited.reply_markup.inline_keyboard.flat().length,1);assert.equal(edited.reply_markup.inline_keyboard[0][0].text,'❌ Заказ не выполнен');
 f.send(null,{group:true,uid:500,messageId:card.message_id,callback:'r:1:2',access:{groupMember:true}});const buttons=f.deliver().find(x=>x.method==='editMessageReplyMarkup');assert.equal(buttons.reply_markup.inline_keyboard.flat().length,2);assert.equal(f.engine.get(1).status,0);
 f.send(null,{group:true,uid:500,messageId:card.message_id,callback:'g:1:2:3',access:{groupMember:true}});edited=f.deliver().find(x=>x.method==='editMessageText');assert.equal(edited.reply_markup.inline_keyboard[0][0].text,'✅ Заказ выполнен');assert.equal(edited.reply_markup.inline_keyboard.flat().length,1);
});
test('card resembles requested layout and has clean exact area formatting',()=>{
 const f=fixture(),d={customer:'Клиент',film:'Коричневый',lines:[{width:'1000',height:'1300',count:3,processing:false,thickness:'4'}],comment:''};const text=f.engine.card(d,'📋 Ваш расчёт:');assert.match(text,/🧊 Толщина стекла: 4 мм/);assert.match(text,/📦 Плёнка: Коричневый/);assert.match(text,/Обработка края: Без обработки/);assert.match(text,/1000x1300 мм — 3 шт, площадь 3.9 м²/);assert.match(text,/✅ Стёкол: 3/);assert.match(text,/📐 Площадь: 3.9 м²/);assert.equal(areaDisplay([{width:'1234',height:'567',count:1}]),'0.6997');
});
test('daily total counts only completed area within Kazakhstan midnight boundaries',()=>{
 const f=fixture();for(let i=0;i<4;i++)f.fill();const times=['2026-10-25T18:59:59.000Z','2026-10-25T19:00:00.000Z','2026-10-26T18:59:59.000Z','2026-10-26T19:00:00.000Z'];for(let i=0;i<4;i++)f.engine.q('UPDATE orders SET created=?,status=? WHERE id=?',times[i],i===1?3:0,i+1);const report=f.engine.dayReport('26.10.2026');assert.match(report,/Заявок: 2/);assert.match(report,/Общая площадь: 4 м²/);assert.match(report,/Выполнено: 1 заявок · 4 м²/);assert.match(report,/Не выполнено: 1 заявок · 4 м²/);assert.match(f.engine.dayReport('01.01.2000'),/Общая площадь: 0 м²/);assert.throws(()=>f.engine.dayReport('31.02.2026'),InputError);
 f.engine.bindGroup({id:-1001,title:'Цех'});f.send('/day 26.10.2026',{group:true,uid:500,access:{groupMember:true}});assert.match(f.messages().at(-1).text,/Общая площадь: 4 м²/);
});
test('multiline positions use one common treatment and thickness for the whole order',()=>{
 const f=fixture();f.send('/new');f.send('Клиент');f.send('Пленка');f.send('1200 768 4\n12345 567 2');assert.equal(f.engine.session(100).data.lines.length,2);assert.equal(f.engine.session(100).step,'lines');f.action('done');f.action('processing_yes');f.send('4');assert.equal(f.engine.session(100).step,'comment');f.action('skip');f.action('save');const d=f.engine.get(1).data;assert.equal(d.processing,true);assert.equal(d.thickness,'4');assert.ok(d.lines.every(x=>x.processing===true&&x.thickness==='4'));
});

test('invalid multiline batches do not partially append and enforce combined capacity',()=>{
 const f=fixture();f.send('/new');f.send('Клиент');f.send('Пленка');f.send('1000 500 2\nневерный размер');assert.equal(f.engine.session(100).data.lines.length,0);assert.match(f.messages().at(-1).text,/Строка 2/);f.send(Array(21).fill('1000 500').join('\n'));assert.equal(f.engine.session(100).data.lines.length,0);f.send('1000x500\r\n\r\n 1200 × 768 × 4 ');assert.equal(f.engine.session(100).data.lines.length,2);assert.equal(f.engine.session(100).data.lines[0].count,1);
});
test('minimum area is applied to each individual pane before quantity',()=>{
 assert.equal(areaDisplay([parseLine('200 500 4')]),'1.2');assert.equal(areaDisplay([parseLine('600 500 2')]),'0.6');assert.equal(areaDisplay([parseLine('601 500 2')]),'0.601');assert.equal(areaDisplay([parseLine('200 500 4'),parseLine('1000 1000 2')]),'3.2');
});
test('day reposts only explicitly not completed orders from all dates and copies share status',()=>{
 const f=fixture();f.engine.bindGroup({id:-1001,title:'Цех'});f.fill();f.fill();f.fill();const original=f.deliver().filter(x=>x.chat_id<0&&x.text?.includes('📋 Заявка GA-'));f.engine.q("UPDATE orders SET created='2026-01-01T00:00:00.000Z' WHERE id=2");
 for(const [id,status] of [[2,0],[3,3]]){const card=original.find(x=>x.text.includes(`GA-00000${id}`));f.send(null,{group:true,uid:500,messageId:card.message_id,callback:`g:${id}:1:${status}`,access:{groupMember:true}});}f.deliver();
 f.send('/day',{group:true,uid:500,access:{groupMember:true}});assert.equal(f.engine.q('SELECT * FROM report_reposts').length,1);const duplicate=f.deliver().find(x=>x.method==='sendRichMessage'&&x._status_banner!=='day'&&x.text?.includes('📋 Заявка GA-000002'));assert.ok(duplicate);assert.equal(f.engine.q('SELECT id FROM orders').length,3);assert.equal(f.engine.q('SELECT * FROM group_copies WHERE order_id=2').length,2);
 f.send(null,{group:true,uid:500,messageId:duplicate.message_id,callback:'g:2:2:3',access:{groupMember:true}});const edits=f.deliver().filter(x=>x.method==='editMessageText'&&x.text?.includes('GA-000002'));assert.equal(edits.length,2);assert.ok(edits.every(x=>/Статус: Выполнено/.test(x.text)));
 f.send('/day 31.02.2026',{group:true,uid:500,access:{groupMember:true}});assert.equal(f.engine.q('SELECT * FROM group_reposts').length,0);
});
test('banner switches in the same card without sending standalone stickers',()=>{
 const f=fixture();f.engine.bindGroup({id:-1001,title:'Цех'});f.fill();const card=f.deliver().find(x=>x.rich_message);
 for(const [version,status,key]of [[1,0,'pending'],[2,3,'done'],[3,0,'pending']]){f.send(null,{group:true,uid:500,messageId:card.message_id,callback:`g:1:${version}:${status}`,access:{groupMember:true}});f.engine.prepareReactions();const sent=f.deliver();assert.equal(sent.filter(x=>x.method==='editMessageText').length,1);const edit=sent.find(x=>x.method==='editMessageText');assert.equal(edit.message_id,card.message_id);assert.equal(edit._status_banner,key);assert.ok(!sent.some(x=>['sendSticker','sendRichMessage'].includes(x.method)));}
});
test('migration cleans old stickers and consolidates multipart cards without adding new copies',()=>{
 const f=fixture();f.engine.bindGroup({id:-1001,title:'Цех'});f.fill();f.deliver();f.engine.q('INSERT INTO group_copies VALUES (?,?,?,?)',1,-1001,1,4999);f.engine.q('INSERT INTO status_reactions VALUES (?,?,?,?,?)',1,-1001,5000,0,1);f.engine.enqueue('sendSticker',{chat_id:-1001,_status_sticker:'done'});f.engine.migrateBanners();f.engine.prepareReactions();const sent=f.deliver();assert.ok(sent.some(x=>x.method==='deleteMessage'&&x.message_id===5000));assert.ok(sent.some(x=>x.method==='deleteMessage'&&x.message_id===4999));assert.ok(!sent.some(x=>x.method==='sendSticker'));assert.equal(f.engine.q('SELECT * FROM status_reactions').length,0);assert.equal(f.engine.q('SELECT * FROM group_cards').length,1);assert.equal(f.engine.q('SELECT * FROM group_copies').length,1);
});

test('private day reports completed totals and reposts only explicitly not completed cards into the bound group, preserving draft',()=>{
 const f=fixture();f.engine.bindGroup({id:-1001,title:'Цех'});for(let i=0;i<3;i++)f.fill();const cards=f.deliver().filter(x=>x.rich_message);for(const [id,status]of [[2,0],[3,3]]){const card=cards.find(x=>x.text.includes(`GA-00000${id}`));f.send(null,{group:true,uid:500,messageId:card.message_id,callback:`g:${id}:1:${status}`,access:{groupMember:true}});}f.deliver();
 f.fill(false);const draft=f.engine.session(100);f.deliver();f.send('/day');const report=f.messages().at(-1);assert.match(report.text,/📊 Итоги за/);assert.match(report.text,/Общая площадь: 4 м²/);assert.match(report.text,/«Не выполнено»: 1/);assert.equal(report.chat_id,100);assert.deepEqual(f.engine.session(100),draft);const sent=f.deliver(),reposts=sent.filter(x=>x.method==='sendRichMessage'&&x._status_banner!=='day');assert.equal(reposts.length,1);assert.equal(reposts[0].chat_id,-1001);assert.match(reposts[0].text,/GA-000002/);assert.equal(f.engine.q('SELECT id FROM orders').length,3);
});
test('private day validates dates, respects staff access and explains missing group',()=>{
 const f=fixture();f.fill();f.deliver();f.send('/day 26.10.2026');assert.match(f.messages().at(-1).text,/Итоги за 26.10.2026/);assert.match(f.messages().at(-1).text,/Группа сотрудников пока не подключена/);assert.equal(f.engine.q('SELECT * FROM group_reposts').length,0);
 f.send('/day 31.02.2026');assert.match(f.messages().at(-1).text,/существующую дату/);f.send('/day',{uid:777});assert.match(f.messages().at(-1).text,/только сотрудникам/);assert.doesNotMatch(f.messages().at(-1).text,/Итоги за/);f.send('/allow 200');f.send('/day@GlassArtWork_bot',{uid:200});assert.match(f.messages().at(-1).text,/Итоги за/);
});

test('a pending repost is skipped if status changes before publication and unmarked orders never repost',()=>{
 const f=fixture();f.engine.bindGroup({id:-1001,title:'Цех'});f.fill();f.fill();const cards=f.deliver().filter(x=>x.rich_message),card=cards.find(x=>x.text.includes('GA-000002'));f.send(null,{group:true,uid:500,messageId:card.message_id,callback:'g:2:1:0',access:{groupMember:true}});f.deliver();f.send('/day');assert.equal(f.engine.q('SELECT * FROM report_reposts').length,1);f.send(null,{group:true,uid:500,messageId:card.message_id,callback:'g:2:2:3',access:{groupMember:true}});assert.equal(f.deliver().filter(x=>x.method==='sendRichMessage'&&x._status_banner!=='day').length,0);f.send('/day');assert.equal(f.engine.q('SELECT * FROM group_reposts').length,0);
 const report=f.engine.dayReport();assert.match(report,/Общая площадь: 4 м² \(только выполненные\)/);assert.match(report,/Не выполнено: 1 заявок · 4 м²/);f.engine.q('UPDATE orders SET status=0 WHERE id=2');assert.match(f.engine.dayReport(),/Общая площадь: 0 м²/);
});

test('perimeters use real dimensions exactly, include quantity and ignore minimum billable area',()=>{
 assert.equal(perimeterDisplay([parseLine('1200 1500 2'),parseLine('500 800')]),'13.4');assert.equal(perimeterDisplay([parseLine('200 500 4')]),'5.6');assert.equal(perimeterDisplay([parseLine('0.01 0.02 3')]),'0.00018');assert.equal(perimeterDisplay([parseLine('20000 20000 10000')]),'800000');assert.equal(perimeterDisplay([]),'0');
});
test('only the total perimeter appears after treatment and in the group card',()=>{
 for(const choice of ['processing_yes','processing_no']){const f=fixture();f.engine.bindGroup({id:-1001,title:'Цех'});f.send('/new');f.send('Клиент');f.send('Плёнка');f.send('1200 1500 2\n500 800');f.action('done');f.action(choice);assert.equal(f.engine.session(100).step,'thickness');assert.match(f.messages().at(-1).text,/Общий периметр стёкол: 13.4 м/);f.send('4');f.action('skip');const preview=f.messages().at(-1).text;assert.match(preview,/Обработка края: [^\n]+\n📏 Общий периметр: 13.4 м/);assert.doesNotMatch(preview,/Периметр 1 стекла|за 2 шт:/);assert.equal((preview.match(/периметр/gi)||[]).length,1);f.action('save');const card=f.deliver().find(x=>x.rich_message);assert.match(card.text,/Общий периметр: 13.4 м/);assert.doesNotMatch(card.text,/Периметр 1 стекла|за 2 шт:/);}
});

test('private day mirrors report to group and pending cards are queued only after report delivery',()=>{
 const f=fixture();f.engine.bindGroup({id:-1001,title:'Цех'});f.fill();const card=f.deliver().find(x=>x.rich_message);f.send(null,{group:true,uid:500,messageId:card.message_id,callback:'g:1:1:0',access:{groupMember:true}});f.deliver();f.send('/day');assert.equal(f.engine.q('SELECT * FROM group_reposts').length,0);f.engine.prepareGroupJobs();assert.equal(f.engine.q('SELECT * FROM repost_deliveries').length,0);const reports=f.messages().filter(x=>x.text.startsWith('📊'));assert.deepEqual(reports.map(x=>x.chat_id),[-1001,100]);const sent=f.deliver(),groupReport=sent.findIndex(x=>x.chat_id===-1001&&x.text?.startsWith('📊')),repost=sent.findIndex(x=>x.method==='sendRichMessage'&&x._status_banner!=='day');assert.ok(groupReport>=0&&repost>groupReport);
});
test('administrator deletes an order with confirmation and all copies disappear from reports and reposts',()=>{
 const f=fixture();f.engine.bindGroup({id:-1001,title:'Цех'});f.fill();let card=f.deliver().find(x=>x.rich_message);f.send(null,{group:true,uid:500,messageId:card.message_id,callback:'g:1:1:0',access:{groupMember:true}});f.deliver();f.send('/day');f.deliver();const count=f.engine.q('SELECT * FROM group_copies').length;assert.equal(count,2);f.fill(false);const draft=f.engine.session(100);f.deliver();f.send('/delete GA-000001');const confirmation=f.messages().at(-1);assert.match(confirmation.text,/Удалить заявку GA-000001/);assert.ok(f.engine.get(1));const button=confirmation.reply_markup.inline_keyboard[0][0].callback_data;f.send(null,{callback:button});assert.equal(f.engine.get(1),undefined);assert.deepEqual(f.engine.session(100),draft);const sent=f.deliver();assert.equal(sent.filter(x=>x.method==='deleteMessage').length,count);assert.match(f.engine.dayReport(),/Заявок: 0/);f.send('/day');assert.equal(f.deliver().filter(x=>x.method==='sendRichMessage'&&x._status_banner!=='day').length,0);f.engine.bindGroup({id:-1001,title:'Цех'});assert.equal(f.deliver().filter(x=>x.rich_message).length,0);f.send(null,{callback:button});assert.equal(f.engine.q('SELECT * FROM deleted_orders').length,1);
});
test('deletion refuses ordinary employees, other admins, cancelled, expired and stale confirmations',()=>{
 const f=fixture();f.fill();f.deliver();f.send('/allow 200');f.send('/delete 1',{uid:200});assert.match(f.messages().at(-1).text,/только администратор/);f.send('/addadmin 300');f.send('/delete 1');let button=f.messages().at(-1).reply_markup.inline_keyboard[0][0].callback_data;f.send(null,{uid:300,callback:button});assert.ok(f.engine.get(1));f.send(null,{callback:button.replace('del:yes:','del:no:')});assert.ok(f.engine.get(1));f.send(null,{callback:button});assert.ok(f.engine.get(1));f.send('/delete 1');button=f.messages().at(-1).reply_markup.inline_keyboard[0][0].callback_data;f.engine.q('UPDATE deletion_requests SET expires=0');f.send(null,{callback:button});assert.ok(f.engine.get(1));f.send('/delete 1');button=f.messages().at(-1).reply_markup.inline_keyboard[0][0].callback_data;f.engine.q('UPDATE orders SET version=version+1 WHERE id=1');f.send(null,{callback:button});assert.ok(f.engine.get(1));f.send('/delete 999');assert.match(f.messages().at(-1).text,/не найдена/);f.send('/delete');assert.match(f.messages().at(-1).text,/GA-000003/);
});
test('an order deleted during an in-flight delivery is cleaned up instead of reappearing',()=>{
 const f=fixture();f.engine.bindGroup({id:-1001,title:'Цех'});f.fill();f.deliver();f.engine.notify(1);f.engine.prepareGroupJobs();const old=f.engine.one('SELECT o.* FROM outbox o JOIN outbox_meta m ON m.outbox_id=o.id WHERE m.order_id=1');f.send('/delete 1');const button=f.messages().at(-1).reply_markup.inline_keyboard[0][0].callback_data;f.send(null,{callback:button});f.engine.delivered(old.id,{message_id:9999});assert.equal(f.engine.get(1),undefined);assert.equal(f.engine.q('SELECT * FROM group_cards').length,0);assert.ok(f.deliver().some(x=>x.method==='deleteMessage'&&x.message_id===9999));
});

test('daily reports contain the day banner and full totals in one rich message in both chats',()=>{
 const f=fixture();f.engine.bindGroup({id:-1001,title:'Цех'});f.fill();f.deliver();f.send('/day');const rows=f.engine.q("SELECT params FROM outbox WHERE method='sendRichMessage'").map(x=>JSON.parse(x.params));assert.deepEqual(rows.map(x=>x.chat_id),[-1001,100]);for(const r of rows){assert.equal(r._status_banner,'day');assert.match(r.rich_message.html,/tg:\/\/photo\?id=day/);assert.match(r.rich_message.html,/Итоги за/);assert.match(r.rich_message.html,/только выполненные/);assert.equal(r.rich_message.media[0].media.media,'attach://banner');assert.equal(r.text,undefined);}f.deliver();f.send('/day 26.10.2026',{group:true,uid:500,access:{groupMember:true}});const group=f.engine.one("SELECT params FROM outbox WHERE method='sendRichMessage'");assert.equal(JSON.parse(group.params)._status_banner,'day');assert.equal(JSON.parse(group.params).chat_id,-1001);
});
