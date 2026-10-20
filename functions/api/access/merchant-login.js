// Login do lojista usando merchant_users e sessão assinada com SESSION_SECRET.

const COOKIE = 'mf_merchant_session'
const SESSION_SECONDS = 8 * 60 * 60

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...extraHeaders,
    },
  })
}

function b64(bytes) {
  let text = ''
  for (const byte of bytes) text += String.fromCharCode(byte)
  return btoa(text)
}

function unb64(value) {
  const normalized = value
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    + '='.repeat((4 - value.length % 4) % 4)

  const binary = atob(normalized)
  return Uint8Array.from(binary, character => character.charCodeAt(0))
}

async function signPayload(payload, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )

  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(payload)
  )

  return b64(new Uint8Array(signature))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
}

async function verifyPassword(password, storedHash) {
  const [algorithm, iterations, salt, hash] = String(storedHash || '').split('$')

  if (algorithm !== 'pbkdf2-sha256' || !iterations || !salt || !hash) {
    return false
  }

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  )

  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: unb64(salt),
      iterations: Number(iterations),
      hash: 'SHA-256',
    },
    key,
    256
  )

  const calculated = b64(new Uint8Array(bits))

  if (calculated.length !== hash.length) return false

  let difference = 0
  for (let i = 0; i < calculated.length; i++) {
    difference |= calculated.charCodeAt(i) ^ hash.charCodeAt(i)
  }

  return difference === 0
}

export async function onRequestPost(context) {
  const { env, request } = context

  const secret = env.SESSION_SECRET
  if (!secret) {
    return json({ error: 'SESSION_SECRET não configurada.' }, 500)
  }

  let body
  try {
    body = await request.json()
  } catch {
    return json({ error: 'Corpo inválido.' }, 400)
  }

  const email = String(body.email || '').trim().toLowerCase()
  const password = String(body.password || '')

  if (!email || !password) {
    return json({ error: 'Informe e-mail e senha.' }, 400)
  }

  const user = await env.DB.prepare(`
    SELECT
      u.id,
      u.merchant_id,
      u.password_hash,
      u.active,
      m.business_name
    FROM merchant_users u
    JOIN merchants m ON m.id = u.merchant_id
    WHERE u.email = ?1
  `).bind(email).first()

  if (!user || !user.active || !(await verifyPassword(password, user.password_hash))) {
    return json({ error: 'E-mail ou senha incorretos.' }, 401)
  }

  const payload = b64(
    new TextEncoder().encode(
      JSON.stringify({
        merchantId: String(user.merchant_id),
        email,
        exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS,
      })
    )
  )
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')

  const signature = await signPayload(payload, secret)
  const cookie = `${COOKIE}=${payload}.${signature}; Path=/; Max-Age=${SESSION_SECONDS}; Secure; HttpOnly; SameSite=Strict`

  await env.DB.prepare(`
    UPDATE merchant_users
    SET last_login_at = datetime('now')
    WHERE id = ?1
  `).bind(user.id).run()

  return json(
    {
      ok: true,
      merchantId: String(user.merchant_id),
      storeName: user.business_name,
    },
    200,
    { 'set-cookie': cookie }
  )
}
