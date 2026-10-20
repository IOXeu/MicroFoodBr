// Configuração da loja do lojista.
// Lê e salva store_settings, com bloqueio automático do teste de 7 dias.

import { verifyMerchantSession } from '../access/merchant-session.js'

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

function text(value, maxLength = 500) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
}

async function merchantAccess(env, merchantId) {
  const now = new Date().toISOString()
  const today = now.slice(0, 10)

  await env.DB.batch([
    env.DB.prepare(`
      UPDATE subscriptions
      SET status = 'past_due', updated_at = CURRENT_TIMESTAMP
      WHERE status = 'trial' AND trial_ends_at < ?1
    `).bind(now),

    env.DB.prepare(`
      UPDATE merchants
      SET status = 'suspended', updated_at = CURRENT_TIMESTAMP
      WHERE plan = 'trial'
        AND status = 'active'
        AND trial_ends_at < ?1
        AND id NOT IN (
          SELECT merchant_id
          FROM subscriptions
          WHERE status = 'active' AND paid_until >= ?2
        )
    `).bind(now, today),
  ])

  const row = await env.DB.prepare(`
    SELECT
      m.id,
      m.status AS merchant_status,
      m.trial_ends_at,
      s.status AS subscription_status,
      s.trial_ends_at AS subscription_trial_ends_at,
      s.paid_until
    FROM merchants m
    LEFT JOIN subscriptions s ON s.merchant_id = m.id
    WHERE m.id = ?1
  `).bind(Number(merchantId)).first()

  if (!row) {
    return {
      allowed: false,
      reason: 'Loja não encontrada.',
    }
  }

  const trialEnd = row.subscription_trial_ends_at || row.trial_ends_at
  const trialActive =
    row.subscription_status === 'trial' &&
    trialEnd &&
    trialEnd >= now

  const paidActive =
    row.subscription_status === 'active' &&
    row.paid_until &&
    row.paid_until >= today

  if (paidActive) {
    return { allowed: true, access: 'assinatura' }
  }

  if (trialActive) {
    return { allowed: true, access: 'teste' }
  }

  return {
    allowed: false,
    reason:
      row.subscription_status === 'trial'
        ? 'Teste de 7 dias encerrado. Ative a assinatura para continuar.'
        : 'Assinatura inativa. Ative a assinatura para continuar.',
  }
}

export async function onRequestGet(context) {
  const { env, request } = context

  const session = await verifyMerchantSession(request, env)

  if (!session) {
    return json({ error: 'Faça login como lojista.' }, 401)
  }

  const access = await merchantAccess(env, session.merchantId)

  if (!access.allowed) {
    return json({ error: access.reason, blocked: true }, 402)
  }

  const settings = await env.DB.prepare(`
    SELECT *
    FROM store_settings
    WHERE merchant_id = ?1
  `).bind(String(session.merchantId)).first()

  return json({
    settings: settings || null,
    access: access.access,
  })
}

export async function onRequestPut(context) {
  const { env, request } = context

  const session = await verifyMerchantSession(request, env)

  if (!session) {
    return json({ error: 'Faça login como lojista.' }, 401)
  }

  const access = await merchantAccess(env, session.merchantId)

  if (!access.allowed) {
    return json({ error: access.reason, blocked: true }, 402)
  }

  let body
  try {
    body = await request.json()
  } catch {
    return json({ error: 'Corpo inválido.' }, 400)
  }

  const storeName = text(body.storeName, 120)
  const description = text(body.description, 1000)
  const whatsapp = text(body.whatsappNumber, 30).replace(/\D/g, '')
  const announcement = text(body.announcement, 300)
  const cover = text(body.coverImageUrl, 500)
  const logo = text(body.logoUrl, 500)
  const primaryColor = /^#[0-9a-fA-F]{6}$/.test(body.primaryColor || '')
    ? body.primaryColor
    : '#e63946'

  const pickupEnabled = body.pickupEnabled === true ? 1 : 0
  const deliveryEnabled = body.deliveryEnabled === true ? 1 : 0
  const isPublished = body.isPublished === true ? 1 : 0

  if (!storeName) {
    return json({ error: 'Informe o nome da loja.' }, 400)
  }

  if (whatsapp && whatsapp.length < 10) {
    return json({ error: 'Informe um WhatsApp válido.' }, 400)
  }

  await env.DB.prepare(`
    INSERT INTO store_settings (
      merchant_id,
      store_name,
      description,
      cover_image_url,
      logo_url,
      primary_color,
      whatsapp_number,
      announcement,
      pickup_enabled,
      delivery_enabled,
      is_published,
      updated_at
    )
    VALUES (
      ?1, ?2, ?3, ?4, ?5,
      ?6, ?7, ?8, ?9, ?10,
      ?11, datetime('now')
    )
    ON CONFLICT(merchant_id) DO UPDATE SET
      store_name = excluded.store_name,
      description = excluded.description,
      cover_image_url = excluded.cover_image_url,
      logo_url = excluded.logo_url,
      primary_color = excluded.primary_color,
      whatsapp_number = excluded.whatsapp_number,
      announcement = excluded.announcement,
      pickup_enabled = excluded.pickup_enabled,
      delivery_enabled = excluded.delivery_enabled,
      is_published = excluded.is_published,
      updated_at = datetime('now')
  `).bind(
    String(session.merchantId),
    storeName,
    description,
    cover,
    logo,
    primaryColor,
    whatsapp,
    announcement,
    pickupEnabled,
    deliveryEnabled,
    isPublished
  ).run()

  return json({
    ok: true,
    access: access.access,
  })
}
