"""Isolated official oCIS HTTP OIDC probe. No tokens/passwords are persisted.
Run: venv/bin/python probe.py /path/to/ocis
Local self-signed TLS only. Equivalent HTTP sequence, not GUI acceptance.
"""
import base64,hashlib,json,os,pathlib,re,secrets,shutil,subprocess,sys,tempfile,time,urllib.parse
import requests
requests.packages.urllib3.disable_warnings()
HERE=pathlib.Path(__file__).resolve().parent
BASE='https://localhost:9200'
results=[]
passed=False
EXPECTED={'discovery':200,'hello':200,'wrong-password':204,'logon':200,'consent':200,'authorization-redirect':302,'token':200,'code-replay':400,'bearer-graph-drives':200,'wrong-bearer':401,'refresh':200,'wrong-pkce':400,'correct-pkce-after-failed-exchange':400}
def record(name,r,extra=None):
 item={'name':name,'status':r.status_code,'headers':{k:v for k,v in r.headers.items() if k.lower() in ['content-type','cache-control','pragma','www-authenticate']}}
 if extra: item.update(extra)
 results.append(item); print(json.dumps(item),flush=True)
 assert r.status_code == EXPECTED[name], name
 if name in ['logon','consent']: assert item.get('success') is True, name
 if name=='authorization-redirect': assert item.get('has_code'), name
 if name in ['token','refresh']: assert {'access_token','id_token','refresh_token','expires_in','token_type'} <= set(item['fields']), name
 if name in ['code-replay','wrong-pkce','correct-pkce-after-failed-exchange']: assert item.get('error')=='invalid_grant', name
 if name=='bearer-graph-drives': assert 'value' in item['fields'], name
def fields(r):
 j=r.json(); return {'fields':sorted(j),'error':j.get('error')}
def run(wrong_pkce=False):
 p=pathlib.Path(tempfile.mkdtemp(prefix='oidc-reprobe-'));password=secrets.token_urlsafe(28)
 env={**os.environ,'HOME':str(p/'home'),'OCIS_CONFIG_DIR':str(p/'config'),'OCIS_BASE_DATA_PATH':str(p/'data'),'OCIS_INSECURE':'true','PROXY_ENABLE_BASIC_AUTH':'true','OCIS_URL':BASE}
 server=None
 try:
  subprocess.run([sys.argv[1],'init','--insecure','true','--admin-password',password],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=True)
  server=subprocess.Popen([sys.argv[1],'server'],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
  time.sleep(18)
  s=requests.Session();s.verify=False;s.trust_env=False
  r=s.get(BASE+'/.well-known/openid-configuration',timeout=20);d=r.json();record('discovery',r,{'metadata':{k:d[k] for k in ['issuer','authorization_endpoint','token_endpoint','userinfo_endpoint','jwks_uri','token_endpoint_auth_methods_supported'] if k in d}})
  theme=(HERE/'theme.cpp').read_text()
  cid=re.search(r'oauthClientId\(\) const.*?QStringLiteral\("([^"]+)"',theme,re.S).group(1)
  secret=re.search(r'oauthClientSecret\(\) const.*?QStringLiteral\("([^"]+)"',theme,re.S).group(1)
  verifier=secrets.token_urlsafe(48);challenge=base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip('=')
  r=s.get(d['authorization_endpoint'],params={'client_id':cid,'redirect_uri':'http://127.0.0.1:53682','response_type':'code','scope':'openid profile email offline_access','state':secrets.token_urlsafe(18),'code_challenge':challenge,'code_challenge_method':'S256'},timeout=20)
  q=dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(r.url).query));hello={k:q.get(k,'') for k in ['state','flow','scope','prompt','client_id','redirect_uri','id_token_hint','max_age']}
  h={'Kopano-Konnect-XSRF':'1','Origin':BASE,'Referer':r.url}
  r=s.post(BASE+'/signin/v1/identifier/_/hello',json=hello,headers=h);record('hello',r,{'fields':sorted(r.json())})
  r=s.post(BASE+'/signin/v1/identifier/_/logon',json={'state':hello['state'],'params':['admin','wrong-password','1'],'hello':hello},headers=h);record('wrong-password',r)
  r=s.post(BASE+'/signin/v1/identifier/_/logon',json={'state':hello['state'],'params':['admin',password,'1'],'hello':hello},headers=h);record('logon',r,{'success':r.json().get('success')})
  cstate=secrets.token_hex(16)
  r=s.post(BASE+'/signin/v1/identifier/_/consent',json={'state':cstate,'allow':True,'scope':q['scope'],'client_id':cid,'redirect_uri':q['redirect_uri'],'ref':q['state'],'flow_nonce':''},headers=h);record('consent',r,{'success':r.json().get('success')})
  q['konnect']=cstate;r=s.get(d['authorization_endpoint'],params=q,allow_redirects=False)
  cb=urllib.parse.parse_qs(urllib.parse.urlsplit(r.headers.get('Location','')).query)
  record('authorization-redirect',r,{'callback_fields':sorted(cb),'has_code':bool(cb.get('code'))})
  code=cb['code'][0];data={'grant_type':'authorization_code','code':code,'redirect_uri':q['redirect_uri'],'client_id':cid,'code_verifier':verifier}
  if wrong_pkce:
   r=s.post(d['token_endpoint'],data={**data,'code_verifier':'wrong-verifier-value-xxxxxxxxxxxxxxxxxxxxxxxxxxx'},auth=(cid,secret));record('wrong-pkce',r,fields(r))
   r=s.post(d['token_endpoint'],data=data,auth=(cid,secret));record('correct-pkce-after-failed-exchange',r,fields(r));return
  r=s.post(d['token_endpoint'],data=data,auth=(cid,secret));t=r.json();record('token',r,fields(r))
  r=s.post(d['token_endpoint'],data=data,auth=(cid,secret));record('code-replay',r,fields(r))
  r=s.get(BASE+'/graph/v1.0/me/drives',headers={'Authorization':'Bearer '+t['access_token']});record('bearer-graph-drives',r,{'fields':sorted(r.json())})
  r=s.get(BASE+'/graph/v1.0/me/drives',headers={'Authorization':'Bearer invalid-probe-token'});record('wrong-bearer',r)
  r=s.post(d['token_endpoint'],data={'grant_type':'refresh_token','refresh_token':t['refresh_token'],'client_id':cid},auth=(cid,secret));record('refresh',r,fields(r))
 finally:
  if server:
   server.terminate()
   try: server.wait(timeout=20)
   except subprocess.TimeoutExpired: server.kill();server.wait()
  shutil.rmtree(p)
try:
 run();run(True)
 assert set(EXPECTED)=={item['name'] for item in results}
 passed=True
 print('ALL CHECKS PASSED',flush=True)
finally:
 (HERE/'results.json').write_text(json.dumps({'complete':passed,'passed':passed,'server_version':'8.2.3','desktop_source_commit':'9525d7331115d04ab0dd7646db3d0c084c7a1599','method':'HTTP sequence, not GUI client','results':results},indent=2)+'\n')
