import secrets,tempfile,shutil,re,ssl,os,sys,time,json,subprocess,hashlib,threading,http.server,http.client,urllib.request,base64,pathlib
P=pathlib.Path(os.environ.get('PROBE_OUTPUT','client-probe-output')).resolve();P.mkdir(parents=True,exist_ok=True)
private=pathlib.Path(tempfile.mkdtemp(prefix='ocis-client-private-'));password_plain=secrets.token_urlsafe(24)
ocis=os.environ['OCIS_BINARY'];rclone=os.environ['RCLONE_BINARY'];owncloud=os.environ['OWNCLOUD_APPRUN'];duck_binary=os.environ['DUCK_BINARY']
subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',str(private/'key.pem'),'-out',str(private/'cert.pem'),'-days','1','-subj','/CN=localhost'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=True)
ENV=os.environ.copy()
for k in list(ENV):
 if k.lower().endswith('_proxy'): ENV.pop(k)
ENV.update(OCIS_BASE_DATA_PATH=str(P/'server'),OCIS_CONFIG_DIR=str(P/'server/config'),OCIS_URL='https://localhost:9200',OCIS_INSECURE='true',IDP_ISS='https://localhost:9200',PROXY_TLS='false',PROXY_HTTP_ADDR='127.0.0.1:9201',PROXY_ENABLE_BASIC_AUTH='true',OCIS_LOG_LEVEL='error',FRONTEND_UPLOAD_MAX_CHUNK_SIZE=sys.argv[1] if len(sys.argv)>1 else '10485760')
ENV['OCIS_BASE_DATA_PATH']=str(private/'server')
ENV['OCIS_CONFIG_DIR']=ENV['OCIS_BASE_DATA_PATH']+'/config'
subprocess.run([ocis,'init','--insecure','true','--admin-password',password_plain],env=ENV,stdout=subprocess.DEVNULL,check=True)
phase='startup'; records=[]
class Proxy(http.server.BaseHTTPRequestHandler):
 protocol_version='HTTP/1.1'
 def log_message(self,*x):pass
 def handle_any(self):
  if self.headers.get('Transfer-Encoding','').lower()=='chunked':
   chunks=[]
   while True:
    n=int(self.rfile.readline().split(b';')[0],16)
    if not n:self.rfile.readline();break
    chunks.append(self.rfile.read(n));self.rfile.read(2)
   body=b''.join(chunks)
  else:body=self.rfile.read(int(self.headers.get('Content-Length',0)))
  headers=dict(self.headers);headers.pop('Transfer-Encoding',None);headers['Content-Length']=str(len(body));headers['Connection']='close'
  try:
   c=http.client.HTTPConnection('127.0.0.1',9201,timeout=120);c.request(self.command,self.path,body,headers);r=c.getresponse();data=r.read()
   keep=lambda k:k.lower() not in ['authorization','cookie','set-cookie','x-access-token']
   rec={'phase':phase,'method':self.command,'path':self.path.split('?')[0],'request_bytes':len(body),'request_headers':{k:v for k,v in self.headers.items() if keep(k)},'status':r.status,'response_headers':{k:v for k,v in r.getheaders() if keep(k)}}
   for k in list(rec['response_headers']):
    if k.lower()=='location':rec['response_headers'][k]=rec['response_headers'][k].split('?')[0]
   records.append(rec)
   self.send_response(r.status)
   for k,v in r.getheaders():
    if k.lower() not in ['connection','transfer-encoding','content-length']:self.send_header(k,v)
   self.send_header('Content-Length',str(len(data)));self.end_headers()
   if self.command!='HEAD':self.wfile.write(data)
  except Exception as e:
   self.send_error(502,str(e))
 do_GET=do_POST=do_PATCH=do_PUT=do_DELETE=do_HEAD=do_OPTIONS=do_PROPFIND=do_MKCOL=do_MOVE=do_COPY=do_PROPPATCH=handle_any
srv=http.server.ThreadingHTTPServer(('127.0.0.1',9200),Proxy);ctx=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);ctx.load_cert_chain(str(private/'cert.pem'),str(private/'key.pem'));srv.socket=ctx.wrap_socket(srv.socket,server_side=True);threading.Thread(target=srv.serve_forever,daemon=True).start()
proc=subprocess.Popen([ocis,'server'],env=ENV,stdout=open(private/'server.log','w'),stderr=subprocess.STDOUT)
auth='Basic '+base64.b64encode(('admin:'+password_plain).encode()).decode()
def req(path,method='GET',data=None,headers={}):
 return urllib.request.urlopen(urllib.request.Request('https://localhost:9200'+path,data=data,method=method,headers={'Authorization':auth,**headers}),timeout=120,context=ssl._create_unverified_context())
