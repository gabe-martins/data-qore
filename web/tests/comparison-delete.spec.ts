import {test,expect,type Page,type APIRequestContext} from "@playwright/test";
test.skip(process.env.DATAQORE_ISOLATED_TEST!=="1","Use the disposable full-stack fixture.");
async function setup(request:APIRequestContext,name:string){
  const base=process.env.DATAQORE_CONTROLLER_URL!+"/api/v1";
  const login=await request.post(base+"/auth/login",{headers:{Origin:process.env.WEB_ORIGIN!},data:{email:"admin@dataqore.test",password:"DataQore-test-password-2026"}});
  expect(login.status()).toBe(200);
  const headers={Authorization:"Bearer "+(await login.json()).access_token};
  const post=async(path:string,data:unknown,status=201)=>{const response=await request.post(base+path,{headers,data});expect(response.status(),await response.text()).toBe(status);return response.json();};
  const connections:string[]=[],datasets:string[]=[];
  for(const side of ["left","right"]){
    const connection=await post("/connections",{name:name+" "+side,connector:"sqlite",credentials:{database:side+".sqlite"}});connections.push(connection.id);
    datasets.push((await post("/datasets",{connection_id:connection.id,table_name:"records"})).id);
  }
  const comparison=await post("/comparisons",{name,left_dataset_id:datasets[0],right_dataset_id:datasets[1]});
  return {base,headers,post,comparison,connections,datasets};
}
async function login(page:Page,name:string){
  await page.goto("/");await page.getByLabel("Email",{exact:true}).fill("admin@dataqore.test");
  await page.getByLabel("Password",{exact:true}).fill("DataQore-test-password-2026");
  await page.getByRole("button",{name:"Sign in",exact:true}).click();
  await expect(page.getByRole("heading",{name:"Overview",exact:true})).toBeVisible();
  await page.getByRole("link",{name:"Comparisons",exact:true}).click();
  await page.getByLabel("Search comparisons").fill(name);
  await expect(page.getByRole("link",{name,exact:true})).toBeVisible();
  return page.locator("section.card").filter({has:page.getByRole("heading",{name,exact:true})}).getByRole("button",{name:"Delete",exact:true});
}
async function finish(request:APIRequestContext,api:Awaited<ReturnType<typeof setup>>,id:string){
  await expect.poll(async()=>{const r=await request.get(api.base+`/runs/${id}`,{headers:api.headers});return(await r.json()).status;},{timeout:20000}).toBe("succeeded");
}

test("deletion from details removes comparison history, preserves individual profiles and restores focus",async({page,request})=>{
  const api=await setup(request,"Comparison deletion history "+"X".repeat(80));
  const profile=await api.post(`/datasets/${api.datasets[0]}/profile-runs`,{},202);await finish(request,api,profile.id);
  const run=await api.post(`/comparisons/${api.comparison.id}/runs`,{},202);await finish(request,api,run.id);
  await login(page,api.comparison.name);
  await page.getByRole("link",{name:api.comparison.name,exact:true}).click();
  const trigger=page.getByRole("button",{name:"Delete",exact:true});
  await trigger.click();const dialog=page.getByRole("dialog");
  const confirm=dialog.getByRole("button",{name:"Delete comparison and run history",exact:true});
  await expect(confirm).toBeEnabled();
  await expect(dialog.getByRole("region",{name:"Comparison execution history"}).getByText("Results",{exact:true}).locator("..")).toHaveText("Results1");
  await expect(dialog.getByRole("status")).toContainText("cannot be undone");
  await page.screenshot({path:"test-results/comparison-delete-history-desktop.png",fullPage:true});
  await page.keyboard.press("Escape");await expect(trigger).toBeFocused();
  await page.getByRole("button",{name:"Theme",exact:true}).click();await page.getByRole("radio",{name:"Dark",exact:true}).check();await page.keyboard.press("Escape");
  await trigger.click();await page.setViewportSize({width:320,height:844});await confirm.scrollIntoViewIfNeeded();
  expect(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:"test-results/comparison-delete-history-mobile-dark.png",fullPage:true});
  let deletes=0;
  await page.route(`**/api/v1/comparisons/${api.comparison.id}`,async route=>{
    if(route.request().method()!=="DELETE")return route.continue();deletes++;
    const response=await route.fetch();await new Promise(r=>setTimeout(r,250));await route.fulfill({response});
  });
  await confirm.evaluate((button:HTMLButtonElement)=>{button.click();button.click();});
  await expect(dialog.getByRole("button",{name:"Deleting…",exact:true})).toBeDisabled();
  await expect(dialog).not.toBeVisible();await expect(page).toHaveURL(/\/comparisons$/);expect(deletes).toBe(1);
  await expect(page.getByLabel("Search comparisons")).toBeFocused();
  for(const path of [`/comparisons/${api.comparison.id}`,`/runs/${run.id}`,`/runs/${run.id}/result`])expect((await request.get(api.base+path,{headers:api.headers})).status()).toBe(404);
  expect((await request.get(api.base+`/runs/${profile.id}/result`,{headers:api.headers})).status()).toBe(200);
  for(const id of api.datasets){expect((await request.get(api.base+`/datasets/${id}`,{headers:api.headers})).status()).toBe(200);expect((await request.delete(api.base+`/datasets/${id}`,{headers:api.headers,data:{}})).status()).toBe(200);}
  for(const id of api.connections)expect((await request.delete(api.base+`/connections/${id}`,{headers:api.headers,data:{}})).status()).toBe(200);
});

