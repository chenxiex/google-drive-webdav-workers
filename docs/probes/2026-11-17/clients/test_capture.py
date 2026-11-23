import unittest
import capture

class CaptureTests(unittest.TestCase):
    def test_target_and_headers(self):
        self.assertEqual(capture.target('/ocs/v1.php/cloud/user?format=json&access_token=private'), '/ocs/v1.php/cloud/user?format=json&access_token=REDACTED')
        self.assertEqual(capture.headers([('Authorization','Basic private'),('Set-Cookie','secret'),('Location','/upload?token=secret')]), {'Location':'/upload?token=REDACTED'})

    def test_dav_xml(self):
        result=capture.payload('PROPPATCH','/dav/file', b'<D:propertyupdate xmlns:D="DAV:"><D:lastmodified>1794886252</D:lastmodified><password>private</password></D:propertyupdate>','text/xml')
        self.assertIn('lastmodified',result)
        self.assertIn('1794886252',result)
        self.assertNotIn('private',result)
        self.assertIsNone(capture.payload('POST','/token',b'password=private','application/x-www-form-urlencoded'))
        self.assertIsNone(capture.payload('PUT','/dav/file',b'private','text/plain'))

    def test_discovery_json_and_bounds(self):
        result=capture.payload('GET','/graph/v1.0/me/drives',b'{"token":"private","webDavUrl":"https://localhost/dav?access_token=private"}','application/json')
        self.assertNotIn('private',result)
        self.assertIn('webDavUrl',result)
        self.assertIn('omitted',capture.payload('PROPFIND','/dav',b'x'*(capture.LIMIT+1),'text/xml'))
        self.assertIn('omitted',capture.payload('PROPFIND','/dav',b'invalid','text/xml'))

if __name__=='__main__':unittest.main()
