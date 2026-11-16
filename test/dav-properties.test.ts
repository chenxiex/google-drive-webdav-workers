import { describe, expect, it } from 'vitest';
import { DOMParser } from '@xmldom/xmldom';
import { key, parseFind, parsePatch, propertyNameXml, readDeadProperties, writeDeadProperties, type DavProperty } from '../src/dav-properties';

const patch = (inner: string): string => `<d:propertyupdate xmlns:d="DAV:" xmlns:x="urn:test">${inner}</d:propertyupdate>`;
const set = (inner: string): string => `<d:set><d:prop>${inner}</d:prop></d:set>`;
const remove = (inner: string): string => `<d:remove><d:prop>${inner}</d:prop></d:remove>`;
const xml = (text: string) => new DOMParser({ normalizeLineEndings: value => value.replace(/\r\n?/g, '\n') }).parseFromString(text, 'application/xml').documentElement!;
const apply = (current: Record<string, string>, changes: Record<string, string | null>): Record<string, string> => {
    const next = { ...current };
    for (const [name, value] of Object.entries(changes)) {
        if (value === null) delete next[name];
        else next[name] = value;
    }
    return next;
};

describe('WebDAV property XML', () => {
    it('matches expanded names, accepts default namespace, and preserves operation order', () => {
        const operations = parsePatch('<propertyupdate xmlns="DAV:" xmlns:a="urn:a"><set><prop><a:color>red</a:color></prop></set><remove><prop><a:color/></prop></remove><set><prop><a:color>blue</a:color></prop></set></propertyupdate>');
        expect(operations.map(operation => operation.action)).toEqual(['set', 'remove', 'set']);
        expect(operations.map(operation => key(operation.property))).toEqual(Array(3).fill('["urn:a","color"]'));
        expect(xml(operations[2].property.xml).textContent).toBe('blue');
    });

    it('preserves mixed XML, significant whitespace, namespace context and inherited language', () => {
        const [operation] = parsePatch('<d:propertyupdate xmlns:d="DAV:" xmlns:x="urn:test" xmlns:q="urn:q" xml:lang="zh"><d:set><d:prop><x:value xml:space="preserve" kind="q:thing"> pre <q:child q:flag="a&amp;b"/> post\n </x:value></d:prop></d:set></d:propertyupdate>');
        const element = xml(operation.property.xml);
        expect(element.namespaceURI).toBe('urn:test');
        expect(element.getAttribute('xml:lang')).toBe('zh');
        expect(element.getAttribute('xml:space')).toBe('preserve');
        expect(element.lookupNamespaceURI('q')).toBe('urn:q');
        expect(element.getAttribute('kind')).toBe('q:thing');
        expect(element.textContent).toBe(' pre  post\n ');
        expect(element.getElementsByTagNameNS('urn:q', 'child').item(0)?.getAttributeNS('urn:q', 'flag')).toBe('a&b');
    });

    it('does not conflate namespace-less or equal local-name properties', () => {
        const operations = parsePatch(patch(set('<value/><x:value/>')));
        expect(operations.map(operation => operation.property.namespace)).toEqual(['', 'urn:test']);
        expect(key(operations[0].property)).not.toBe(key(operations[1].property));
        for (const operation of operations) {
            const element = xml(propertyNameXml(operation.property));
            expect(element.namespaceURI || '').toBe(operation.property.namespace);
            expect(element.localName).toBe('value');
            expect(element.childNodes.length).toBe(0);
        }
    });

    it('keeps empty property distinct from absent, and inherits the nearest xml:lang', () => {
        const [operation] = parsePatch('<propertyupdate xmlns="DAV:" xml:lang="en"><set xml:lang="fr"><prop><p xmlns="urn:test" xml:lang=""/></prop></set></propertyupdate>');
        expect(xml(operation.property.xml).hasAttribute('xml:lang')).toBe(true);
        expect(xml(operation.property.xml).getAttribute('xml:lang')).toBe('');
        expect(xml(operation.property.xml).textContent).toBe('');
    });

    it('preserves DTD-like literal text without allowing declarations', () => {
        const [operation] = parsePatch(patch(set('<x:value><![CDATA[<!DOCTYPE sample>]]></x:value>')));
        expect(xml(operation.property.xml).textContent).toBe('<!DOCTYPE sample>');
    });

    it('preserves character-reference carriage returns across serialization', () => {
        const [operation] = parsePatch(patch(set('<x:value attr="&#9;&#10;&#13;">&#13;</x:value>')));
        expect(xml(operation.property.xml).textContent).toBe('\r');
        expect(xml(operation.property.xml).getAttribute('attr')).toBe('\t\n\r');
    });

    it('normalizes XML 1.0 newlines without changing Unicode text', () => {
        const [operation] = parsePatch(patch(set('<x:value>one\r\ntwo\rthree\u0085four\u2028five</x:value>')));
        expect(xml(operation.property.xml).textContent).toBe('one\ntwo\nthree\u0085four\u2028five');
    });

    it.each([
        '', 'not XML', '<p/>', '<propertyupdate/>',
        '<d:propertyupdate xmlns:d="DAV:"/>',
        patch('<d:set><d:prop/></d:set>'),
        patch(set('<x:value>unclosed')),
        patch(set('<missing:value/>')),
        patch(set('<x:value>&unknown;</x:value>')),
        patch(remove('<x:value>text</x:value>')),
        patch(remove('<x:value><x:child/></x:value>')),
        patch('<d:unknown/>'),
        patch(set('<x:value>\u0000</x:value>')),
        patch(set('<x:value>&#0;</x:value>')),
        patch(set('<x:value>]]></x:value>')),
        '<?xml version="1.1"?>' + patch(set('<x:value/>')),
        patch(set('<x:value xmlns:xml="wrong"/>')),
        patch(set('<x:value xmlns:a=""/>')),
        patch(set('<x:value xmlns:a="urn:a" xmlns:b="urn:a" a:z="1" b:z="2"/>')),
        '<!DOCTYPE d:propertyupdate [<!ENTITY x "secret">]>' + patch(set('<x:value>&x;</x:value>')),
        '<!DOCTYPE d:propertyupdate SYSTEM "https://example.com/external.dtd">' + patch(set('<x:value/>')),
    ])('rejects malformed or unsafe propertyupdate: %s', body => {
        expect(() => parsePatch(body)).toThrowError(expect.objectContaining({ status: 400 }));
    });

    it('bounds request bytes and nesting', () => {
        expect(() => parsePatch(patch(set('<x:value>' + '你'.repeat(22000) + '</x:value>')))).toThrowError(expect.objectContaining({ status: 413 }));
        expect(() => parsePatch(patch(set('<x:value>' + '<a>'.repeat(130) + '</a>'.repeat(130) + '</x:value>')))).toThrowError(expect.objectContaining({ status: 400 }));
    });

    it('parses empty/allprop/propname/explicit property requests and include', () => {
        expect(parseFind('')).toEqual({ mode: 'allprop', properties: [] });
        expect(parseFind('<propfind xmlns="DAV:"><propname/></propfind>')).toEqual({ mode: 'propname', properties: [] });
        expect(parseFind('<propfind xmlns="DAV:"><prop/></propfind>')).toEqual({ mode: 'prop', properties: [] });
        const result = parseFind('<propfind xmlns="DAV:" xmlns:x="urn:test"><allprop/><include><x:p/></include></propfind>');
        expect(result.mode).toBe('allprop');
        expect(result.properties[0]).toMatchObject({ namespace: 'urn:test', name: 'p' });
    });

    it('ignores unexpected update-envelope elements and their whole subtrees', () => {
        const operations = parsePatch(patch(
            '<x:extension><d:set><d:prop><x:ignored/></d:prop></d:set></x:extension>' +
            '<d:set x:attribute="ignored"><x:extension><d:prop><x:ignored/></d:prop></x:extension>' +
            '<d:prop><x:kept>value<x:nested/></x:kept></d:prop><d:unexpected/></d:set>' +
            '<d:remove><x:extension/><d:prop><x:removed/></d:prop></d:remove>'
        ));
        expect(operations.map(operation => [operation.action, operation.property.name])).toEqual([['set', 'kept'], ['remove', 'removed']]);
        expect(xml(operations[0].property.xml).getElementsByTagNameNS('urn:test', 'nested').length).toBe(1);
    });

    it('ignores unexpected find-envelope elements without interpreting nested selectors', () => {
        expect(parseFind('<propfind xmlns="DAV:" xmlns:x="urn:test"><x:extension><prop/></x:extension><allprop><propname/></allprop></propfind>')).toEqual({ mode: 'allprop', properties: [] });
        expect(parseFind('<propfind xmlns="DAV:"><propname><unexpected/></propname></propfind>')).toEqual({ mode: 'propname', properties: [] });
        const result = parseFind('<propfind xmlns="DAV:" xmlns:x="urn:test"><x:extension/><prop><x:kept/></prop></propfind>');
        expect(result.properties.map(property => property.name)).toEqual(['kept']);
    });

    it.each([
        '<propfind xmlns="DAV:"/>',
        '<propfind xmlns="DAV:"><allprop/><propname/></propfind>',
        '<propfind xmlns="DAV:"><prop/><include><p/></include></propfind>',
        '<propfind xmlns="DAV:"><extension><allprop/></extension></propfind>',
        '<propfind xmlns="DAV:"><prop><p>value</p></prop></propfind>',
    ])('rejects invalid propfind selections: %s', body => {
        expect(() => parseFind(body)).toThrowError(expect.objectContaining({ status: 400 }));
    });
});

