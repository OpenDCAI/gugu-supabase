import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

// #791: a member on another machine hands a changed copy of a project file to the host that keeps it, and the host
// writes it as the next version — recorded as the requester's edit and sent as the requester's message.
const url=process.env.GUGU_INTEGRATION_DATABASE_URL??''
let db:pg.Client, owner:string, member:string, agent:string, outsider:string, group:string, device:string, item:string
const sha='ab'.repeat(32), edited='ef'.repeat(32), cipherSha='cd'.repeat(32), key=Buffer.alloc(32,7).toString('base64'), type='text/markdown'
const cfg={inventory_ready:true,storage_global_bytes:10000,storage_account_bytes:10000,storage_group_bytes:10000,
  download_global_bytes:10000,download_account_bytes:10000,download_group_bytes:10000,
  upload_permit_seconds:120,sign_window_seconds:60,sign_account_count:100,sign_group_count:100,file_max_bytes:1000,temporary_group_bytes:10000}
const REQUEST='SELECT chat.file_version_handoff_request($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) AS r'
const CREATE_REQUEST='SELECT chat.file_version_handoff_request($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) AS r'
const creationArgs=(id=randomUUID()):unknown[]=>[randomUUID(),id,null,'new.md',type,140,edited,168,168,{message_id:randomUUID(),caption:'new file'},agent,group]
async function create(args=creationArgs()) {
  await user(member)
  return (await db.query(CREATE_REQUEST,args)).rows[0].r
}
async function user(id=owner) {
  await db.query('SET LOCAL ROLE authenticated')
  await db.query("SELECT set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:id,role:'authenticated'})])
}
async function service() { await db.query('RESET ROLE') }
async function fails(sql:string,args:unknown[]=[]) {
  await db.query('SAVEPOINT refused')
  try { await db.query(sql,args) } catch(error) {
    await db.query('ROLLBACK TO SAVEPOINT refused');return error as pg.DatabaseError
  }
  throw Error('Expected refusal: '+sql)
}
async function request(overrides:Record<number,unknown>={},as=agent) {
  await user(member)
  const args=Object.assign([randomUUID(),item,1,'notes.md',type,140,edited,168,168,{message_id:randomUUID(),caption:'fixed the typo'},as],overrides)
  return (await db.query(REQUEST,args)).rows[0].r
}
async function commit(id:string,account=member,cipher=cipherSha) {
  await service()
  return (await db.query('SELECT chat.file_version_handoff_commit($1,$2,$3,168,$4) AS r',[id,account,cipher,key])).rows[0].r
}
// Each copy is encrypted under its own key, so no two ciphertexts are alike (blob SHA-256s are unique).
async function ready(cipher=cipherSha) { const r=await request();await commit(r.handoff_id,member,cipher);return r.handoff_id as string }
async function publish(id:string,size=140,hash=edited) {
  await user()
  return (await db.query('SELECT chat.file_version_handoff_publish($1,$2,$3,$4) AS r',[id,'.gugu/attachments/notes-2.md',hash,size])).rows[0].r
}
async function status(id:string,cancel=false) {
  await user(member)
  return (await db.query('SELECT chat.file_version_handoff_status($1,$2) AS r',[id,cancel])).rows[0].r
}
async function row(id:string) { await service();return (await db.query('SELECT * FROM chat.file_version_handoffs WHERE id=$1',[id])).rows[0] }
async function current() { await service();return (await db.query('SELECT version,updated_by,size_bytes FROM chat.workspace_items WHERE id=$1',[item])).rows[0] }
async function freshProject() {
  await service()
  const chat=randomUUID(),project=randomUUID()
  // The host reserves the chat id before creating the group; neither a file nor a file policy exists yet.
  await db.query(`INSERT INTO identity.device_projects(device_id,user_id,local_project_id,name,root_path,created_at,chat_id)
    VALUES($1,$2,$3,'fresh','/private/fresh',now(),$4)`,[device,owner,project,chat])
  await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'group','fresh project',$2)",[chat,owner])
  await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member'),($1,$4,'member')",[chat,owner,member,agent])
  return {chat,project}
}

