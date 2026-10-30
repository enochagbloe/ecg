import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const header=fs.readFileSync(new URL('../MultiWifiManager.h',import.meta.url),'utf8');
const script=header.match(/<script>([\s\S]*?)<\/script>/)[1];
function fixture(networks=[]) {
 class Element {
  children=[];value='';checked=false;disabled=false;textContent='';
  append(...items){this.children.push(...items)} replaceChildren(){this.children=[];this.textContent=''}
  set innerHTML(value){throw Error('SSID must never be interpolated into HTML')}
 }
 const ids={};for(const id of ['message','networks','form','save','ssid','password','open','priority','done'])ids[id]=new Element();
 ids.priority.value='3';const requests=[];let failure=null;
 const context={document:{getElementById:id=>ids[id],createElement:()=>new Element(),createTextNode:text=>({textContent:text})},fetch:async(url,options={})=>{
  requests.push({url,...options});
  if(url==='/networks'&&!options.method)return {ok:true,json:async()=>({networks})};
  const error=failure;failure=null;
  return {ok:!error,json:async()=>error?{ok:false,error}:{ok:true}};
 }};
 vm.runInNewContext(script,context);
 return {ids,requests,failNext(message){failure=message},flush:()=>new Promise(resolve=>setImmediate(resolve))};
}
test('saved SSIDs are text nodes, including HTML-looking names',async()=>{
 const f=fixture([{ssid:'<img src=x onerror=alert(1)>',priority:1,connected:false}]);await f.flush();
 assert.equal(f.ids.networks.children[0].children[0].textContent,'<img src=x onerror=alert(1)> — priority 1');
});
test('editing priority omits a blank password, preserving the stored password',async()=>{
 const f=fixture();await f.flush();f.ids.ssid.value='Office';f.ids.priority.value='1';
 await f.ids.form.onsubmit({preventDefault(){}});
 const req=f.requests.find(r=>r.url==='/provision');assert.deepEqual(JSON.parse(req.body),{ssid:'Office',priority:1});assert.equal(f.ids.save.disabled,false);
});
test('explicit open Wi-Fi sends an empty password and clears entered text after saving',async()=>{
 const f=fixture();await f.flush();f.ids.ssid.value='Guest';f.ids.open.checked=true;f.ids.password.value='do-not-send';
 await f.ids.form.onsubmit({preventDefault(){}});assert.equal(JSON.parse(f.requests.find(r=>r.url==='/provision').body).password,'');assert.equal(f.ids.password.value,'');
});
test('new password is sent only in the save request, and cleared after success',async()=>{
 const f=fixture();await f.flush();f.ids.ssid.value='Phone';f.ids.password.value='my-private-pass';
 await f.ids.form.onsubmit({preventDefault(){}});assert.equal(JSON.parse(f.requests.find(r=>r.url==='/provision').body).password,'my-private-pass');assert.equal(f.ids.password.value,'');
});
test('capacity/persistence errors are visible and allow a corrected retry',async()=>{
 const f=fixture();await f.flush();f.ids.ssid.value='Sixth';f.ids.password.value='keep-for-retry';f.failNext('Five networks are already saved');
 await f.ids.form.onsubmit({preventDefault(){}});assert.equal(f.ids.message.textContent,'Five networks are already saved');assert.equal(f.ids.save.disabled,false);assert.equal(f.ids.password.value,'keep-for-retry');
});
test('remove request contains the chosen SSID, without a password',async()=>{
 const f=fixture([{ssid:'Office',priority:2}]);await f.flush();await f.ids.networks.children[0].children[1].onclick();
 const req=f.requests.find(r=>r.method==='DELETE');assert.deepEqual(JSON.parse(req.body),{ssid:'Office'});
});
test('Done reports the server response and does not restart the device',async()=>{
 const f=fixture();await f.flush();await f.ids.done.onclick();assert(f.requests.some(r=>r.url==='/finish'&&r.method==='POST'));assert.match(f.ids.message.textContent,/Setup is closing/);
});
