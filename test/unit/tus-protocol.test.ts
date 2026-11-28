import { describe, expect, it } from 'vitest';
import { StatusError } from '../../src/http';
import {
    EMPTY_CHECKSUMS,
    matchesIfMatch,
    mergeExpectedChecksums,
    parseOcChecksum,
    parseTusChecksumMetadata,
    parseTusMetadata,
    parseUnixMtime,
    parseUploadChecksum,
    validateTusFilename,
    verifyChunkChecksum,
    verifyDriveChecksums,
} from '../../src/tus/protocol';

describe('parseUnixMtime', () => {
    it.each([
        ['1700000000', '2023-11-14T22:13:20.000Z'],
        ['1700000000.29', '2023-11-14T22:13:20.290Z'],
        ['1700000000.5', '2023-11-14T22:13:20.500Z'],
        ['1700000000.1239', '2023-11-14T22:13:20.123Z'],
        ['0', '1970-01-01T00:00:00.000Z'],
        ['-0.0', '1970-01-01T00:00:00.000Z'],
        ['-1.5', '1969-12-31T23:59:58.500Z'],
    ])('parses %s -> %s', (input, expected) => {
        expect(parseUnixMtime(input)).toBe(expected);
    });

    it.each(['', 'abc', '1700000000.', '.5', '1e5', '9999999999999999', '-9999999999999999'])(
        'rejects invalid mtime %j with 400',
        input => {
            expect(() => parseUnixMtime(input)).toThrowError(new StatusError('Invalid mtime', 400));
        },
    );
});

describe('checksum parsers and verifiers', () => {
    const sha1Hex = 'a'.repeat(40);
    const md5Hex = 'b'.repeat(32);
    const sha256Hex = 'c'.repeat(64);

    it.each([
        ['SHA1:' + sha1Hex.toUpperCase(), { algorithm: 'sha1', hex: sha1Hex }],
        ['md5:' + md5Hex, { algorithm: 'md5', hex: md5Hex }],
        ['Sha256:' + sha256Hex.toUpperCase(), { algorithm: 'sha256', hex: sha256Hex }],
    ] as const)('parses OC-Checksum %s', (header, expected) => {
        expect(parseOcChecksum(header)).toEqual(expected);
    });

    it.each(['SHA1 ' + sha1Hex, 'md5:' + md5Hex, 'SHA256 ' + sha256Hex])(
        'parses TUS metadata checksum %s',
        value => {
            expect(parseTusChecksumMetadata(value).hex).toMatch(/^[a-f]+$/);
        },
    );

    it.each(['SHA1', 'SHA1:short', 'SHA512:' + 'a'.repeat(128), 'SHA1:' + 'g'.repeat(40)])(
        'rejects malformed OC-Checksum %s',
        header => {
            expect(() => parseOcChecksum(header)).toThrowError(new StatusError('Invalid OC-Checksum', 400));
        },
    );

    it('merges distinct algorithms and rejects conflicting digests for the same algorithm', () => {
        expect(mergeExpectedChecksums(
            { algorithm: 'sha1', hex: sha1Hex },
            { algorithm: 'sha1', hex: sha1Hex },
        )).toEqual([{ algorithm: 'sha1', hex: sha1Hex }]);
        expect(mergeExpectedChecksums(
            { algorithm: 'sha1', hex: sha1Hex },
            { algorithm: 'md5', hex: md5Hex },
        )).toEqual([{ algorithm: 'sha1', hex: sha1Hex }, { algorithm: 'md5', hex: md5Hex }]);
        expect(() => mergeExpectedChecksums(
            { algorithm: 'sha1', hex: sha1Hex },
            { algorithm: 'sha1', hex: 'd'.repeat(40) },
        )).toThrowError(new StatusError('Conflicting checksums', 400));
    });

    it('verifies Upload-Checksum Base64 and hex digests and rejects mismatches with 460', async () => {
        const payload = new TextEncoder().encode('hello');
        // SHA-1("hello") = aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d -> qvTGHdzF6KLavt4PO0gs2a6pQ00=
        await verifyChunkChecksum('sha1 qvTGHdzF6KLavt4PO0gs2a6pQ00=', payload);
        await verifyChunkChecksum('SHA1 aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d', payload);
        await verifyChunkChecksum('SHA256 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824', payload);

        await expect(verifyChunkChecksum('sha1 AAAAAAAAAAAAAAAAAAAAAAAAAAA=', payload))
            .rejects.toMatchObject({ status: 460 });
        await expect(verifyChunkChecksum('sha1 AAAA', payload))
            .rejects.toMatchObject({ status: 460 });
        expect(() => parseUploadChecksum('sha512 AAAA')).toThrowError(StatusError);
        expect(() => parseUploadChecksum('sha1 ###')).toThrowError(StatusError);
    });

    it('verifies empty digests using constants even when Drive omits sha1/sha256 on metadata-only create', () => {
        expect(verifyDriveChecksums([{ algorithm: 'sha1', hex: EMPTY_CHECKSUMS.sha1 }], null, true)).toBe(true);
        expect(verifyDriveChecksums([{ algorithm: 'sha256', hex: EMPTY_CHECKSUMS.sha256 }], null, true)).toBe(true);
        expect(verifyDriveChecksums([{ algorithm: 'sha1', hex: '0'.repeat(40) }], null, true)).toBe(false);
    });
});