beforeAll(async()=>{
  if(!['127.0.0.1','localhost','[::1]'].includes(new URL(url).hostname)) throw Error('Handoff contracts require an isolated loopback database')
  db=new pg.Client({connectionString:url});await db.connect()
})
afterAll(async()=>{await db?.end()})
beforeEach(async()=>{
  await db.query('BEGIN')
  ;[owner,member,agent,outsider,group,device,item]=Array.from({length:7},randomUUID)
  for(const id of [owner,member,outsider]) await db.query(`INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES($1,'authenticated','authenticated',$2,'{"provider":"email"}','{}',now(),now())`,[id,id+'@handoff.invalid'])
  // The requester's agent lives on the requester's own machine.
  await db.query(`INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform) VALUES($1,$2,'Studio Mac','studio','darwin'),
    ($3,$4,'B laptop','b-laptop','linux')`,[device,owner,'b-'+device,member])
  await db.query("INSERT INTO identity.users(id,type,display_name,owner_user_id,device_id) VALUES($1,'agent','B agent',$2,$3)",[agent,member,'b-'+device])
  await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'group','handoff',$2)",[group,owner])
  await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member'),($1,$4,'member')",[group,owner,member,agent])
  await db.query(`INSERT INTO identity.device_projects(device_id,user_id,local_project_id,name,root_path,created_at,chat_id)
    VALUES($1,$2,'root','fixture','/private/root',now(),$3)`,[device,owner,group])
  const baseline=Number((await db.query("SELECT chat.file_transfer_usage('upload','global','*') AS n")).rows[0].n)
  await db.query("INSERT INTO chat.file_transfer_limits(scope,scope_id,settings) VALUES('global','*',$1) ON CONFLICT(scope,scope_id) DO UPDATE SET settings=EXCLUDED.settings",
    [{...cfg,storage_global_bytes:baseline+cfg.storage_global_bytes}])
  await user()
  await db.query('SELECT chat.file_project_policy_as($1,$2,$3,false,true,$4)',[group,device,'root','7d'])
  await db.query('SELECT chat.file_device_publish($1,$2,$3,$4,$5,$6,$7,$8,NULL,NULL)',[item,group,device,'notes.md',sha,120,'notes.md',type])
})
afterEach(async()=>{await db.query('ROLLBACK')})

