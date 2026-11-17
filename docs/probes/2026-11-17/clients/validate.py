import os,json,pathlib,re,hashlib
P=pathlib.Path(os.environ.get('PROBE_OUTPUT',pathlib.Path(__file__).resolve().parent)).resolve()
out=P;out.mkdir(exist_ok=True)
sha='7be259d71245aebcf1073acdc3c2262f8910873766ce02358df010cbdf2c68a3'
def sanitize(s):
 s=re.sub(r'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+',lambda m:'REDACTED_TOKEN_'+hashlib.sha256(m[0].encode()).hexdigest()[:8],s)
 return s
runs=[]
for size in [10000000,8388608,12582912,10485760]:
 cap=json.loads((P/f'cap-{size}.json').read_text());assert cap['ocs']['data']['capabilities']['files']['tus_support']['max_chunk_size']==size
 log=(P/f'run-{size}.txt').read_text();wire=json.loads((P/f'wire-{size}.json').read_text())
 for client in ['rclone','cli','duck']:
  phase=f'{size}-{client}';assert f'{phase} 0\n' in log
  assert f'{client} 26214403 {sha} True' in log
  rr=[r for r in wire if r['phase']==phase and r['method'] in ['POST','PATCH'] and not any(k.lower()=='user-agent' and v.startswith('Go-http-client') for k,v in r['request_headers'].items())]
  chunk=size if client=='cli' else 10485760
  lengths=[];left=26214403
  if client!='cli':lengths.append(0)
  while left:lengths.append(min(chunk,left));left-=min(chunk,left)
  assert [r['request_bytes'] for r in rr]==lengths,(size,client,rr)
  assert [r['method'] for r in rr]==['POST']+['PATCH']*(len(rr)-1)
  assert [r['status'] for r in rr]==[201]+[204]*(len(rr)-1)
  runs.append({'advertised_chunk_size':size,'client':client,'exit_code':0,'source_and_download_sha256':sha,'file_bytes':26214403,'requests':[{'method':r['method'],'bytes':r['request_bytes'],'status':r['status']} for r in rr]})
 (out/f'wire-{size}.json').write_text(sanitize(json.dumps(wire,indent=2)))
 (out/f'run-{size}.txt').write_text(log)
 (out/f'cap-{size}.json').write_text((P/f'cap-{size}.json').read_text())
log=(P/'run-10485760.txt').read_text();wire=json.loads((P/'wire-10485760.json').read_text())
crud=['rclone-mkdir','rclone-unicode','rclone-empty','rclone-copy','rclone-move','rclone-overwrite','rclone-download','rclone-delete','cli-crud-create','cli-crud-move-overwrite','cli-download','cli-delete','duck-mkdir','duck-unicode','duck-empty','duck-copy','duck-move','duck-overwrite','duck-large','duck-download','duck-delete']
for phase in crud:assert f'{phase} 0\n' in log
for c in ['cli','rclone']:assert f'{c}-client-download-hash {sha}' in log
largehash='d04c2e7d8c8e01027ddd2ba299705657a43306d395aeceeb8f008fa7abd69bf3'
assert f'duck-large-source 110000000 {largehash} download {largehash}' in log
rr=[r for r in wire if r['phase']=='duck-large' and r['method'] in ['POST','PATCH']]
assert [r['request_bytes'] for r in rr]==[0]+[10485760]*10+[5142400]
summary={'validation':'passed independent assertions against retained logs and wire','server':'official oCIS 8.2.3','clients':{'cli':'official owncloudcmd 6.0.3.18040, not GUI 7.1.1','rclone':'1.76.0 vendor=infinitescale','duck':'Cyberduck CLI 9.6.0.46406 owncloud profile'},'matrix':runs,'crud_client_exit_codes':{x:0 for x in crud},'large_duck':{'bytes':110000000,'source_download_sha256':largehash,'requests':[{'method':r['method'],'bytes':r['request_bytes'],'status':r['status']} for r in rr]},'notes':['Loopback TLS-terminating recording proxy forwards original request method/path/body to unmodified official oCIS on HTTP loopback; no capability/response semantic rewriting. Self-signed local test certificate accepted by clients.','Go-http-client/1.1 first-POST delegated PATCH retained in wire but excluded from client matrix.','Matrix hashes use authenticated HTTP downloads. CRUD includes actual CLI/rclone/duck client downloads with hash comparison.','Exit codes alone are not full content assertions for every individual CRUD step. Wire statuses and methods retained for review.','No GUI7.1.1, Android, Windows or deployed Worker run.']}
assert (P/'wire-overrides.json').exists(), 'Missing mandatory five override evidence runs'
if True:
 wire=json.loads((P/'wire-overrides.json').read_text());log=(P/'run-overrides.txt').read_text();summary['overrides']=[]
 for client,size in [('duck','8388608'),('duck','12582912'),('duck','262144'),('rclone','8Mi'),('rclone','12Mi')]:
  phase=f'{client}-override-{size}';assert f'{phase} 0\n' in log;assert f'{phase} download_hash {sha}' in log
  rr=[r for r in wire if r['phase']==phase and r['method'] in ['POST','PATCH']]
  chunk=int(size) if client=='duck' else 10485760;left=26214403;lengths=[0]
  while left:lengths.append(min(left,chunk));left-=min(left,chunk)
  assert [r['request_bytes'] for r in rr]==lengths
  assert [r['method'] for r in rr]==['POST']+['PATCH']*(len(rr)-1)
  assert [r['status'] for r in rr]==[201]+[204]*(len(rr)-1)
  summary['overrides'].append({'client':client,'setting':size,'actual_chunks':lengths,'source_download_sha256':sha})
 (out/'wire-overrides.json').write_text(sanitize(json.dumps(wire,indent=2)));(out/'run-overrides.txt').write_text(log)
(out/'summary.json').write_text(json.dumps(summary,indent=2));print('VALIDATED',len(runs),'matrix runs;',len(crud),'client CRUD calls; overrides',len(summary.get('overrides',[])))
