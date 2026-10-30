#ifndef ECG_WIFI_PROFILES_H
#define ECG_WIFI_PROFILES_H
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#define ECG_WIFI_CAPACITY 5
#define ECG_WIFI_MAGIC 0x45435735u
#define ECG_WIFI_VERSION 1u

typedef struct {
  uint8_t used;
  uint8_t priority; /* 1 is highest; equal priorities use slot order. */
  char ssid[33];
  char password[64];
} EcgWifiProfile;
typedef struct {
  uint32_t magic;
  uint16_t version;
  uint16_t count;
  uint32_t generation;
  EcgWifiProfile profiles[ECG_WIFI_CAPACITY];
  uint32_t checksum;
} EcgWifiProfiles;
static inline uint32_t ecg_wifi_crc(const void *bytes, size_t size) {
  const uint8_t *p=(const uint8_t *)bytes; uint32_t crc=0xffffffffu;
  while (size--) { crc^=*p++; for (unsigned i=0;i<8;i++) crc=(crc>>1)^((0u-(crc&1u))&0xedb88320u); }
  return ~crc;
}
static inline void ecg_wifi_profiles_seal(EcgWifiProfiles *s) {
  s->magic=ECG_WIFI_MAGIC; s->version=ECG_WIFI_VERSION; s->count=0;
  for (unsigned i=0;i<ECG_WIFI_CAPACITY;i++) if (s->profiles[i].used) s->count++;
  s->checksum=ecg_wifi_crc(s,offsetof(EcgWifiProfiles,checksum));
}
static inline void ecg_wifi_profiles_empty(EcgWifiProfiles *s) {
  memset(s,0,sizeof(*s)); ecg_wifi_profiles_seal(s);
}
static inline int ecg_wifi_profiles_valid(const EcgWifiProfiles *s) {
  unsigned count=0;
  if (s->magic!=ECG_WIFI_MAGIC || s->version!=ECG_WIFI_VERSION ||
      s->checksum!=ecg_wifi_crc(s,offsetof(EcgWifiProfiles,checksum))) return 0;
  for (unsigned i=0;i<ECG_WIFI_CAPACITY;i++) {
    const EcgWifiProfile *p=&s->profiles[i];
    if (p->used>1) return 0;
    if (!p->used) continue;
    if (!p->ssid[0] || !memchr(p->ssid,0,sizeof(p->ssid)) ||
        !memchr(p->password,0,sizeof(p->password)) || p->priority<1 || p->priority>5) return 0;
    for (unsigned j=0;j<i;j++) if (s->profiles[j].used && !strcmp(p->ssid,s->profiles[j].ssid)) return 0;
    count++;
  }
  return count==s->count;
}
static inline int ecg_wifi_profile_find(const EcgWifiProfiles *s,const char *ssid) {
  for (unsigned i=0;i<ECG_WIFI_CAPACITY;i++) if (s->profiles[i].used && !strcmp(s->profiles[i].ssid,ssid)) return (int)i;
  return -1;
}
/* NULL password preserves an existing password; an empty string means open Wi-Fi.
   Return slot, -1 for full, -2 for invalid input. Never evict another profile. */
static inline int ecg_wifi_profile_upsert(EcgWifiProfiles *s,const char *ssid,const char *password,uint8_t priority) {
  if (!ssid || !ssid[0] || strlen(ssid)>32 || (password && strlen(password)>63) || priority<1 || priority>5) return -2;
  int slot=ecg_wifi_profile_find(s,ssid);
  if (slot<0) {
    if (!password) return -2;
    for (unsigned i=0;i<ECG_WIFI_CAPACITY;i++) if (!s->profiles[i].used) { slot=(int)i; break; }
  }
  if (slot<0) return -1;
  EcgWifiProfile *p=&s->profiles[slot]; p->used=1; p->priority=priority;
  memcpy(p->ssid,ssid,strlen(ssid)+1);
  if (password) { memset(p->password,0,sizeof(p->password)); memcpy(p->password,password,strlen(password)+1); }
  s->generation++; ecg_wifi_profiles_seal(s); return slot;
}
static inline int ecg_wifi_profile_remove(EcgWifiProfiles *s,const char *ssid) {
  int i=ecg_wifi_profile_find(s,ssid); if (i<0) return 0;
  memset(&s->profiles[i],0,sizeof(s->profiles[i])); s->generation++; ecg_wifi_profiles_seal(s); return 1;
}
static inline uint8_t ecg_wifi_profile_mask(const EcgWifiProfiles *s) {
  uint8_t mask=0; for (unsigned i=0;i<ECG_WIFI_CAPACITY;i++) if (s->profiles[i].used) mask|=(uint8_t)(1u<<i);
  return mask;
}
#endif
