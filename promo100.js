// ═══════════════════════════════════════════════════════════════════════════
//  PROMO 100% FINANCIADO (landing promos-0km): Fiat Cronos, Argo y Strada, 50 cupos
//
//  La landing es pública: estas rutas no piden clave, pero tienen límite por IP.
//  Cada consulta abre un pedido en calificaciones_kommo con origen 'promo-100', así aparece
//  en "Pedidos Bancos" y lo resuelve la consulta automática de kommo-webhook.js usando SOLO
//  Bancor y Nación (ver bancosDe()). Al cliente nunca le llega el banco ni el monto.
//
//    POST /api/promo100/calificar   {cuit, auto, telefono, dni?, genero?}
//         -> {estado: 'pendiente', id} | {estado: 'agotado'}
//    GET  /api/promo100/estado/:id  -> {estado: 'pendiente'|'aprobado'|'rechazado'|'revision'}
//    GET  /api/promo100/cupos       -> {total, restantes}
//
//  Variables opcionales en Railway:
//    PROMO100_CUPOS        (por defecto 50)
//    PROMO100_MAX_POR_IP   consultas por hora por IP (por defecto 8)
// ═══════════════════════════════════════════════════════════════════════════
const express = require('express')

const AUTOS = {
  cronos: 'Fiat Cronos Drive 1.3',
  argo: 'Fiat Argo Drive MT',
  strada: 'Fiat Strada Freedom CD 1.3'
}
const soloDigitos = s => String(s || '').replace(/\D/g, '')
function validarCuil(c) {
  if (!/^\d{11}$/.test(c)) return false
  const w = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2]
  let dv = 11 - (w.reduce((a, x, i) => a + x * Number(c[i]), 0) % 11)
  if (dv === 11) dv = 0
  if (dv === 10) dv = 9
  return dv === Number(c[10])
}