describe('matchesIfMatch', () => {
    it.each<[string | null, string | undefined, boolean, boolean]>([
        [null, undefined, false, true],
        ['*', '"f-r1"', true, true],
        ['*', undefined, false, false],
        ['"f-r1"', '"f-r1"', true, true],
        ['"other", "f-r1"', '"f-r1"', true, true],
        ['W/"f-r1", "f-r1"', '"f-r1"', true, true],
        ['W/"f-r1"', '"f-r1"', true, false],
        ['"stale"', '"f-r1"', true, false],
        ['"f-r1"', undefined, false, false],
        ['unquoted', '"f-r1"', true, false],
        ['', '"f-r1"', true, false],
    ])('evaluates %j against etag=%j (exists=%s) -> %s', (header, etag, exists, expected) => {
        expect(matchesIfMatch(header, etag, exists)).toBe(expected);
    });
});

describe('validateTusFilename and parseTusMetadata (14A)', () => {
    it.each([
        ['photo.jpg', 'photo.jpg'],
        ['dir/sub/file.txt', 'dir/sub/file.txt'],
        ['/cli-10485760/cli.bin', 'cli-10485760/cli.bin'],
    ])('normalizes valid filename %j -> %j', (raw, expected) => {
        expect(validateTusFilename(raw)).toBe(expected);
    });

    it.each(['', '/', '//', 'a/', 'a//b', 'http://evil.com/a', '../escape', 'a/../b', 'a/./b', 'a\\b', 'bad\x00name'])(
        'rejects unsafe filename %j',
        raw => {
            expect(() => validateTusFilename(raw)).toThrowError(new StatusError('Invalid filename', 400));
        },
    );

    it('parses Cyberduck trailing commas, plaintext filetype, invalid filetype fallback, and ignores unknown keys', () => {
        const parsed = parseTusMetadata(
            `filename ${btoa('duck.bin')}, filetype application/octet-stream, opaque /w==,`,
        );
        expect(parsed).toEqual({ filename: 'duck.bin', filetype: 'application/octet-stream' });

        const fallback = parseTusMetadata(`filename ${btoa('a.bin')}, filetype ${btoa('invalid-mime')}`);
        expect(fallback).toEqual({ filename: 'a.bin', filetype: 'application/octet-stream' });

        const android = parseTusMetadata(
            `filename ${btoa('vid.mp4')}, mimetype ${btoa('video/mp4')}, mtime ${btoa('1700000000.25')}, checksum ${btoa('SHA1 ' + 'a'.repeat(40))}`,
        );
        expect(android).toEqual({
            filename: 'vid.mp4',
            filetype: 'video/mp4',
            mtime: '2023-11-14T22:13:20.250Z',
            checksum: { algorithm: 'sha1', hex: 'a'.repeat(40) },
        });

        expect(() => parseTusMetadata(`filename ${btoa('a.txt')}, filename ${btoa('b.txt')}`))
            .toThrowError(StatusError);
    });
});
