import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const url=process.env.GUGU_INTEGRATION_DATABASE_URL??''
let db:pg.Client, owner:string, member:string, outsider:string, group:string, device:string, otherDevice:string, item:string
const sha='ab'.repeat(32), type='application/octet-stream'
const POLICY='SELECT chat.file_project_policy_as($1,$2,$3,$4,$5,$6) AS r'
const PUBLISH='SELECT chat.file_device_publish($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS r'
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
const args=(overrides:Record<number,unknown>={})=>Object.assign([item,group,device,'data/file.bin',sha,123,'file.bin',type,null,null],overrides)
async function publish(overrides:Record<number,unknown>={}) {return (await db.query(PUBLISH,args(overrides))).rows[0].r}
async function resolve(ref:unknown={item_id:item},actor=member) {
  await user(actor)
  return (await db.query('SELECT chat.file_resolve_as($1,$2) AS r',[ref,actor])).rows[0].r
}
beforeAll(async()=>{
  if(!['127.0.0.1','localhost','[::1]'].includes(new URL(url).hostname)) throw Error('Project revision contracts require an isolated loopback database')
  db=new pg.Client({connectionString:url});await db.connect()
})
afterAll(async()=>{await db?.end()})
beforeEach(async()=>{
  await db.query('BEGIN')
  ;[owner,member,outsider,group,device,otherDevice,item]=Array.from({length:7},randomUUID)
  for(const id of [owner,member,outsider]) await db.query(`INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES($1,'authenticated','authenticated',$2,'{"provider":"email"}','{}',now(),now())`,[id,id+'@project-files.invalid'])
  await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'group','project revision',$2)",[group,owner])
  // Membership predates binding: existing project members retain their normal read scope.
  await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')",[group,owner,member])
  for(const [id,account] of [[device,owner],[otherDevice,member]]) await db.query(`INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform)
    VALUES($1,$2,'fixture','fixture','linux')`,[id,account])
  await db.query(`INSERT INTO identity.device_projects(device_id,user_id,local_project_id,name,root_path,created_at,chat_id)
    VALUES($1,$2,'root','fixture','/private/root',now(),$3)`,[device,owner,group])
  await user()
  await db.query(POLICY,[group,device,'root',false,true,'7d'])
})
afterEach(async()=>{await db.query('ROLLBACK')})

