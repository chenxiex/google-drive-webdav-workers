import { DOMParser } from '@xmldom/xmldom';
import { describe, expect, it } from 'vitest';
import { StatusError } from '../../src/http';
import { buildGraphQuota, computeSpaceRootEtag, serializeGraphDrivesJson } from '../../src/ocis/graph';
import { negotiateOcsFormat, serializeOcsXml } from '../../src/ocis/ocs';
import { personalSpaceId } from '../../src/ocis/profile';

function makeRequest(url: string, accept?: string): Request {
    return new Request(url, accept ? { headers: { Accept: accept } } : undefined);
}

describe('negotiateOcsFormat', () => {
    it.each<[string, string | undefined, 'json' | 'xml']>([
        ['https://example.com/ocs/v2.php/cloud/user?format=json', undefined, 'json'],
        ['https://example.com/ocs/v2.php/cloud/user?format=JSON', 'application/xml', 'json'],
        ['https://example.com/ocs/v2.php/cloud/user?format=xml', 'application/json', 'xml'],
        ['https://example.com/ocs/v2.php/cloud/user?format=XML', undefined, 'xml'],
        ['https://example.com/ocs/v2.php/cloud/user?format=', 'application/json', 'json'],
        ['https://example.com/ocs/v2.php/cloud/user', undefined, 'xml'],
        ['https://example.com/ocs/v2.php/cloud/user', '*/*', 'xml'],
        ['https://example.com/ocs/v2.php/cloud/user', 'application/xml', 'xml'],
        ['https://example.com/ocs/v2.php/cloud/user', 'text/xml', 'xml'],
        ['https://example.com/ocs/v2.php/cloud/user', 'application/json', 'json'],
        ['https://example.com/ocs/v2.php/cloud/user', 'text/json', 'json'],
        ['https://example.com/ocs/v2.php/cloud/user', 'application/vnd.api+json', 'json'],
        ['https://example.com/ocs/v2.php/cloud/user', 'application/json;q=0.5, application/xml;q=0.9', 'xml'],
        ['https://example.com/ocs/v2.php/cloud/user', 'application/json;q=0.9, application/xml;q=0.5', 'json'],
        ['https://example.com/ocs/v2.php/cloud/user', 'application/json; charset=utf-8; q=0.8', 'json'],
        ['https://example.com/ocs/v2.php/cloud/user', 'application/json;q=0', 'xml'],
        ['https://example.com/ocs/v2.php/cloud/user', 'application/json;q=invalid', 'xml'],
        ['https://example.com/ocs/v2.php/cloud/user', 'application/json;q=1, application/xml;q=1', 'xml'],
    ])('resolves %s (Accept: %s) -> %s', (url, accept, expected) => {
        expect(negotiateOcsFormat(makeRequest(url, accept))).toBe(expected);
    });

    it('rejects unsupported explicit format query values with 400', () => {
        expect(() => negotiateOcsFormat(makeRequest('https://example.com/ocs/v2.php/cloud/user?format=yaml')))
            .toThrowError(new StatusError('Unsupported OCS format', 400));
    });
});

describe('serializeOcsXml', () => {
    it('serializes envelopes, escapes special characters, and formats arrays/empty values cleanly', () => {
        const xml = serializeOcsXml({
            ocs: {
                meta: { status: 'ok', statuscode: 100, message: 'OK' },
                data: {
                    id: 'alice&bob<1>',
                    'display-name': 'Alice "A" & Bob',
                    pollinterval: 30000,
                    enabled: true,
                    disabled: false,
                    emptyStr: '',
                    supportedTypes: ['sha1', 'md5', 'sha256'],
                    blacklisted_files: [],
                },
            },
        });

        const doc = new DOMParser().parseFromString(xml, 'application/xml');
        expect(doc.documentElement?.tagName).toBe('ocs');
        expect(doc.getElementsByTagName('statuscode')[0]?.textContent).toBe('100');
        expect(doc.getElementsByTagName('id')[0]?.textContent).toBe('alice&bob<1>');
        expect(doc.getElementsByTagName('display-name')[0]?.textContent).toBe('Alice "A" & Bob');
        expect(doc.getElementsByTagName('pollinterval')[0]?.textContent).toBe('30000');
        expect(doc.getElementsByTagName('enabled')[0]?.textContent).toBe('true');
        expect(doc.getElementsByTagName('disabled')[0]?.textContent).toBe('false');
        expect(doc.getElementsByTagName('emptyStr')[0]?.textContent).toBe('');
        const elements = Array.from(doc.getElementsByTagName('supportedTypes')[0]!.getElementsByTagName('element'))
            .map(node => node.textContent);
        expect(elements).toEqual(['sha1', 'md5', 'sha256']);
        expect(doc.getElementsByTagName('blacklisted_files')[0]?.childNodes.length).toBe(0);
    });
});

describe('Graph quota and space helpers', () => {
    it.each<[
        { limit?: string; available?: string; used: string } | undefined,
        { total: bigint; used: bigint; remaining: bigint; state: string } | undefined,
    ]>([
        [undefined, undefined],
        [{ used: '4096' }, undefined],
        [{ limit: '0', used: '0', available: '0' }, undefined],
        [{ limit: '1073741824', used: '4096', available: '1073737728' }, {
            total: 1073741824n, used: 4096n, remaining: 1073737728n, state: 'normal',
        }],
        [{ limit: '100', used: '75', available: '25' }, {
            total: 100n, used: 75n, remaining: 25n, state: 'nearing',
        }],
        [{ limit: '100', used: '90', available: '10' }, {
            total: 100n, used: 90n, remaining: 10n, state: 'critical',
        }],
        [{ limit: '1024', used: '4096', available: '0' }, {
            total: 1024n, used: 4096n, remaining: 0n, state: 'exceeded',
        }],
        [{ limit: '9223372036854775807', used: '9007199254740993', available: '9214364837600034814' }, {
            total: 9223372036854775807n, used: 9007199254740993n, remaining: 9214364837600034814n, state: 'normal',
        }],
    ])('buildGraphQuota(%j)', (input, expected) => {
        expect(buildGraphQuota(input)).toEqual(expected);
    });

    it('serializes int64 quota fields verbatim without IEEE-754 rounding', () => {
        const raw = serializeGraphDrivesJson({
            id: 'personal$root',
            name: 'Personal',
            eTag: '"root-1"',
            webDavUrl: 'https://example.com/dav/spaces/personal$root',
            quota: {
                total: 9223372036854775807n,
                used: 9007199254740993n,
                remaining: 9214364837600034814n,
                state: 'normal',
            },
        });
        expect(raw).toContain('"total":9223372036854775807');
        expect(raw).toContain('"used":9007199254740993');
        expect(raw).toContain('"remaining":9214364837600034814');
        const parsed = JSON.parse(raw);
        expect(parsed.value).toHaveLength(1);
        expect(parsed.value[0].quota.state).toBe('normal');
    });

    it('formats space IDs and computes space root ETags with fallbacks', () => {
        expect(personalSpaceId('root')).toBe('personal$root');
        expect(personalSpaceId('folder/with$special')).toBe('personal$folder%2Fwith%24special');
        expect(computeSpaceRootEtag({ id: 'f1', headRevisionId: 'rev-2', version: '3' }, 'f1')).toBe('"f1-rev-2"');
        expect(computeSpaceRootEtag({ id: 'f1', version: '3' }, 'f1')).toBe('"f1-3"');
        expect(computeSpaceRootEtag({ id: 'root', modifiedTime: '2024-01-01T00:00:00.000Z' }, 'root'))
            .toBe('"root-2024-01-01T00:00:00.000Z"');
    });
});