test("comparison card lists paused schedules with pagination and blocks deletion",async({page,request})=>{
  const api=await setup(request,"Comparison deletion schedules");
  for(let i=0;i<21;i++)await api.post("/schedules",{name:`Comparison delete schedule ${String(i).padStart(2,"0")}`,comparison_id:api.comparison.id,cron_expression:"0 0 * * *",timezone:"UTC",is_active:false});
  const trigger=await login(page,api.comparison.name);await trigger.click();
  const dialog=page.getByRole("dialog"),schedules=dialog.getByRole("region",{name:"Linked schedules"});
  await expect(schedules.getByRole("heading")).toHaveText("Schedules (21)");
  await expect(schedules.getByRole("link")).toHaveCount(20);await expect(schedules.getByText("inactive",{exact:true})).toHaveCount(20);
  await expect(dialog.getByRole("button",{name:"Delete comparison and run history",exact:true})).toBeDisabled();
  await schedules.getByRole("button",{name:"Next",exact:true}).click();await expect(schedules.getByRole("link")).toHaveCount(1);
  await expect(schedules.getByRole("link")).toHaveAttribute("href",`/schedules?comparison_id=${api.comparison.id}`);
  await page.screenshot({path:"test-results/comparison-delete-blocked-schedules.png",fullPage:true});
  await page.keyboard.press("Escape");await expect(trigger).toBeFocused();
});

test("comparison deletion recovers from query errors and refreshes schedules on conflict",async({page,request})=>{
  const api=await setup(request,"Comparison deletion conflict");
  const trigger=await login(page,api.comparison.name);let checks=0;
  await page.route(`**/api/v1/comparisons/${api.comparison.id}/dependencies?*`,route=>++checks===1?route.fulfill({status:503,json:{message:"Dependency check unavailable.",code:"storage_unavailable"}}):route.continue());
  await trigger.click();const dialog=page.getByRole("dialog"),confirm=dialog.getByRole("button",{name:"Delete comparison and run history",exact:true});
  await expect(dialog.getByRole("alert")).toContainText("Dependency check unavailable.");await expect(confirm).toBeDisabled();
  await dialog.getByRole("button",{name:"Retry dependency check",exact:true}).click();await expect(confirm).toBeEnabled();
  const schedule=await api.post("/schedules",{name:"Comparison deletion newly scheduled",comparison_id:api.comparison.id,cron_expression:"0 0 * * *",timezone:"UTC",is_active:false});
  await confirm.click();await expect(dialog.getByRole("alert")).toContainText("current or historical schedules");
  await expect(dialog.getByRole("link",{name:schedule.name,exact:true})).toBeVisible();await expect(confirm).toBeDisabled();
});
