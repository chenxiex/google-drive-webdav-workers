import shutil,os,ssl,json,time,hashlib,base64,subprocess,tempfile,urllib.request,urllib.error,urllib.parse,re,uuid,zlib,struct,datetime
from pathlib import Path
OUT=Path(__file__).parent; BIN=os.environ.get('OCIS_BINARY','/tmp/ocis-http-rerun/ocis'); D=Path(tempfile.mkdtemp(prefix='ocis-http-private-')); os.chmod(D,0o700)
assert hashlib.sha256(Path(BIN).read_bytes()).hexdigest()=='7a386c4e85ffe629d6ffdfb0a0ea4e60c87ac3620892b9534d0a3ec8b14fc68a', 'Unexpected official binary digest'
pw=uuid.uuid4().hex; base='https://localhost:9200'; ctx=ssl._create_unverified_context(); records=[]; substitutions={}; server=None
E=dict(os.environ,HOME=str(D),OCIS_CONFIG_DIR=str(D/'config'),OCIS_BASE_DATA_PATH=str(D/'data'),OCIS_INSECURE='true',PROXY_ENABLE_BASIC_AUTH='true',OCIS_URL=base,OCIS_LOG_LEVEL='error',OCIS_LOG_PRETTY='false')
(D/'config').mkdir(); log=open(D/'private.log','wb')
def clean(s):
 s=str(s).replace(pw,'<password>')
 s=re.sub(r'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+',lambda m: substitutions.setdefault(m[0],f'TOKEN-{len(substitutions)+1}'),s)
 s=re.sub(r'(?i)(access_token|refresh_token|token|signature)=([^&\s"<>]+)',r'\1=<redacted>',s)
 s=re.sub(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}',lambda m:substitutions.setdefault(m[0],f'UUID-{len(substitutions)+1}'),s)
 return s

