"""Compare non-Wi-Fi firmware sections to the parent/PR base, without secrets."""
from pathlib import Path
import subprocess,sys,re
root=Path(__file__).resolve().parents[3]
path='firmware/ecg_meter_cloud/ecg_meter_cloud.ino'
ref=sys.argv[1] if len(sys.argv)>1 else 'HEAD'
old=subprocess.check_output(['git','show',f'{ref}:{path}'],cwd=root,text=True,encoding="utf-8")
new=(root/path).read_text(encoding="utf-8")
def section(source,start,end=None):
 a=source.index(start);return source[a:source.index(end,a) if end else len(source)]
for start,end in [
 ('void loop() {','// ---------- Clock / display ----------'),
 ('// ---------- Clock / display ----------','// ---------- Network worker ----------'),
 ('// ---------- LittleFS: flash-backed append-only outbox ----------','// ---------- Local Wi-Fi provisioning ----------'),
]:
 if start=='// ---------- Clock / display ----------':
  # New Wi-Fi owner task is inserted immediately before the network worker.
  assert section(old,start,end)==section(new,start,'// Dedicated owner remains responsive')
 elif start.startswith('// ---------- LittleFS'):
  assert section(old,start,end)==section(new,start,'// ---------- Backend response string decoder ----------')
 else:assert section(old,start,end)==section(new,start,end)
# Replay/ACK handling below the connection preamble is untouched.
start='    bool handledFlashEvent = false;'
assert section(old,start,'// ---------- LittleFS:')==section(new,start,'// ---------- LittleFS:')
assert section(old,'bool extractJsonString(const String& body, const char* key, String& value) {','void configureProvisioningServer() {').rstrip()==section(new,'bool extractJsonString(const String& body, const char* key, String& value) {').rstrip()
headers='\n'.join((root/'firmware/ecg_meter_cloud'/name).read_text(encoding="utf-8") for name in ['MultiWifiManager.h','WifiPolicy.h','WifiProfiles.h'])
all_code=new+headers
assert len(re.findall(r'WiFi\.begin\(',all_code))==1
assert not re.search(r'WiFi\.reconnect\(',all_code)
assert 'ESP.restart(' not in all_code
assert 'setAutoReconnect(false)' in headers
assert 'store_.begin("ecg-wifi",false)' in headers
assert not re.search(r'store_\.(clear|remove)\(',headers)
assert not re.search(r'cJSON_Add\w+ToObject\([^\n]*"password"',headers)
assert not re.search(r'Serial\.[^;]*password',headers,re.I)
assert 'seenWifiGeneration' in new and 'wifiGeneration != seenWifiGeneration' in new
print('PASS: non-Wi-Fi sections unchanged; one begin owner; no reconnect/restart; profiles separate from meter NVS; no password response/log fields; link generation triggers existing handshake')
