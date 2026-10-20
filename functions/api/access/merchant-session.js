// Diagnóstico da sessão do lojista.

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
  if (!secret) return { error: 'SESSION_SECRET ausente.' }

  const cookieHeader = request.headers.get('cookie') || ''
  const cookie = cookieHeader
    .split(';')
    .map(part => part.trim())
    .find(part => part.startsWith(`${COOKIE}=`))

  if (!cookie) return { error: 'Cookie da sessão não encontrado.' }

  const value = cookie.slice(COOKIE.length + 1)
  const parts = value.split('.')

  if (parts.length !== 2) return { error: 'Cookie inválido.' }

  const [payload, signature] = parts

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
const expected = b64(
    new Uint8Array(
      await crypto.subtle.sign(
        'HMAC',
        key,
        new TextEncoder().encode(payload)
      )
    )
  )
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')

  if (expected !== signature) return { error: 'Assinatura da sessão inválida.' }

  try {
    const session = JSON.parse(new TextDecoder().decode(unb64(payload)))

    if (!session.merchantId) return { error: 'Sessão sem merchantId.' }
    if (!Number.isInteger(session.exp)) return { error: 'Sessão sem expiração.' }
    if (session.exp < Math.floor(Date.now() / 1000)) return { error: 'Sessão expirada.' }

    return { session }
  } catch (error) {
    return { error: 'Erro ao decodificar sessão: ' + String(error) }
  }
}

export async function onRequestGet(context) {
  try {
    const { env, request } = context

    const result = await verifySession(request, env)

    if (result.error) {
      return json({
        authenticated: false,
        debug: result.error
      }, 401)
    }

    const session = result.session

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
        debug: 'Erro no banco: ' + String(error && error.message ? error.message : error)
      }, 500)
    }

    if (!merchant) {
      return json({
        authenticated: false,
        debug: 'Lojista não encontrado no banco.'
      }, 401)
    }

    return json({
      authenticated: true,
      merchantId: String(merchant.id),
      merchant
    })
  } catch (error) {
    return json({
      authenticated: false,
      debug: 'Erro geral: ' + String(error && error.message ? error.message : error)
    }, 500)
  }
}

export { verifySession as verifyMerchantSession }
