import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
test.skip(process.env.DATAQORE_ISOLATED_TEST !== "1", "Use the disposable full-stack fixture.");

async function setup(request:APIRequestContext,name:string) {
  const base=process.env.DATAQORE_CONTROLLER_URL!+"/api/v1";
  const login=await request.post(base+"/auth/login",{headers:{Origin:process.env.WEB_ORIGIN!},
    data:{email:"admin@dataqore.test",password:"DataQore-test-password-2026"}});
  expect(login.status()).toBe(200);
  const headers={Authorization:"Bearer "+(await login.json()).access_token};
  async function post(path:string,data:unknown,status=201) {
    const response=await request.post(base+path,{headers,data});
    expect(response.status(),await response.text()).toBe(status);
    return response.json();
  }
  const connection=await post("/connections",{name,connector:"sqlite",credentials:{database:"left.sqlite"}});
  const dataset=await post("/datasets",{connection_id:connection.id,table_name:"records"});
  return {base,headers,post,connection,dataset};
}
async function openCatalog(page:Page,id:string) {
  await page.goto("/");
  await page.getByLabel("Email",{exact:true}).fill("admin@dataqore.test");
  await page.getByLabel("Password",{exact:true}).fill("DataQore-test-password-2026");
  await page.getByRole("button",{name:"Sign in",exact:true}).click();
  await expect(page.getByRole("heading",{name:"Overview",exact:true})).toBeVisible();
  await page.getByRole("link",{name:"Catalog",exact:true}).click();
  const registered=page.locator("section.card").filter({has:page.getByRole("heading",{name:"Registered datasets",exact:true})});
  const link=registered.locator(`a[href="/datasets/${id}"]`);
  for(let attempt=0;attempt<10;attempt++) {
    await expect(registered.getByRole("table")).toBeVisible();
    if(await link.count())break;
    const response=page.waitForResponse(r=>r.request().method()==="GET" && /\/api\/v1\/datasets\?/.test(r.url()));
    await registered.getByRole("button",{name:"Next",exact:true}).click();
    await response;
  }
  await expect(link).toBeVisible();
  return link.locator("xpath=ancestor::tr").getByRole("button",{name:"Delete",exact:true});
}

test("Catalog deletion shows current and inactive comparisons, pagination and preserves schedules",async({page,request})=>{
  const api=await setup(request,"Dataset deletion linked");
  const rightConnection=await api.post("/connections",{name:"Dataset deletion other",connector:"sqlite",credentials:{database:"right.sqlite"}});
  const right=await api.post("/datasets",{connection_id:rightConnection.id,table_name:"records"});
  let first:any;
  for(let i=0;i<21;i++) {
    const comparison=await api.post("/comparisons",{name:`Dataset delete linked ${String(i).padStart(2,"0")}`,left_dataset_id:api.dataset.id,right_dataset_id:right.id});
    if(i%2)expect((await request.patch(api.base+`/comparisons/${comparison.id}`,{headers:api.headers,data:{is_active:false}})).status()).toBe(200);
    if(!i)first=comparison;
  }
  const schedule=await api.post("/schedules",{name:"Dataset deletion preserved schedule",comparison_id:first.id,cron_expression:"0 0 * * *",timezone:"UTC",is_active:false});
  const trigger=await openCatalog(page,api.dataset.id);
  await trigger.click();
  const dialog=page.getByRole("dialog");
  await expect(dialog.getByText("Connection: "+api.connection.name,{exact:true})).toBeVisible();
  const comparisons=dialog.getByRole("region",{name:"Linked comparisons"});
  await expect(comparisons.getByRole("heading")).toHaveText("Comparisons (21)");
  await expect(comparisons.getByText("inactive",{exact:true})).toHaveCount(10);
  await expect(comparisons.getByText("Current",{exact:true})).toHaveCount(20);
  await expect(dialog.getByRole("button",{name:"Delete dataset",exact:true})).toBeDisabled();
  await comparisons.getByRole("button",{name:"Next",exact:true}).click();
  await expect(comparisons.getByRole("link")).toHaveCount(1);
  await page.screenshot({path:"test-results/dataset-delete-blocked-desktop.png",fullPage:true});
  await page.keyboard.press("Escape");await expect(trigger).toBeFocused();
  expect((await request.delete(api.base+`/datasets/${api.dataset.id}`,{headers:api.headers,data:{}})).status()).toBe(409);
  expect((await request.get(api.base+`/schedules/${schedule.id}`,{headers:api.headers})).status()).toBe(200);
});

