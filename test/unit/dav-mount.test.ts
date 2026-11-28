import { describe, expect, it } from 'vitest';
import { StatusError, decodeRelativeSegments, decodeSegment, formatDavHref } from '../../src/http';
import { type AuthPrincipal } from '../../src/ocis/profile';
import { classifyDavPrefix, resolveDavMount, resolveDestinationMount } from '../../src/webdav/mount';

const basicPrincipal: AuthPrincipal = {
    owner: 'basic:test',
    id: 'test',
    displayName: 'test',
};

const oidcPrincipal: AuthPrincipal = {
    owner: 'oidc:cf-sub-alice',
    id: 'alice@example.com',
    displayName: 'Alice Example',
    email: 'alice@example.com',
};

const baseConfig = {
    basePath: '/webdav/',
    rootId: 'root',
};

describe('decodeSegment and decodeRelativeSegments', () => {
    it.each([
        ['', { segments: [], hasTrailingSlash: false, fpath: '/' }],
        ['a.txt', { segments: ['a.txt'], hasTrailingSlash: false, fpath: '/a.txt' }],
        ['docs/', { segments: ['docs'], hasTrailingSlash: true, fpath: '/docs/' }],
        ['sub//dir/', { segments: ['sub', 'dir'], hasTrailingSlash: true, fpath: '/sub/dir/' }],
        ['a%2520b.txt', { segments: ['a%20b.txt'], hasTrailingSlash: false, fpath: '/a%20b.txt' }],
        ['100%25%20done/x%20%26%20y%20%5B1%5D.txt', { segments: ['100% done', 'x & y [1].txt'], hasTrailingSlash: false, fpath: '/100% done/x & y [1].txt' }],
    ])('decodes %j once into canonical relative segments', (rawTail, expected) => {
        expect(decodeRelativeSegments(rawTail)).toEqual(expected);
    });

    it.each([
        '.',
        '..',
        'a/../b',
        '%2e',
        '%2e%2e',
        'a/%2e%2e/b',
        'a%2fb',
        'a%2Fb',
        'a%5cb',
        'a%00b',
        'bad%zz',
        'line%0Abreak',
    ])('rejects invalid or traversal segment %j with 400', rawTail => {
        expect(() => decodeRelativeSegments(rawTail)).toThrowError(StatusError);
        try {
            decodeRelativeSegments(rawTail);
        } catch (error) {
            expect((error as StatusError).status).toBe(400);
        }
    });

    it('throws 400 for malformed single-segment encoding', () => {
        expect(() => decodeSegment('bad%zz')).toThrowError(new StatusError('Invalid path encoding', 400));
    });
});

describe('formatDavHref', () => {
    it.each([
        ['/dav/spaces/personal$root/', [], true, '/dav/spaces/personal$root/'],
        ['/dav/spaces/personal$root/', ['100% done', 'a%20b.txt'], false, '/dav/spaces/personal$root/100%25%20done/a%2520b.txt'],
        ['/dav/spaces/personal$root/', ['folder & dir'], true, '/dav/spaces/personal$root/folder%20%26%20dir/'],
        ['/webdav/', ['x & y [#].txt'], false, '/webdav/x%20%26%20y%20%5B%23%5D.txt'],
    ])('formats %s + %j (folder=%s) -> %s', (hrefBase, segments, isFolder, expected) => {
        expect(formatDavHref(hrefBase, segments, isFolder)).toBe(expected);
    });
});

describe('classifyDavPrefix', () => {
    it.each([
        ['/dav/spaces/personal$root', { kind: 'space', preferBearer: true }],
        ['/dav/spaces/personal%24root/a.txt', { kind: 'space', preferBearer: true }],
        ['/remote.php/webdav', { kind: 'remote-webdav', preferBearer: true }],
        ['/remote.php/webdav/a.txt', { kind: 'remote-webdav', preferBearer: true }],
        ['/remote.php/dav/files/test/a.txt', { kind: 'remote-files', preferBearer: true }],
        ['/webdav', { redirect: '/webdav/' }],
        ['/webdav/', { kind: 'generic', preferBearer: false }],
        ['/dav/spaces', null],
        ['/remote.php/dav', null],
        ['/other', null],
    ])('classifies %s', (pathname, expected) => {
        expect(classifyDavPrefix(pathname, baseConfig)).toEqual(expected);
    });
});

