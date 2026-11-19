"""Client-construction probe only: synthetic responses are NOT oCIS evidence."""
import http.server,threading,subprocess,json,os
records=[]
class Recorder(http.server.BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def run_request(self):
  body=self.rfile.read(int(self.headers.get('Content-Length',0)))
  records.append(dict(method=self.command,path=self.path,body=body.decode(),bytes=len(body)))
  props='<d:resourcetype/><d:getcontentlength>4</d:getcontentlength><d:getlastmodified>Tue, 17 Nov 2026 00:00:00 GMT</d:getlastmodified><oc:checksums><oc:checksum>SHA1:81fe8bfe87576c3ecb22426f8e57847382917acf</oc:checksum></oc:checksums>' if self.command=='PROPFIND' else '<d:lastmodified/><oc:checksums/>'
  xml=f'<d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:response><d:href>{self.path}</d:href><d:propstat><d:prop>{props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>'.encode()
  self.send_response(207);self.send_header('Content-Type','application/xml');self.send_header('Content-Length',str(len(xml)));self.end_headers();self.wfile.write(xml)
 do_PROPFIND=run_request
 do_PROPPATCH=run_request
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Recorder)
threading.Thread(target=server.serve_forever,daemon=True).start()
env={k:v for k,v in os.environ.items() if not k.lower().endswith('_proxy')}
env.update(RCLONE_CONFIG_PROBE_TYPE='webdav',RCLONE_CONFIG_PROBE_URL=f'http://127.0.0.1:{server.server_port}/',RCLONE_CONFIG_PROBE_VENDOR='owncloud')
result=subprocess.run([os.environ.get('RCLONE_BINARY','.cache/rclone/rclone-v1.76.0-linux-amd64/rclone'),'--config','/dev/null','touch','probe:file.txt','--no-create','--timestamp','2026-11-18T00:00:00Z','--retries','1','--low-level-retries','1'],env=env,capture_output=True,text=True,timeout=20)
server.shutdown()
print(json.dumps(dict(scope='Official rclone 1.76.0 client request construction against synthetic localhost recorder; NOT oCIS or adapter acceptance',exit_code=result.returncode,stderr=result.stderr,requests=records),indent=2))
