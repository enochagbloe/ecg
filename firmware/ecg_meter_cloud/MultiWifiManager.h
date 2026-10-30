#ifndef ECG_MULTI_WIFI_MANAGER_H
#define ECG_MULTI_WIFI_MANAGER_H
#include <Arduino.h>
#include <WiFi.h>
#include <WebServer.h>
#include <Preferences.h>
#include <cJSON.h>
#include <memory>
#include "WifiProfiles.h"
#include "WifiPolicy.h"

// All Wi-Fi mutations, profile changes and onboarding HTTP run on one owner task.
// Event callbacks only publish diagnostics under a lock; they never reconnect.
class MultiWifiManager {
 public:
  explicit MultiWifiManager(WebServer &server): server_(server) {}
  void begin(const String &legacySsid,const String &legacyPassword,const String &apName,const char *deviceId) {
    apName_=apName; deviceId_=deviceId;
    ecg_wifi_profiles_empty(&profiles_); ecg_wifi_policy_init(&policy_);
    storeHealthy_=store_.begin("ecg-wifi",false);
    if (storeHealthy_ && store_.isKey("profiles")) {
      EcgWifiProfiles saved;
      storeHealthy_=store_.getBytesLength("profiles")==sizeof(saved) &&
        store_.getBytes("profiles",&saved,sizeof(saved))==sizeof(saved) && ecg_wifi_profiles_valid(&saved);
      if (storeHealthy_) profiles_=saved;
      else Serial.println("WIFI PROFILE STORE INVALID: existing data retained; no automatic erase");
    } else if (legacySsid.length()>0) {
      EcgWifiProfiles migrated=profiles_;
      if (ecg_wifi_profile_upsert(&migrated,legacySsid.c_str(),legacyPassword.c_str(),1)>=0) {
        // An NVS failure must not strand an existing single-network device.
        profiles_=migrated;
        if (storeHealthy_ && persist(migrated)) Serial.println("WIFI LEGACY PROFILE MIGRATED; legacy keys retained");
        else Serial.println("WIFI LEGACY PROFILE IN RAM; profile persistence unavailable");
      }
    }
    WiFi.persistent(false);
    WiFi.setAutoReconnect(false);
    WiFi.onEvent([this](WiFiEvent_t,WiFiEventInfo_t info) {
      portENTER_CRITICAL(&eventMux_);
      disconnectReason_=info.wifi_sta_disconnected.reason; disconnectNotice_=true;
      portEXIT_CRITICAL(&eventMux_);
    },ARDUINO_EVENT_WIFI_STA_DISCONNECTED);
    configureServer();
    Serial.println("WIFI MANAGER STARTED");
    Serial.printf("SAVED NETWORKS: %u\n",(unsigned)profiles_.count);
  }
  bool connectionReady() {
    portENTER_CRITICAL(&eventMux_); bool value=ready_; portEXIT_CRITICAL(&eventMux_); return value;
  }
  uint32_t connectionGeneration() {
    portENTER_CRITICAL(&eventMux_); uint32_t value=generation_; portEXIT_CRITICAL(&eventMux_); return value;
  }
  void tick() {
    if (setupActive_) server_.handleClient();
    bool notice; uint8_t reason;
    portENTER_CRITICAL(&eventMux_);
    notice=disconnectNotice_; reason=disconnectReason_; disconnectNotice_=false;
    portEXIT_CRITICAL(&eventMux_);
    if (notice) Serial.printf("WIFI DISCONNECT REASON: %u\n",(unsigned)reason);
    EcgWifiInput input={}; input.now=millis(); input.usedMask=ecg_wifi_profile_mask(&profiles_);
    for (unsigned i=0;i<ECG_WIFI_CAPACITY;i++) input.priority[i]=profiles_.profiles[i].priority;
    input.connected=WiFi.status()==WL_CONNECTED;
    if (policy_.phase==ECG_W_CONNECTING && policy_.target>=0)
      input.connected=input.connected && WiFi.SSID()==profiles_.profiles[policy_.target].ssid;
    input.setupBusy=setupActive_ && (uint32_t)(input.now-lastSetupActivity_)<120000u;
    input.stopped=stationStopped_; input.joinFailed=joinStartFailed_;
    input.scanStatus=ECG_W_SCAN_RUNNING;
    if (policy_.phase==ECG_W_SCANNING) {
      int result=WiFi.scanComplete();
      if (result>=0) {
        input.scanStatus=ECG_W_SCAN_DONE;
        for (int n=0;n<result;n++) {
          String ssid=WiFi.SSID(n);
          int slot=ecg_wifi_profile_find(&profiles_,ssid.c_str());
          if (slot>=0) input.availableMask|=(uint8_t)(1u<<slot);
        }
        WiFi.scanDelete();
      } else if (result==WIFI_SCAN_FAILED || scanStartFailed_) input.scanStatus=ECG_W_SCAN_FAILED;
    }
    uint8_t oldPhase=policy_.phase;
    EcgWifiAction action=ecg_wifi_tick(&policy_,&input);
    if (action.flags&ECG_W_LINK_DOWN) {
      Serial.println("WIFI DISCONNECTED"); Serial.println("SEARCHING SAVED NETWORKS...");
    }
    if (action.flags&ECG_W_STOP) stopStation();
    if (action.flags&ECG_W_AP_ON) startSetup();
    if (action.flags&ECG_W_AP_OFF) stopSetup();
    if (action.flags&ECG_W_SCAN) startScan();
    if (action.flags&ECG_W_JOIN) startJoin(action.target);
    if (action.flags&ECG_W_LINK_UP) {
      portENTER_CRITICAL(&eventMux_); generation_++; ready_=true; portEXIT_CRITICAL(&eventMux_);
      Serial.println("WIFI CONNECTED"); Serial.print("IP: "); Serial.println(WiFi.localIP());
    }
    if (oldPhase==ECG_W_STOPPING && policy_.phase==ECG_W_BACKOFF && !input.stopped)
      Serial.println("WIFI STATION STOP NOT CONFIRMED; waiting before retry, no overlapping begin");
    if (policy_.setup && !setupActive_ && policy_.phase==ECG_W_BACKOFF) startSetup();
    if (finishRequested_ && policy_.phase==ECG_W_ONLINE &&
        (uint32_t)(millis()-finishRequestedAt_)>=750u) {
      finishRequested_=false; policy_.setup=0; stopSetup();
    }
  }
 private:
  WebServer &server_;
  Preferences store_;
  EcgWifiProfiles profiles_={};
  EcgWifiPolicy policy_={};
  String apName_; const char *deviceId_=nullptr;
  bool storeHealthy_=false,setupActive_=false,stationStopped_=false,joinStartFailed_=false,scanStartFailed_=false;
  portMUX_TYPE eventMux_=portMUX_INITIALIZER_UNLOCKED;
  bool ready_=false;
  uint32_t lastSetupTry_=0,lastSetupActivity_=0,finishRequestedAt_=0;
  bool finishRequested_=false;
  bool disconnectNotice_=false; uint8_t disconnectReason_=0; uint32_t generation_=0;

