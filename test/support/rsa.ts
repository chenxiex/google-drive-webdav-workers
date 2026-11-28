export async function generateRsaPair(): Promise<{
    privateKey: CryptoKey;
    publicKey: CryptoKey;
    pkcs8Pem: string;
    privateJwk: JsonWebKey;
    publicJwk: JsonWebKey;
}> {
    const pair = await crypto.subtle.generateKey(
        {
            name: 'RSASSA-PKCS1-v1_5',
            modulusLength: 2048,
            publicExponent: new Uint8Array([1, 0, 1]),
            hash: 'SHA-256',
        },
        true,
        ['sign', 'verify'],
    ) as CryptoKeyPair;
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey) as ArrayBuffer);
    const b64 = btoa(String.fromCharCode(...pkcs8));
    const lines = b64.match(/.{1,64}/g)?.join('\n') ?? b64;
    const pkcs8Pem = `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----`;
    const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey) as JsonWebKey;
    const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey) as JsonWebKey;
    return { privateKey: pair.privateKey, publicKey: pair.publicKey, pkcs8Pem, privateJwk, publicJwk };
}