def req(case,method,url,body=None,headers=None,auth=True):
 url=urllib.parse.urljoin(base,url); h={'User-Agent':'ocis-reference-probe/1','Accept-Encoding':'identity','Host':urllib.parse.urlsplit(url).netloc,**dict(headers or {})}
 if auth:h['Authorization']='Basic '+base64.b64encode(('admin:'+pw).encode()).decode()
 if isinstance(body,str):body=body.encode()
 if body is not None:h['Content-Length']=str(len(body))
 r=urllib.request.Request(url,data=body,headers=h,method=method); start=time.monotonic()
 try: res=urllib.request.urlopen(r,context=ctx,timeout=40)
 except urllib.error.HTTPError as e:res=e
 data=res.read(); rh=dict(res.headers); typ=rh.get('Content-Type','')
 def show(data):
  if data is None:return None
  if len(data)<30000 and (not data or data.startswith((b'<',b'{',b'[')) or all(c in b'\r\n\t' or 32<=c<127 for c in data)):return clean(data.decode())
  return {'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),**({'png_dimensions':list(struct.unpack('>II',data[16:24]))} if data.startswith(b'\x89PNG') else {})}
 records.append(dict(case=case,request=dict(method=method,url=clean(url),headers={k:('<redacted>' if k.lower() in ('authorization','cookie','lock-token') else clean(v)) for k,v in h.items()},body=show(body)),response=dict(status=res.status,headers={k:('<redacted>' if k.lower() in ('set-cookie','lock-token') else clean(v)) for k,v in rh.items()},body=show(data),bytes=len(data),sha256=hashlib.sha256(data).hexdigest()),elapsed_seconds=round(time.monotonic()-start,3)))
 save(); print(case,res.status,flush=True);return res.status,rh,data

def save():
 (OUT/'observations.json').write_text(json.dumps({'reference':'official oCIS 8.2.3 local filesystem; not Worker','run_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'binary_sha256':hashlib.sha256(Path(BIN).read_bytes()).hexdigest(),'request_header_scope':'Explicit application headers; Python urllib may add default Content-Type for body-bearing requests if not specified. Response headers captured in full.', 'sanitization':'Authorization/cookie/lock tokens redacted; UUIDs stable aliases; synthetic fixture bodies only; private server configuration excluded','cases':records},indent=2))
def start():
 global server
 server=subprocess.Popen([BIN,'server'],env=E,stdout=log,stderr=log);time.sleep(18)
def stop():
 if server and server.poll() is None:
  server.terminate()
  try:server.wait(20)
  except subprocess.TimeoutExpired:server.kill();server.wait()
try:
 subprocess.run([BIN,'init','--insecure','true','--admin-password',pw],env=E,stdout=log,stderr=log,check=True);start()
 req('unauth','PROPFIND','/remote.php/webdav/',headers={'Depth':'0'},auth=False)
 req('status','GET','/status.php',auth=False);req('discovery','GET','/.well-known/openid-configuration',auth=False)
 req('user','GET','/ocs/v2.php/cloud/user?format=json');req('capabilities','GET','/ocs/v2.php/cloud/capabilities?format=json')
 _,_,data=req('drives','GET','/graph/v1.0/me/drives');drive=next(d for d in json.loads(data)['value'] if d['driveType']=='personal');root=drive['root']['webDavUrl'].rstrip('/')
 print('root resolved',flush=True)
 req('mkdir','MKCOL',root+'/probe-run');p=root+'/probe-run'; f=p+'/file.txt'
 req('fixture-upload','PUT',f,b'0123456789abcdefghijklmnopqrstuvwxyz')
 req('properties','PROPFIND',p+'/',headers={'Depth':'1'})
 req('properties-mixed','PROPFIND',f,'<d:propfind xmlns:d="DAV:" xmlns:x="urn:probe"><d:prop><d:getetag/><d:getcontentlength/><x:unknown/></d:prop></d:propfind>',{'Depth':'0','Content-Type':'application/xml'})
 req('range','GET',f,headers={'Range':'bytes=10-19'});req('bad-range','GET',f,headers={'Range':'bytes=10000-20000'});req('missing','GET',p+'/missing')
 req('overwrite-target','PUT',p+'/existing.txt',b'existing')
 req('overwrite-false','COPY',f,headers={'Destination':p+'/existing.txt','Overwrite':'F'});req('overwrite-target-unchanged','GET',p+'/existing.txt')
 req('bad-if-match','PUT',f,b'bad',{'If-Match':'"stale"'});req('missing-parent','MKCOL',p+'/absent/child')
 req('copy-success','COPY',f,headers={'Destination':p+'/copy.txt','Overwrite':'F'});req('copy-content','GET',p+'/copy.txt')
 req('move-success','MOVE',p+'/copy.txt',headers={'Destination':p+'/moved.txt','Overwrite':'F'});req('move-old-missing','GET',p+'/copy.txt');req('move-content','GET',p+'/moved.txt')
 req('options','OPTIONS',root)
 def post(case,name,length,body=b''):
  return req(case,'POST',root,body,{'Tus-Resumable':'1.0.0','Upload-Length':str(length),'Upload-Metadata':'filename '+base64.b64encode(name.encode()).decode()+',filetype '+base64.b64encode(b'application/octet-stream').decode(),'Content-Type':'application/offset+octet-stream'})
 _,h,_=post('creation-with-data','probe-run/tus.txt',6,b'abc'); loc=h.get('Location');assert loc, 'Missing TUS Location'
 if loc:
  th={'Tus-Resumable':'1.0.0'}
  req('head-partial','HEAD',loc,headers=th)
  req('offset-conflict','PATCH',loc,b'xx',{**th,'Upload-Offset':'0','Content-Type':'application/offset+octet-stream'})
  req('complete','PATCH',loc,b'def',{**th,'Upload-Offset':'3','Content-Type':'application/offset+octet-stream'})
  req('head-complete','HEAD',loc,headers=th);req('created-content','GET',p+'/tus.txt')
 post('empty-post','probe-run/empty-post',0);post('path-metadata','probe-run/path',4,b'path');req('path-get','GET',p+'/path')
 req('preview-text','GET',f+'?preview=1&x=32&y=32')
 req('opaque-upload','PUT',p+'/opaque.bin',b'\x00\xff\x01\x80',{'Content-Type':'application/octet-stream'})
 req('preview-nonimage','GET',p+'/opaque.bin?preview=1&x=32&y=32')
 lock='<d:lockinfo xmlns:d="DAV:"><d:lockscope><d:exclusive/></d:lockscope><d:locktype><d:write/></d:locktype><d:owner>local-probe</d:owner></d:lockinfo>'
 req('initial-lock','LOCK',f,lock,{'Content-Type':'application/xml','Timeout':'Second-60'});req('repeat-lock','LOCK',f,lock,{'Content-Type':'application/xml','Timeout':'Second-60'})
 _,_,before=req('drives-before-image','GET','/graph/v1.0/me/drives')
 req('new-empty-PUT','PUT',p+'/empty-put',b'');req('stale-fixture','PUT',p+'/stale.txt',b'content');req('stale-if-match','PUT',p+'/stale.txt',b'changed',{'If-Match':'"stale"'});req('content-after-stale','GET',p+'/stale.txt');req('empty-post-visible','GET',p+'/empty-post')
 def chunk(t,d):return struct.pack('>I',len(d))+t+d+struct.pack('>I',zlib.crc32(t+d)&0xffffffff)
 png=b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',96,64,8,2,0,0,0))+chunk(b'IDAT',zlib.compress((b'\0'+b'\xff\0\0'*96)*64))+chunk(b'IEND',b'')
 _,h,_=req('image-upload','PUT',p+'/image.png',png,{'Content-Type':'image/png'})
 _,_,after=req('drives-after-image','GET','/graph/v1.0/me/drives')
 req('image-preview','GET',p+'/image.png?preview=1&x=32&y=32&c='+urllib.parse.quote(h.get('ETag','')));req('original-image','GET',p+'/image.png');req('delete-image','DELETE',p+'/image.png');req('deleted-image','GET',p+'/image.png')
 _,h,_=post('restart-create','probe-run/restart',6,b'abc');loc=h.get('Location');assert loc, 'Missing TUS Location';stop();start()
 if loc:
  req('restart-head','HEAD',loc,headers={'Tus-Resumable':'1.0.0'});req('restart-finish','PATCH',loc,b'def',{'Tus-Resumable':'1.0.0','Upload-Offset':'3','Content-Type':'application/offset+octet-stream'});req('restart-get','GET',p+'/restart')
 (OUT/'facts.json').write_text(json.dumps({'root_etag_changed':next(d for d in json.loads(before)['value'] if d['driveType']=='personal')['root']['eTag']!=next(d for d in json.loads(after)['value'] if d['driveType']=='personal')['root']['eTag'],'fixture_image_dimensions':[96,64]},indent=2))

 c={r['case']:r['response'] for r in records};checks={}
 expected={'unauth':401,'status':200,'discovery':200,'user':200,'capabilities':200,'drives':200,'mkdir':201,'fixture-upload':201,'properties':207,'properties-mixed':207,'range':206,'bad-range':416,'missing':404,'overwrite-false':412,'bad-if-match':409,'missing-parent':409,'copy-success':201,'copy-content':200,'move-success':201,'move-old-missing':404,'move-content':200,'options':204,'creation-with-data':201,'head-partial':200,'offset-conflict':409,'complete':204,'head-complete':404,'created-content':200,'empty-post':201,'path-metadata':201,'path-get':200,'preview-text':200,'preview-nonimage':404,'initial-lock':200,'repeat-lock':423,'new-empty-PUT':201,'stale-if-match':409,'content-after-stale':200,'empty-post-visible':200,'image-upload':201,'image-preview':200,'original-image':200,'delete-image':204,'deleted-image':404,'restart-create':201,'restart-head':200,'restart-finish':204,'restart-get':200}
 for name,status in expected.items():checks[name+' status']=c.get(name,{}).get('status')==status
 for name,offset in [('creation-with-data','3'),('head-partial','3'),('complete','6'),('restart-head','3'),('restart-finish','6')]:checks[name+' offset']=c[name]['headers'].get('Upload-Offset')==offset
 checks.update({'completed content':c['created-content']['body']=='abcdef','restart content':c['restart-get']['body']=='abcdef','stale unchanged':c['content-after-stale']['body']=='content','copy exact':c['copy-content']['body']=='0123456789abcdefghijklmnopqrstuvwxyz','move exact':c['move-content']['body']=='0123456789abcdefghijklmnopqrstuvwxyz','overwrite target unchanged':c['overwrite-target-unchanged']['body']=='existing','range exact':c['range']['body']=='abcdefghij','PNG preview dimensions':c['image-preview']['body']['png_dimensions']==[32,32],'original PNG exact':c['original-image']['sha256']==hashlib.sha256(png).hexdigest(),'root etag changed':json.loads((OUT/'facts.json').read_text())['root_etag_changed'],'mixed propstat 200 and 404':'200 OK' in c['properties-mixed']['body'] and '404 Not Found' in c['properties-mixed']['body'],'completion fileid':any(k.lower()=='oc-fileid' for k in c['complete']['headers']),'completion no etag/perm':not any(k.lower() in ['etag','oc-perm','oc-permissions'] for k in c['complete']['headers'])})
 (OUT/'validation.json').write_text(json.dumps({'complete':True,'passed':all(checks.values()),'checks':checks,'case_count':len(records)},indent=2))
 assert all(checks.values()), 'Failed checks: '+str([k for k,v in checks.items() if not v])
finally:stop();save();log.close();shutil.rmtree(D)
