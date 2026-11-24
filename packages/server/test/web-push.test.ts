import { createDecipheriv, createECDH, createHmac, createPublicKey, randomBytes, verify } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { encrypt, generateVapid, validSubscription, vapidAuthorization, type Subscription } from '../src/web-push.ts'

const b64u = (b: Buffer): string => b.toString('base64url')
const hmac = (k: Buffer, d: Buffer): Buffer => createHmac('sha256', k).update(d).digest()

/** A browser's side of RFC 8291, written out separately from the sender's. */
function decrypt(message: Buffer, uaPrivate: Buffer, auth: Buffer): string {
  const salt = message.subarray(0, 16)
  const idlen = message[20]!
  const asPublic = message.subarray(21, 21 + idlen)
  const body = message.subarray(21 + idlen)
  const ua = createECDH('prime256v1')
  ua.setPrivateKey(uaPrivate)
  const shared = ua.computeSecret(asPublic)
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic, Buffer.from([1])])
  const prk = hmac(salt, hmac(hmac(auth, shared), info))
  const cek = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])])).subarray(0, 16)
  const nonce = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])])).subarray(0, 12)
  const d = createDecipheriv('aes-128-gcm', cek, nonce)
  d.setAuthTag(body.subarray(body.length - 16))
  const plain = Buffer.concat([d.update(body.subarray(0, body.length - 16)), d.final()])
  expect(plain[plain.length - 1]).toBe(2)
  return plain.subarray(0, plain.length - 1).toString('utf8')
}

function browser(): { sub: Subscription; priv: Buffer; auth: Buffer } {
  const ua = createECDH('prime256v1')
  ua.generateKeys()
  const auth = randomBytes(16)
  return { sub: { endpoint: 'https://push.example/x', keys: { p256dh: b64u(ua.getPublicKey()), auth: b64u(auth) } }, priv: ua.getPrivateKey(), auth }
}

describe('encrypt (RFC 8291)', () => {
  it('can be read by the browser holding the subscription, and by no other', () => {
    const b = browser()
    const msg = encrypt(b.sub, Buffer.from('{"title":"tring.chat/3 needs permission"}'))
    expect(msg.readUInt32BE(16)).toBe(4096)
    expect(msg[20]).toBe(65)
    expect(decrypt(msg, b.priv, b.auth)).toBe('{"title":"tring.chat/3 needs permission"}')
    const other = browser()
    expect(() => decrypt(msg, other.priv, b.auth)).toThrow()
  })

  it('uses fresh keys and salt each time', () => {
    const b = browser()
    const one = encrypt(b.sub, Buffer.from('x'))
    const two = encrypt(b.sub, Buffer.from('x'))
    expect(one.subarray(0, 16).equals(two.subarray(0, 16))).toBe(false)
    expect(one.subarray(21, 86).equals(two.subarray(21, 86))).toBe(false)
  })

  it('matches the worked example in RFC 8291 appendix A', () => {
    const sub: Subscription = {
      endpoint: 'https://push.example.net/push/JzLQ3raZJfFBR0aqvOMsLrt54w4rJUsV',
      keys: {
        p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
        auth: 'BTBZMqHH6r4Tts7J_aSIgg',
      },
    }
    const msg = encrypt(sub, Buffer.from('When I grow up, I want to be a watermelon'), {
      salt: Buffer.from('DGv6ra1nlYgDCS1FRnbzlw', 'base64url'),
      ephemeral: Buffer.from('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', 'base64url'),
    })
    expect(b64u(msg)).toBe(
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
    )
  })
})

describe('VAPID (RFC 8292)', () => {
  it('signs a JWT for the push service, verifiable with the public key it sends', () => {
    const v = generateVapid()
    const h = vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', v, 'https://tring.chat', 1_700_000_000_000)
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(h)!
    expect(m[4]).toBe(v.publicKey)
    expect(JSON.parse(Buffer.from(m[2]!, 'base64url').toString())).toEqual({
      aud: 'https://fcm.googleapis.com', exp: 1_700_000_000 + 12 * 3600, sub: 'https://tring.chat',
    })
    const pub = Buffer.from(v.publicKey, 'base64url')
    const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33)) }, format: 'jwk' })
    expect(verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(m[3]!, 'base64url'))).toBe(true)
  })
})

describe('validSubscription', () => {
  it('accepts what a browser produces and nothing else', () => {
    const b = browser()
    expect(validSubscription(b.sub)).toEqual(b.sub)
    expect(validSubscription({ ...b.sub, endpoint: 'http://push.example/x' })).toBeNull()
    expect(validSubscription({ ...b.sub, keys: { ...b.sub.keys, auth: 'short' } })).toBeNull()
    expect(validSubscription({ endpoint: 'https://x' })).toBeNull()
  })
})
