import {
  createCipheriv, createECDH, createHmac, createPrivateKey, randomBytes, sign, type KeyObject,
} from 'node:crypto'

/**
 * Web Push, the protocol a browser's push service speaks (RFC 8030), with the
 * payload encrypted for the browser alone (RFC 8291, aes128gcm) and the
 * request signed with this daemon's VAPID key (RFC 8292).
 *
 * Node's crypto has every primitive this needs, so there is no dependency:
 * an ECDH on P-256, HKDF written out as the HMACs it is, AES-128-GCM, and an
 * ES256 signature. The push service (Apple's, Google's, Mozilla's) relays the
 * message without being able to read it.
 */

/** A browser's PushSubscription, as `toJSON()` gives it. */
export interface Subscription {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

/** This daemon's VAPID key pair: the public key raw (65 bytes), the private scalar (32). */
export interface Vapid {
  publicKey: string
  privateKey: string
}

const b64u = (b: Buffer): string => b.toString('base64url')
const unb64u = (s: string): Buffer => Buffer.from(s, 'base64url')
const hmac = (key: Buffer, data: Buffer): Buffer => createHmac('sha256', key).update(data).digest()

export function generateVapid(): Vapid {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) }
}

/** A subscription a browser could really have produced: an https endpoint and keys of the right sizes. */
export function validSubscription(v: unknown): Subscription | null {
  if (!v || typeof v !== 'object') return null
  const { endpoint, keys } = v as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } }
  if (typeof endpoint !== 'string' || endpoint.length > 2048) return null
  try {
    if (new URL(endpoint).protocol !== 'https:') return null
  } catch {
    return null
  }
  const p256dh = keys?.p256dh
  const auth = keys?.auth
  if (typeof p256dh !== 'string' || typeof auth !== 'string') return null
  const pub = unb64u(p256dh)
  if (pub.length !== 65 || pub[0] !== 4 || unb64u(auth).length !== 16) return null
  return { endpoint, keys: { p256dh, auth } }
}

function vapidKey(v: Vapid): KeyObject {
  const pub = unb64u(v.publicKey)
  return createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', d: v.privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) },
    format: 'jwk',
  })
}

/** RFC 8292: a short-lived JWT for the push service's origin, signed ES256. */
export function vapidAuthorization(endpoint: string, v: Vapid, subject: string, now = Date.now()): string {
  const enc = (o: object): string => b64u(Buffer.from(JSON.stringify(o)))
  const data = `${enc({ typ: 'JWT', alg: 'ES256' })}.${enc({
    aud: new URL(endpoint).origin,
    exp: Math.floor(now / 1000) + 12 * 3600,
    sub: subject,
  })}`
  const sig = sign('sha256', Buffer.from(data), { key: vapidKey(v), dsaEncoding: 'ieee-p1363' })
  return `vapid t=${data}.${b64u(sig)}, k=${v.publicKey}`
}

/**
 * RFC 8291: the payload, readable only by the browser that holds the
 * subscription's private key. One record, so the whole message must fit in
 * the push services' 4 KB; tring's are a few hundred bytes.
 *
 * `salt` and `ephemeral` are for tests; a real message uses fresh ones.
 */
export function encrypt(sub: Subscription, plaintext: Buffer, fixed?: { salt?: Buffer; ephemeral?: Buffer }): Buffer {
  const uaPublic = unb64u(sub.keys.p256dh)
  const authSecret = unb64u(sub.keys.auth)
  const ecdh = createECDH('prime256v1')
  if (fixed?.ephemeral) ecdh.setPrivateKey(fixed.ephemeral)
  else ecdh.generateKeys()
  const asPublic = ecdh.getPublicKey()
  const shared = ecdh.computeSecret(uaPublic)
  const salt = fixed?.salt ?? randomBytes(16)

  // HKDF(auth, shared, "WebPush: info" || ua || as) -> IKM; HKDF(salt, IKM, ...) -> CEK, nonce.
  const ikm = hmac(hmac(authSecret, shared), Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]))
  const prk = hmac(salt, ikm)
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01', 'binary')).subarray(0, 16)
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01', 'binary')).subarray(0, 12)

  const cipher = createCipheriv('aes-128-gcm', cek, nonce)
  // 0x02 marks the last (and only) record.
  const body = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()])
  const rs = Buffer.alloc(4)
  rs.writeUInt32BE(4096)
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body])
}

export interface PushOptions {
  /** Seconds the push service keeps it for a phone that is off. */
  ttl: number
  urgency: 'very-low' | 'low' | 'normal' | 'high'
  /** A newer message with the same topic replaces an undelivered one. */
  topic?: string
}

/** The push service's HTTP status: 201 delivered, 404/410 the subscription is gone. */
export async function sendPush(
  sub: Subscription, payload: object, vapid: Vapid, subject: string, opts: PushOptions,
  fetchFn: typeof fetch = fetch,
): Promise<number> {
  const res = await fetchFn(sub.endpoint, {
    method: 'POST',
    headers: {
      authorization: vapidAuthorization(sub.endpoint, vapid, subject),
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      ttl: String(opts.ttl),
      urgency: opts.urgency,
      ...(opts.topic ? { topic: opts.topic.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) } : {}),
    },
    body: new Uint8Array(encrypt(sub, Buffer.from(JSON.stringify(payload), 'utf8'))),
    signal: AbortSignal.timeout(15_000),
  })
  return res.status
}