describe('asking the host to write a next version',()=>{
  it('opens only the requester\'s and host\'s RPCs to signed-in callers; the rest is the service\'s',async()=>{
    await service()
    for(const permission of ['SELECT','INSERT','UPDATE','DELETE']) for(const role of ['anon','authenticated'])
      expect((await db.query('SELECT has_table_privilege($1,$2,$3) AS ok',[role,'chat.file_version_handoffs',permission])).rows[0].ok).toBe(false)
    const can=async(role:string,fn:string)=>(await db.query("SELECT has_function_privilege($1,$2,'EXECUTE') AS ok",[role,fn])).rows[0].ok
    for(const fn of ['chat.file_version_handoff_request(uuid,uuid,integer,text,text,bigint,text,bigint,bigint,jsonb,text)',
      'chat.file_version_handoff_request(uuid,uuid,integer,text,text,bigint,text,bigint,bigint,jsonb,text,text)','chat.file_version_handoff_pending(text)',
      'chat.file_version_handoff_publish(uuid,text,text,bigint)','chat.file_version_handoff_status(uuid,boolean)','chat.file_project_policy_for(text,text)',
      'file_private.link_project_message(uuid,text)',
      'file_private.publish_revision(uuid,text,text,text,text,bigint,text,text,integer,uuid)']) {
      expect([fn,await can('authenticated',fn),await can('anon',fn)]).toEqual([fn,true,false])
    }
    for(const fn of ['chat.file_version_handoff_upload(uuid,text)','chat.file_version_handoff_commit(uuid,text,text,bigint,text)',
      'chat.file_version_handoff_fetch(uuid,text)','chat.file_version_handoff_expire(integer)','chat.file_version_handoff_host(text)',
      'file_private.publish_revision_by(uuid,text,text,text,text,bigint,text,text,integer,uuid,text)']) {
      expect([fn,await can('authenticated',fn),await can('anon',fn)]).toEqual([fn,false,false])
    }
  })
  it('names the host machine to members, and whether it is online',async()=>{
    await user(member)
    expect((await db.query('SELECT chat.file_project_policy_for($1,$2) AS r',[group,member])).rows[0].r)
      .toMatchObject({host_device_id:device,host_label:'Studio Mac',host_online:true,host_account_id:owner})
  })
  it('gives the requester an upload permit for its encrypted copy, counted like a temporary transfer',async()=>{
    const r=await request()
    expect(r).toMatchObject({status:'uploading',item_id:item,max_bytes:168,host_label:'Studio Mac',host_online:true})
    expect(r.staging_key).toBe(`temporary/handoff/${group}/${item}/${r.handoff_id}`)
    const h=await row(r.handoff_id)
    expect(h).toMatchObject({state:'uploading',base_version:1,requester_account:member,requester_actor:agent,host_device_id:device,data_key:null})
    expect(Number((await db.query('SELECT chat.file_temporary_usage($1) AS n',[group])).rows[0].n)).toBe(168)
  })
  it('holds the provider ceiling only until the copy is committed; then only its stored bytes count', async()=>{
    const r=await request({8:900})
    await service()
    expect(Number((await db.query('SELECT chat.file_temporary_usage($1) AS n',[group])).rows[0].n)).toBe(900)
    await commit(r.handoff_id)
    await service()
    expect((await db.query('SELECT state,actual_bytes FROM chat.file_transfer_reservations WHERE id=$1',[r.handoff_id])).rows[0]).toEqual({state:'settled',actual_bytes:'168'})
    expect(Number((await db.query('SELECT chat.file_temporary_usage($1) AS n',[group])).rows[0].n)).toBe(168)
  })
  it('refuses at once while the host is offline, naming the machine, and writes nothing',async()=>{
    await service();await db.query("UPDATE identity.gugu_devices SET status='offline' WHERE device_id=$1",[device])
    expect(await request()).toEqual({status:'host_offline',item_id:item,host_device_id:device,host_label:'Studio Mac',host_account_id:owner,host_online:false})
    await service()
    expect((await db.query('SELECT count(*)::int AS n FROM chat.file_version_handoffs')).rows[0].n).toBe(0)
  })
  it('answers conflict for a copy of an older version, with the current one',async()=>{
    await user()
    await db.query('SELECT chat.file_device_publish($1,$2,$3,$4,$5,$6,$7,$8,1,NULL)',[item,group,device,'notes.md',sha,121,'notes.md',type])
    expect(await request()).toEqual({status:'conflict',item_id:item,current_version:2})
  })
  it('lets only a member act, as themselves or their own agent',async()=>{
    await user(member)
    expect((await fails(REQUEST,[randomUUID(),item,1,'notes.md',type,140,edited,168,168,{},owner])).message).toMatch(/Not allowed to act/)
    await user(outsider)
    expect((await db.query(REQUEST,[randomUUID(),item,1,'notes.md',type,140,edited,168,168,{},outsider])).rows[0].r).toEqual({status:'gone'})
  })
  it('keeps one identity per request id',async()=>{
    const r=await request()
    expect(await request({0:r.handoff_id})).toMatchObject({handoff_id:r.handoff_id,status:'uploading'})
    expect((await fails(REQUEST,[r.handoff_id,item,1,'notes.md',type,141,edited,168,168,{},agent])).hint).toBe('file_transfer_conflict')
  })
})