module.exports = function registrarPromo100(app, pool, kommoMod) {
  const TOTAL = Math.max(1, Number(process.env.PROMO100_CUPOS || 50))
  const MAX_IP = Math.max(1, Number(process.env.PROMO100_MAX_POR_IP || 8))

  pool.query(`CREATE TABLE IF NOT EXISTS promo100_solicitudes (
    id SERIAL PRIMARY KEY,
    pedido_id INTEGER NOT NULL,
    cuil TEXT NOT NULL,
    dni TEXT DEFAULT '',
    genero TEXT DEFAULT '',
    auto TEXT DEFAULT '',
    telefono TEXT DEFAULT '',
    ip TEXT DEFAULT '',
    created_at TIMESTAMP DEFAULT NOW()
  )`).then(() => console.log('✅ Promo 100% financiado lista: /api/promo100/*'))
    .catch(e => console.error('promo100 tabla:', e.message))

  // límite por IP (en memoria; alcanza para frenar a alguien que quiera consultar CUITs en masa)
  const hits = new Map()
  function limitar(req, res, next) {
    const ip = String(req.get('x-forwarded-for') || req.ip || '').split(',')[0].trim()
    const ahora = Date.now()
    const lista = (hits.get(ip) || []).filter(t => ahora - t < 3600000)
    if (lista.length >= MAX_IP) return res.status(429).json({ error: 'Demasiadas consultas. Probá de nuevo en un rato.' })
    lista.push(ahora); hits.set(ip, lista); req._ip = ip
    next()
  }

  // aprobados en la promo = CUILs distintos con Bancor o Nación aprobado
  const SQL_APROBADO = `(c.resultados->'bancor'->>'estado' = 'aprobado' OR c.resultados->'nacion'->>'estado' = 'aprobado')`
  async function restantes() {
    const r = await pool.query(
      `SELECT COUNT(DISTINCT p.cuil)::int n FROM promo100_solicitudes p
         JOIN calificaciones_kommo c ON c.id = p.pedido_id
        WHERE c.estado = 'resuelto' AND ${SQL_APROBADO}`)
    return Math.max(0, TOTAL - r.rows[0].n)
  }

  // estado del pedido traducido para la landing (solo Bancor y Nación cuentan)
  function estadoLanding(c) {
    if (!c) return 'revision'
    if (['pendiente', 'en_proceso'].includes(c.estado)) return 'pendiente'
    if (c.estado !== 'resuelto') return 'revision'               // descartado a mano
    const r = c.resultados || {}
    const est = k => (r[k] && r[k].estado) || 'no_consultado'
    if (est('bancor') === 'aprobado' || est('nacion') === 'aprobado') return 'aprobado'
    if (est('bancor') === 'rechazado' || est('nacion') === 'rechazado') return 'rechazado'
    return 'revision'                                             // ningún banco contestó a tiempo
  }

  app.get('/api/promo100/cupos', async (req, res) => {
    try { res.json({ total: TOTAL, restantes: await restantes() }) }
    catch (e) { res.status(500).json({ error: e.message }) }
  })

  app.post('/api/promo100/calificar', express.json({ limit: '50kb' }), limitar, async (req, res) => {
    try {
      const b = req.body || {}
      const cuil = soloDigitos(b.cuit)
      const autoKey = String(b.auto || '').toLowerCase()
      const telefono = soloDigitos(b.telefono).slice(0, 15)
      const dni = soloDigitos(b.dni).slice(0, 8)
      const genero = b.genero === 'F' || b.genero === 'M' ? b.genero : ''
      if (!validarCuil(cuil)) return res.status(400).json({ error: 'CUIT o CUIL inválido' })
      if (!AUTOS[autoKey]) return res.status(400).json({ error: 'Auto inválido' })
      if (telefono.length < 8) return res.status(400).json({ error: 'Teléfono inválido' })
      if (await restantes() <= 0) return res.json({ estado: 'agotado' })
      const auto = AUTOS[autoKey]

      // mismo CUIL en las últimas 24 h por la landing: se devuelve esa consulta (no se vuelve a los bancos)
      const prev = await pool.query(
        `SELECT p.id FROM promo100_solicitudes p WHERE p.cuil=$1 AND p.created_at > NOW() - INTERVAL '24 hours' ORDER BY p.id DESC LIMIT 1`, [cuil])
      if (prev.rows.length) return res.json({ estado: 'pendiente', id: prev.rows[0].id })

      // ¿ya hay un pedido abierto para este CUIL (Kommo, ARA, Tutu+…)? se engancha a ese y no se duplica
      const abierto = await pool.query(
        `SELECT id FROM calificaciones_kommo WHERE cuil=$1 AND estado IN ('pendiente','en_proceso') ORDER BY created_at DESC LIMIT 1`, [cuil])
      let pedidoId
      if (abierto.rows.length) {
        pedidoId = abierto.rows[0].id
        await pool.query(
          `UPDATE calificaciones_kommo SET observaciones=TRIM(BOTH E'\\n' FROM COALESCE(observaciones,'') || E'\\n' || $1), updated_at=NOW() WHERE id=$2`,
          [`También pidió la promo 100% financiado (landing): ${auto} · Tel ${telefono}`, pedidoId])
      } else {
        const ins = await pool.query(
          `INSERT INTO calificaciones_kommo (cuil, cuil_valido, nombre, telefono, auto, origen, externo_id, estado, observaciones)
           VALUES ($1, true, $2, $3, $4, 'promo-100', $5, 'pendiente', $6) RETURNING id`,
          [cuil, 'Promo 100% · ' + (dni ? 'DNI ' + dni : 'CUIL ' + cuil), telefono, auto,
           'promo100:' + Date.now(), `Promo 100% financiado (landing) · ${auto} · Tel ${telefono}`])
        pedidoId = ins.rows[0].id
      }
      const sol = await pool.query(
        `INSERT INTO promo100_solicitudes (pedido_id, cuil, dni, genero, auto, telefono, ip) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [pedidoId, cuil, dni, genero, auto, telefono, req._ip || ''])

      // que la consulta automática lo levante ya
      if (kommoMod && typeof kommoMod.cicloAuto === 'function') setTimeout(() => kommoMod.cicloAuto(), 300)
      console.log(`[promo100] CUIL ${cuil} · ${auto} → pedido ${pedidoId}`)
      res.json({ estado: 'pendiente', id: sol.rows[0].id })
    } catch (e) {
      console.error('[promo100] calificar:', e.message)
      res.status(500).json({ error: 'No se pudo registrar la consulta' })
    }
  })

  app.get('/api/promo100/estado/:id', async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT c.* FROM promo100_solicitudes p JOIN calificaciones_kommo c ON c.id = p.pedido_id WHERE p.id=$1`,
        [Number(req.params.id) || 0])
      if (!r.rows.length) return res.status(404).json({ error: 'No existe' })
      res.json({ estado: estadoLanding(r.rows[0]) })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })
}
