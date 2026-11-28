import { expect, it } from 'vitest';
import { StatusError, errorStatus } from '../../src/http';

it.each<[string, unknown, number]>([
    ['string e.code', Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }), 500],
    ['non-HTTP numeric e.code', Object.assign(new Error('sqlite busy'), { code: 5 }), 500],
    ['HTTP-like e.code without status', Object.assign(new Error('code ignored'), { code: 404 }), 500],
    ['DOMException with numeric code', new DOMException('Aborted', 'AbortError'), 500],
    ['valid StatusError status', new StatusError('Rate limited', 429), 429],
    ['non-error 204 status', Object.assign(new Error('no content'), { status: 204 }), 500],
    ['out-of-range status', Object.assign(new Error('out of range'), { status: 999 }), 500],
    ['fractional status', Object.assign(new Error('fractional'), { status: 404.5 }), 500],
    ['non-numeric status', Object.assign(new Error('string status'), { status: '404' }), 500],
    ['plain object with valid status', { status: 503, message: 'upstream down' }, 503],
    ['thrown string', 'unexpected string failure', 500],
    ['thrown null', null, 500],
])('maps %s to an HTTP error status', (_label, error, status) => {
    expect(errorStatus(error)).toBe(status);
});
