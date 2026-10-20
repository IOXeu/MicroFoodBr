// Verifica a sessão do lojista usando o cookie assinado com SESSION_SECRET.

const COOKIE = 'mf_merchant_session'

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
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

async function verifySession(request, env) {
  const secret = env.SESSION_SECRET
  if (!secret) return null

  const cookieHeader = request.headers.get('cookie') || ''
  const cookie = cookieHeader
    .split(';')
    .map(part => part.trim())
    .find(part => part.startsWith(`${COOKIE}=`))

  if (!cookie) return null

  const value = cookie.slice(COOKIE.length + 1)
  const [payload, signature] = value.split('.')

  if (!payload || !signature || value.split('.').length !== 2) {
    return null
  }

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )

  const expected = b64(
    await crypto.subtle.sign(
      'HMAC',
      key,
      new TextEncoder().encode(payload)
    )
  )
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')

  if (expected !== signature) return null

  try {
    const session = JSON.parse(new TextDecoder().decode(unb64(payload)))

    if (!session.merchantId) return null
    if (!Number.isInteger(session.exp)) return null
    if (session.exp < Math.floor(Date.now() / 1000)) return null

    return session
  } catch {
    return null
  }
}

export async function onRequestGet(context) {
  const { env, request } = context

  const session = await verifySession(request, env)

  if (!session) {
    return json({ authenticated: false }, 401)
  }

  let merchant

  try {
    merchant = await env.DB.prepare(`
      SELECT
        m.id,
        m.business_name,
        m.status,
        m.trial_ends_at,
        s.status AS subscription_status,
        s.trial_ends_at AS subscription_trial_ends_at,
        s.paid_until
      FROM merchants m
      LEFT JOIN subscriptions s ON s.merchant_id = m.id
      WHERE m.id = ?1
    `).bind(Number(session.merchantId)).first()
  } catch (error) {
    return json({
      authenticated: false,
      debug_error: String(error && error.message ? error.message : error)
    }, 500)
  }

  if (!merchant) {
    return json({ authenticated: false }, 401)
  }

  return json({
    authenticated: true,
    merchantId: String(merchant.id),
    merchant,
  })
}

export { verifySession as verifyMerchantSession }