describe('a new file message handed to its host (#577)',()=>{
  it('sends the first file in a fresh project group without a host seed or explicit file policy',async()=>{
    const fresh=await freshProject(),args=creationArgs();args[11]=fresh.chat
    // A member also has this group bound locally; it is not authority to choose that member's host.
    await db.query(`INSERT INTO identity.device_projects(device_id,user_id,local_project_id,name,root_path,created_at,chat_id,group_representative)
      VALUES($1,$2,'member-root','member','/private/member',now()-interval '1 day',$3,true)`,['b-'+device,member,fresh.chat])
    expect((await db.query('SELECT id FROM chat.workspace_items WHERE chat_id=$1',[fresh.chat])).rows).toEqual([])
    expect((await db.query('SELECT chat_id FROM chat.file_project_policies WHERE chat_id=$1',[fresh.chat])).rows).toEqual([])
    await user(outsider)
    expect((await fails('SELECT chat.file_project_policy_for($1,$2)',[fresh.chat,outsider])).hint).toBe('workspace_not_member')
    await user(member)
    expect((await fails('SELECT chat.file_project_policy_for($1,$2)',[fresh.chat,owner])).message).toMatch(/Not allowed to act/)
    expect((await db.query('SELECT chat.file_project_policy_for($1,$2) AS r',[fresh.chat,agent])).rows[0].r)
      .toMatchObject({host_device_id:device,host_project_id:fresh.project,host_account_id:owner,host_online:true,proactive_upload:false})
    const r=await create(args);await commit(r.handoff_id)
    expect(await publish(r.handoff_id)).toMatchObject({status:'published',version:1,message:{chat_id:fresh.chat,sender_user_id:agent}})
    await service()
    expect((await db.query('SELECT created_by,updated_by,source_message_ids FROM chat.workspace_items WHERE id=$1',[args[1]])).rows)
      .toEqual([{created_by:agent,updated_by:agent,source_message_ids:[(args[9] as {message_id:string}).message_id]}])
  })
  it('keeps a fresh offline host named, without a placeholder, handoff, upload or permit',async()=>{
    const fresh=await freshProject(),args=creationArgs();args[11]=fresh.chat
    await db.query("UPDATE identity.gugu_devices SET status='offline' WHERE device_id=$1",[device])
    expect(await create(args)).toMatchObject({status:'host_offline',host_device_id:device,host_label:'Studio Mac'})
    await service()
    for(const table of ['file_version_handoffs','file_transfer_reservations'])
      expect((await db.query(`SELECT id FROM chat.${table} WHERE id=$1`,[args[0]])).rows).toEqual([])
    expect((await db.query('SELECT staging_key FROM chat.file_transfer_uploads WHERE reservation_id=$1',[args[0]])).rows).toEqual([])
    expect((await db.query('SELECT id FROM chat.workspace_items WHERE chat_id=$1',[fresh.chat])).rows).toEqual([])
    expect((await db.query('SELECT id FROM chat.messages WHERE chat_id=$1',[fresh.chat])).rows).toEqual([])
  })
  it('does not invent a host for an ordinary group or a project owned only by a member',async()=>{
    await service()
    const chat=randomUUID()
    await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'group','ordinary',$2)",[chat,owner])
    await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')",[chat,owner,member])
    await user(member)
    expect((await db.query('SELECT chat.file_project_policy_for($1,$2) AS r',[chat,member])).rows[0].r).toBeNull()
    await service()
    await db.query(`INSERT INTO identity.device_projects(device_id,user_id,local_project_id,name,root_path,created_at,chat_id)
      VALUES($1,$2,'member-root','member','/private/member',now(),$3)`,['b-'+device,member,chat])
    await user(member)
    expect((await db.query('SELECT chat.file_project_policy_for($1,$2) AS r',[chat,member])).rows[0].r).toBeNull()
    await service()
    expect((await db.query('SELECT chat_id FROM chat.file_project_policies WHERE chat_id=$1',[chat])).rows).toEqual([])
  })
  it('preserves an explicit binding while it is unlisted instead of selecting another project',async()=>{
    await service()
    await db.query(`INSERT INTO identity.device_projects(device_id,user_id,local_project_id,name,root_path,created_at,chat_id,group_representative)
      VALUES($1,$2,'other-root','other','/private/other',now()-interval '1 day',$3,true)`,[device,owner,group])
    await user(member)
    expect((await db.query('SELECT chat.file_project_policy_for($1,$2) AS r',[group,agent])).rows[0].r)
      .toMatchObject({host_project_id:'root'})
    await service();await db.query("DELETE FROM identity.device_projects WHERE device_id=$1 AND local_project_id='root'",[device])
    await user(member)
    expect((await db.query('SELECT chat.file_project_policy_for($1,$2) AS r',[group,agent])).rows[0].r).toBeNull()
    await service()
    expect((await db.query('SELECT host_project_id FROM chat.file_project_policies WHERE chat_id=$1',[group])).rows)
      .toEqual([{host_project_id:'root'}])
  })
  it('uses the published representative when an admin has multiple projects bound to a fresh group',async()=>{
    const fresh=await freshProject()
    await db.query("UPDATE chat.chat_members SET role='admin' WHERE chat_id=$1 AND user_id=$2",[fresh.chat,owner])
    await db.query(`INSERT INTO identity.device_projects(device_id,user_id,local_project_id,name,root_path,created_at,chat_id,group_representative)
      VALUES($1,$2,'representative','representative','/private/representative',now()+interval '1 day',$3,true)`,[device,owner,fresh.chat])
    await user(member)
    expect((await db.query('SELECT chat.file_project_policy_for($1,$2) AS r',[fresh.chat,agent])).rows[0].r)
      .toMatchObject({host_device_id:device,host_project_id:'representative',host_account_id:owner})
  })
  it('uses the fresh host account global storage setting without changing it',async()=>{
    const fresh=await freshProject(),args=creationArgs();args[11]=fresh.chat
    await db.query(`INSERT INTO identity.user_settings(user_id,scope,config) VALUES($1,'user',$2)
      ON CONFLICT(user_id,scope) DO UPDATE SET config=EXCLUDED.config`,[owner,{file_storage:{proactive_upload:true,retention:'1d'}}])
    await user(member)
    expect((await db.query('SELECT chat.file_project_policy_for($1,$2) AS r',[fresh.chat,agent])).rows[0].r)
      .toMatchObject({host_account_id:owner,proactive_upload:true,retention:'1d'})
    expect((await fails(CREATE_REQUEST,args)).hint).toBe('file_transfer_invalid')
    await service()
    expect((await db.query('SELECT id FROM chat.file_transfer_reservations WHERE id=$1',[args[0]])).rows).toEqual([])
  })
  it('creates no placeholder; the same drain publishes v1 and its message as the requester, once',async()=>{
    const args=creationArgs(),r=await create(args),h=await row(r.handoff_id)
    expect(h).toMatchObject({item_id:args[1],base_version:null,requester_actor:agent,requester_account:member})
    expect((await db.query('SELECT 1 FROM chat.workspace_items WHERE id=$1',[args[1]])).rows).toEqual([])
    expect(await create(args)).toMatchObject({handoff_id:r.handoff_id,status:'uploading'})
    await commit(r.handoff_id)
    await service()
    expect((await db.query('SELECT state,actual_bytes FROM chat.file_transfer_reservations WHERE id=$1',[r.handoff_id])).rows)
      .toEqual([{state:'settled',actual_bytes:'168'}])
    await user()
    expect((await db.query('SELECT * FROM chat.file_version_handoff_pending($1)',[device])).rows.map(r=>Object.values(r)[0]))
      .toEqual([expect.objectContaining({id:r.handoff_id,item_id:args[1],base_version:null,relative_path:null,requester_actor:agent})])
    expect(await publish(r.handoff_id)).toMatchObject({status:'published',version:1,
      message:{id:h.message.message_id,sender_user_id:agent,file_item_id:args[1],file_version:1}})
    expect(await publish(r.handoff_id)).toMatchObject({status:'published',version:1})
    await service()
    expect((await db.query('SELECT version,created_by,updated_by,source_message_ids FROM chat.workspace_items WHERE id=$1',[args[1]])).rows)
      .toEqual([{version:1,created_by:agent,updated_by:agent,source_message_ids:[h.message.message_id]}])
    expect((await db.query('SELECT version,host_device_id,sha256 FROM chat.file_device_revisions WHERE item_id=$1',[args[1]])).rows)
      .toEqual([{version:1,host_device_id:device,sha256:edited}])
    expect((await db.query('SELECT id FROM chat.messages WHERE file_item_id=$1',[args[1]])).rows).toEqual([{id:h.message.message_id}])
    expect((await db.query('SELECT 1 FROM chat.file_blob_gc WHERE blob_id=$1',[h.blob_id])).rows).toHaveLength(1)
  })
  it('names an offline host before reserving anything and still enforces current membership and actor ownership',async()=>{
    const args=creationArgs()
    await service();await db.query("UPDATE identity.gugu_devices SET status='offline' WHERE device_id=$1",[device])
    expect(await create(args)).toMatchObject({status:'host_offline',item_id:args[1],host_label:'Studio Mac',host_online:false})
    await service()
    expect((await db.query('SELECT 1 FROM chat.file_transfer_reservations WHERE id=$1',[args[0]])).rows).toEqual([])
    expect((await db.query('SELECT 1 FROM chat.file_version_handoffs WHERE id=$1',[args[0]])).rows).toEqual([])
    await user(member)
    expect((await fails(CREATE_REQUEST,Object.assign([...args],{10:owner}))).message).toMatch(/Not allowed to act/)
    await user(outsider)
    expect((await fails(CREATE_REQUEST,Object.assign([...args],{10:outsider}))).hint).toBe('workspace_not_member')
  })
  it('keeps a topic message in that topic while its file and quota use the source group',async()=>{
    const topic=randomUUID(),anchor=randomUUID()
    await service()
    await db.query("INSERT INTO chat.messages(id,chat_id,sender_user_id,content) VALUES($1,$2,$3,'source')",[anchor,group,owner])
    await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id,source_chat_id,source_message_id) VALUES($1,'topic','files',$2,$3,$4)",[topic,owner,group,anchor])
    await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member'),($1,$4,'member')",[topic,owner,member,agent])
    const args=creationArgs();args[11]=topic
    const r=await create(args)
    // The same source container is not permission to replay into a different message stream.
    expect((await fails(CREATE_REQUEST,Object.assign([...args],{11:group}))).hint).toBe('file_transfer_conflict')
    expect((await row(r.handoff_id)).chat_id).toBe(group)
    await commit(r.handoff_id)
    expect(await publish(r.handoff_id)).toMatchObject({status:'published',version:1,message:{chat_id:topic,file_item_id:args[1]}})
    await service()
    expect((await db.query('SELECT chat_id,source_message_ids FROM chat.workspace_items WHERE id=$1',[args[1]])).rows)
      .toEqual([{chat_id:group,source_message_ids:[(args[9] as {message_id:string}).message_id]}])
  })
  it('binds the new target, metadata and message identity to the request id',async()=>{
    const args=creationArgs();await create(args)
    for(const changes of [{1:item},{3:'renamed.md'},{7:169},{9:{message_id:randomUUID()}}]) {
      await user(member)
      expect((await fails(CREATE_REQUEST,Object.assign([...args],changes))).hint).toBe('file_transfer_conflict')
    }
  })
  it.each(['requester left','host unbound'])('rolls back the new row and message when the %s before publication',async change=>{
    const args=creationArgs(),r=await create(args);await commit(r.handoff_id)
    await service()
    if(change==='requester left') await db.query('DELETE FROM chat.chat_members WHERE chat_id=$1 AND user_id=$2',[group,agent])
    else await db.query('UPDATE identity.device_projects SET chat_id=NULL WHERE device_id=$1',[device])
    await user()
    await fails('SELECT chat.file_version_handoff_publish($1,$2,$3,$4)',[r.handoff_id,'new.md',edited,140])
    await service()
    expect((await db.query('SELECT 1 FROM chat.workspace_items WHERE id=$1',[args[1]])).rows).toEqual([])
    expect((await db.query('SELECT 1 FROM chat.messages WHERE file_item_id=$1',[args[1]])).rows).toEqual([])
  })
  it('cannot replace an item that appeared before the host published the new file',async()=>{
    const args=creationArgs(),r=await create(args);await commit(r.handoff_id)
    await user()
    await db.query('SELECT chat.file_device_publish($1,$2,$3,$4,$5,$6,$7,$8,NULL,NULL)',[args[1],group,device,'original.md',sha,120,'original.md',type])
    expect(await publish(r.handoff_id)).toMatchObject({status:'conflict',current_version:1})
    await service()
    expect((await db.query('SELECT filename,version,created_by FROM chat.workspace_items WHERE id=$1',[args[1]])).rows)
      .toEqual([{filename:'original.md',version:1,created_by:owner}])
  })
  it('never creates a cancelled file when the host takes the request late',async()=>{
    const args=creationArgs(),r=await create(args);await commit(r.handoff_id)
    expect(await status(r.handoff_id,true)).toMatchObject({status:'cancelled',current_version:null})
    expect(await publish(r.handoff_id)).toMatchObject({status:'cancelled'})
    await service()
    expect((await db.query('SELECT 1 FROM chat.workspace_items WHERE id=$1',[args[1]])).rows).toEqual([])
    expect((await db.query('SELECT 1 FROM chat.messages WHERE file_item_id=$1',[args[1]])).rows).toEqual([])
  })
})

