import { describe, expect, it } from 'vitest';
import { isGoogleThumbnailHost, parseThumbnailUrl } from '../../src/drive/types';
import { StatusError } from '../../src/http';
import { parsePreviewQuery } from '../../src/webdav/preview';

describe('parsePreviewQuery', () => {
    it.each([
        'https://example.com/dav/spaces/personal$root/photo.png',
        'https://example.com/dav/spaces/personal$root/photo.png?preview=0',
        'https://example.com/dav/spaces/personal$root/photo.png?preview=true&x=32&y=32',
        'https://example.com/dav/spaces/personal$root/photo.png?preview=2',
    ])('returns null when preview is not 1 (%s)', raw => {
        expect(parsePreviewQuery(new URL(raw))).toBeNull();
    });

    it.each<[string, { x?: number; y?: number; c: string }]>([
        ['https://example.com/a.png?preview=1', { c: '' }],
        ['https://example.com/a.png?preview=1&x=32&y=32&c=', { x: 32, y: 32, c: '' }],
        ['https://example.com/a.png?preview=1&x=1&y=4096&c=etag-1', { x: 1, y: 4096, c: 'etag-1' }],
        ['https://example.com/a.png?preview=1&x=256', { x: 256, c: '' }],
        ['https://example.com/a.png?preview=1&y=512', { y: 512, c: '' }],
        [`https://example.com/a.png?preview=1&c=${'a'.repeat(512)}`, { c: 'a'.repeat(512) }],
    ])('parses valid preview query %s', (raw, expected) => {
        expect(parsePreviewQuery(new URL(raw))).toEqual(expected);
    });

    it.each([
        'https://example.com/a.png?preview=1&x=0',
        'https://example.com/a.png?preview=1&y=0',
        'https://example.com/a.png?preview=1&x=-1',
        'https://example.com/a.png?preview=1&y=1.5',
        'https://example.com/a.png?preview=1&x=01',
        'https://example.com/a.png?preview=1&x=abc',
        'https://example.com/a.png?preview=1&x=',
        'https://example.com/a.png?preview=1&x=4097',
        'https://example.com/a.png?preview=1&y=4097',
        'https://example.com/a.png?preview=1&x=10&x=20',
        'https://example.com/a.png?preview=1&y=10&y=20',
        `https://example.com/a.png?preview=1&c=${'a'.repeat(513)}`,
        'https://example.com/a.png?preview=1&c=bad%00val',
        'https://example.com/a.png?preview=1&c=bad%0Aval',
        'https://example.com/a.png?preview=1&c=a&c=b',
    ])('rejects invalid preview query %s with 400', raw => {
        expect(() => parsePreviewQuery(new URL(raw))).toThrowError(StatusError);
        try {
            parsePreviewQuery(new URL(raw));
        } catch (error) {
            expect((error as StatusError).status).toBe(400);
        }
    });
});

describe('thumbnail URL & host validation', () => {
    it.each<[string, boolean]>([
        ['lh3.googleusercontent.com', true],
        ['googleusercontent.com', true],
        ['LH4.GoogleUserContent.com.', true],
        ['www.googleapis.com', true],
        ['docs.google.com', true],
        ['encrypted-tbn0.gstatic.com', true],
        ['yt3.ggpht.com', true],
        ['evilgoogleusercontent.com', false],
        ['googleusercontent.com.evil.com', false],
        ['thumb.example', false],
        ['localhost', false],
        ['', false],
    ])('classifies Google thumbnail host %s -> %s', (host, expected) => {
        expect(isGoogleThumbnailHost(host)).toBe(expected);
    });

    it.each<[unknown, boolean]>([
        ['https://lh3.googleusercontent.com/abc=s220', true],
        ['https://thumb.example/preview.jpg', true],
        ['http://lh3.googleusercontent.com/abc=s220', false],
        ['ftp://thumb.example/a.png', false],
        ['https://user:pass@lh3.googleusercontent.com/abc', false],
        ['https://user@thumb.example/abc', false],
        ['https://localhost/thumb.png', false],
        ['https://app.localhost/thumb.png', false],
        ['https://127.0.0.1/thumb.png', false],
        ['https://127.0.0.1./thumb.png', false],
        ['https://[::1]/thumb.png', false],
        ['https://0x7f000001/thumb.png', false],
        ['https://intranet/thumb.png', false],
        ['', false],
        ['not a url', false],
        [null, false],
        [undefined, false],
    ])('validates thumbnailLink %s -> %s', (raw, valid) => {
        const parsed = parseThumbnailUrl(raw);
        expect(parsed !== null).toBe(valid);
    });
});
