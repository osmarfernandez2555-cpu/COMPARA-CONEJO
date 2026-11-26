// ═══════════════════════════════════════════════════════════════════════════
//  PROMO 100% FINANCIADO (landing promos-0km): Fiat Cronos, Argo y Strada, 50 cupos
//
//  La landing es pública: estas rutas no piden clave, pero tienen límite por IP.
//  Cada consulta abre un pedido en calificaciones_kommo con origen 'promo-100', así aparece
//  en "Pedidos Bancos" y lo resuelve la consulta automática de kommo-webhook.js usando SOLO
//  Bancor y Nación (ver bancosDe()). Al cliente nunca le llega el banco ni el monto.
//
//    POST /api/promo100/calificar   {cuit, auto, telefono, dni?, genero?}  -> {estado: 'pendiente', id}
//    GET  /api/promo100/estado/:id  -> {estado: 'pendiente'|'aprobado'|'rechazado'|'revision'}
//    GET  /api/promo100/resumen     -> totales, volumen por auto y la lista (pestaña "Promos 0km" de Pedidos Bancos)
//
//  Los "50 cupos" de la landing son fijos (estrategia comercial): acá no se cuentan ni se descuentan.
//
//  Variables opcionales en Railway:
//    PROMO100_MAX_POR_IP   consultas por hora por IP (por defecto 8)
//    PROMO100_MONTO_MIN    monto mínimo aprobado (Bancor o Nación) para entrar a la promo; por defecto 6000000
//    PROMO100_PANEL_KEY    clave que pide la pestaña "Promos 0km" de Ruthina para ver la lista (recomendada)
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

  // estado del pedido traducido para la landing (solo Bancor y Nación cuentan)
  // Para entrar a la promo, Bancor o Nación tienen que aprobar MÁS de PROMO100_MONTO_MIN (por defecto $ 6.000.000).
  //   aprobado: algún banco aprobó más del mínimo → "Felicitaciones"
  //   rechazado: rechazaron, o aprobaron por menos del mínimo → "probá con otro DNI"
  //   revision: aprobaron sin informar monto, o ningún banco contestó a tiempo → "un asesor revisa tu caso"
  const MONTO_MIN = Math.max(0, Number(String(process.env.PROMO100_MONTO_MIN || '6000000').replace(/\D/g, '')) || 6000000)
  function estadoLanding(c) {
    if (!c) return 'revision'
    if (['pendiente', 'en_proceso'].includes(c.estado)) return 'pendiente'
    if (c.estado !== 'resuelto') return 'revision'               // descartado a mano
    const r = c.resultados || {}
    const bancos = ['bancor', 'nacion'].map(k => r[k] || {})
    const aprob = bancos.filter(x => x.estado === 'aprobado')
    const monto = x => Number(soloDigitos(x.monto)) || 0
    if (aprob.some(x => monto(x) > MONTO_MIN)) return 'aprobado'
    if (aprob.some(x => !monto(x))) return 'revision'            // aprobó pero sin monto: que lo vea un asesor
    if (aprob.length) return 'rechazado'                         // aprobó por menos del mínimo
    if (bancos.some(x => x.estado === 'rechazado')) return 'rechazado'
    return 'revision'                                            // ningún banco contestó a tiempo
  }

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

  // Panel de Ruthina (Pedidos Bancos → pestaña "Promos 0km"): todas las consultas de la landing con su resultado
  //   GET /api/promo100/resumen   -> { totales: {total, aprobados, rechazados, pendientes, revision}, por_auto: {...}, pedidos: [...] }
  // Lista con CUIL y teléfonos: si PROMO100_PANEL_KEY está cargada en Railway, se pide en el header x-panel-key
  app.get('/api/promo100/resumen', async (req, res) => {
    const clave = String(process.env.PROMO100_PANEL_KEY || '').trim()
    if (clave && String(req.get('x-panel-key') || '').trim() !== clave) return res.status(401).json({ error: 'Clave del panel incorrecta' })
    try {
      const r = await pool.query(
        `SELECT DISTINCT ON (c.id) c.*, p.id AS promo_id, p.auto AS promo_auto, p.telefono AS promo_tel, p.dni AS promo_dni,
                p.created_at AS promo_at
           FROM promo100_solicitudes p JOIN calificaciones_kommo c ON c.id = p.pedido_id
          ORDER BY c.id DESC, p.id DESC
          LIMIT 1000`)
      const pedidos = r.rows.map(x => Object.assign(x, { estado_promo: estadoLanding(x) }))
        .sort((a, b) => new Date(b.promo_at) - new Date(a.promo_at))
      const totales = { total: pedidos.length, aprobados: 0, rechazados: 0, pendientes: 0, revision: 0 }
      const por_auto = {}
      pedidos.forEach(x => {
        const k = { aprobado: 'aprobados', rechazado: 'rechazados', pendiente: 'pendientes', revision: 'revision' }[x.estado_promo]
        totales[k]++
        const a = x.promo_auto || x.auto || '(sin auto)'
        por_auto[a] = por_auto[a] || { total: 0, aprobados: 0 }
        x.monto_minimo = MONTO_MIN
        por_auto[a].total++
        if (x.estado_promo === 'aprobado') por_auto[a].aprobados++
      })
      res.json({ totales, por_auto, pedidos })
    } catch (e) { res.status(500).json({ error: e.message }) }
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
