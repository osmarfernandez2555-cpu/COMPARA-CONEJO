// ═══════════════════════════════════════════════════════════════════════════
//  CLUB DE REFERIDOS — Tutu Automotores
// ───────────────────────────────────────────────────────────────────────────
//  Landing pública:   GET  /referidos            (public/referidos.html)
//  Bases y cond.:     GET  /referidos/bases      (public/referidos-bases.html)
//  Panel interno:     GET  /referidos/admin      (public/referidos-admin.html)
//
//  API pública:
//    POST /api/referidos                 carga un referido (lo usa la landing)
//  API del panel (header  x-referidos-pass: <REFERIDOS_PANEL_PASS>):
//    GET   /api/referidos?estado=&q=     lista
//    PATCH /api/referidos/:id            { estado, notas, vendedor }
//    GET   /api/referidos.csv?pass=...   exporta a Excel/CSV
//
//  Variables de entorno (Railway → Variables del servicio de Ruthina):
//    REFERIDOS_PANEL_PASS   contraseña del panel                      [obligatoria para el panel]
//    REFERIDOS_INICIO       inicio de la campaña  (def: 2026-11-12T00:00:00-03:00)
//    REFERIDOS_FIN          fin de la campaña     (def: 2026-12-31T23:59:59-03:00)
//    REFERIDOS_MADURACION_DIAS  días que tiene el referido para comprar (def: 60)
//    REFERIDOS_TOPE_REFERENTE   beneficios máximos por referente (def: 5)
//    REFERIDOS_TOPE_TOTAL       beneficios máximos en toda la campaña (def: 10)
//    REFERIDOS_DIAS_DUPLICADO   opcional: si se pone, un comprador se puede volver a referir pasados esos días.
//                               Sin esto, un comprador ya cargado (y no descartado) no se puede volver a cargar.
//
//  Reglas tomadas de los Términos y Condiciones de la campaña (TyC - Campaña Referidos).
//
//  Estados: nuevo → contactado → en_gestion → vendido → pagado   |  descartado
// ═══════════════════════════════════════════════════════════════════════════

const path = require('path')
const crypto = require('crypto')

const ESTADOS = ['nuevo', 'contactado', 'en_gestion', 'vendido', 'pagado', 'descartado']
const PREMIO = 100000
const env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k])
const INICIO = new Date(env('REFERIDOS_INICIO', '2026-11-12T00:00:00-03:00'))
const FIN = new Date(env('REFERIDOS_FIN', '2026-12-31T23:59:59-03:00'))
const MADURACION = parseInt(env('REFERIDOS_MADURACION_DIAS', '60'), 10) || 60
const TOPE_REF = parseInt(env('REFERIDOS_TOPE_REFERENTE', '5'), 10) || 5
const TOPE_TOTAL = parseInt(env('REFERIDOS_TOPE_TOTAL', '10'), 10) || 10