  bool persist(const EcgWifiProfiles &next) {
    if (!storeHealthy_ || !ecg_wifi_profiles_valid(&next)) return false;
    if (store_.putBytes("profiles",&next,sizeof(next))!=sizeof(next)) return false;
    EcgWifiProfiles check;
    return store_.getBytesLength("profiles")==sizeof(check) &&
      store_.getBytes("profiles",&check,sizeof(check))==sizeof(check) &&
      ecg_wifi_profiles_valid(&check) && memcmp(&next,&check,sizeof(check))==0;
  }
  void stopStation() {
    // Disable STA (not merely disconnect) before changing its configuration.
    // WiFi.enableSTA returns after the mode update; policy adds a settle window.
    portENTER_CRITICAL(&eventMux_); ready_=false; portEXIT_CRITICAL(&eventMux_);
    bool ok=WiFi.enableSTA(false);
    stationStopped_=ok && !(WiFi.getMode()&WIFI_MODE_STA);
    joinStartFailed_=false; scanStartFailed_=false;
    WiFi.scanDelete();
  }
  void startScan() {
    Serial.println("SCANNING AVAILABLE NETWORKS...");
    stationStopped_=false;
    bool enabled=WiFi.enableSTA(true);
    scanStartFailed_=!enabled;
    if (enabled) {
      int result=WiFi.scanNetworks(true,true);
      scanStartFailed_=result!=WIFI_SCAN_RUNNING && result<0;
    }
  }
  void startJoin(int slot) {
    if (slot<0 || slot>=ECG_WIFI_CAPACITY || !profiles_.profiles[slot].used) { joinStartFailed_=true; return; }
    const EcgWifiProfile &profile=profiles_.profiles[slot];
    Serial.print("MATCH FOUND: "); Serial.println(profile.ssid);
    Serial.print("CONNECTING TO: "); Serial.println(profile.ssid);
    stationStopped_=false;
    if (!WiFi.enableSTA(true)) { joinStartFailed_=true; return; }
    // The only begin() in the firmware. No reconnect() or auto-reconnect path.
    wl_status_t result=WiFi.begin(profile.ssid,profile.password[0]?profile.password:nullptr);
    joinStartFailed_=result==WL_CONNECT_FAILED;
  }
  void startSetup() {
    if (setupActive_) return;
    uint32_t now=millis();
    if (lastSetupTry_ && (uint32_t)(now-lastSetupTry_)<10000u) return;
    lastSetupTry_=now;
    // Invoked after station cancellation, or during an offline backoff.
    if (!WiFi.enableAP(true) || !WiFi.softAP(apName_.c_str())) {
      Serial.println("WIFI SETUP AP START FAILED; retrying during offline backoff"); return;
    }
    server_.begin(); setupActive_=true; lastSetupActivity_=millis();
    Serial.print("SETUP AP: "); Serial.println(apName_);
    Serial.print("SETUP PAGE IP: "); Serial.println(WiFi.softAPIP());
  }
  void stopSetup() {
    if (!setupActive_) return;
    server_.stop(); WiFi.softAPdisconnect(false); WiFi.enableAP(false);
    setupActive_=false; Serial.println("SETUP MODE CLOSED; saved-network connection retained");
  }
  void sendJson(int status,cJSON *root) {
    server_.sendHeader("Cache-Control","no-store");
    if (!root) { server_.send(503,"application/json","{\"ok\":false,\"error\":\"Memory unavailable\"}"); return; }
    char *text=cJSON_PrintUnformatted(root); cJSON_Delete(root);
    if (!text) { server_.send(503,"application/json","{\"ok\":false,\"error\":\"Memory unavailable\"}"); return; }
    server_.send(status,"application/json",String(text)); cJSON_free(text);
  }
  void error(int code,const char *message) {
    cJSON *root=cJSON_CreateObject(); if (root) { cJSON_AddBoolToObject(root,"ok",false); cJSON_AddStringToObject(root,"error",message); }
    sendJson(code,root);
  }
  using JsonPtr=std::unique_ptr<cJSON,decltype(&cJSON_Delete)>;
  JsonPtr requestJson() { return JsonPtr(cJSON_Parse(server_.arg("plain").c_str()),&cJSON_Delete); }
  void saveProfile() {
    if (server_.arg("plain").length()>1024) { error(413,"Request too large"); return; }
    JsonPtr body=requestJson();
    cJSON *ssid=cJSON_GetObjectItemCaseSensitive(body.get(),"ssid");
    cJSON *password=cJSON_GetObjectItemCaseSensitive(body.get(),"password");
    cJSON *priority=cJSON_GetObjectItemCaseSensitive(body.get(),"priority");
    if (!cJSON_IsObject(body.get()) || !cJSON_IsString(ssid) || !ssid->valuestring[0] ||
        strlen(ssid->valuestring)>32 || (password && (!cJSON_IsString(password) || strlen(password->valuestring)>63))) {
      error(400,"Provide an SSID (1-32 bytes) and an optional password (0-63 bytes)"); return;
    }
    int existing=ecg_wifi_profile_find(&profiles_,ssid->valuestring);
    int rank=existing>=0?profiles_.profiles[existing].priority:3;
    if (priority) {
      if (!cJSON_IsNumber(priority) || priority->valuedouble<1 || priority->valuedouble>5 ||
          priority->valuedouble!=(double)priority->valueint) { error(400,"Priority must be 1 to 5"); return; }
      rank=priority->valueint;
    }
    EcgWifiProfiles next=profiles_;
    int slot=ecg_wifi_profile_upsert(&next,ssid->valuestring,password?password->valuestring:nullptr,(uint8_t)rank);
    if (slot==-1) { error(409,"Five networks are already saved; remove one before adding another"); return; }
    if (slot<0) { error(400,"A new network needs a password, or an explicit empty password for open Wi-Fi"); return; }
    if (!persist(next)) { error(503,"Network could not be saved; existing profiles retained"); return; }
    profiles_=next; policy_.profilesChanged=1; lastSetupActivity_=millis();
    Serial.print("WIFI PROFILE SAVED: "); Serial.println(profiles_.profiles[slot].ssid);
    Serial.printf("SAVED NETWORKS: %u\n",(unsigned)profiles_.count);
    cJSON *root=cJSON_CreateObject();
    if (root) { cJSON_AddBoolToObject(root,"ok",true); cJSON_AddBoolToObject(root,"restarting",false); cJSON_AddNumberToObject(root,"count",profiles_.count); }
    sendJson(200,root);
  }
  void removeProfile() {
    if (server_.arg("plain").length()>1024) { error(413,"Request too large"); return; }
    JsonPtr body=requestJson(); cJSON *ssid=cJSON_GetObjectItemCaseSensitive(body.get(),"ssid");
    if (!cJSON_IsObject(body.get()) || !cJSON_IsString(ssid) || !ssid->valuestring[0] || strlen(ssid->valuestring)>32) { error(400,"Provide an SSID"); return; }
    EcgWifiProfiles next=profiles_;
    if (!ecg_wifi_profile_remove(&next,ssid->valuestring)) { error(404,"Saved network not found"); return; }
    if (!persist(next)) { error(503,"Network could not be removed; existing profiles retained"); return; }
    profiles_=next; policy_.profilesChanged=1; lastSetupActivity_=millis();
    cJSON *root=cJSON_CreateObject(); if (root) cJSON_AddBoolToObject(root,"ok",true); sendJson(200,root);
  }
  void listProfiles() {
    lastSetupActivity_=millis();
    cJSON *root=cJSON_CreateObject(); cJSON *items=cJSON_CreateArray();
    if (!root || !items) { cJSON_Delete(root); cJSON_Delete(items); sendJson(503,nullptr); return; }
    cJSON_AddItemToObject(root,"networks",items); cJSON_AddNumberToObject(root,"capacity",ECG_WIFI_CAPACITY);
    for (unsigned i=0;i<ECG_WIFI_CAPACITY;i++) if (profiles_.profiles[i].used) {
      cJSON *item=cJSON_CreateObject(); if (!item) { cJSON_Delete(root); sendJson(503,nullptr); return; }
      cJSON_AddStringToObject(item,"ssid",profiles_.profiles[i].ssid);
      cJSON_AddNumberToObject(item,"priority",profiles_.profiles[i].priority);
      cJSON_AddBoolToObject(item,"connected",WiFi.status()==WL_CONNECTED && WiFi.SSID()==profiles_.profiles[i].ssid);
      cJSON_AddItemToArray(items,item);
    }
    sendJson(200,root); // Passwords are never added to a response object.
  }
  void configureServer() {
    server_.on("/",HTTP_GET,[this]() {
      lastSetupActivity_=millis();
      static const char page[]=R"ECGHTML(<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ECG Wi-Fi Setup</title><style>body{font:16px system-ui;background:#f5f6fa;color:#182237;margin:24px}main{max-width:480px;margin:auto;background:white;padding:24px;border-radius:12px}label{display:block;margin:16px 0 6px}input,select,button{box-sizing:border-box;padding:12px;width:100%;font:inherit}button{margin-top:12px}li{margin:12px 0}li button{width:auto;padding:6px 12px;margin-left:12px}#message{white-space:pre-wrap}small{display:block;margin-top:16px}</style>
<main><h1>ECG Wi-Fi Setup</h1><p>Save up to five 2.4 GHz networks. The device chooses the available network with the highest priority. A working connection stays connected.</p>
<h2>Saved networks</h2><ul id="networks"></ul><form id="form"><label for="ssid">Network name (SSID)</label><input id="ssid" maxlength="32" required autocomplete="off">
<label for="password">Password</label><input id="password" type="password" maxlength="63" autocomplete="new-password"><small>For an existing network, leave blank to keep its password.</small>
<label><input id="open" type="checkbox" style="width:auto"> This is an open network (no password)</label>
<label for="priority">Priority (1 is highest)</label><select id="priority"><option>1</option><option>2</option><option selected>3</option><option>4</option><option>5</option></select>
<button id="save">Save network</button></form><p id="message" role="status" aria-live="polite"></p><small>Saving does not restart the device. It keeps trying saved networks while setup is open. Once connected, setup closes after two minutes without activity. Use Done when you have finished adding networks. Reconnect your phone to its normal network to open the dashboard.</small>
<button id="done" type="button">Done — close setup</button><p><a href="https://ecg-pro.onrender.com/login">Open ECG dashboard</a></p></main><script>
const message=document.getElementById('message');
async function list(){const r=await fetch('/networks');const data=await r.json();if(!r.ok)throw Error(data.error||'Could not read saved networks');const ul=document.getElementById('networks');ul.replaceChildren();for(const n of data.networks){const li=document.createElement('li');li.append(document.createTextNode(n.ssid+' — priority '+n.priority+(n.connected?' (connected)':'')));const b=document.createElement('button');b.textContent='Remove';b.type='button';b.onclick=async()=>{try{const r=await fetch('/networks',{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({ssid:n.ssid})});const d=await r.json();if(!r.ok)throw Error(d.error);await list();message.textContent='Network removed.'}catch(e){message.textContent=e.message}};li.append(b);ul.append(li)}if(!data.networks.length)ul.textContent='No saved networks yet.';}
document.getElementById('form').onsubmit=async e=>{e.preventDefault();const button=document.getElementById('save');button.disabled=true;message.textContent='Saving network…';const payload={ssid:document.getElementById('ssid').value,priority:Number(document.getElementById('priority').value)};const password=document.getElementById('password').value;if(document.getElementById('open').checked)payload.password='';else if(password)payload.password=password;try{const r=await fetch('/provision',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});const d=await r.json();if(!r.ok||!d.ok)throw Error(d.error||'Could not save network');document.getElementById('password').value='';message.textContent='Network saved. The device will connect automatically when it is available. No restart is needed.';await list()}catch(e){message.textContent=e.message}finally{button.disabled=false}};
document.getElementById('done').onclick=async()=>{try{const r=await fetch('/finish',{method:'POST'});const d=await r.json();if(!r.ok)throw Error(d.error);message.textContent='Setup is closing. Reconnect your phone to its normal network.'}catch(e){message.textContent=e.message}};
list().catch(e=>message.textContent=e.message);
</script></html>)ECGHTML";
      server_.sendHeader("Cache-Control","no-store"); server_.send(200,"text/html; charset=utf-8",page);
    });
    server_.on("/status",HTTP_GET,[this]() {
      cJSON *root=cJSON_CreateObject(); if (root) {
        cJSON_AddStringToObject(root,"deviceId",deviceId_);
        cJSON_AddBoolToObject(root,"setupMode",setupActive_);
        cJSON_AddBoolToObject(root,"connected",WiFi.status()==WL_CONNECTED);
        cJSON_AddNumberToObject(root,"savedNetworks",profiles_.count);
        cJSON_AddBoolToObject(root,"profileStoreHealthy",storeHealthy_);
      } sendJson(200,root);
    });
    server_.on("/finish",HTTP_POST,[this]() {
      if (policy_.phase!=ECG_W_ONLINE || WiFi.status()!=WL_CONNECTED) {
        error(409,"Wait for a saved network to connect before closing setup"); return;
      }
      finishRequested_=true; finishRequestedAt_=millis();
      cJSON *root=cJSON_CreateObject(); if (root) cJSON_AddBoolToObject(root,"ok",true); sendJson(200,root);
    });
    server_.on("/networks",HTTP_GET,[this]() { listProfiles(); });
    server_.on("/networks",HTTP_POST,[this]() { saveProfile(); });
    server_.on("/provision",HTTP_POST,[this]() { saveProfile(); });
    server_.on("/networks",HTTP_DELETE,[this]() { removeProfile(); });
    server_.onNotFound([this]() { error(404,"Not found"); });
  }
};
#endif
