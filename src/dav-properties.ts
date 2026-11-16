import { DOMParser, XMLSerializer, type Element, type Node } from '@xmldom/xmldom';

export interface DavProperty {
    namespace: string;
    name: string;
    xml: string;
    // Only DAV:displayname needs a tombstone to suppress its computed default.
    removed?: true;
}

export class PropertyError extends Error {
    constructor(message: string, public status: number) { super(message); }
}

const DAV = 'DAV:';
const XML = 'http://www.w3.org/XML/1998/namespace';
const XMLNS = 'http://www.w3.org/2000/xmlns/';
const encoder = new TextEncoder();
const serializer = new XMLSerializer();
const forbiddenCharacters = /[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/u;
const invalid = (message = 'Invalid WebDAV XML'): never => { throw new PropertyError(message, 400); };
const escape = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

export const key = (property: Pick<DavProperty, 'namespace' | 'name'> & { xml?: string }): string => JSON.stringify([property.namespace, property.name]);

function parseXml(text: string): Element {
    if (encoder.encode(text).length > 65536) throw new PropertyError('Property XML exceeds 64 KiB', 413);
    const markup = text.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g, value => ' '.repeat(value.length));
    if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(markup)) invalid('DTD and entity declarations are not supported');
    const version = /^\s*<\?xml\s[^?]*?\bversion\s*=\s*(['"])(.*?)\1/.exec(markup);
    if (version && version[2] !== '1.0') invalid('Only XML 1.0 is supported');
    if (markup.replace(/<\?[\s\S]*?\?>|<[^\s/>!?]+(?:"[^"]*"|'[^']*'|[^'">])*>/g, '').includes(']]>')) invalid();
    // XML 1.0 characters. In particular, do not silently replace lone surrogates.
    if (forbiddenCharacters.test(text)) invalid();
    try {
        const document = new DOMParser({
            onError: () => { throw new Error('Malformed XML'); },
            // XML 1.0 normalizes CR/CRLF, not U+0085 or U+2028 in property values.
            normalizeLineEndings: value => value.replace(/\r\n?/g, '\n'),
        }).parseFromString(text, 'application/xml');
        if (!document.documentElement || document.doctype) invalid();
        const tags = markup.match(/<[^\s/>!?]+(?:"[^"]*"|'[^']*'|[^'">])*>/g) || [];
        let tagIndex = 0;
        const stack: [Node, number][] = [[document.documentElement!, 0]];
        while (stack.length) {
            const [node, depth] = stack.pop()!;
            if (depth > 128) invalid('Property XML is too deeply nested');
            if (node.nodeType === 1) {
                const element = node as Element;
                const tag = tags[tagIndex++];
                if (!tag) invalid();
                const attributeNames = [...tag.matchAll(/([^\s=]+)\s*=\s*(?:"[^"]*"|'[^']*')/g)].map(match => match[1]);
                const expandedNames = new Set<string>();
                for (const name of attributeNames) {
                    const colon = name.indexOf(':');
                    const namespace = colon < 0 ? '' : element.lookupNamespaceURI(name.slice(0, colon));
                    const expanded = JSON.stringify([namespace, name.slice(colon + 1)]);
                    if (expandedNames.has(expanded)) invalid('Duplicate expanded XML attribute name');
                    expandedNames.add(expanded);
                }
                if (element.prefix && !element.namespaceURI) invalid('Unbound XML prefix');
                for (let i = 0; i < element.attributes.length; i++) {
                    const attribute = element.attributes.item(i)!;
                    if (forbiddenCharacters.test(attribute.value)) invalid();
                    if (attribute.namespaceURI === XMLNS && (
                        attribute.value === XMLNS || attribute.name === 'xmlns:xmlns' ||
                        (attribute.name === 'xmlns:xml' ? attribute.value !== XML : attribute.value === XML) ||
                        (attribute.prefix === 'xmlns' && !attribute.value)
                    )) invalid('Invalid namespace binding');
                    if (attribute.prefix && !attribute.namespaceURI) invalid('Unbound XML prefix');
                }
            }
            if (node.nodeValue && forbiddenCharacters.test(node.nodeValue)) invalid();
            for (let child = node.lastChild; child; child = child.previousSibling) stack.push([child, depth + 1]);
        }
        return document.documentElement!;
    } catch (error) {
        if (error instanceof PropertyError) throw error;
        return invalid();
    }
}

function elements(node: Node): Element[] {
    const result: Element[] = [];
    for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === 1) result.push(child as Element);
        else if ((child.nodeType === 3 || child.nodeType === 4) && child.nodeValue?.trim()) invalid();
    }
    return result;
}

const isDav = (element: Element, name: string): boolean => element.namespaceURI === DAV && element.localName === name;

function property(element: Element): DavProperty {
    const copy = element.cloneNode(true) as Element;
    // Retain all in-scope bindings, not just element/attribute prefixes: values
    // can themselves contain QNames. The nearest declaration wins.
    const inherited = new Map<string, string>();
    let language: string | undefined;
    let space: string | undefined;
    for (let ancestor: Node | null = element; ancestor?.nodeType === 1; ancestor = ancestor.parentNode) {
        const current = ancestor as Element;
        for (let i = 0; i < current.attributes.length; i++) {
            const attribute = current.attributes.item(i)!;
            if (attribute.namespaceURI === XMLNS && !inherited.has(attribute.name)) inherited.set(attribute.name, attribute.value);
        }
        if (language === undefined && current.hasAttributeNS(XML, 'lang')) language = current.getAttributeNS(XML, 'lang')!;
        if (space === undefined && current.hasAttributeNS(XML, 'space')) space = current.getAttributeNS(XML, 'space')!;
    }
    for (const [name, value] of inherited) copy.setAttributeNS(XMLNS, name, value);
    if (language !== undefined) copy.setAttributeNS(XML, 'xml:lang', language);
    if (space !== undefined) copy.setAttributeNS(XML, 'xml:space', space);
    return { namespace: element.namespaceURI || '', name: element.localName || element.nodeName, xml: serializer.serializeToString(copy).replace(/\r/g, '&#13;') };
}