test("deleting a dataset explicitly removes its completed profile history and allows registering the source again",async({page,request})=>{
  const api=await setup(request,"Dataset deletion profile "+"X".repeat(100));
  const run=await api.post(`/datasets/${api.dataset.id}/profile-runs`,{},202);
  await expect.poll(async()=>{
    const response=await request.get(api.base+`/runs/${run.id}`,{headers:api.headers});
    return (await response.json()).status;
  },{timeout:20000}).toBe("succeeded");
  const trigger=await openCatalog(page,api.dataset.id);
  await trigger.click();
  const dialog=page.getByRole("dialog");
  const confirm=dialog.getByRole("button",{name:"Delete dataset and profile history",exact:true});
  await expect(confirm).toBeEnabled();
  const history=dialog.getByRole("region",{name:"Individual profile history"});
  await expect(history.getByText("Profile runs",{exact:true}).locator("..")).toHaveText("Profile runs1");
  await expect(history.getByText("Results",{exact:true}).locator("..")).toHaveText("Results1");
  await expect(dialog.getByRole("status")).toContainText("cannot be undone");
  await page.keyboard.press("Escape");await expect(trigger).toBeFocused();
  await page.getByRole("button",{name:"Theme",exact:true}).click();
  await page.getByRole("radio",{name:"Dark",exact:true}).check();await page.keyboard.press("Escape");
  await trigger.click();
  await page.setViewportSize({width:320,height:844});
  await confirm.scrollIntoViewIfNeeded();
  await expect(confirm).toBeVisible();
  expect(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
  await page.screenshot({path:"test-results/dataset-delete-profile-mobile-dark.png",fullPage:true});
  let deletions=0;
  await page.route(`**/api/v1/datasets/${api.dataset.id}`,async route=>{
    if(route.request().method()!=="DELETE")return route.continue();
    deletions++;
    const response=await route.fetch();
    await new Promise(resolve=>setTimeout(resolve,250));
    await route.fulfill({response});
  });
  await confirm.evaluate((button:HTMLButtonElement)=>{button.click();button.click();});
  await expect(dialog.getByRole("button",{name:"Deleting…",exact:true})).toBeDisabled();
  await expect(dialog).not.toBeVisible();expect(deletions).toBe(1);
  await expect(page.getByLabel("Connection",{exact:true})).toBeFocused();
  expect((await request.get(api.base+`/runs/${run.id}`,{headers:api.headers})).status()).toBe(404);
  expect((await request.get(api.base+`/runs/${run.id}/result`,{headers:api.headers})).status()).toBe(404);
  const deps=await request.get(api.base+`/connections/${api.connection.id}/dependencies`,{headers:api.headers});
  expect((await deps.json()).can_delete).toBe(true);
  const again=await api.post("/datasets",{connection_id:api.connection.id,table_name:"records"});
  expect(again.id).not.toBe(api.dataset.id);
});

test("Catalog deletion recovers from dependency errors and refreshes links after a conflict",async({page,request})=>{
  const api=await setup(request,"Dataset deletion conflict");
  const otherConnection=await api.post("/connections",{name:"Dataset deletion conflict other",connector:"sqlite",credentials:{database:"right.sqlite"}});
  const other=await api.post("/datasets",{connection_id:otherConnection.id,table_name:"records"});
  const trigger=await openCatalog(page,api.dataset.id);
  let checks=0;
  await page.route(`**/api/v1/datasets/${api.dataset.id}/dependencies?*`,route=>++checks===1
    ? route.fulfill({status:503,json:{code:"storage_unavailable",message:"Dependency check unavailable."}})
    : route.continue());
  await trigger.click();
  const dialog=page.getByRole("dialog");
  await expect(dialog.getByRole("alert")).toContainText("Dependency check unavailable.");
  await expect(dialog.getByRole("button",{name:"Delete dataset",exact:true})).toBeDisabled();
  await dialog.getByRole("button",{name:"Retry dependency check",exact:true}).click();
  await expect(dialog.getByRole("button",{name:"Delete dataset",exact:true})).toBeEnabled();
  const comparison=await api.post("/comparisons",{name:"Dataset deletion newly linked",left_dataset_id:api.dataset.id,right_dataset_id:other.id});
  await dialog.getByRole("button",{name:"Delete dataset",exact:true}).click();
  await expect(dialog.getByRole("alert")).toContainText("current or historical comparisons");
  await expect(dialog.getByRole("link",{name:comparison.name,exact:true})).toHaveAttribute("href",`/comparisons/${comparison.id}`);
  await expect(dialog.getByRole("button",{name:"Delete dataset",exact:true})).toBeDisabled();
});
