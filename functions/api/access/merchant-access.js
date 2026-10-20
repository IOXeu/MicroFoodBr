// Administrador cria ou redefine o acesso do lojista
// somente após pagamento confirmado pelo Mercado Pago.

const ITERATIONS = 210000

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

function generatePassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return 'Mfbr-' + Array.from(bytes, byte => alphabet[byte % alphabet.length]).join('')
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16))
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
      salt,
      iterations: ITERATIONS,
      hash: 'SHA-256',
    },
    key,
    256
  )

  return ['pbkdf2-sha256', ITERATIONS, b64(salt), b64(new Uint8Array(bits))].join('$')
}

async function requireAdmin(env, request) {
  const expected = env.ADMIN_TOKEN
  if (!expected) return false

  const provided =
    request.headers.get('x-admin-token') ||
    request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ||
    ''

  if (!provided || provided.length !== expected.length) return false

  const left = new TextEncoder().encode(provided)
  const right = new TextEncoder().encode(expected)
  let difference = 0

  for (let i = 0; i < left.length; i++) {
    difference |= left[i] ^ right[i]
  }

  return difference === 0
}

export async function onRequestPost(context) {
  const { env, request } = context

  if (!(await requireAdmin(env, request))) {
    return json({ error: 'Não autorizado.' }, 401)
  }

  let body
  try {
    body = await request.json()
  } catch {
    return json({ error: 'Corpo inválido.' }, 400)
  }

  const merchantId = String(body.merchantId || '').trim()
  if (!merchantId) {
    return json({ error: 'Informe o cadastro.' }, 400)
  }

  const merchant = await env.DB.prepare(
    'SELECT id, business_name, email FROM merchants WHERE id = ?1'
  ).bind(merchantId).first()

  if (!merchant) {
    return json({ error: 'Cadastro não encontrado.' }, 404)
  }

  const subscription = await env.DB.prepare(
    'SELECT status, paid_until FROM subscriptions WHERE merchant_id = ?1'
  ).bind(merchantId).first()

  if (!subscription || subscription.status !== 'active') {
    return json({
      error: 'Bloqueado: não há pagamento aprovado confirmado. O retorno do checkout não libera acesso.',
    }, 409)
  }

  const email = String(merchant.email || '').toLowerCase()
  if (!email) {
    return json({ error: 'O cadastro não possui e-mail para criar o acesso.' }, 400)
  }

  const temporaryPassword = generatePassword()
  const passwordHash = await hashPassword(temporaryPassword)

  const existing = await env.DB.prepare(
    'SELECT id FROM merchant_users WHERE merchant_id = ?1'
  ).bind(merchantId).first()

  if (existing) {
    await env.DB.prepare(`
      UPDATE merchant_users
      SET email = ?2, password_hash = ?3, active = 1
      WHERE merchant_id = ?1
    `).bind(merchantId, email, passwordHash).run()
  } else {
    await env.DB.prepare(`
      INSERT INTO merchant_users (merchant_id, email, password_hash, active)
      VALUES (?1, ?2, ?3, 1)
    `).bind(merchantId, email, passwordHash).run()
  }

  return json({
    merchantId,
    email,
    temporaryPassword,
    source: 'mercadopago-webhook',
    note: 'Acesso liberado por pagamento aprovado confirmado.',
  })
}
