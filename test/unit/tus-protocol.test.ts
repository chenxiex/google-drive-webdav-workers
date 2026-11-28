import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { UPLOAD_RESULT_FIELDS } from '../../src/drive/types';
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
import { MockDrive } from '../support/mock-drive';

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

describe('MockDrive OC-06 upload & recovery contract', () => {
    const authHeaders = { Authorization: 'Bearer test-access-token' };
    const sha256Hex = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

    it('keeps resumable sessions alive across offset-gap 503 and mismatched status probes, and replays completion payloads', async () => {
        const drive = new MockDrive();
        const total = 524300;
        const payload = new Uint8Array(total);
        for (let i = 0; i < total; i++) payload[i] = (i * 73) % 251;
        const modifiedTime = '2023-11-14T22:13:20.500Z';

        const init = await drive.handle(
            `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=${encodeURIComponent(UPLOAD_RESULT_FIELDS)}`,
            {
                method: 'POST',
                headers: {
                    ...authHeaders,
                    'Content-Type': 'application/json; charset=UTF-8',
                    'X-Upload-Content-Type': 'application/octet-stream',
                    'X-Upload-Content-Length': String(total),
                },
                body: JSON.stringify({ name: 'probe.bin', parents: ['root'], modifiedTime }),
            },
        );
        expect(init.status).toBe(200);
        const uploadUrl = init.headers.get('Location')!;

        expect((await drive.handle(uploadUrl, {
            method: 'PUT',
            headers: { 'Content-Length': '0', 'Content-Range': 'bytes */999999' },
        })).status).toBe(308);

        const chunk1 = await drive.handle(uploadUrl, {
            method: 'PUT',
            headers: { 'Content-Length': '262144', 'Content-Range': `bytes 0-262143/${total}` },
            body: payload.subarray(0, 262144),
        });
        expect(chunk1.status).toBe(308);
        expect(chunk1.headers.get('Range')).toBe('bytes=0-262143');

        const gap = await drive.handle(uploadUrl, {
            method: 'PUT',
            headers: { 'Content-Length': String(total - 393216), 'Content-Range': `bytes 393216-${total - 1}/${total}` },
            body: payload.subarray(393216),
        });
        expect(gap.status).toBe(503);

        const afterGap = await drive.handle(uploadUrl, {
            method: 'PUT',
            headers: { 'Content-Length': '0', 'Content-Range': `bytes */${total}` },
        });
        expect(afterGap.status).toBe(308);
        expect(afterGap.headers.get('Range')).toBe('bytes=0-262143');

        const replayChunk1 = await drive.handle(uploadUrl, {
            method: 'PUT',
            headers: { 'Content-Length': '262144', 'Content-Range': `bytes 0-262143/${total}` },
            body: new Uint8Array(262144).fill(9),
        });
        expect(replayChunk1.status).toBe(308);

        const finalRes = await drive.handle(uploadUrl, {
            method: 'PUT',
            headers: { 'Content-Length': String(total - 262144), 'Content-Range': `bytes 262144-${total - 1}/${total}` },
            body: payload.subarray(262144),
        });
        expect(finalRes.status).toBe(200);
        const completed = await finalRes.json<any>();
        expect(completed).toMatchObject({
            id: expect.any(String),
            headRevisionId: expect.any(String),
            sha256Checksum: sha256Hex(payload),
        });

        // Repeated post-completion status probes and final-chunk replays return the same 200 payload.
        for (const probeInit of [
            { method: 'PUT', headers: { 'Content-Length': '0', 'Content-Range': `bytes */${total}` } },
            { method: 'PUT', headers: { 'Content-Length': '0', 'Content-Range': `bytes */${total}` } },
            {
                method: 'PUT',
                headers: { 'Content-Length': String(total - 262144), 'Content-Range': `bytes 262144-${total - 1}/${total}` },
                body: payload.subarray(262144),
            },
        ] as RequestInit[]) {
            const res = await drive.handle(uploadUrl, probeInit);
            expect(res.status).toBe(200);
            expect(await res.json()).toEqual(completed);
        }

        const stored = drive.findById(completed.id)!;
        expect(stored.modifiedTime).toBe(modifiedTime);
        expect(sha256Hex(stored.content!)).toBe(sha256Hex(payload));

        const missing = await drive.handle(
            'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=missing-id',
            { method: 'PUT', headers: { 'Content-Length': '0', 'Content-Range': 'bytes */10' } },
        );
        expect(missing.status).toBe(404);
    });

    it('strips MIME parameters, distinguishes resumable vs media MIME overwrites, and preserves digests across follow-up mtime PATCH', async () => {
        const drive = new MockDrive();
        const emptyRes = await drive.handle(
            'https://www.googleapis.com/drive/v3/files?fields=id,mimeType,headRevisionId,md5Checksum,modifiedTime',
            {
                method: 'POST',
                headers: { ...authHeaders, 'Content-Type': 'application/json; charset=UTF-8' },
                body: JSON.stringify({
                    name: 'empty.txt',
                    parents: ['root'],
                    mimeType: 'text/plain; charset=utf-8',
                    modifiedTime: '2023-11-14T22:13:40.500Z',
                }),
            },
        );
        expect(emptyRes.status).toBe(200);
        const empty = await emptyRes.json<any>();
        expect(empty).toMatchObject({
            mimeType: 'text/plain',
            headRevisionId: expect.any(String),
            md5Checksum: EMPTY_CHECKSUMS.md5,
            modifiedTime: '2023-11-14T22:13:40.500Z',
        });

        // PATCH ?uploadType=resumable preserves existing non-generic MIME on application/octet-stream
        // and updates MIME for specific X-Upload-Content-Type values (with parameters stripped).
        for (const [uploadMime, expectedMime] of [
            ['application/octet-stream', 'text/plain'],
            ['image/png; charset=binary', 'image/png'],
        ] as const) {
            const init = await drive.handle(
                `https://www.googleapis.com/upload/drive/v3/files/${empty.id}?uploadType=resumable&fields=id,mimeType,headRevisionId`,
                {
                    method: 'PATCH',
                    headers: {
                        ...authHeaders,
                        'Content-Type': 'application/json',
                        'X-Upload-Content-Type': uploadMime,
                        'X-Upload-Content-Length': '3',
                    },
                    body: JSON.stringify({ modifiedTime: '2023-11-14T22:13:41.250Z' }),
                },
            );
            const uploadUrl = init.headers.get('Location')!;
            const fin = await drive.handle(uploadUrl, {
                method: 'PUT',
                headers: { 'Content-Length': '3', 'Content-Range': 'bytes 0-2/3' },
                body: new Uint8Array([1, 2, 3]),
            });
            expect(fin.status).toBe(200);
            expect((await fin.json<any>()).mimeType).toBe(expectedMime);
        }

        // PATCH ?uploadType=media preserves existing MIME and follow-up modifiedTime PATCH preserves headRevisionId & digests.
        const mediaRes = await drive.handle(
            `https://www.googleapis.com/upload/drive/v3/files/${empty.id}?uploadType=media&fields=${encodeURIComponent(UPLOAD_RESULT_FIELDS + ',mimeType')}`,
            {
                method: 'PATCH',
                headers: { ...authHeaders, 'Content-Type': 'text/plain' },
                body: new Uint8Array(0),
            },
        );
        const truncated = await mediaRes.json<any>();
        expect(truncated).toMatchObject({
            mimeType: 'image/png',
            md5Checksum: EMPTY_CHECKSUMS.md5,
            sha1Checksum: EMPTY_CHECKSUMS.sha1,
            sha256Checksum: EMPTY_CHECKSUMS.sha256,
        });

        const patchMtime = await drive.handle(
            `https://www.googleapis.com/drive/v3/files/${empty.id}?supportsAllDrives=true&fields=${encodeURIComponent(UPLOAD_RESULT_FIELDS + ',modifiedTime,mimeType')}`,
            {
                method: 'PATCH',
                headers: { ...authHeaders, 'Content-Type': 'application/json' },
                body: JSON.stringify({ modifiedTime: '2023-11-14T22:13:42.125Z' }),
            },
        );
        expect(await patchMtime.json()).toMatchObject({
            mimeType: 'image/png',
            headRevisionId: truncated.headRevisionId,
            md5Checksum: EMPTY_CHECKSUMS.md5,
            sha1Checksum: EMPTY_CHECKSUMS.sha1,
            sha256Checksum: EMPTY_CHECKSUMS.sha256,
            modifiedTime: '2023-11-14T22:13:42.125Z',
        });
    });
});
