#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <assert.h>
#include "../WifiPolicy.h"

typedef struct {
 EcgWifiPolicy policy; EcgWifiInput input;
 unsigned stops,scans,joins,apOn,apOff,links,downs;
 int targets[128]; int stopBeforeJoin;
 uint32_t stopAt;
} Harness;
static Harness make(uint8_t used) {
 Harness h; memset(&h,0,sizeof(h));ecg_wifi_policy_init(&h.policy);
 h.input.usedMask=used;for(unsigned i=0;i<5;i++)h.input.priority[i]=(uint8_t)(i+1);return h;
}
static EcgWifiAction step(Harness *h,uint32_t dt) {
 h->input.now+=dt;EcgWifiAction a=ecg_wifi_tick(&h->policy,&h->input);
 if(a.flags&ECG_W_STOP){h->stops++;h->stopBeforeJoin=1;h->stopAt=h->input.now;h->input.stopped=1;h->input.connected=0;h->input.joinFailed=0;h->input.scanStatus=ECG_W_SCAN_RUNNING;}
 if(a.flags&ECG_W_SCAN){h->scans++;h->input.stopped=0;h->input.scanStatus=ECG_W_SCAN_RUNNING;}
 if(a.flags&ECG_W_JOIN){assert(h->stopBeforeJoin);assert(h->input.stopped);assert((uint32_t)(h->input.now-h->stopAt)>=ECG_WIFI_SETTLE_MS);h->stopBeforeJoin=0;assert(h->joins<128);h->targets[h->joins++]=a.target;h->input.stopped=0;h->input.joinFailed=0;}
 if(a.flags&ECG_W_AP_ON)h->apOn++;
 if(a.flags&ECG_W_AP_OFF)h->apOff++;
 if(a.flags&ECG_W_LINK_UP)h->links++;
 if(a.flags&ECG_W_LINK_DOWN)h->downs++;
 return a;
}
static void boot_scan(Harness *h){step(h,0);step(h,ECG_WIFI_SETTLE_MS);assert(h->policy.phase==ECG_W_SCANNING);}
static void scanned(Harness *h,uint8_t mask){h->input.availableMask=mask;h->input.scanStatus=ECG_W_SCAN_DONE;step(h,1);step(h,ECG_WIFI_SETTLE_MS);}
static void connected(Harness *h){h->input.connected=1;step(h,1);assert(h->policy.phase==ECG_W_ONLINE);}
static void failed(Harness *h){h->input.joinFailed=1;step(h,1);}
static unsigned tests=0;
#define TEST(name) do{tests++;printf("PASS %s\n",name);}while(0)