def run(label,args,env=ENV):
 global phase
 phase=label
 r=subprocess.run(args,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=180)
 # Raw client logs may contain bearer upload URLs or credentials; only print exit status.
 print(label,r.returncode,flush=True)
 if r.returncode:raise RuntimeError(label+' exited '+str(r.returncode))
 return r.returncode
try:
 for i in range(100):
  try:
   drives=json.load(req('/graph/v1.0/me/drives'))['value']; break
  except Exception:time.sleep(1)
 else:raise Exception('server not ready')
 time.sleep(5)
 personal=next(d for d in drives if d['driveType']=='personal');dav=personal['root']['webDavUrl'];print('dav',dav,flush=True)
 (P/'drive.json').write_text(json.dumps(personal,indent=2))
 cap=json.load(req('/ocs/v1.php/cloud/capabilities?format=json'));(P/('cap-'+ENV['FRONTEND_UPLOAD_MAX_CHUNK_SIZE']+'.json')).write_text(json.dumps(cap,indent=2))
 (P/'input.bin').write_bytes((bytes(range(256))*102400)+b'end')
 rc=rclone
 password=subprocess.check_output([rc,'obscure',password_plain],env=ENV,text=True).strip()
 cfg=private/'rclone.conf';cfg.write_text('[oc]\ntype = webdav\nurl = '+dav+'\nvendor = infinitescale\nuser = admin\npass = '+password+'\n');os.chmod(cfg,0o600)
 prefix=ENV['FRONTEND_UPLOAD_MAX_CHUNK_SIZE']
 run(prefix+'-rclone',[rc,'--no-check-certificate','--config',str(cfg),'copyto',str(P/'input.bin'),'oc:rclone-'+prefix+'.bin','-vv'])
 cli=pathlib.Path(owncloud);local=P/('cli-'+prefix);local.mkdir(exist_ok=True);(local/'cli.bin').write_bytes((P/'input.bin').read_bytes())
 # independent remote collection for each sync
 rel=dav.split('9200')[1]+'/cli-'+prefix
 req(rel,'MKCOL').read()
 run(prefix+'-cli',[str(cli),'--cmd','--non-interactive','--trust','-u','admin','-p',password_plain,'--server','https://localhost:9200',str(local),dav,'/cli-'+prefix],{**ENV,'QT_QPA_PLATFORM':'offscreen'})
 duck=duck_binary;du=[duck,'--assumeyes','--nokeychain','--username','admin','--password',password_plain,'--verbose']
 run(prefix+'-duck',du+['--upload','owncloud://localhost:9200/Personal/duck-'+prefix+'.bin',str(P/'input.bin')])
 for name,path in [('rclone','rclone-'+prefix+'.bin'),('cli','cli-'+prefix+'/cli.bin'),('duck','duck-'+prefix+'.bin')]:
  phase=prefix+'-'+name+'-verify'
  try:
   data=req(dav.split('9200')[1]+'/'+path).read(); print(name,len(data),hashlib.sha256(data).hexdigest(),data==(P/'input.bin').read_bytes(),flush=True);assert data==(P/'input.bin').read_bytes()
  except Exception as e:raise RuntimeError(name+' verify failed') from e
 if prefix=='10485760' and len(sys.argv)<3:
  base=[rc,'--no-check-certificate','--config',str(cfg)]
  (P/'small.txt').write_text('hello UTF-8 test\n');(P/'empty.txt').write_bytes(b'')
  run('rclone-mkdir',base+['mkdir','oc:rclone-crud'])
  run('rclone-unicode',base+['copyto',str(P/'small.txt'),'oc:rclone-crud/中文 space.txt'])
  run('rclone-empty',base+['copyto',str(P/'empty.txt'),'oc:rclone-crud/empty'])
  run('rclone-copy',base+['copyto','oc:rclone-crud/中文 space.txt','oc:rclone-crud/copy.txt'])
  run('rclone-move',base+['moveto','oc:rclone-crud/copy.txt','oc:rclone-crud/moved.txt'])
  run('rclone-overwrite',base+['copyto',str(P/'input.bin'),'oc:rclone-crud/moved.txt'])
  run('rclone-download',base+['copyto','oc:rclone-crud/moved.txt',str(P/'rclone-download.bin')])
  print('rclone-client-download-hash',hashlib.sha256((P/'rclone-download.bin').read_bytes()).hexdigest(),flush=True)
  run('rclone-delete',base+['purge','oc:rclone-crud'])
  (local/'目录').mkdir(exist_ok=True);(local/'目录/中文 space.txt').write_text('hello UTF-8 test\n');(local/'empty').write_bytes(b'')
  cliargs=[str(cli),'--cmd','--non-interactive','--trust','-u','admin','-p',password_plain,'--server','https://localhost:9200']
  clienv={**ENV,'QT_QPA_PLATFORM':'offscreen'}
  run('cli-crud-create',cliargs+[str(local),dav,'/cli-'+prefix],clienv)
  (local/'cli.bin').rename(local/'renamed.bin');(local/'目录/中文 space.txt').write_text('new content for overwrite\n')
  run('cli-crud-move-overwrite',cliargs+[str(local),dav,'/cli-'+prefix],clienv)
  fresh=P/('fresh-'+str(time.time_ns()));fresh.mkdir()
  run('cli-download',cliargs+[str(fresh),dav,'/cli-'+prefix],clienv)
  print('cli-client-download-hash',hashlib.sha256((fresh/'renamed.bin').read_bytes()).hexdigest(),flush=True)
  (local/'renamed.bin').unlink()
  run('cli-delete',cliargs+[str(local),dav,'/cli-'+prefix],clienv)
  run('duck-mkdir',du+['--mkdir','owncloud://localhost:9200/Personal/duck-crud/'])
  run('duck-unicode',du+['--upload','owncloud://localhost:9200/Personal/duck-crud/中文 space.txt',str(P/'small.txt')])
  run('duck-empty',du+['--upload','owncloud://localhost:9200/Personal/duck-crud/empty',str(P/'empty.txt')])
  run('duck-copy',du+['--copy','owncloud://localhost:9200/Personal/duck-crud/中文 space.txt','owncloud://localhost:9200/Personal/duck-crud/copied.txt'])
  run('duck-move',du+['--move','owncloud://localhost:9200/Personal/duck-crud/copied.txt','owncloud://localhost:9200/Personal/duck-crud/moved.txt'])
  run('duck-overwrite',du+['--existing','overwrite','--upload','owncloud://localhost:9200/Personal/duck-crud/moved.txt',str(P/'input.bin')])
  (P/'large.bin').write_bytes((bytes(range(256))*429688)[:110000000])
  run('duck-large',du+['--upload','owncloud://localhost:9200/Personal/large.bin',str(P/'large.bin')])
  run('duck-download',du+['--download','owncloud://localhost:9200/Personal/large.bin',str(P/'duck-download.bin')])
  print('duck-large-source',len((P/'large.bin').read_bytes()),hashlib.sha256((P/'large.bin').read_bytes()).hexdigest(),'download',hashlib.sha256((P/'duck-download.bin').read_bytes()).hexdigest(),flush=True)
  run('duck-delete',du+['--delete','owncloud://localhost:9200/Personal/duck-crud/'])

 if len(sys.argv)>2:
  for size in [8388608,12582912,262144]:
   label='duck-override-'+str(size)
   run(label,du+['--upload','owncloud://localhost:9200/Personal/'+label+'.bin',str(P/'input.bin')],{**ENV,'tus.chunk.size':str(size)})
   phase=label+'-verify';body=req(dav.split('9200')[1]+'/'+label+'.bin').read();assert body==(P/'input.bin').read_bytes();print(label,'download_hash',hashlib.sha256(body).hexdigest(),flush=True)
  for size in ['8Mi','12Mi']:
   label='rclone-override-'+size
   run(label,[rc,'--no-check-certificate','--config',str(cfg),'--webdav-nextcloud-chunk-size',size,'copyto',str(P/'input.bin'),'oc:'+label+'.bin'])
   phase=label+'-verify';body=req(dav.split('9200')[1]+'/'+label+'.bin').read();assert body==(P/'input.bin').read_bytes();print(label,'download_hash',hashlib.sha256(body).hexdigest(),flush=True)

finally:
 (P/(('wire-overrides' if len(sys.argv)>2 else 'wire-'+ENV['FRONTEND_UPLOAD_MAX_CHUNK_SIZE'])+'.json')).write_text(re.sub(r'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+',lambda m:'REDACTED_TOKEN_'+hashlib.sha256(m[0].encode()).hexdigest()[:8],json.dumps(records,indent=2)));proc.terminate();proc.wait(timeout=20);srv.shutdown();shutil.rmtree(private)
