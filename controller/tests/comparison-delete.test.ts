import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { loadConfig } from "../src/config.js";
import { database } from "../src/db.js";
import { createApp } from "../src/app.js";
import { Auth } from "../src/auth.js";
const isolated=process.env.DATAQORE_ISOLATED_TEST==="1";
const config=isolated?loadConfig():null;
const db=config?database(config.databaseUrl):null;
after(async()=>{await db?.$disconnect();});

test("comparison deletion guards schedules, historical dispatches, pagination, auth and audit",{skip:!isolated},async()=>{
  const base=process.env.DATAQORE_CONTROLLER_URL!+"/api/v1";
  const login=await fetch(base+"/auth/login",{method:"POST",headers:{Origin:config!.webOrigin,"Content-Type":"application/json"},
    body:JSON.stringify({email:"admin@dataqore.test",password:"DataQore-test-password-2026"})});
  assert.equal(login.status,200);
  const headers={Authorization:"Bearer "+(await login.json()).access_token,"Content-Type":"application/json"};
  async function post(path:string,body:unknown){const r=await fetch(base+path,{method:"POST",headers,body:JSON.stringify(body)});assert.equal(r.status,201,await r.clone().text());return r.json();}
  const connections=[],datasets=[],comparisons=[],schedules=[];
  for(const side of ["left","right"]){
    const connection=await post("/connections",{name:"Delete-controller-"+side,connector:"sqlite",credentials:{database:side+".sqlite"}});connections.push(connection.id);
    datasets.push((await post("/datasets",{connection_id:connection.id,table_name:"records"})).id);
  }
  for(const name of ["scheduled","other"])comparisons.push((await post("/comparisons",{name:"Delete-controller-"+name,left_dataset_id:datasets[0],right_dataset_id:datasets[1]})).id);
  const path=`/comparisons/${comparisons[0]}`;
  try {
    assert.equal((await fetch(base+path,{method:"DELETE",headers:{"Content-Type":"application/json"},body:"{}"})).status,401);
    assert.equal((await fetch(base+path+"/dependencies")).status,401);
    assert.equal((await fetch(base+`/comparisons/${randomUUID()}`,{method:"DELETE",headers,body:"{}"})).status,404);
    for(let n=0;n<21;n++)schedules.push((await post("/schedules",{name:`Delete-controller schedule ${String(n).padStart(2,"0")}`,comparison_id:comparisons[0],cron_expression:"0 0 * * *",timezone:"UTC",is_active:false})).id);
    const preview=await (await fetch(base+path+"/dependencies?schedule_limit=1",{headers})).json();
    assert.equal(preview.schedules.total,21);assert.equal(preview.schedules.items.length,1);assert.equal(preview.can_delete,false);
    const second=await (await fetch(base+path+"/dependencies?schedule_limit=1&schedule_offset=1",{headers})).json();
    assert.notEqual(second.schedules.items[0].id,preview.schedules.items[0].id);
    for(const q of ["schedule_limit=0","schedule_limit=201","schedule_offset=-1"])assert.equal((await fetch(base+path+"/dependencies?"+q,{headers})).status,422);
    for(const scheduleId of schedules.slice(0,2))await db!.scheduleDispatch.create({data:{scheduleId,comparisonId:comparisons[0],scheduledFor:new Date(),status:"skipped",finishedAt:new Date()}});
    const moved=await fetch(base+`/schedules/${schedules[0]}`,{method:"PATCH",headers,body:JSON.stringify({comparison_id:comparisons[1]})});assert.equal(moved.status,200,await moved.clone().text());
    const historical=await (await fetch(base+path+"/dependencies?schedule_limit=200",{headers})).json();
    assert.equal(historical.schedules.total,21);
    const old=historical.schedules.items.find((s:any)=>s.id===schedules[0]);assert.equal(old.current,false);assert.equal(old.historical,true);
    assert.equal(historical.schedules.items.filter((s:any)=>s.id===schedules[1]).length,1);
    const blocked=await fetch(base+path,{method:"DELETE",headers,body:"{}"});assert.equal(blocked.status,409);assert.equal((await blocked.json()).code,"comparison_scheduled");
    assert.equal(await db!.schedule.count({where:{id:{in:schedules}}}),21);assert.equal(await db!.scheduleDispatch.count({where:{scheduleId:{in:schedules}}}),2);
    // Only disposable fixtures are cleaned here. Product deletion preserves schedules.
    await db!.schedule.deleteMany({where:{id:{in:schedules}}});
    const removed=await fetch(base+path,{method:"DELETE",headers,body:"{}"});assert.equal(removed.status,200);assert.deepEqual(await removed.json(),{id:comparisons[0],status:"deleted"});
    assert.equal((await fetch(base+path,{method:"DELETE",headers,body:"{}"})).status,404);
    assert.ok(await db!.auditLog.count({where:{action:"delete:/v1/comparisons/{identifier}",outcome:"success",resourceId:comparisons[0]}}));
  }finally{
    await db!.schedule.deleteMany({where:{id:{in:schedules}}});
    for(const id of comparisons)await fetch(base+`/comparisons/${id}`,{method:"DELETE",headers,body:"{}"});
    for(const id of datasets)await fetch(base+`/datasets/${id}`,{method:"DELETE",headers,body:"{}"});
    for(const id of connections)await fetch(base+`/connections/${id}`,{method:"DELETE",headers,body:"{}"});
  }
});