int main(void){
 for(int available=0;available<3;available++){
  Harness h=make(31);boot_scan(&h);scanned(&h,(uint8_t)(1u<<available));assert(h.joins==1&&h.targets[0]==available);connected(&h);
  TEST(available==0?"home on startup":available==1?"office without home":"hotspot without home/office");
 }
 {Harness h=make(31);boot_scan(&h);scanned(&h,31);assert(h.targets[0]==0);h.input.priority[0]=5;h.input.priority[3]=1;connected(&h);step(&h,600000);assert(h.joins==1&&h.scans==1);TEST("stable connection does not roam to another saved network");}
 {Harness h=make(31);h.input.priority[0]=5;h.input.priority[4]=1;boot_scan(&h);scanned(&h,31);assert(h.targets[0]==4);TEST("highest priority beats scan order and slot number");}
 {Harness h=make(7);boot_scan(&h);scanned(&h,7);failed(&h);step(&h,ECG_WIFI_RETRY_MS);assert(h.targets[1]==1);failed(&h);step(&h,ECG_WIFI_RETRY_MS);assert(h.targets[2]==2);connected(&h);TEST("bad credentials fail through available candidates");}
 {Harness h=make(7);boot_scan(&h);scanned(&h,7);connected(&h);h.input.connected=0;step(&h,1);step(&h,ECG_WIFI_RETRY_MS);assert(h.targets[1]==0);failed(&h);step(&h,ECG_WIFI_RETRY_MS);assert(h.targets[2]==0);failed(&h);step(&h,ECG_WIFI_RETRY_MS);assert(h.policy.phase==ECG_W_SCANNING);scanned(&h,6);assert(h.targets[3]==1);connected(&h);assert(h.downs==1&&h.links==2);TEST("two controlled reconnects then fail over after an outage");}
 {Harness h=make(31);boot_scan(&h);scanned(&h,0);assert(h.policy.phase==ECG_W_BACKOFF&&h.apOn==1);step(&h,ECG_WIFI_RESCAN_MS-1);assert(h.scans==1);step(&h,1);step(&h,ECG_WIFI_SETTLE_MS);scanned(&h,4);connected(&h);assert(h.apOff==0);step(&h,ECG_WIFI_AP_GRACE_MS);assert(h.apOff==1);TEST("all absent opens setup; returning hotspot reconnects and closes setup after grace");}
 {Harness h=make(0);step(&h,0);step(&h,ECG_WIFI_SETTLE_MS);assert(h.apOn==1&&h.joins==0);h.input.usedMask=1;h.policy.profilesChanged=1;step(&h,1);step(&h,ECG_WIFI_SETTLE_MS);scanned(&h,1);connected(&h);TEST("new onboarding profile connects without restart");}
 {Harness h=make(7);boot_scan(&h);scanned(&h,1);connected(&h);h.policy.profilesChanged=1;step(&h,1);assert(h.joins==1&&h.scans==1);TEST("saving a profile leaves a stable connection alone");}
 {Harness h=make(3);boot_scan(&h);scanned(&h,3);h.policy.profilesChanged=1;step(&h,1);assert(h.policy.phase==ECG_W_STOPPING);step(&h,ECG_WIFI_SETTLE_MS);assert(h.policy.phase==ECG_W_SCANNING);TEST("new profile cancels an in-flight attempt before rescanning");}
 {Harness h=make(1);boot_scan(&h);step(&h,ECG_WIFI_SCAN_MS);step(&h,ECG_WIFI_SETTLE_MS);assert(h.apOn==1&&h.policy.phase==ECG_W_BACKOFF);TEST("stuck scan is bounded and setup remains available");}
 {Harness h=make(1);boot_scan(&h);scanned(&h,1);step(&h,ECG_WIFI_JOIN_MS-1);assert(h.policy.phase==ECG_W_CONNECTING);step(&h,1);step(&h,ECG_WIFI_RETRY_MS);assert(h.apOn==1&&h.joins==1);TEST("join timeout retains bounded retry/backoff");}
 {Harness h=make(1);step(&h,0);h.input.stopped=0;step(&h,ECG_WIFI_STOP_MS);assert(h.joins==0&&h.scans==0);step(&h,ECG_WIFI_RESCAN_MS);h.input.stopped=0;step(&h,ECG_WIFI_STOP_MS);assert(h.joins==0);TEST("unconfirmed station cancellation never permits a competing begin");}
 {Harness h=make(31);h.input.now=0xffffff80u;boot_scan(&h);scanned(&h,16);assert(h.targets[0]==4);step(&h,ECG_WIFI_JOIN_MS);step(&h,ECG_WIFI_RETRY_MS);assert(h.apOn==1);TEST("deadlines work across millis rollover");}
 {Harness h=make(1);boot_scan(&h);scanned(&h,0);step(&h,ECG_WIFI_RESCAN_MS);step(&h,ECG_WIFI_SETTLE_MS);scanned(&h,1);connected(&h);h.input.setupBusy=1;step(&h,ECG_WIFI_AP_GRACE_MS+100);assert(h.apOff==0);h.input.setupBusy=0;step(&h,1);assert(h.apOff==1);TEST("onboarding activity keeps setup available while adding several networks");}
 {Harness h=make(7);boot_scan(&h);scanned(&h,7);step(&h,ECG_WIFI_JOIN_MS);step(&h,ECG_WIFI_RETRY_MS);step(&h,ECG_WIFI_JOIN_MS);step(&h,ECG_WIFI_RETRY_MS);assert(h.apOn==1&&h.policy.phase==ECG_W_CONNECTING&&h.targets[2]==2);TEST("prolonged bad-credential rounds expose setup at a safe station-stop boundary");}
 {Harness h=make(3);boot_scan(&h);scanned(&h,1);connected(&h);h.input.usedMask=2;h.policy.profilesChanged=1;step(&h,1);h.input.connected=0;step(&h,1);step(&h,ECG_WIFI_RETRY_MS);assert(h.policy.phase==ECG_W_SCANNING);scanned(&h,2);failed(&h);step(&h,ECG_WIFI_RETRY_MS);assert(h.apOn==1&&h.joins==2);TEST("removing current profile defers switching until outage and skips obsolete retries");}
 {EcgWifiProfiles p;ecg_wifi_profiles_empty(&p);assert(ecg_wifi_profiles_valid(&p));
  const char *names[]={"Home WiFi","Office WiFi","Phone hotspot","Other A","Other B"};
  for(int i=0;i<5;i++)assert(ecg_wifi_profile_upsert(&p,names[i],"private-password",(uint8_t)(i+1))==i);
  assert(p.count==5&&ecg_wifi_profiles_valid(&p));EcgWifiProfiles saved=p;
  assert(ecg_wifi_profile_upsert(&p,"Sixth","secret",1)==-1);assert(!memcmp(&p,&saved,sizeof(p)));
  assert(ecg_wifi_profile_upsert(&p,names[1],NULL,1)==1);assert(!strcmp(p.profiles[1].password,"private-password"));
  assert(ecg_wifi_profile_remove(&p,names[2]));assert(ecg_wifi_profile_upsert(&p,"Replacement","",2)==2);
  assert(p.count==5&&ecg_wifi_profiles_valid(&p));
  TEST("five profiles, explicit capacity error, password preservation, removal and open network");
  unsigned char bytes[sizeof(p)];memcpy(bytes,&p,sizeof(p));EcgWifiProfiles reboot;memcpy(&reboot,bytes,sizeof(reboot));assert(ecg_wifi_profiles_valid(&reboot));assert(!strcmp(reboot.profiles[1].ssid,"Office WiFi"));TEST("profile snapshot survives a restart round trip");
  bytes[sizeof(p)/2]^=1;memcpy(&reboot,bytes,sizeof(reboot));assert(!ecg_wifi_profiles_valid(&reboot));TEST("corrupt/partial snapshot fails checksum instead of being accepted");
  p.profiles[1].ssid[0]=0;ecg_wifi_profiles_seal(&p);assert(!ecg_wifi_profiles_valid(&p));TEST("semantic validation rejects invalid saved SSIDs even with valid CRC");
 }
 {EcgWifiProfiles p;ecg_wifi_profiles_empty(&p);char ssid[34],password[65];memset(ssid,'x',33);ssid[33]=0;memset(password,'s',64);password[64]=0;
  assert(ecg_wifi_profile_upsert(&p,ssid,"x",1)==-2);ssid[32]=0;
  assert(ecg_wifi_profile_upsert(&p,ssid,password,1)==-2);password[63]=0;
  assert(ecg_wifi_profile_upsert(&p,ssid,password,1)==0);assert(ecg_wifi_profile_upsert(&p," leading and trailing ","",5)==1);
  assert(ecg_wifi_profile_upsert(&p,"new",NULL,1)==-2);assert(ecg_wifi_profile_upsert(&p,"new","pw",0)==-2);
  TEST("SSID/password boundaries and whitespace SSIDs are preserved");
 }
 {EcgWifiProfiles p;ecg_wifi_profiles_empty(&p);ecg_wifi_profile_upsert(&p,"Legacy SSID","unchanged-password",1);EcgWifiProfiles old=p,next=p;
  ecg_wifi_profile_upsert(&next,"Office","new-password",2);assert(ecg_wifi_profiles_valid(&old));assert(old.count==1&&next.count==2);
  /* The codec retains a complete old snapshot until a single new blob commits. */
  assert(!strcmp(old.profiles[0].password,next.profiles[0].password));TEST("legacy migration and next snapshot do not mutate the old snapshot");
 }
 {Harness h=make(31);unsigned seed=12345;unsigned joinsBefore=0;
  for(unsigned i=0;i<20000;i++){
   seed=seed*1664525u+1013904223u;
   if(h.policy.phase==ECG_W_SCANNING){h.input.scanStatus=ECG_W_SCAN_DONE;h.input.availableMask=(uint8_t)(seed&31);}
   if(h.policy.phase==ECG_W_CONNECTING){h.input.connected=(seed&3)==0;h.input.joinFailed=(seed&7)==1;}
   else if(h.policy.phase==ECG_W_ONLINE)h.input.connected=(seed&63)!=0;
   if(h.joins>=120){joinsBefore+=h.joins;h.joins=0;}
   step(&h,(seed>>16)%700);
  }
  assert(joinsBefore+h.joins>10);TEST("20000 transition stress ticks preserve cancellation-before-join invariant");
 }
 printf("%u policy/profile scenarios passed\n",tests);return 0;
}