describe('the host writes it',()=>{
  it('wakes the host device with the handoff id only, and shows the host what to write without the key',async()=>{
    const id=await ready()
    const events=(await db.query("SELECT topic,payload FROM realtime.messages WHERE event='files.handoff' AND payload->>'handoff_id'=$1",[id])).rows
    expect(events.map(e=>[e.topic,Object.keys(e.payload).sort()])).toEqual([[`gugu:${device}:rpc`,['handoff_id','id']]])
    await user()
    const pending=(await db.query('SELECT * FROM chat.file_version_handoff_pending($1)',[device])).rows.map(r=>Object.values(r)[0])
    expect(pending).toEqual([expect.objectContaining({id,item_id:item,base_version:1,relative_path:'notes.md',sha256:edited,size_bytes:140,requester_actor:agent})])
    expect(JSON.stringify(pending)).not.toContain(key)
    await user(member)
    expect((await fails('SELECT * FROM chat.file_version_handoff_pending($1)',[device])).hint).toBe('file_transfer_denied')
    await service()
    expect((await fails('SELECT chat.file_version_handoff_fetch($1,$2)',[id,member])).hint).toBe('file_transfer_denied')
    expect((await db.query('SELECT chat.file_version_handoff_fetch($1,$2) AS r',[id,owner])).rows[0].r).toMatchObject({key,ciphertext_bytes:168})
  })
  it('records the version as the requester\'s edit and sends it as the requester\'s message',async()=>{
    const id=await ready(),h=await row(id)
    const out=await publish(id)
    expect(out).toMatchObject({status:'published',version:2,host_label:'Studio Mac',
      message:{id:h.message.message_id,sender_user_id:agent,file_item_id:item,file_version:2,sent_by_agent:false}})
    expect(out.message.content).toContain('fixed the typo')
    expect(await current()).toEqual({version:2,updated_by:agent,size_bytes:'140'})
    expect((await row(id))).toMatchObject({state:'published',version:2,data_key:null})
    expect((await db.query('SELECT 1 FROM chat.file_blob_gc WHERE blob_id=$1',[h.blob_id])).rows).toHaveLength(1)
    expect(await status(id)).toMatchObject({status:'published',version:2,current_version:2})
    // Written once: publishing again only reports it.
    expect(await publish(id)).toMatchObject({status:'published',version:2})
    expect((await current()).version).toBe(2)
    expect((await db.query('SELECT source_message_ids FROM chat.workspace_items WHERE id=$1',[item])).rows)
      .toEqual([{source_message_ids:[h.message.message_id]}])
  })
  it('keeps the host\'s own edits recorded as the host\'s',async()=>{
    await service()
    expect((await db.query('SELECT created_by,updated_by FROM chat.workspace_items WHERE id=$1',[item])).rows)
      .toEqual([{created_by:owner,updated_by:null}])
    await user()
    await db.query('SELECT chat.file_device_publish($1,$2,$3,$4,$5,$6,$7,$8,1,NULL)',[item,group,device,'notes.md',sha,121,'notes.md',type])
    expect((await current()).updated_by).toBe(owner)
    await user()
    expect((await fails('SELECT file_private.publish_revision_by($1,$2,$3,$4,$5,$6,$7,$8,2,NULL,$9)',[item,group,device,'notes.md',sha,1,'notes.md',type,agent])).code).toBe('42501')
  })
  it('settles as conflict when the file moved on before the host wrote it, and writes nothing',async()=>{
    const id=await ready()
    await user()
    await db.query('SELECT chat.file_device_publish($1,$2,$3,$4,$5,$6,$7,$8,1,NULL)',[item,group,device,'notes.md',sha,121,'notes.md',type])
    expect(await publish(id)).toMatchObject({status:'conflict',current_version:2})
    expect(await current()).toEqual({version:2,updated_by:owner,size_bytes:'121'})
    expect(await status(id)).toMatchObject({status:'conflict',current_version:2})
  })
  it('refuses bytes that differ from the committed copy, and other hosts',async()=>{
    const id=await ready()
    await user()
    expect((await fails('SELECT chat.file_version_handoff_publish($1,$2,$3,$4)',[id,'x.md',edited,139])).hint).toBe('file_transfer_conflict')
    await user(member)
    expect((await fails('SELECT chat.file_version_handoff_publish($1,$2,$3,$4)',[id,'x.md',edited,140])).hint).toBe('file_transfer_denied')
    expect((await current()).version).toBe(1)
  })
  it('does not write a handoff the requester withdrew, or one past its window',async()=>{
    const withdrawn=await ready()
    expect(await status(withdrawn,true)).toMatchObject({status:'cancelled',current_version:1})
    expect(await publish(withdrawn)).toMatchObject({status:'cancelled'})
    const late=await ready('ce'.repeat(32))
    await service();await db.query("UPDATE chat.file_version_handoffs SET ready_until=now()-interval '1 second' WHERE id=$1",[late])
    expect((await db.query('SELECT chat.file_version_handoff_expire(500) AS n')).rows[0].n).toBe(1)
    expect(await publish(late)).toMatchObject({status:'expired'})
    expect((await current()).version).toBe(1)
    await user()
    expect((await db.query('SELECT * FROM chat.file_version_handoff_pending($1)',[device])).rows).toEqual([])
  })
  it('accepts a commitment only from the requester, once, for the reserved size',async()=>{
    const r=await request()
    await service()
    expect((await fails('SELECT chat.file_version_handoff_commit($1,$2,$3,168,$4)',[r.handoff_id,owner,cipherSha,key])).hint).toBe('file_transfer_denied')
    expect((await fails('SELECT chat.file_version_handoff_commit($1,$2,$3,167,$4)',[r.handoff_id,member,cipherSha,key])).hint).toBe('file_transfer_conflict')
    expect(await commit(r.handoff_id)).toMatchObject({status:'ready'})
    expect(await commit(r.handoff_id)).toMatchObject({status:'ready'})
    await service()
    expect((await fails('SELECT chat.file_version_handoff_commit($1,$2,$3,168,$4)',[r.handoff_id,member,'ee'.repeat(32),key])).hint).toBe('file_transfer_conflict')
  })
})
