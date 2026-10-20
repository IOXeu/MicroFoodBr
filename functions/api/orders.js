// Cria pedidos da loja virtual.
// Bloqueia pedidos quando o teste de 7 dias expira ou a assinatura está inativa.

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

function money(cents) {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(cents / 100)
}

async function merchantCanReceiveOrders(env, merchantId) {
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

  const access = await env.DB.prepare(`
    SELECT
      m.status AS merchant_status,
      m.trial_ends_at,
      s.status AS subscription_status,
      s.trial_ends_at AS subscription_trial_ends_at,
      s.paid_until
    FROM merchants m
    LEFT JOIN subscriptions s ON s.merchant_id = m.id
    WHERE m.id = ?1
  `).bind(Number(merchantId)).first()

  if (!access) {
    return {
      allowed: false,
      reason: 'Loja não encontrada.',
    }
  }

  const trialEnd = access.subscription_trial_ends_at || access.trial_ends_at
  const trialActive =
    access.subscription_status === 'trial' &&
    trialEnd &&
    trialEnd >= now

  const paidActive =
    access.subscription_status === 'active' &&
    access.paid_until &&
    access.paid_until >= today

  if (paidActive) {
    return { allowed: true }
  }

  if (trialActive) {
    return { allowed: true }
  }

  return {
    allowed: false,
    reason: 'Teste encerrado ou assinatura inativa. A loja não pode receber pedidos.',
  }
}

export async function onRequestPost(context) {
  const { env, request } = context

  let body
  try {
    body = await request.json()
  } catch {
    return json({ error: 'Corpo inválido.' }, 400)
  }

  const merchantId = String(body.merchantId || '')
  const qrCode = String(body.qrCode || '')
  const tableNumber = String(body.tableNumber || '').trim()
  const customerName = String(body.customerName || '').trim()
  const items = Array.isArray(body.items) ? body.items : []
  const orderType = body.orderType === 'delivery' ? 'delivery' : 'pickup'

  if (!merchantId || !items.length) {
    return json({ error: 'Pedido inválido.' }, 400)
  }

  const store = await env.DB.prepare(`
    SELECT *
    FROM store_settings
    WHERE merchant_id = ?1 AND is_published = 1
  `).bind(merchantId).first()

  if (!store) {
    return json({ error: 'Loja não disponível.' }, 404)
  }

  const access = await merchantCanReceiveOrders(env, merchantId)

  if (!access.allowed) {
    return json({ error: access.reason, blocked: true }, 402)
  }

  if (qrCode) {
    const table = await env.DB.prepare(`
      SELECT table_number
      FROM store_tables
      WHERE merchant_id = ?1
        AND code = ?2
        AND is_active = 1
    `).bind(merchantId, qrCode).first()

    if (!table) {
      return json({ error: 'Mesa inválida.' }, 403)
    }
  }

  let total = 0
  const lines = []

  for (const item of items) {
    const product = await env.DB.prepare(`
      SELECT name, price_cents
      FROM store_products
      WHERE id = ?1
        AND merchant_id = ?2
        AND is_active = 1
    `).bind(String(item.id || ''), merchantId).first()

    if (!product) continue

    const quantity = Math.max(1, Math.min(50, Number(item.qty) || 1))
    const subtotal = product.price_cents * quantity

    total += subtotal
    lines.push(`${quantity}x ${product.name} — ${money(subtotal)}`)
  }

  if (!lines.length) {
    return json({ error: 'Nenhum item válido no pedido.' }, 400)
  }

  let courierId = null
  let courierFee = 0
  let distance = null

  if (orderType === 'delivery') {
    courierId = body.courierId ? String(body.courierId) : null
    courierFee = Math.max(0, Math.round(Number(body.courierFeeCents) || 0))
    distance = body.distanceKm != null ? Number(body.distanceKm) : null

    if (!courierId) {
      return json({ error: 'Escolha um entregador para a entrega.' }, 400)
    }

    const courier = await env.DB.prepare(`
      SELECT
        id,
        display_name,
        base_fee_cents,
        base_distance_km,
        extra_fee_per_km_cents,
        max_distance_km
      FROM couriers
      WHERE id = ?1 AND is_active = 1
    `).bind(courierId).first()

    if (!courier) {
      return json({ error: 'Entregador indisponível.' }, 404)
    }

    const expectedFee =
      distance != null && distance <= courier.base_distance_km
        ? courier.base_fee_cents
        : courier.base_fee_cents +
          Math.ceil((distance || 0) - courier.base_distance_km) *
          courier.extra_fee_per_km_cents

    if (courierFee !== expectedFee) {
      return json({ error: 'Valor da entrega inválido. Consulte novamente.' }, 400)
    }

    total += courierFee
  }

  const orderId = crypto.randomUUID()

  await env.DB.prepare(`
    INSERT INTO store_orders (
      id,
      merchant_id,
      table_number,
      customer_name,
      items_json,
      total_cents,
      order_type,
      status,
      courier_id,
      courier_fee_cents,
      distance_km,
      delivery_cep
    )
    VALUES (
      ?1, ?2, ?3, ?4, ?5,
      ?6, ?7, 'sent', ?8, ?9,
      ?10, ?11
    )
  `).bind(
    orderId,
    merchantId,
    tableNumber,
    customerName,
    JSON.stringify(lines),
    total,
    orderType,
    courierId,
    courierFee,
    distance,
    String(body.deliveryCep || '').replace(/\D/g, '')
  ).run()

  const message = [
    `*${store.store_name || 'Novo pedido'}`,
    tableNumber
      ? `Mesa: ${tableNumber}`
      : orderType === 'pickup'
        ? 'Retirada na loja'
        : 'Entrega',
    customerName ? `Cliente: ${customerName}` : '',
    ...lines,
    '',
  ]

  if (orderType === 'delivery' && courierFee) {
    message.push(
      `Entrega: ${money(courierFee)}${distance ? ` (${distance} km)` : ''}`
    )
  }

  message.push(`*Total: ${money(total)}*`)

  const whatsapp = String(store.whatsapp_number || '').replace(/\D/g, '')

  if (!whatsapp) {
    return json({
      ok: true,
      orderId,
      whatsappUrl: null,
      message: 'Loja sem WhatsApp configurado.',
    })
  }

  return json({
    ok: true,
    orderId,
    whatsappUrl: `https://wa.me/${whatsapp}?text=${encodeURIComponent(message.join('\n'))}`,
  })
}
