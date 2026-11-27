export interface BasicCredentials {
    user: string;
    pass: string;
}

// Constant-time string comparison. `crypto.subtle.timingSafeEqual` throws when
// the buffers differ in length, and returning early would leak the length of
// the stored secret through timing, so compare a value against itself instead.
// Falls back to a constant-time XOR loop when `timingSafeEqual` is unavailable (e.g. Node unit tests).
export function timingSafeEqual(a: string, b: string): boolean {
    const encoder = new TextEncoder();
    const left = encoder.encode(a);
    const right = encoder.encode(b);
    const subtle = crypto.subtle as SubtleCrypto & {
        timingSafeEqual?: (a: ArrayBufferView | ArrayBuffer, b: ArrayBufferView | ArrayBuffer) => boolean;
    };
    if (typeof subtle.timingSafeEqual === 'function') {
        return left.byteLength === right.byteLength
            ? subtle.timingSafeEqual(left, right)
            : !subtle.timingSafeEqual(left, left);
    }
    let diff = left.byteLength ^ right.byteLength;
    const len = left.byteLength;
    for (let i = 0; i < len; i++) {
        diff |= left[i] ^ (right[i % (right.byteLength || 1)] ?? 0);
    }
    return diff === 0;
}

export function isValidUser(users: Record<string, string>, creds: BasicCredentials): boolean {
    if (!Object.prototype.hasOwnProperty.call(users, creds.user)) return false;
    return timingSafeEqual(String(users[creds.user]), creds.pass);
}

export function basicAuthentication(request: Request): BasicCredentials | null {
    const Authorization = request.headers.get('Authorization');
    if (!Authorization) return null;
    const [scheme, encoded] = Authorization.split(' ');
    if (!encoded || scheme !== 'Basic') return null;
    let decoded: string;
    try {
        const buffer = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
        decoded = new TextDecoder().decode(buffer).normalize();
    } catch {
        // Malformed base64 should not collapse into a 500.
        return null;
    }
    const index = decoded.indexOf(':');
    if (index === -1 || /[\0-\x1F\x7F]/.test(decoded)) return null;
    return { user: decoded.substring(0, index), pass: decoded.substring(index + 1) };
}
