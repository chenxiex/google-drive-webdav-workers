import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../../src/config';

describe('WebDAV mount configuration', () => {
    it.each<[string | undefined, string]>([
        [undefined, '/webdav/'],
        ['', '/webdav/'],
        ['/webdav/', '/webdav/'],
        ['/webdav', '/webdav/'],
        ['/custom/', '/custom/'],
        ['/custom', '/custom/'],
        ['/files/dav/', '/files/dav/'],
        ['/dav/other/', '/dav/other/'],
        ['/dav-legacy/', '/dav-legacy/'],
        ['/status.php-alt/', '/status.php-alt/'],
    ])('normalizes %s to %s', (path, basePath) => {
        expect(resolveConfig({ WEBDAV_PATH: path })).toMatchObject({ path: path || '/webdav/', basePath });
    });

    it.each([
        '/',
        '/dav/',
        '/dav',
        '/dav/spaces/',
        '/dav/spaces',
        '/dav/spaces/personal/',
        '/remote.php/',
        '/remote.php',
        '/remote.php/webdav/',
        '/remote.php/dav/files/test/',
        '/ocs/',
        '/ocs',
        '/ocs/v2.php/cloud/capabilities',
        '/graph/',
        '/graph',
        '/graph/v1.0/me/drives',
        '/oauth/',
        '/oauth',
        '/oauth/authorize',
        '/status.php',
        '/status.php/',
        '/status.php/sub',
        '/.well-known/',
        '/.well-known',
        '/.well-known/openid-configuration',
        'webdav',
        '   ',
        '//',
        '/./',
        '/custom/../ocs/',
        '/webdav?x=1',
        '/webdav#frag',
        '/%64av/',
    ])('rejects invalid or reserved mount path %j', WEBDAV_PATH => {
        expect(() => resolveConfig({ WEBDAV_PATH })).toThrowError(
            expect.objectContaining({ status: 500, message: expect.stringMatching(/^Server not configured: WEBDAV_PATH/) }),
        );
    });
});