test("schedule creation and editing serialize with deletion in both orders",{skip:!isolated},async()=>{
  const auth=new Auth(db!,config!);
  const login=await auth.login({email:"admin@dataqore.test",password:"DataQore-test-password-2026"},randomUUID());
  const headers={authorization:"Bearer "+login.body.access_token};
  for(const mutation of ["create","edit"]){
    for(const first of ["delete","schedule"]){
      const target=randomUUID(),other=randomUUID();let exists=true,deleteCalls=0;
      let entered!:()=>void,release!:()=>void;
      const held=new Promise<void>(resolve=>{entered=resolve;});const gate=new Promise<void>(resolve=>{release=resolve;});
      const source=createServer(async(req,res)=>{
        assert.equal(req.headers["x-api-key"],config!.engineKey);
        if((first==="delete"&&req.method==="DELETE")||(first==="schedule"&&req.method==="GET")){entered();await gate;}
        res.setHeader("Content-Type","application/json");
        if(req.method==="DELETE"){deleteCalls++;exists=false;res.end(JSON.stringify({id:target,status:"deleted"}));}
        else if(exists)res.end(JSON.stringify({id:target,is_active:true}));
        else {res.statusCode=404;res.end(JSON.stringify({code:"not_found"}));}
      });
      source.listen(0,"127.0.0.1");await once(source,"listening");
      const port=(source.address() as {port:number}).port;
      const {app}=await createApp({...config!,engineUrl:`http://127.0.0.1:${port}`},db!);
      const server=app.getHttpAdapter().getInstance();
      let existing:string|undefined;
      if(mutation==="edit")existing=(await db!.schedule.create({data:{name:"Deletion race edit",comparisonId:other,cronExpression:"0 0 * * *",timezone:"UTC",isActive:false,nextRunAt:new Date(Date.now()+86400000)}})).id;
      const change=()=>server.inject({method:mutation==="create"?"POST":"PATCH",url:mutation==="create"?"/api/v1/schedules":`/api/v1/schedules/${existing}`,headers,
        payload:mutation==="create"?{name:"Deletion race create",comparison_id:target,cron_expression:"0 0 * * *",timezone:"UTC",is_active:false}:{comparison_id:target}});
      const remove=()=>server.inject({method:"DELETE",url:`/api/v1/comparisons/${target}`,headers,payload:{}});
      try {
        const a=first==="delete"?remove():change();
        await held;
        const b=first==="delete"?change():remove();
        let waiting=false;
        for(let n=0;n<100;n++){
          const rows=await db!.$queryRaw<{waiting:boolean}[]>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%pg_advisory_xact_lock%') AS waiting`;
          if(rows[0].waiting){waiting=true;break;}await new Promise(r=>setTimeout(r,20));
        }
        release();
        const [one,two]=await Promise.all([a,b]);
        assert.equal(waiting,true,"Competing mutation must wait for the shared comparison lock");
        if(first==="delete"){
          assert.equal(one.statusCode,200,one.body);assert.equal(two.statusCode,404,two.body);assert.equal(deleteCalls,1);
          assert.equal(await db!.schedule.count({where:{comparisonId:target}}),0);
        }else{
          assert.equal(one.statusCode,mutation==="create"?201:200,one.body);assert.equal(two.statusCode,409,two.body);assert.equal(deleteCalls,0);
        }
      }finally{
        release();await app.close();await new Promise<void>(resolve=>source.close(()=>resolve()));
        await db!.schedule.deleteMany({where:{comparisonId:{in:[target,other]}}});
      }
    }
  }
});
