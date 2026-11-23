import assert from "node:assert/strict";
import { test } from "node:test";
import { createDashboardFetch, DashboardSessionExpired } from "../app/components/dashboardFetch";

test("expired dashboard session requests sign-in and stops the request before reading protected data", async () => {
  let calls=0, redirects=0;
  const request=createDashboardFetch(async()=>{calls++;return new Response(null,{status:401});},()=>{redirects++;});
  await assert.rejects(request("/api/v1/devices/TEST/settings"),DashboardSessionExpired);
  assert.equal(calls,1);assert.equal(redirects,1);
});
test("expired settings POST is never retried and retains same-origin credentials",async()=>{
  let calls=0;
  const request=createDashboardFetch(async(_input,init)=>{calls++;assert.equal(init?.method,"POST");assert.equal(init?.credentials,"same-origin");assert.equal(init?.body,'{"action":"rename","name":"Test"}');return new Response(null,{status:401});},()=>{});
  await assert.rejects(request("/api/v1/devices/TEST/settings",{method:"POST",body:'{"action":"rename","name":"Test"}'}),DashboardSessionExpired);
  assert.equal(calls,1);
});
test("successful loads and non-auth errors preserve the response; aborts and outages do not force login",async()=>{
  let redirects=0;
  for(const status of [200,403,404,500,503]) {
    const response=new Response(null,{status});
    const request=createDashboardFetch(async()=>response,()=>{redirects++;});
    assert.equal(await request("/api/v1/devices/TEST/settings"),response);
  }
  const controller=new AbortController();controller.abort();
  const request=createDashboardFetch(async(_input,init)=>{assert.equal(init?.signal,controller.signal);throw new DOMException("Aborted","AbortError");},()=>{redirects++;});
  await assert.rejects(request("/api/v1/devices/TEST/settings",{signal:controller.signal}),{name:"AbortError"});
  assert.equal(redirects,0);
});

test("form sign-in cookie restores the Settings HTTP endpoint; a missing session stays rejected",async()=>{
  const {createServer}=await import("node:http");
  const {dashboardLogin}=await import("../server/routes/dashboardLogin");
  const {createMeterSettingsHandler}=await import("../server/routes/meterSettings");
  const {HttpError,json}=await import("../server/utils/http");
  const oldUser=process.env.DASHBOARD_USERNAME,oldPassword=process.env.DASHBOARD_PASSWORD;
  process.env.DASHBOARD_USERNAME="session-recovery-test";
  process.env.DASHBOARD_PASSWORD="test-only-session-recovery-password-over-32-characters";
  const device={hardwareId:"TEST",name:"Test building",isActive:true,lastSeenAt:new Date(),firmwareVersion:null,
    meterConstant:1000,settings:null,meterPeriods:[],meterState:{totalPulses:20n}};
  const client={device:{findUnique:async()=>device}} as unknown as import("@prisma/client").PrismaClient;
  const settings=createMeterSettingsHandler(client);
  const server=createServer((req,res)=>{void (req.url==="/login"?dashboardLogin(req,res):settings(req,res,"TEST")).catch(e=>json(res,e instanceof HttpError?e.status:500,{error:e.message}));});
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const address=server.address() as import("node:net").AddressInfo;
  const url=`http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(url+"/settings")).status,401);
    const login=await fetch(url+"/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username:process.env.DASHBOARD_USERNAME,password:process.env.DASHBOARD_PASSWORD})});
    assert.equal(login.status,200);
    const cookie=login.headers.get("set-cookie")!.split(";")[0];
    const response=await fetch(url+"/settings",{headers:{Cookie:cookie}});
    assert.equal(response.status,200);
    const body=await response.json();assert.equal(body.deviceId,"TEST");assert.equal(body.meterConstant,1000);assert.equal(body.totalPulses,20);
    assert.equal((await fetch(url+"/settings")).status,401);
  } finally {
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    if(oldUser===undefined)delete process.env.DASHBOARD_USERNAME;else process.env.DASHBOARD_USERNAME=oldUser;
    if(oldPassword===undefined)delete process.env.DASHBOARD_PASSWORD;else process.env.DASHBOARD_PASSWORD=oldPassword;
  }
});