describe('Drive-backed dead property payload', () => {
    const properties = (text: string): Map<string, DavProperty> => {
        const property = parsePatch(patch(set(`<x:value>${text}</x:value>`)))[0].property;
        return new Map([[key(property), property]]);
    };

    it('roundtrips XML and UTF-8 split across bounded fields, preserving unrelated properties', () => {
        const original = properties('中文🙂 '.repeat(70));
        const stored = apply({ anotherAppKey: 'leave me' }, writeDeadProperties(original, { anotherAppKey: 'leave me' }));
        expect(stored.anotherAppKey).toBe('leave me');
        expect(Object.keys(stored).length).toBeGreaterThan(2);
        for (const [name, value] of Object.entries(stored)) expect(new TextEncoder().encode(name + value).length).toBeLessThanOrEqual(124);
        expect(readDeadProperties(stored)).toEqual(original);
    });

    it('removes old trailing chunks and deletes an empty store using null patches', () => {
        const stored = apply({}, writeDeadProperties(properties('a'.repeat(1500))));
        const shortened = writeDeadProperties(properties('short'), stored);
        expect(Object.values(shortened)).toContain(null);
        const next = apply(stored, shortened);
        expect(readDeadProperties(next)).toEqual(properties('short'));
        const removed = writeDeadProperties(new Map(), next);
        expect(Object.values(removed).every(value => value === null)).toBe(true);
        expect(readDeadProperties(apply(next, removed)).size).toBe(0);
    });

    it('uses the available private property budget and fails before writing over quota', () => {
        const unrelated = Object.fromEntries(Array.from({ length: 29 }, (_, index) => ['custom' + index, 'value']));
        expect(() => writeDeadProperties(properties('large enough to need more than one field'), unrelated)).toThrowError(expect.objectContaining({ status: 507 }));
        expect(() => writeDeadProperties(properties('x'.repeat(4000)))).toThrowError(expect.objectContaining({ status: 507 }));
    });

    it.each([
        { wdp01: 'missing first chunk' },
        { wdp00: 'not JSON' },
        { wdp00: '{"v":2,"properties":[]}' },
        { wdp00: '{"v":1,"properties":[{"namespace":"urn:test","name":"p","xml":"<different/>"}]}' },
    ])('refuses corrupted or unsupported storage without overwriting: %s', current => {
        expect(() => readDeadProperties(current as unknown as Record<string, string>)).toThrowError(expect.objectContaining({ status: 500 }));
        expect(() => writeDeadProperties(new Map(), current as unknown as Record<string, string>)).toThrowError(expect.objectContaining({ status: 500 }));
    });
});