describe('project local metadata, exact references and read-only host ownership',()=>{
  it('keeps defaults local and exposes policy only through the existing membership and actor gates',async()=>{
    await user(member)
    expect((await db.query('SELECT chat.file_project_policy_for($1,$2) AS r',[group,member])).rows[0].r)
      .toMatchObject({proactive_upload:false,temporary_transfer:true,retention:'7d',host_device_id:device,host_project_id:'root'})
    expect((await fails(POLICY,[group,device,'root',true,true,'1d'])).hint).toBe('file_transfer_denied')
    expect((await fails('SELECT chat.file_project_policy_for($1,$2)',[group,owner])).message).toMatch(/Not allowed to act/)
    await user(outsider)
    expect((await fails('SELECT chat.file_project_policy_for($1,$2)',[group,outsider])).message).toBeTruthy()
    await user()
    for(const retention of ['read-once','1d','7d','30d']) expect((await db.query(POLICY,[group,device,'root',false,false,retention])).rows[0].r.retention).toBe(retention)
    expect((await fails(POLICY,[group,device,'root',false,true,'forever'])).code).toBe('23514')
    expect((await fails(POLICY,[group,device,'root',null,true,'7d'])).code).toBe('23502')
    expect((await fails(POLICY,[group,otherDevice,'root',false,true,'7d'])).hint).toBe('file_transfer_denied')
    expect((await fails(POLICY,[group,device,'unbound',false,true,'7d'])).hint).toBe('file_transfer_denied')
  })
  it('publishes immutable device/project/path/SHA metadata, without a cloud blob, URL, key or absolute root',async()=>{
    expect(await publish()).toMatchObject({item_id:item,version:1,sha256:sha,size_bytes:123})
    const local=await resolve()
    expect(local).toMatchObject({status:'ready',source:'local',item_id:item,version:1,sha256:sha,size_bytes:123,
      host_device_id:device,host_project_id:'root',host_account_id:owner,relative_path:'data/file.bin'})
    for(const field of ['url','data_key','root_path','download_id','storage_id']) expect(local[field]).toBeUndefined()
    await service()
    expect((await db.query('SELECT blob_id FROM chat.workspace_items WHERE id=$1',[item])).rows[0].blob_id).toBeNull()
    expect((await db.query('SELECT id FROM chat.file_transfer_storage WHERE blob_id IN (SELECT blob_id FROM chat.workspace_items WHERE id=$1)',[item])).rows).toEqual([])
    expect(await resolve({item_id:item},outsider)).toEqual({status:'gone'})
  })
  it('rejects traversal, ambiguous platform paths, invalid SHA and sizes atomically; Unicode and empty files remain valid',async()=>{
    for(const path of ['/etc/passwd','../secret','a/../../secret','a/./b','a//b','a/','C:/secret','C:secret','a\\b','\\\\server\\file','a\nb','']) {
      expect((await fails(PUBLISH,args({3:path}))).code,path).toBe('23514')
      expect((await db.query('SELECT id FROM chat.workspace_items WHERE id=$1',[item])).rows).toEqual([])
    }
    for(const invalid of [{4:'XX'.repeat(32)},{4:'ab'},{5:-1},{7:''}]) expect((await fails(PUBLISH,args(invalid))).code).toBe('23514')
    await publish({3:'资料/空文件.txt',5:0,6:'空文件.txt'})
    expect(await resolve()).toMatchObject({relative_path:'资料/空文件.txt',size_bytes:0})
  })
  it('requires the exact bound owner device and optimistic version, retaining old file names and hashes',async()=>{
    await user(member)
    expect((await fails(PUBLISH,args({2:otherDevice}))).hint).toBe('file_transfer_denied')
    await user()
    await publish()
    expect((await fails(PUBLISH,args())).hint).toBe('file_transfer_conflict')
    expect((await fails(PUBLISH,args({8:99}))).hint).toBe('file_transfer_conflict')
    await publish({3:'data/new.bin',4:'cd'.repeat(32),5:456,6:'new.bin',8:1})
    expect(await resolve({item_id:item})).toMatchObject({version:2,file_name:'new.bin',sha256:'cd'.repeat(32),size_bytes:456})
    expect(await resolve({item_id:item,version:1})).toMatchObject({version:1,file_name:'file.bin',sha256:sha,size_bytes:123})
    expect(await resolve({item_id:item,version:3})).toEqual({status:'gone'})
  })
  it('preserves the real message pin and refuses retracted or hidden messages even when an item is readable',async()=>{
    await publish()
    // Use the production envelope to exercise the same send trigger as a client.
    await service()
    const envelope=(await db.query('SELECT chat.workspace_version_envelope($1,1) AS e',[item])).rows[0].e
    const id=randomUUID()
    await user()
    await db.query(`SELECT * FROM chat.send_message_idempotent($1,$2,$3,'{}',$4,'attachment',NULL,NULL,false,false,NULL,$5,1)`,[id,group,owner,envelope,item])
    await publish({3:'data/new.bin',4:'cd'.repeat(32),5:456,6:'new.bin',8:1})
    expect(await resolve({message_id:id})).toMatchObject({version:1,sha256:sha,file_name:'file.bin'})
    await service();await db.query('UPDATE chat.messages SET retracted_at=now() WHERE id=$1',[id])
    expect(await resolve({message_id:id})).toEqual({status:'gone'})
    await user()
    const hidden=randomUUID()
    await db.query('INSERT INTO chat.messages(id,chat_id,sender_user_id,content,is_whisper,to_user_ids) VALUES($1,$2,$3,$4,true,$5)',[hidden,group,owner,'private', [owner]])
    expect(await resolve({message_id:hidden})).toEqual({status:'gone'})
    expect(await resolve({item_id:item})).toMatchObject({status:'ready'})
  })
  it('rejects alternate or malformed reference shapes without manufacturing broader authority',async()=>{
    await publish();await user(member)
    for(const ref of [null,[],{}, {item_id:item,message_id:randomUUID()},{item_id:item,version:0},{item_id:item,version:1.5},
      {item_id:item,version:'1'},{item_id:item,version:1000000000},{item_id:item,path:'../secret'},{attachment_id:randomUUID(),item_id:item}]) {
      expect((await fails('SELECT chat.file_resolve_as($1,$2)',[ref,member])).hint).toBe('file_transfer_invalid')
    }
    expect(await resolve({item_id:'bad-id'})).toEqual({status:'gone'})
    expect(await resolve()).toMatchObject({status:'ready'})
  })
  it('blocks existing mutation APIs for remote readers and stops owner metadata edits that omit a published revision',async()=>{
    await publish();await user(member)
    expect((await fails('SELECT * FROM chat.workspace_move_as($1,$2,NULL,$3)',[item,member,'renamed.bin'])).hint).toBe('file_transfer_read_only')
    await user()
    expect((await fails('SELECT * FROM chat.workspace_move_as($1,$2,NULL,$3)',[item,owner,'renamed.bin'])).hint).toBe('file_transfer_read_only')
    await publish({3:'data/renamed.bin',6:'renamed.bin',8:1})
    expect(await resolve()).toMatchObject({version:2,file_name:'renamed.bin'})
  })
  it('invalidates an unbound project even if its policy row survives; removal cascades policy but preserves a tombstone',async()=>{
    await publish();await service()
    await db.query('UPDATE identity.device_projects SET chat_id=NULL WHERE device_id=$1',[device])
    expect(await resolve()).toEqual({status:'gone'})
    await service();await db.query('UPDATE identity.device_projects SET chat_id=$2 WHERE device_id=$1',[device,group])
    expect(await resolve()).toMatchObject({status:'ready'})
    await service();await db.query('DELETE FROM identity.device_projects WHERE device_id=$1',[device])
    expect(await resolve()).toEqual({status:'gone'})
    await service()
    expect((await db.query('SELECT item_id FROM chat.file_device_revisions WHERE item_id=$1',[item])).rows).toHaveLength(1)
    expect((await db.query('SELECT chat_id FROM chat.file_project_policies WHERE chat_id=$1',[group])).rows).toEqual([])
  })
  it('does not convert an existing document or cross-group item into a local file',async()=>{
    await service()
    await db.query("INSERT INTO chat.workspace_items(id,chat_id,kind,filename,content_type,created_by) VALUES($1,$2,'document','doc.md','text/markdown',$3)",[item,group,owner])
    await user()
    expect((await fails(PUBLISH,args({8:1}))).hint).toBe('file_transfer_conflict')
    expect((await db.query('SELECT kind FROM chat.workspace_items WHERE id=$1',[item])).rows[0].kind).toBe('document')
  })
  it('continues to resolve existing managed files through their original ACL and distinguishes expired references',async()=>{
    await service()
    const object=group+'/'+owner+'/'+randomUUID()+'.bin'
    await db.query("INSERT INTO storage.objects(bucket_id,name,metadata) VALUES('workspace',$1,$2)",[object,{size:123,mimetype:type}])
    await db.query(`INSERT INTO chat.workspace_items(id,chat_id,kind,filename,content_type,size_bytes,created_by,blob_id)
      VALUES($1,$2,'file','managed.bin',$3,123,$4,chat.file_blob_for_pointer($5,123,$3,$4))`,[item,group,type,owner,object])
    expect(await resolve()).toMatchObject({status:'ready',source:'managed-object',object_name:object})
    expect(await resolve({item_id:item},outsider)).toEqual({status:'gone'})
    await service();await db.query('UPDATE chat.file_transfer_storage_refs SET expired_at=now() WHERE chat_id=$1',[group])
    expect(await resolve()).toMatchObject({status:'expired',source:'managed-object'})
  })
  it('has no direct API table access or public helper grants; intended metadata APIs remain authenticated',async()=>{
    await service()
    for(const role of ['anon','authenticated']) for(const table of ['file_project_policies','file_device_revisions']) {
      for(const permission of ['SELECT','INSERT','UPDATE','DELETE']) expect((await db.query('SELECT has_table_privilege($1,$2,$3) AS ok',[role,'chat.'+table,permission])).rows[0].ok).toBe(false)
    }
    for(const signature of ['file_project_policy_as(text,text,text,boolean,boolean,text)','file_project_policy_for(text,text)',
      'file_device_publish(uuid,text,text,text,text,bigint,text,text,integer,uuid)','file_resolve_as(jsonb,text)']) {
      expect((await db.query("SELECT has_function_privilege('authenticated',$1,'EXECUTE') AS ok",['chat.'+signature])).rows[0].ok).toBe(true)
      expect((await db.query("SELECT has_function_privilege('anon',$1,'EXECUTE') AS ok",['chat.'+signature])).rows[0].ok).toBe(false)
    }
    expect((await db.query("SELECT has_function_privilege('authenticated','chat.file_device_read_only()','EXECUTE') AS ok")).rows[0].ok).toBe(false)
  })
})
