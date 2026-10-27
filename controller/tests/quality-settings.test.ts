import { IdentityCrypto } from "../src/identity.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { qualityTargetSchema, qualitySettingsOut } from "../src/quality-settings.js";
import { routePermission, permissionsFor, profiles } from "../src/permissions.js";
import { targetState } from "../../web/src/lib/qualityTarget.js";
test("quality target is a bounded nullable percentage, without coercion or extra keys",()=>{
 for(const target of [0,95,99.9999,100,null]) assert.equal(qualityTargetSchema.parse({row_match_target_percentage:target}).row_match_target_percentage,target);
 for(const target of [-1,100.0001,"95",true,NaN,Infinity,0.12345]) assert.throws(()=>qualityTargetSchema.parse({row_match_target_percentage:target}));
 assert.throws(()=>qualityTargetSchema.parse({}));assert.throws(()=>qualityTargetSchema.parse({row_match_target_percentage:95,other:true}));
 assert.equal(qualitySettingsOut({rowMatchTargetPercentage:null,updatedAt:new Date()}).metric,"row_match_rate");
});
test("all dashboard readers see the target, only quality managers and their supersets can change it",()=>{
 assert.equal(routePermission("get","/api/v1/settings/quality"),"dashboard.read");
 assert.equal(routePermission("patch","/api/v1/settings/quality"),"quality_settings.manage");
 for(const p of profiles){assert.ok(permissionsFor(p).includes("dashboard.read"));assert.equal(permissionsFor(p).includes("quality_settings.manage"),p!=="viewer");}
 for(const path of ["/overview/comparisons","/overview/metric-trend"])assert.equal(routePermission("get","/api/v1"+path),"dashboard.read");
});
test("target assessment does not promote zero-denominator or partial evaluation into target attainment",()=>{
 assert.equal(targetState({percentage:"100",denominator:0},"95").state,"neutral");
 assert.equal(targetState({percentage:null,denominator:5},"0").state,"neutral");
 assert.equal(targetState({percentage:"99",denominator:100,not_evaluated:1},"95").state,"partial");
 assert.equal(targetState({percentage:"95",denominator:100,not_evaluated:0},"95").state,"met");
 assert.equal(targetState({percentage:"94.9999",denominator:100},"95").state,"below");
 assert.equal(targetState({percentage:"100",denominator:100},null).state,"neutral");
 assert.equal(targetState({percentage:"100.0000",numerator:9999999,denominator:10000000},"100").state,"below");
});

// Runs only against the disposable database supplied by the integration harness.
test("real isolated controller: viewer is read-only, target persists and updates are audited atomically", {skip:process.env.DATAQORE_ISOLATED_TEST!=="1"}, async()=>{
 const {database}=await import("../src/db.js"); const {loadConfig}=await import("../src/config.js");
 const {createApp}=await import("../src/app.js");const {Auth,hashPassword}=await import("../src/auth.js");const {randomUUID}=await import("node:crypto");
 const config=loadConfig(), db=database(config.databaseUrl), password="Quality-target-test-password-2026";
 const users:string[]=[],groups:string[]=[];
 const original=await db.qualitySettings.findUniqueOrThrow({where:{id:true}});
 const {app,auth}=await createApp(config,db), server=app.getHttpAdapter().getInstance();
 try{
  const tokens:Record<string,string>={};
  for(const profile of ["viewer","quality_manager"]){
   const group=await db.accessGroup.create({data:{name:`Target test ${randomUUID()}`,profile}});groups.push(group.id);
   const user=await db.user.create({data:{...new IdentityCrypto(loadConfig().identityKey).seal(`${randomUUID()}@target.test`,profile),groupId:group.id,passwordHash:await hashPassword(password)}});users.push(user.id);
   tokens[profile]=(await auth.login({email:new IdentityCrypto(loadConfig().identityKey).open(user).email,password},randomUUID())).body.access_token;
  }
  const request=(profile:string,method:"GET"|"PATCH",payload?:unknown)=>server.inject({method,url:"/api/v1/settings/quality",headers:{authorization:`Bearer ${tokens[profile]}`},...(payload===undefined?{}:{payload})});
  assert.equal((await request("viewer","GET")).statusCode,200);
  assert.equal((await request("viewer","PATCH",{row_match_target_percentage:1})).statusCode,403);
  assert.equal((await request("quality_manager","PATCH",{row_match_target_percentage:101})).statusCode,422);
  for(const target of [99.7,null,0,100]){
   const response=await request("quality_manager","PATCH",{row_match_target_percentage:target});assert.equal(response.statusCode,200,response.body);
   const saved=(await request("viewer","GET")).json();assert.equal(saved.row_match_target_percentage==null?null:Number(saved.row_match_target_percentage),target);
  }
  assert.equal(await db.auditLog.count({where:{action:"quality_target_updated",actorUserId:{in:users}}}),4);
 }finally{
  await app.close();await db.qualitySettings.update({where:{id:true},data:{rowMatchTargetPercentage:original.rowMatchTargetPercentage,updatedAt:original.updatedAt}});
  await db.user.deleteMany({where:{id:{in:users}}});await db.accessGroup.deleteMany({where:{id:{in:groups}}});await db.$disconnect();
 }
});
