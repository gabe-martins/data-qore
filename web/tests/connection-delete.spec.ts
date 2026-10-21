import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
test.skip(process.env.DATAQORE_ISOLATED_TEST !== "1", "Use the disposable full-stack fixture.");

async function setup(request: APIRequestContext) {
  const base=process.env.DATAQORE_CONTROLLER_URL!+"/api/v1";
  const login=await request.post(base+"/auth/login",{
    headers:{Origin:process.env.WEB_ORIGIN!},
    data:{email:"admin@dataqore.test",password:"DataQore-test-password-2026"},
  });
  expect(login.status()).toBe(200);
  const token=(await login.json()).access_token;
  const headers={Authorization:"Bearer "+token};
  async function post(path:string,data:unknown) {
    const response=await request.post(base+path,{headers,data});
    expect(response.status(),await response.text()).toBe(201);
    return response.json();
  }
  return {base,headers,post};
}
async function login(page:Page,name:string) {
  await page.goto("/");
  await page.getByLabel("Email",{exact:true}).fill("admin@dataqore.test");
  await page.getByLabel("Password",{exact:true}).fill("DataQore-test-password-2026");
  await page.getByRole("button",{name:"Sign in",exact:true}).click();
  await expect(page.getByRole("heading",{name:"Overview",exact:true})).toBeVisible();
  await page.getByRole("link",{name:"Connections",exact:true}).click();
  await page.getByLabel("Search connections").fill(name);
  await expect(page.getByRole("heading",{name,exact:true})).toBeVisible();
}