module.exports = function (app, pool) {
  // ── tabla ────────────────────────────────────────────────────────────────
  pool.query(`
    CREATE TABLE IF NOT EXISTS referidos (
      id               SERIAL PRIMARY KEY,
      creado           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      actualizado      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      estado           TEXT NOT NULL DEFAULT 'nuevo',
      ref_nombre       TEXT NOT NULL,
      ref_tel          TEXT NOT NULL,
      ref_tel_norm     TEXT NOT NULL,
      ref_dni          TEXT,
      ref_email        TEXT,
      ref_alias        TEXT,
      comp_nombre      TEXT NOT NULL,
      comp_tel         TEXT NOT NULL,
      comp_tel_norm    TEXT NOT NULL,
      comp_email       TEXT,
      comp_localidad   TEXT,
      marca            TEXT,
      modelo           TEXT,
      anio             TEXT,
      moneda           TEXT,
      presupuesto      BIGINT,
      entrega          TEXT,
      usado_marca_modelo TEXT,
      usado_anio       TEXT,
      usado_km         INTEGER,
      financia         TEXT,
      comp_dni         TEXT,
      garantes         JSONB NOT NULL DEFAULT '[]'::jsonb,
      comentarios      TEXT,
      origen           TEXT,
      vendedor         TEXT,
      notas            TEXT,
      pagado_en        TIMESTAMPTZ,
      ip               TEXT
    )`)
    .then(() => pool.query(`ALTER TABLE referidos ADD COLUMN IF NOT EXISTS ref_dni TEXT,
                                                   ADD COLUMN IF NOT EXISTS ref_email TEXT,
                                                   ADD COLUMN IF NOT EXISTS comp_email TEXT`))
    .then(() => pool.query('CREATE INDEX IF NOT EXISTS referidos_comp_tel_idx ON referidos (comp_tel_norm)'))
    .then(() => console.log('✅ Tabla referidos lista'))
    .catch(e => console.error('❌ Tabla referidos:', e.message))

  // ── utilidades ───────────────────────────────────────────────────────────
  const txt = (v, max = 120) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max)
  const dig = v => String(v == null ? '' : v).replace(/\D+/g, '')
  // Normaliza teléfonos argentinos a los últimos 10 dígitos (sin 54, 9, 0 ni 15)
  function telNorm(t) {
    let d = dig(t)
    if (d.startsWith('54')) d = d.slice(2)
    if (d.startsWith('9') && d.length === 11) d = d.slice(1)
    if (d.startsWith('0')) d = d.slice(1)
    const m = /^(\d{2,4})15(\d{6,8})$/.exec(d)
    if (m && (m[1] + m[2]).length === 10) d = m[1] + m[2]
    return d.slice(-10)
  }
  const codigo = id => 'R-' + String(id).padStart(4, '0')
  const mailOk = m => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(m)
  const ip = req => (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim()

  // límite simple por IP: 8 envíos cada 15 minutos
  const intentos = new Map()
  function limitado(req) {
    const k = ip(req), ahora = Date.now()
    const lista = (intentos.get(k) || []).filter(t => ahora - t < 15 * 60 * 1000)
    lista.push(ahora); intentos.set(k, lista)
    if (intentos.size > 5000) intentos.clear()
    return lista.length > 8
  }

  function passOk(req) {
    const esperado = process.env.REFERIDOS_PANEL_PASS || ''
    const dado = String(req.headers['x-referidos-pass'] || req.query.pass || '')
    if (!esperado || !dado) return false
    const a = Buffer.from(esperado), b = Buffer.from(dado)
    return a.length === b.length && crypto.timingSafeEqual(a, b)
  }
  function exigirPass(req, res) {
    if (!process.env.REFERIDOS_PANEL_PASS) { res.status(503).json({ error: 'Falta configurar REFERIDOS_PANEL_PASS en Railway (Variables).' }); return false }
    if (!passOk(req)) { res.status(401).json({ error: 'Contraseña incorrecta.' }); return false }
    return true
  }

  // ── páginas ──────────────────────────────────────────────────────────────
  app.get(['/referidos', '/referidos/'], (req, res) => res.sendFile(path.join(__dirname, 'public', 'referidos.html')))
  app.get(['/referidos/bases', '/referidos/bases/'], (req, res) => res.sendFile(path.join(__dirname, 'public', 'referidos-bases.html')))
  app.get(['/referidos/admin', '/referidos/admin/'], (req, res) => res.sendFile(path.join(__dirname, 'public', 'referidos-admin.html')))

  // ── alta pública ─────────────────────────────────────────────────────────
  app.post('/api/referidos', async (req, res) => {
    try {
      const b = req.body || {}
      if (b.empresa) return res.json({ ok: true, codigo: 'R-0000' })          // trampa para bots
      const ahora = new Date()
      if (ahora < INICIO || ahora > FIN) return res.status(410).json({ error: 'La campaña Referidos no está vigente. Ya no se reciben referidos por este formulario.' })
      if (limitado(req)) return res.status(429).json({ error: 'Demasiados envíos seguidos. Probá en unos minutos.' })

      const d = {
        ref_nombre: txt(b.ref_nombre, 80), ref_tel: txt(b.ref_tel, 25), ref_alias: txt(b.ref_alias, 40),
        ref_dni: dig(b.ref_dni).slice(0, 8), ref_email: txt(b.ref_email, 100).toLowerCase(),
        comp_nombre: txt(b.comp_nombre, 80), comp_tel: txt(b.comp_tel, 25), comp_localidad: txt(b.comp_localidad, 60),
        comp_email: txt(b.comp_email, 100).toLowerCase(),
        marca: txt(b.marca, 40), modelo: txt(b.modelo, 60), anio: txt(b.anio, 8),
        moneda: b.moneda === 'USD' ? 'USD' : 'ARS',
        presupuesto: Number(dig(b.presupuesto).slice(0, 13)) || null,
        entrega: ['si', 'no', 'nose'].includes(b.entrega) ? b.entrega : null,
        usado_marca_modelo: txt(b.usado_marca_modelo, 60), usado_anio: txt(b.usado_anio, 4),
        usado_km: Number(dig(b.usado_km).slice(0, 7)) || null,
        financia: ['si', 'no', 'nose'].includes(b.financia) ? b.financia : null,
        comp_dni: dig(b.comp_dni).slice(0, 11),
        garantes: (Array.isArray(b.garantes) ? b.garantes : []).slice(0, 3)
          .map(g => ({ nombre: txt(g && g.nombre, 80), dni: dig(g && g.dni).slice(0, 11), tel: txt(g && g.tel, 25) }))
          .filter(g => g.nombre || g.dni || g.tel),
        comentarios: txt(b.comentarios, 600), origen: txt(b.origen, 40)
      }
      const refNorm = telNorm(d.ref_tel), compNorm = telNorm(d.comp_tel)

      const faltan = []
      if (d.ref_nombre.length < 3) faltan.push('tu nombre')
      if (refNorm.length !== 10) faltan.push('tu WhatsApp')
      if (![7, 8].includes(d.ref_dni.length)) faltan.push('tu DNI')
      if (!mailOk(d.ref_email)) faltan.push('tu correo')
      if (d.comp_nombre.length < 2) faltan.push('el nombre del comprador')
      if (compNorm.length !== 10) faltan.push('el teléfono del comprador')
      if (!mailOk(d.comp_email)) faltan.push('el correo del comprador')
      if (d.comp_localidad.length < 2) faltan.push('la ciudad o zona del comprador')
      if (!d.marca) faltan.push('la marca que busca')
      if (!b.comp_aviso) faltan.push('confirmar que le avisaste al comprador')
      if (!b.acepto) faltan.push('aceptar las bases')
      if (faltan.length) return res.status(400).json({ error: 'Falta completar: ' + faltan.join(', ') + '.' })
      if (refNorm === compNorm || d.ref_email === d.comp_email) return res.status(400).json({ error: 'Los datos del comprador no pueden ser los tuyos: no podés referirte a vos mismo.' })
      if (d.comp_dni && (d.comp_dni === d.ref_dni || (d.comp_dni.length === 11 && d.comp_dni.slice(2, 10).replace(/^0/, '') === d.ref_dni)))
        return res.status(400).json({ error: 'El DNI del comprador es el tuyo: no podés referirte a vos mismo.' })
      if (d.comp_dni && ![7, 8, 11].includes(d.comp_dni.length)) return res.status(400).json({ error: 'Revisá el DNI o CUIL del comprador.' })

      // Cláusula CUARTA e): un comprador ya cargado en la campaña no se puede volver a cargar (salvo que se haya descartado)
      const dias = parseInt(process.env.REFERIDOS_DIAS_DUPLICADO || '0', 10) || 0
      const dup = await pool.query(
        `SELECT id, ref_tel_norm FROM referidos
          WHERE (comp_tel_norm = $1 OR (comp_email <> '' AND comp_email = $2)) AND estado <> 'descartado'
            AND ($3::int = 0 OR creado > NOW() - make_interval(days => $3::int))
          ORDER BY id LIMIT 1`, [compNorm, d.comp_email, dias])
      if (dup.rows.length) {
        const mismo = dup.rows[0].ref_tel_norm === refNorm
        return res.status(409).json({
          error: mismo
            ? `Ya cargaste a este comprador (código ${codigo(dup.rows[0].id)}). No hace falta cargarlo de nuevo.`
            : 'Este comprador ya fue referido por otra persona. Si creés que es un error, escribinos al 351 517-1111.'
        })
      }

      const r = await pool.query(
        `INSERT INTO referidos (ref_nombre, ref_tel, ref_tel_norm, ref_alias, comp_nombre, comp_tel, comp_tel_norm, comp_localidad,
           marca, modelo, anio, moneda, presupuesto, entrega, usado_marca_modelo, usado_anio, usado_km, financia, comp_dni,
           garantes, comentarios, origen, ip, ref_dni, ref_email, comp_email)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb,$21,$22,$23,$24,$25,$26) RETURNING id`,
        [d.ref_nombre, d.ref_tel, refNorm, d.ref_alias || null, d.comp_nombre, d.comp_tel, compNorm, d.comp_localidad || null,
         d.marca, d.modelo || null, d.anio || null, d.moneda, d.presupuesto, d.entrega, d.usado_marca_modelo || null,
         d.usado_anio || null, d.usado_km, d.financia, d.comp_dni || null, JSON.stringify(d.garantes), d.comentarios || null,
         d.origen || null, ip(req), d.ref_dni, d.ref_email, d.comp_email])
      const id = r.rows[0].id
      console.log(`🤝 Referido ${codigo(id)}: ${d.comp_nombre} (${d.marca} ${d.modelo}) de ${d.ref_nombre}`)
      res.json({ ok: true, id, codigo: codigo(id) })
    } catch (e) {
      console.error('❌ POST /api/referidos:', e.message)
      res.status(500).json({ error: 'No pudimos guardar el referido. Probá de nuevo en un rato.' })
    }
  })

  // ── panel ────────────────────────────────────────────────────────────────
  app.get('/api/referidos', async (req, res) => {
    if (!exigirPass(req, res)) return
    try {
      const cond = [], vals = []
      if (ESTADOS.includes(req.query.estado)) { vals.push(req.query.estado); cond.push(`estado = $${vals.length}`) }
      const q = txt(req.query.q, 60)
      if (q) {
        vals.push('%' + q.toLowerCase() + '%')
        cond.push(`(LOWER(comp_nombre) LIKE $${vals.length} OR LOWER(ref_nombre) LIKE $${vals.length} OR comp_tel_norm LIKE $${vals.length} OR ref_tel_norm LIKE $${vals.length} OR LOWER(COALESCE(marca,'')||' '||COALESCE(modelo,'')) LIKE $${vals.length})`)
      }
      const r = await pool.query(`SELECT * FROM referidos ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''} ORDER BY id DESC LIMIT 1000`, vals)
      const t = await pool.query(`SELECT estado, COUNT(*)::int AS n FROM referidos GROUP BY estado`)
      const totales = Object.fromEntries(ESTADOS.map(e => [e, 0]))
      t.rows.forEach(x => { totales[x.estado] = x.n })
      // Topes (cláusula NOVENA): hasta TOPE_REF beneficios por referente y TOPE_TOTAL en toda la campaña.
      // Se ordenan las ventas confirmadas por fecha de actualización; las que superan un tope se marcan "sin_beneficio".
      const v = await pool.query(`SELECT id, COALESCE(NULLIF(ref_dni,''), ref_tel_norm) AS quien FROM referidos
                                   WHERE estado IN ('vendido','pagado') ORDER BY COALESCE(pagado_en, actualizado), id`)
      const porRef = {}, sinBeneficio = new Set(), beneficiosDe = {}
      let total = 0
      v.rows.forEach(x => {
        porRef[x.quien] = (porRef[x.quien] || 0) + 1
        if (porRef[x.quien] > TOPE_REF || total >= TOPE_TOTAL) sinBeneficio.add(x.id)
        else { total++; beneficiosDe[x.quien] = (beneficiosDe[x.quien] || 0) + 1 }
      })
      const DIA = 86400000
      res.json({
        ok: true, premio: PREMIO, totales,
        campania: { inicio: INICIO, fin: FIN, maduracion_dias: MADURACION, tope_referente: TOPE_REF, tope_total: TOPE_TOTAL, beneficios_otorgados: total },
        referidos: r.rows.map(x => {
          const quien = x.ref_dni || x.ref_tel_norm
          const vence = new Date(new Date(x.creado).getTime() + MADURACION * DIA)
          return { ...x, ip: undefined, codigo: codigo(x.id), vence,
            vencido: !['vendido', 'pagado', 'descartado'].includes(x.estado) && Date.now() > vence.getTime(),
            sin_beneficio: sinBeneficio.has(x.id), beneficios_referente: beneficiosDe[quien] || 0 }
        })
      })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  app.patch('/api/referidos/:id', async (req, res) => {
    if (!exigirPass(req, res)) return
    try {
      const id = parseInt(req.params.id, 10)
      const b = req.body || {}
      const sets = [], vals = []
      if (b.estado !== undefined) {
        if (!ESTADOS.includes(b.estado)) return res.status(400).json({ error: 'Estado inválido.' })
        vals.push(b.estado); sets.push(`estado = $${vals.length}`)
        sets.push(b.estado === 'pagado' ? `pagado_en = COALESCE(pagado_en, NOW())` : `pagado_en = NULL`)
      }
      if (b.notas !== undefined) { vals.push(txt(b.notas, 2000)); sets.push(`notas = $${vals.length}`) }
      if (b.vendedor !== undefined) { vals.push(txt(b.vendedor, 60)); sets.push(`vendedor = $${vals.length}`) }
      if (!sets.length) return res.status(400).json({ error: 'Nada para actualizar.' })
      vals.push(id)
      const r = await pool.query(`UPDATE referidos SET ${sets.join(', ')}, actualizado = NOW() WHERE id = $${vals.length} RETURNING *`, vals)
      if (!r.rows.length) return res.status(404).json({ error: 'No existe ese referido.' })
      res.json({ ok: true, referido: { ...r.rows[0], codigo: codigo(id), ip: undefined } })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  app.get('/api/referidos.csv', async (req, res) => {
    if (!exigirPass(req, res)) return
    try {
      const r = await pool.query('SELECT * FROM referidos ORDER BY id DESC')
      const cols = ['codigo', 'creado', 'estado', 'ref_nombre', 'ref_tel', 'ref_dni', 'ref_email', 'ref_alias', 'comp_nombre', 'comp_tel', 'comp_email', 'comp_localidad',
        'marca', 'modelo', 'anio', 'moneda', 'presupuesto', 'entrega', 'usado_marca_modelo', 'usado_anio', 'usado_km',
        'financia', 'comp_dni', 'garantes', 'comentarios', 'vendedor', 'notas', 'pagado_en']
      const cel = v => {
        if (v == null) return ''
        if (v instanceof Date) v = new Date(v.getTime() - 3 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ')
        if (typeof v === 'object') v = v.map ? v.map(g => [g.nombre, g.dni, g.tel].filter(Boolean).join(' / ')).join(' | ') : JSON.stringify(v)
        v = String(v)
        return /[";\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v
      }
      const filas = r.rows.map(x => cols.map(c => cel(c === 'codigo' ? codigo(x.id) : x[c])).join(';'))
      res.setHeader('Content-Type', 'text/csv; charset=utf-8')
      res.setHeader('Content-Disposition', 'attachment; filename="referidos-tutu.csv"')
      res.send('﻿' + cols.join(';') + '\n' + filas.join('\n'))
    } catch (e) { res.status(500).json({ error: e.message }) }
  })
}