export function propertyNameXml(property: Pick<DavProperty, 'namespace' | 'name'> & { xml?: string }): string {
    return property.namespace
        ? `<P:${property.name} xmlns:P="${escape(property.namespace)}"/>`
        : `<${property.name} xmlns=""/>`;
}

export function parsePatch(text: string): { action: 'set' | 'remove'; property: DavProperty }[] {
    const root = parseXml(text);
    if (!isDav(root, 'propertyupdate')) invalid();
    const operations: { action: 'set' | 'remove'; property: DavProperty }[] = [];
    // RFC 4918 section 17: ignore unexpected envelope elements together with
    // their subtrees. Inside DAV:prop every element is a property, not an extension.
    for (const operation of elements(root).filter(child => isDav(child, 'set') || isDav(child, 'remove'))) {
        const containers = elements(operation).filter(child => isDav(child, 'prop'));
        if (containers.length !== 1) invalid();
        const properties = elements(containers[0]);
        if (!properties.length) invalid();
        for (const element of properties) {
            const action = operation.localName as 'set' | 'remove';
            if (action === 'remove' && element.hasChildNodes()) invalid('Removed property must be empty');
            operations.push({ action, property: property(element) });
        }
    }
    if (!operations.length) invalid('Property update must contain at least one property');
    return operations;
}

export function parseFind(text: string): { mode: 'allprop' | 'propname' | 'prop'; properties: DavProperty[] } {
    if (!text.trim()) return { mode: 'allprop', properties: [] };
    const root = parseXml(text);
    if (!isDav(root, 'propfind')) invalid();
    const children = elements(root);
    const selectors = children.filter(child => ['allprop', 'propname', 'prop'].some(name => isDav(child, name)));
    const includes = children.filter(child => isDav(child, 'include'));
    if (selectors.length !== 1 || includes.length > 1) invalid();
    const selector = selectors[0];
    const mode = selector.localName as 'allprop' | 'propname' | 'prop';
    if (includes.length && mode !== 'allprop') invalid();
    if (mode !== 'prop') elements(selector); // Reject text, but ignore unexpected child elements.
    const selected = mode === 'prop' ? elements(selector) : includes.length ? elements(includes[0]) : [];
    if (selected.some(element => element.hasChildNodes())) invalid('Requested property name must be empty');
    return { mode, properties: selected.map(property) };
}

// appProperties is one atomically patched Drive field. Keep a versioned XML
// payload in bounded chunks, rather than separate sidecar files or KV writes.
const storageKey = (index: number): string => 'wdp' + String(index).padStart(2, '0');
const reserved = (name: string): boolean => /^wdp(?:[01][0-9]|2[0-9])$/.test(name);
const corrupt = (): never => { throw new PropertyError('Stored WebDAV properties are corrupt; refusing to overwrite them', 500); };

export function readDeadProperties(current: Record<string, string> = {}): Map<string, DavProperty> {
    const names = Object.keys(current).filter(reserved).sort();
    if (!names.length) return new Map();
    if (names.some((name, index) => name !== storageKey(index))) return corrupt();
    try {
        const stored = JSON.parse(names.map(name => current[name]).join(''));
        if (stored?.v !== 1 || !Array.isArray(stored.properties)) return corrupt();
        const result = new Map<string, DavProperty>();
        for (const value of stored.properties) {
            if (!value || typeof value.namespace !== 'string' || typeof value.name !== 'string' || typeof value.xml !== 'string') return corrupt();
            const element = parseXml(value.xml);
            if ((element.namespaceURI || '') !== value.namespace || element.localName !== value.name || result.has(key(value))) return corrupt();
            if (value.removed !== undefined && (value.removed !== true || value.namespace !== DAV || value.name !== 'displayname')) return corrupt();
            result.set(key(value), { namespace: value.namespace, name: value.name, xml: value.xml, ...(value.removed ? { removed: true as const } : {}) });
        }
        return result;
    } catch { return corrupt(); }
}

export function writeDeadProperties(properties: Map<string, DavProperty>, current: Record<string, string> = {}): Record<string, string | null> {
    // Ensure a caller cannot accidentally repair a broken payload by deleting it.
    readDeadProperties(current);
    const available = 30 - Object.keys(current).filter(name => !reserved(name)).length;
    const chunks: string[] = [];
    if (properties.size) {
        const payload = JSON.stringify({ v: 1, properties: Array.from(properties.values()) });
        let chunk = '';
        let bytes = 0;
        for (const character of payload) {
            const length = encoder.encode(character).length;
            if (bytes + length > 119) { chunks.push(chunk); chunk = ''; bytes = 0; }
            chunk += character;
            bytes += length;
        }
        if (chunk) chunks.push(chunk);
    }
    if (chunks.length > available) throw new PropertyError('Google Drive custom-property storage is full', 507);
    const patch: Record<string, string | null> = {};
    for (const name of Object.keys(current).filter(reserved)) patch[name] = null;
    chunks.forEach((chunk, index) => { patch[storageKey(index)] = chunk; });
    return patch;
}