test("dependencies include inactive comparisons once, paginate independently and preserve schedules",async({page,request})=>{
  const api=await setup(request);
  const connection=await api.post("/connections",{name:"Delete dependencies",connector:"sqlite",credentials:{database:"delete.sqlite"}});
  const left=await api.post("/datasets",{connection_id:connection.id,schema_name:"main",table_name:"records"});
  let comparison:any;
  for(let i=0;i<21;i++) {
    const right=await api.post("/datasets",{connection_id:connection.id,schema_name:"main",table_name:`dependency_${String(i).padStart(2,"0")}`});
    const c=await api.post("/comparisons",{name:`Delete linked ${String(i).padStart(2,"0")}`,left_dataset_id:left.id,right_dataset_id:right.id});
    if(i%2!==0)expect((await request.patch(api.base+`/comparisons/${c.id}`,{headers:api.headers,data:{is_active:false}})).status()).toBe(200);
    if(i===0)comparison=c;
  }
  const schedule=await api.post("/schedules",{name:"Delete preserved schedule",comparison_id:comparison.id,cron_expression:"0 0 * * *",timezone:"UTC",is_active:false});
  await login(page,connection.name);
  const trigger=page.getByRole("button",{name:"Delete",exact:true});
  await trigger.click();
  const dialog=page.getByRole("dialog");
  const datasets=dialog.getByRole("region",{name:"Registered datasets"});
  const comparisons=dialog.getByRole("region",{name:"Linked comparisons"});
  await expect(datasets.getByRole("heading")).toHaveText("Catalog datasets (22)");
  await expect(comparisons.getByRole("heading")).toHaveText("Comparisons (21)");
  await expect(comparisons.getByRole("link",{name:comparison.name,exact:true})).toHaveAttribute("href",`/comparisons/${comparison.id}`);
  await expect(comparisons.getByText("inactive",{exact:true})).toHaveCount(10);
  await expect(dialog.getByRole("button",{name:"Delete connection",exact:true})).toBeDisabled();
  await expect(dialog.getByRole("status")).toContainText("Deactivate");
  await datasets.getByRole("button",{name:"Next",exact:true}).click();
  await expect(datasets.getByRole("link")).toHaveCount(2);
  await expect(comparisons.getByRole("link")).toHaveCount(20);
  await comparisons.getByRole("button",{name:"Next",exact:true}).click();
  await expect(comparisons.getByRole("link")).toHaveCount(1);
  await page.screenshot({path:"test-results/delete-dependencies-desktop.png",fullPage:true});
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await page.getByRole("button",{name:"Theme",exact:true}).click();
  await page.getByRole("radio",{name:"Dark",exact:true}).check();
  await page.keyboard.press("Escape");
  await trigger.click();
  await page.setViewportSize({width:390,height:844});
  await expect(dialog.getByRole("heading",{name:"Delete connection",exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:"test-results/delete-dependencies-mobile-dark.png",fullPage:true});
  const blocked=await request.delete(api.base+`/connections/${connection.id}`,{headers:api.headers,data:{}});
  expect(blocked.status()).toBe(409);
  expect((await blocked.json()).message).toContain("Deactivate");
  const unchanged=await request.get(api.base+`/schedules/${schedule.id}`,{headers:api.headers});
  expect(unchanged.status()).toBe(200);
  expect((await unchanged.json()).comparison_id).toBe(comparison.id);
});

test("unused connection requires confirmation, cancels with keyboard and deletes only once",async({page,request})=>{
  const api=await setup(request);
  const connection=await api.post("/connections",{name:"Delete unused",connector:"sqlite",credentials:{database:"delete.sqlite"}});
  await login(page,connection.name);
  const trigger=page.getByRole("button",{name:"Delete",exact:true});
  await trigger.focus();await page.keyboard.press("Enter");
  const dialog=page.getByRole("dialog");
  await expect(dialog.getByText("No registered datasets.",{exact:true})).toBeVisible();
  await expect(dialog.getByText("No linked comparisons.",{exact:true})).toBeVisible();
  await page.keyboard.press("Escape");await expect(trigger).toBeFocused();
  expect((await request.get(api.base+`/connections/${connection.id}`,{headers:api.headers})).status()).toBe(200);
  await trigger.click();
  const confirm=dialog.getByRole("button",{name:"Delete connection",exact:true});
  await expect(confirm).toBeEnabled();
  let deletes=0;
  await page.route(`**/api/v1/connections/${connection.id}`,async route=>{
    if(route.request().method()!=="DELETE")return route.continue();
    deletes++;
    const response=await route.fetch();
    await new Promise(resolve=>setTimeout(resolve,250));
    await route.fulfill({response});
  });
  await confirm.evaluate((button:HTMLButtonElement)=>{button.click();button.click();});
  await expect(dialog.getByRole("button",{name:"Deleting…",exact:true})).toBeDisabled();
  await expect(dialog).not.toBeVisible();
  expect(deletes).toBe(1);
  await expect(page.getByRole("heading",{name:connection.name,exact:true})).toHaveCount(0);
  await expect(page.getByRole("button",{name:"New connection",exact:true})).toBeFocused();
  expect((await request.get(api.base+`/connections/${connection.id}`,{headers:api.headers})).status()).toBe(404);
});

test("dependency check recovers from errors and refreshes a conflicting preview",async({page,request})=>{
  const api=await setup(request);
  const connection=await api.post("/connections",{name:"Delete stale preview",connector:"sqlite",credentials:{database:"delete.sqlite"}});
  await login(page,connection.name);
  let checks=0;
  await page.route(`**/api/v1/connections/${connection.id}/dependencies?*`,route=>{
    if(++checks===1)return route.fulfill({status:503,json:{code:"storage_unavailable",message:"Dependency check unavailable."}});
    return route.continue();
  });
  await page.getByRole("button",{name:"Delete",exact:true}).click();
  const dialog=page.getByRole("dialog");
  await expect(dialog.getByRole("alert")).toContainText("Dependency check unavailable.");
  await expect(dialog.getByRole("button",{name:"Delete connection",exact:true})).toBeDisabled();
  await dialog.getByRole("button",{name:"Retry dependency check",exact:true}).click();
  await expect(dialog.getByRole("button",{name:"Delete connection",exact:true})).toBeEnabled({timeout:15000});
  const dataset=await api.post("/datasets",{connection_id:connection.id,schema_name:"main",table_name:"records"});
  await dialog.getByRole("button",{name:"Delete connection",exact:true}).click();
  await expect(dialog.getByRole("alert")).toContainText("This connection is in use");
  const qualifiedName=[dataset.catalog_name,dataset.schema_name,dataset.table_name].filter(Boolean).join(".");
  await expect(dialog.getByRole("link",{name:qualifiedName,exact:true})).toHaveAttribute("href",`/datasets/${dataset.id}`);
  await expect(dialog.getByRole("button",{name:"Delete connection",exact:true})).toBeDisabled();
});
