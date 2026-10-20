import http from 'node:http'
import type net from 'node:net'

import * as jose from 'jose'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  SUBPROTOCOL,
  asAgentFromProtocols,
  bearerFromAuthorization,
  bearerFromProtocols,
  createVerifier,
  offeredProtocols,
} from '../../../services/files/src/auth.mjs'
import { colorFor } from '../../../packages/files-core/src/presence.mjs'
import { TokenBucket } from '../../../packages/files-core/src/limits.mjs'

describe('files auth:凭证从哪来', () => {
  it('WebSocket 子协议:必须同时提供 gugu-files.v1 才取 bearer.', () => {
    expect(bearerFromProtocols(offeredProtocols(`${SUBPROTOCOL}, bearer.abc.def.ghi`))).toBe('abc.def.ghi')
    expect(bearerFromProtocols(offeredProtocols('bearer.abc.def.ghi'))).toBeNull()
    expect(bearerFromProtocols(offeredProtocols(SUBPROTOCOL))).toBeNull()
    expect(bearerFromProtocols(offeredProtocols(undefined))).toBeNull()
  })
  it('HTTP:Authorization: Bearer', () => {
    expect(bearerFromAuthorization('Bearer x.y.z')).toBe('x.y.z')
    expect(bearerFromAuthorization('bearer x.y.z')).toBe('x.y.z')
    expect(bearerFromAuthorization('Basic abc')).toBeNull()
    expect(bearerFromAuthorization(undefined)).toBeNull()
  })
  it('presence 颜色按 userId 确定', () => {
    const id = '11111111-2222-4333-8444-555555555555'
    expect(colorFor(id)).toBe(colorFor(id))
    expect(colorFor(id)).toMatch(/^#[0-9a-f]{6}$/)
    expect(colorFor(id)).not.toBe(colorFor('11111111-2222-4333-8444-555555555556'))
  })
})

describe('files auth:验签', () => {
  const sub = '0b7c3f0e-1a2b-4c3d-8e4f-5a6b7c8d9e0f'
  let server: http.Server
  let jwksUrl: string
  let key: CryptoKey
  let other: CryptoKey
  const secret = new TextEncoder().encode('hs256-test-secret-hs256-test-secret')
  beforeAll(async () => {
    const pair = await jose.generateKeyPair('ES256', { extractable: true })
    key = pair.privateKey
    other = (await jose.generateKeyPair('ES256')).privateKey
    const jwk = { ...(await jose.exportJWK(pair.publicKey)), kid: 'k1', alg: 'ES256' }
    server = http.createServer((_req, res) => res.end(JSON.stringify({ keys: [jwk] })))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    jwksUrl = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}/jwks`
  })
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

  const es = (claims: jose.JWTPayload, signer: CryptoKey = key, exp: string | number = '1h') =>
    new jose.SignJWT(claims).setProtectedHeader({ alg: 'ES256', kid: 'k1' }).setExpirationTime(exp).sign(signer)
  const hs = (claims: jose.JWTPayload) => new jose.SignJWT(claims).setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h').sign(secret)

  it('JWKS(ES256):放行已登录用户;别的钥匙、过期、不是 authenticated、sub 不是 uuid 都拒', async () => {
    const verify = createVerifier({ jwksUrl, jwtSecret: null, jwtIssuer: null })
    await expect(verify(await es({ sub, role: 'authenticated' }))).resolves.toMatchObject({ userId: sub })
    await expect(verify(await es({ sub, role: 'authenticated' }, other))).rejects.toMatchObject({ reason: 'bad-credential', status: 401 })
    await expect(verify(await es({ sub, role: 'authenticated' }, key, Math.floor(Date.now() / 1000) - 60))).rejects.toMatchObject({ reason: 'bad-credential' })
    await expect(verify(await es({ sub, role: 'anon' }))).rejects.toMatchObject({ reason: 'bad-credential' })
    await expect(verify(await es({ sub: 'not-a-uuid', role: 'authenticated' }))).rejects.toMatchObject({ reason: 'bad-credential' })
    await expect(verify(null)).rejects.toMatchObject({ reason: 'bad-credential' })
  })

  it('HS256 只在配了密钥时认;没配就拒(不会拿 JWKS 公钥当 HMAC 密钥)', async () => {
    const token = await hs({ sub, role: 'authenticated' })
    await expect(createVerifier({ jwksUrl, jwtSecret: secret, jwtIssuer: null })(token)).resolves.toMatchObject({ userId: sub })
    await expect(createVerifier({ jwksUrl, jwtSecret: null, jwtIssuer: null })(token)).rejects.toMatchObject({ reason: 'bad-credential' })
  })

  it('配了 issuer 就核 iss', async () => {
    const verify = createVerifier({ jwksUrl, jwtSecret: null, jwtIssuer: 'https://devdb.example/auth/v1' })
    await expect(verify(await es({ sub, role: 'authenticated', iss: 'https://devdb.example/auth/v1' }))).resolves.toMatchObject({ userId: sub })
    await expect(verify(await es({ sub, role: 'authenticated', iss: 'https://elsewhere/auth/v1' }))).rejects.toMatchObject({ reason: 'bad-credential' })
  })
})

describe('files limits:令牌桶', () => {
  it('突发用完即拒,按速率回补,不超过突发上限', () => {
    let now = 0
    const b = new TokenBucket({ perSecond: 10, burst: 3 }, () => now)
    expect([b.take(), b.take(), b.take(), b.take()]).toEqual([true, true, true, false])
    now += 100 // 0.1 s × 10/s = 1 个
    expect([b.take(), b.take()]).toEqual([true, false])
    now += 60_000
    expect([b.take(3), b.take()]).toEqual([true, false])
    expect(b.take(0)).toBe(true)
  })
})

describe('files auth:代 agent 打开(子协议 as.<agentId>)', () => {
  it('不带 ⇒ 令牌主人本人;带一个 ⇒ 那个 agent(判不判得过交给 authorizeItem);两个或空的 ⇒ not-found', () => {
    expect(asAgentFromProtocols([SUBPROTOCOL, 'bearer.x'])).toBeNull()
    expect(asAgentFromProtocols([SUBPROTOCOL, 'bearer.x', 'as.0f2c'])).toBe('0f2c')
    expect(() => asAgentFromProtocols([SUBPROTOCOL, 'as.a', 'as.b'])).toThrow('not-found')
    expect(() => asAgentFromProtocols([SUBPROTOCOL, 'as.'])).toThrow('not-found')
  })
})
