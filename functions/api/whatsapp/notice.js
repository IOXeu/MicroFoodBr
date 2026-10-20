// Envia avisos pelo WhatsApp Cloud API.
// Se a API não estiver configurada, retorna um link wa.me como alternativa.

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
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
  const to = String(body.to || '').replace(/\D/g, '')
  const message = String(body.message || '').trim()

  if (!merchantId || to.length < 12 || !message) {
    return json({ error: 'Informe cadastro, número completo e mensagem.' }, 400)
  }

  const token = env.WHATSAPP_TOKEN
  const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID

  if (!token || !phoneNumberId) {
    return json({
      sent: false,
      reason: 'WhatsApp Cloud API não configurada.',
      fallbackUrl: `https://wa.me/${to}?text=${encodeURIComponent(message)}`,
    })
  }

  const response = await fetch(
    `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: {
          body: message,
        },
      }),
    }
  )

  const data = await response.json().catch(() => ({}))

  if (!response.ok) {
    return json({
      sent: false,
      error: data?.error?.message || `Falha no envio (${response.status})`,
    }, 502)
  }

  return json({
    sent: true,
    messageId: data?.messages?.[0]?.id || null,
  })
}
