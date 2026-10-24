import test, { before, after } from 'node:test';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApplication, clientIP, isPublicIP, lookupLocation, PAYMENT_ADDRESS } from './app.mjs';
const password = 'local-testing-password-only';
let temporaryMongo;
let mongoUri;
const testDatabaseNames = new Set();
before(async()=>{
  mongoUri = process.env.TEST_MONGODB_URI || process.env.MONGODB_URI;
  if(!mongoUri){temporaryMongo=await MongoMemoryServer.create();mongoUri=temporaryMongo.getUri();}
});
after(async()=>{
  if(mongoUri){
    const client=new MongoClient(mongoUri);
    try{await client.connect();for(const name of testDatabaseNames){
      if(!/^cr7_test_[a-f0-9]{24}$/.test(name))throw new Error('Unexpected test database name');
      await client.db(name).dropDatabase();
    }}finally{await client.close();}
  }
  await temporaryMongo?.stop();
});
function testDatabase(){const name='cr7_test_'+randomUUID().replaceAll('-','').slice(0,24);testDatabaseNames.add(name);return name;}
async function start(options={}){const app=await createApplication({mongoUri,databaseName:testDatabase(),password,secure:false,...options});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));return {...app,url:`http://127.0.0.1:${app.server.address().port}`};}
const post=(app,path,body,headers={})=>fetch(app.url+path,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
async function login(app){const res=await post(app,'/api/admin/login',{password});assert.equal(res.status,200);assert.match(res.headers.get('set-cookie'),/HttpOnly/);return res.headers.get('set-cookie').split(';')[0];}
const report=(extra={})=>({eventId:randomUUID(),orderId:'#TEST123',amount:5,currency:'SOL',timezone:'Asia/Calcutta',...extra});
test('source IP ignores untrusted forwarding and private IPs are not geolocated',async()=>{
 const req={socket:{remoteAddress:'::ffff:127.0.0.1'},headers:{'x-forwarded-for':'1.1.1.1, 8.8.8.8'}};
 assert.equal(clientIP(req),'127.0.0.1');assert.equal(clientIP(req,['127.0.0.1']),'8.8.8.8');
 for(const ip of ['127.0.0.1','10.0.0.1','192.168.1.1','::1','fe80::1','fc00::1'])assert.equal(isPublicIP(ip),false);
 assert.equal(isPublicIP('8.8.8.8'),true);assert.equal((await lookupLocation('127.0.0.1')).status,'local');
});
test('records persist, retries deduplicate, filters and CSV stay private',async()=>{
 const databaseName=testDatabase();
 let app=await start({databaseName,geo:async()=>({status:'located',city:'Test city',region:'Test region',country:'Test country'})});
 try{
  assert.equal((await fetch(app.url+'/api/admin/reports')).status,401);
  assert.equal((await fetch(app.url+'/api/admin/export')).status,401);
  assert.equal((await post(app,'/api/admin/login',{password:'wrong'})).status,401);
  assert.equal((await post(app,'/api/admin/login',{password},{origin:'https://other.example'})).status,403);
  assert.equal((await post(app,'/api/payment-reports',report({amount:-1}))).status,400);
  assert.equal((await post(app,'/api/payment-reports',report({amount:'5'}))).status,400);
  const first=report();assert.equal((await post(app,'/api/payment-reports',first,{'x-forwarded-for':'8.8.8.8'})).status,201);
  assert.equal((await post(app,'/api/payment-reports',first)).status,200);
  assert.equal((await post(app,'/api/payment-reports',report())).status,201);
  const cookie=await login(app);
  const response=await fetch(app.url+'/api/admin/reports',{headers:{cookie}});assert.equal(response.status,200);
  const result=await response.json();assert.equal(result.summary.totalClicks,2);assert.equal(result.summary.uniqueOrders,1);assert.equal(result.rows[0].tokenAmount,47250);assert.equal(result.rows[0].recipientAddress,PAYMENT_ADDRESS);assert.equal(result.rows[0].ip,'127.0.0.1');assert.ok(['pending','located'].includes(result.rows[0].locationStatus));
  const filtered=await (await fetch(app.url+'/api/admin/reports?q=TEST123',{headers:{cookie}})).json();assert.equal(filtered.summary.totalClicks,2);
  const empty=await (await fetch(app.url+'/api/admin/reports?q=nonexistent',{headers:{cookie}})).json();assert.equal(empty.summary.totalClicks,0);
  const wildcard=await (await fetch(app.url+'/api/admin/reports?q=%25',{headers:{cookie}})).json();assert.equal(wildcard.summary.totalClicks,0);
  assert.equal((await fetch(app.url+'/api/admin/reports?from=bad',{headers:{cookie}})).status,400);
  const dateEmpty=await (await fetch(app.url+'/api/admin/reports?to=2000-01-01',{headers:{cookie}})).json();assert.equal(dateEmpty.summary.totalClicks,0);
  const csv=await fetch(app.url+'/api/admin/export',{headers:{cookie}});assert.equal(csv.status,200);assert.match(await csv.text(),/TEST123/);
  await post(app,'/api/admin/logout',{}, {cookie});assert.equal((await fetch(app.url+'/api/admin/reports',{headers:{cookie}})).status,401);
  await app.close();app=await start({databaseName});const nextCookie=await login(app);
  const persisted=await (await fetch(app.url+'/api/admin/reports',{headers:{cookie:nextCookie}})).json();assert.equal(persisted.summary.totalClicks,2);assert.equal(persisted.rows[0].country,'Test country');
 }finally{await app.close();}
});
test('provider failures do not lose reports; pagination and login throttling work',async()=>{
 const app=await start({geo:async()=>{throw new Error('offline');}});
 try{
  for(let i=0;i<26;i++)assert.equal((await post(app,'/api/payment-reports',report({orderId:`TEST-${i}`}))).status,201);
  const cookie=await login(app);const result=await (await fetch(app.url+'/api/admin/reports?page=2',{headers:{cookie}})).json();
  assert.equal(result.rows.length,1);assert.ok(['pending','unavailable'].includes(result.rows[0].locationStatus));assert.equal(result.summary.uniqueOrders,26);
  for(let i=0;i<4;i++)await post(app,'/api/admin/login',{password:'wrong'});
  assert.equal((await post(app,'/api/admin/login',{password})).status,429);
 }finally{await app.close();}
});



test('cross-origin frontend can preflight and authenticate with a bearer session',async()=>{
 const origin='http://localhost:5173';
 const app=await start({allowedOrigins:[origin]});
 try{
  const preflight=await fetch(app.url+'/api/admin/reports',{method:'OPTIONS',headers:{Origin:origin,'Access-Control-Request-Method':'GET','Access-Control-Request-Headers':'authorization'}});
  assert.equal(preflight.status,204);assert.equal(preflight.headers.get('access-control-allow-origin'),origin);assert.match(preflight.headers.get('access-control-allow-headers'),/Authorization/);
  const blocked=await fetch(app.url+'/api/admin/reports',{method:'OPTIONS',headers:{Origin:'https://not-allowed.example'}});assert.equal(blocked.status,403);assert.equal(blocked.headers.get('access-control-allow-origin'),null);
  const loginResponse=await post(app,'/api/admin/login',{password},{Origin:origin,'sec-fetch-site':'cross-site'});
  assert.equal(loginResponse.status,200);assert.equal(loginResponse.headers.get('access-control-allow-origin'),origin);
  const {token}=await loginResponse.json();assert.match(token,/^[a-f0-9]{64}$/);
  const headers={Origin:origin,Authorization:`Bearer ${token}`};
  assert.equal((await fetch(app.url+'/api/admin/session',{headers})).status,200);
  const reports=await fetch(app.url+'/api/admin/reports',{headers});assert.equal(reports.status,200);assert.equal((await reports.json()).summary.totalClicks,0);
  const csv=await fetch(app.url+'/api/admin/export',{headers});assert.equal(csv.status,200);
  assert.equal((await post(app,'/api/admin/logout',{},headers)).status,200);
  assert.equal((await fetch(app.url+'/api/admin/session',{headers})).status,401);
  assert.equal((await fetch(app.url+'/api/admin/session',{headers:{Origin:origin,Authorization:'Bearer invalid'}})).status,401);
 }finally{await app.close();}
});
