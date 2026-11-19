"""Bounded, credential-redacting capture for disposable reference-server probes."""
import json
import re
import xml.etree.ElementTree as ET
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

LIMIT = 128 * 1024
SAFE_QUERY = {'format', 'depth', 'preview', 'x', 'y', 'a', 'mode', 'scalingup', 'forceicon', 'etag'}
SECRET = re.compile(r'password|secret|token|authorization|cookie|(^|[_-])code($|[_-])', re.I)
JWT = re.compile(r'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+')


def sanitize_text(value, secrets=()):
    value = JWT.sub('REDACTED_TOKEN', value)
    for secret in secrets:
        if secret:
            value = value.replace(secret, 'REDACTED')
    return value


def target(value, secrets=()):
    parts = urlsplit(value)
    query = [(k, v if k.lower() in SAFE_QUERY else 'REDACTED')
             for k, v in parse_qsl(parts.query, keep_blank_values=True)]
    return sanitize_text(urlunsplit((parts.scheme, parts.netloc, parts.path,
                                    urlencode(query), '')), secrets)


def headers(values, secrets=()):
    result = {}
    for key, value in values:
        if SECRET.search(key):
            continue
        result[key] = target(value, secrets) if key.lower() in ('location', 'referer') else sanitize_text(value, secrets)
    return result


def payload(method, path, body, content_type, secrets=()):
    """Capture DAV XML and small OCS/Graph documents, never upload/login bodies."""
    dav = method in ('PROPFIND', 'PROPPATCH')
    discovery = method == 'GET' and path.startswith(('/ocs/', '/graph/'))
    if not (dav or discovery) or not body:
        return None
    if len(body) > LIMIT:
        return {'omitted': 'body exceeds capture limit', 'bytes': len(body)}
    try:
        value = body.decode('utf-8')
        if 'json' in content_type:
            def clean(x):
                if isinstance(x, dict):
                    return {k: ('REDACTED' if SECRET.search(k) else clean(v)) for k, v in x.items()}
                if isinstance(x, list):
                    return [clean(v) for v in x]
                if isinstance(x, str):
                    return target(x, secrets) if x.startswith(('http://', 'https://')) else sanitize_text(x, secrets)
                return x
            return json.dumps(clean(json.loads(value)), ensure_ascii=False)
        # Do not interpret binary or HTML error bodies as DAV evidence.
        root = ET.fromstring(value)
        for element in root.iter():
            if SECRET.search(element.tag.split('}')[-1]):
                element.clear()
                element.text = 'REDACTED'
            for key in list(element.attrib):
                if SECRET.search(key):
                    element.attrib[key] = 'REDACTED'
            if element.text and element.text.startswith(('http://', 'https://')):
                element.text = target(element.text, secrets)
        return sanitize_text(ET.tostring(root, encoding='unicode'), secrets)
    except (UnicodeError, ValueError, ET.ParseError):
        return {'omitted': 'not valid supported text'}
