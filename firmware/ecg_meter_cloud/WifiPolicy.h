#ifndef ECG_WIFI_POLICY_H
#define ECG_WIFI_POLICY_H
#include <stdint.h>
#include <string.h>
#include "WifiProfiles.h"
/* Platform-independent policy, shared verbatim by the ESP32 and native tests. */
#define ECG_WIFI_JOIN_MS 25000u
#define ECG_WIFI_SCAN_MS 15000u
#define ECG_WIFI_RESCAN_MS 30000u
#define ECG_WIFI_STOP_MS 5000u
#define ECG_WIFI_SETTLE_MS 250u
#define ECG_WIFI_RETRY_MS 1500u
#define ECG_WIFI_AP_GRACE_MS 3000u
#define ECG_WIFI_RECONNECTS 2u

enum { ECG_W_COLD,ECG_W_STOPPING,ECG_W_SCANNING,ECG_W_CONNECTING,ECG_W_ONLINE,ECG_W_BACKOFF };
enum { ECG_W_TO_SCAN,ECG_W_TO_JOIN,ECG_W_TO_WAIT };
enum { ECG_W_SCAN_RUNNING,ECG_W_SCAN_DONE,ECG_W_SCAN_FAILED };
enum { ECG_W_STOP=1,ECG_W_SCAN=2,ECG_W_JOIN=4,ECG_W_AP_ON=8,ECG_W_AP_OFF=16,ECG_W_LINK_UP=32,ECG_W_LINK_DOWN=64 };
typedef struct {
  uint8_t phase,afterStop,failedMask,availableMask,reconnects,reconnecting,setup,profilesChanged;
  int8_t target,lastGood;
  uint32_t since,settleMs,offlineSince;
} EcgWifiPolicy;
typedef struct {
  uint32_t now;
  uint8_t connected,stopped,joinFailed,scanStatus,availableMask,usedMask,setupBusy;
  uint8_t priority[ECG_WIFI_CAPACITY];
} EcgWifiInput;
typedef struct { unsigned flags; int target; } EcgWifiAction;
static inline int ecg_wifi_best(uint8_t available,uint8_t used,uint8_t failed,const uint8_t *priority) {
  int best=-1;
  for (unsigned i=0;i<ECG_WIFI_CAPACITY;i++) if ((available&used&~failed)&(1u<<i))
    if (best<0 || priority[i]<priority[best]) best=(int)i;
  return best;
}
static inline void ecg_wifi_policy_init(EcgWifiPolicy *p) {
  memset(p,0,sizeof(*p)); p->target=-1; p->lastGood=-1;
}
static inline void ecg_wifi_stop_for(EcgWifiPolicy *p,EcgWifiAction *a,uint8_t next,int target,uint32_t now,uint32_t settle) {
  p->phase=ECG_W_STOPPING; p->afterStop=next; p->target=(int8_t)target;
  p->since=now; p->settleMs=settle; a->flags|=ECG_W_STOP;
}
static inline EcgWifiAction ecg_wifi_tick(EcgWifiPolicy *p,const EcgWifiInput *in) {
  EcgWifiAction a={0,-1}; uint32_t elapsed=(uint32_t)(in->now-p->since);
  if (p->profilesChanged && p->phase!=ECG_W_ONLINE && p->phase!=ECG_W_COLD) {
    p->profilesChanged=0; p->failedMask=0; p->reconnecting=0;
    ecg_wifi_stop_for(p,&a,ECG_W_TO_SCAN,-1,in->now,ECG_WIFI_SETTLE_MS); return a;
  }
  switch(p->phase) {
  case ECG_W_COLD:
    p->profilesChanged=0; p->offlineSince=in->now;
    ecg_wifi_stop_for(p,&a,ECG_W_TO_SCAN,-1,in->now,ECG_WIFI_SETTLE_MS); break;
  case ECG_W_STOPPING:
    if (in->stopped && elapsed>=p->settleMs) {
      if (!p->setup && (uint32_t)(in->now-p->offlineSince)>=ECG_WIFI_RESCAN_MS) {
        p->setup=1; a.flags|=ECG_W_AP_ON;
      }
      if (p->afterStop==ECG_W_TO_WAIT || !in->usedMask) {
        if (!p->setup) { p->setup=1; a.flags|=ECG_W_AP_ON; }
        p->phase=ECG_W_BACKOFF; p->since=in->now;
      } else if (p->afterStop==ECG_W_TO_JOIN && p->target>=0 && (in->usedMask&(1u<<p->target))) {
        p->phase=ECG_W_CONNECTING; p->since=in->now; a.flags|=ECG_W_JOIN; a.target=p->target;
      } else {
        p->phase=ECG_W_SCANNING; p->since=in->now; a.flags|=ECG_W_SCAN;
      }
    } else if (elapsed>=ECG_WIFI_STOP_MS) {
      /* No begin/config call is permitted without a confirmed station stop. */
      p->phase=ECG_W_BACKOFF; p->since=in->now;
    }
    break;
  case ECG_W_SCANNING:
    if (in->scanStatus==ECG_W_SCAN_DONE) {
      p->availableMask=in->availableMask;
      int target=ecg_wifi_best(p->availableMask,in->usedMask,p->failedMask,in->priority);
      ecg_wifi_stop_for(p,&a,target<0?ECG_W_TO_WAIT:ECG_W_TO_JOIN,target,in->now,ECG_WIFI_SETTLE_MS);
    } else if (in->scanStatus==ECG_W_SCAN_FAILED || elapsed>=ECG_WIFI_SCAN_MS)
      ecg_wifi_stop_for(p,&a,ECG_W_TO_WAIT,-1,in->now,ECG_WIFI_SETTLE_MS);
    break;
  case ECG_W_CONNECTING:
    if (in->connected) {
      p->phase=ECG_W_ONLINE; p->lastGood=p->target; p->since=in->now;
      p->failedMask=0; p->reconnecting=0; a.flags|=ECG_W_LINK_UP;
    } else if (in->joinFailed || elapsed>=ECG_WIFI_JOIN_MS) {
      if (p->target>=0) p->failedMask|=(uint8_t)(1u<<p->target);
      if (p->reconnecting && p->reconnects>1) {
        p->reconnects--;
        ecg_wifi_stop_for(p,&a,ECG_W_TO_JOIN,p->target,in->now,ECG_WIFI_RETRY_MS);
      } else if (p->reconnecting) {
        p->reconnecting=0;
        ecg_wifi_stop_for(p,&a,ECG_W_TO_SCAN,-1,in->now,ECG_WIFI_RETRY_MS);
      } else {
        int target=ecg_wifi_best(p->availableMask,in->usedMask,p->failedMask,in->priority);
        ecg_wifi_stop_for(p,&a,target<0?ECG_W_TO_WAIT:ECG_W_TO_JOIN,target,in->now,ECG_WIFI_RETRY_MS);
      }
    }
    break;
  case ECG_W_ONLINE:
    p->profilesChanged=0; /* New profiles apply on next outage; never roam a stable link. */
    if (!in->connected) {
      a.flags|=ECG_W_LINK_DOWN; p->offlineSince=in->now; p->reconnecting=1; p->reconnects=ECG_WIFI_RECONNECTS; p->failedMask=0;
      int target=p->lastGood>=0 && (in->usedMask&(1u<<p->lastGood)) ? p->lastGood : -1;
      p->reconnecting=target>=0;
      ecg_wifi_stop_for(p,&a,target<0?ECG_W_TO_SCAN:ECG_W_TO_JOIN,target,in->now,ECG_WIFI_RETRY_MS);
    } else if (p->setup && !in->setupBusy && elapsed>=ECG_WIFI_AP_GRACE_MS) { p->setup=0; a.flags|=ECG_W_AP_OFF; }
    break;
  case ECG_W_BACKOFF:
    if (elapsed>=ECG_WIFI_RESCAN_MS) {
      p->failedMask=0; p->reconnecting=0;
      ecg_wifi_stop_for(p,&a,ECG_W_TO_SCAN,-1,in->now,ECG_WIFI_SETTLE_MS);
    }
    break;
  }
  return a;
}
#endif