describe('resolveDavMount', () => {
    it.each([
        ['/dav/spaces/personal$root', 'root', basicPrincipal, {
            kind: 'space',
            hrefBase: '/dav/spaces/personal$root/',
            segments: [],
            fpath: '/',
            isTusPath: false,
            tusSessionId: null,
        }],
        ['/dav/spaces/personal%24root/dir/file.txt', 'root', oidcPrincipal, {
            kind: 'space',
            hrefBase: '/dav/spaces/personal$root/',
            segments: ['dir', 'file.txt'],
            fpath: '/dir/file.txt',
            isTusPath: false,
            tusSessionId: null,
        }],
        ['/dav/spaces/personal%24folder%2Fwith%24special/a.txt', 'folder/with$special', basicPrincipal, {
            kind: 'space',
            hrefBase: '/dav/spaces/personal$folder%2Fwith%24special/',
            segments: ['a.txt'],
            fpath: '/a.txt',
            isTusPath: false,
            tusSessionId: null,
        }],
        ['/remote.php/webdav', 'root', basicPrincipal, {
            kind: 'remote-webdav',
            hrefBase: '/remote.php/webdav/',
            segments: [],
            fpath: '/',
            isTusPath: false,
            tusSessionId: null,
        }],
        ['/remote.php/dav/files/alice%40example.com/tus_uploads/11111111-1111-4111-8111-111111111111', 'root', oidcPrincipal, {
            kind: 'remote-files',
            hrefBase: '/remote.php/dav/files/alice%40example.com/',
            segments: ['tus_uploads', '11111111-1111-4111-8111-111111111111'],
            fpath: '/tus_uploads/11111111-1111-4111-8111-111111111111',
            isTusPath: true,
            tusSessionId: '11111111-1111-4111-8111-111111111111',
        }],
        ['/webdav/folder/tus_uploads/file', 'root', basicPrincipal, {
            kind: 'generic',
            hrefBase: '/webdav/',
            segments: ['folder', 'tus_uploads', 'file'],
            fpath: '/folder/tus_uploads/file',
            isTusPath: false,
            tusSessionId: null,
        }],
    ])('resolves %s (rootId=%s)', (pathname, rootId, principal, expected) => {
        expect(resolveDavMount(pathname, { basePath: '/webdav/', rootId }, principal)).toMatchObject(expected);
    });

    it.each([
        '/dav/spaces/',
        '/dav/spaces/other$root/',
        '/dav/spaces/personal%2524root/',
        '/remote.php/dav/files/',
        '/remote.php/dav/files/other/',
        '/other/a.txt',
    ])('returns null for mismatched or unmounted path %s', pathname => {
        expect(resolveDavMount(pathname, baseConfig, basicPrincipal)).toBeNull();
    });
});

describe('resolveDestinationMount', () => {
    const spaceMount = resolveDavMount('/dav/spaces/personal$root/a.txt', baseConfig, oidcPrincipal)!;

    it('accepts equivalent $ / %24 destinations and PUBLIC_ORIGIN', () => {
        const dest = resolveDestinationMount(
            'https://files.example.org/dav/spaces/personal%24root/b.txt',
            'https://internal.local/dav/spaces/personal$root/a.txt',
            spaceMount,
            { ...baseConfig, publicOrigin: 'https://files.example.org' },
            oidcPrincipal,
        );
        expect(dest.kind).toBe('space');
        expect(dest.fpath).toBe('/b.txt');
    });

    it.each([
        ['cross-mount generic', 'https://example.com/webdav/b.txt', 403],
        ['cross-mount remote-webdav', 'https://example.com/remote.php/webdav/b.txt', 403],
        ['wrong space id', 'https://example.com/dav/spaces/personal$other/b.txt', 403],
        ['cross-origin', 'https://evil.example/dav/spaces/personal$root/b.txt', 502],
        ['malformed url', 'http://[invalid', 400],
        ['bad percent encoding', 'https://example.com/dav/spaces/personal$root/%zz', 400],
    ])('rejects %s destination with %i', (_label, destination, status) => {
        expect(() => resolveDestinationMount(
            destination,
            'https://example.com/dav/spaces/personal$root/a.txt',
            spaceMount,
            baseConfig,
            oidcPrincipal,
        )).toThrowError(StatusError);
        try {
            resolveDestinationMount(
                destination,
                'https://example.com/dav/spaces/personal$root/a.txt',
                spaceMount,
                baseConfig,
                oidcPrincipal,
            );
        } catch (error) {
            expect((error as StatusError).status).toBe(status);
        }
    });
});
