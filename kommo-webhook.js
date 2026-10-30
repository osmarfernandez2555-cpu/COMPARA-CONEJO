// ═══════════════════════════════════════════════════════════════════════════
//  RUTHINA ⇄ KOMMO — Webhook para pedir autos y calificar clientes por banco
// ───────────────────────────────────────────────────────────────────────────
//  Kommo manda CUIL + auto que busca el cliente  →  Ruthina:
//    1. Busca el auto en el stock y lo devuelve (y lo deja como nota en el lead)
//    2. Guarda/actualiza el cliente en la base de clientes de Ruthina
//    3. Crea un "pedido de calificación" PENDIENTE (Bancor / Nación / Galicia /
//       decreditos)
//    4. CONSULTA AUTOMÁTICA: mientras las sesiones de los bancos estén abiertas en
//       Consulta Créditos (consulta-bancor), Ruthina consulta el CUIL sola en cada
//       banco conectado. Si un banco aprueba, o todos los bancos configurados
//       rechazan, el pedido se cierra solo y el resultado va a Kommo.
//       Si falta alguna sesión o un banco dice "REVISAR", el pedido queda abierto
//       con lo que ya se sabe, y un vendedor lo termina desde "Pedidos Kommo".
//    5. El resultado va al lead en Kommo (nota + campo "Calificación" + etapa)
//
//  Variables de entorno (Railway → Variables):
//    KOMMO_WEBHOOK_KEY        clave secreta que va en la URL del webhook (?key=...)   [obligatoria]
//    KOMMO_DOMINIO            ej: tutuautomotores.kommo.com                            [para escribir en Kommo]
//    KOMMO_TOKEN              token de larga duración de la integración privada       [para escribir en Kommo]
//    KOMMO_CAMPO_CUIL         nombre del campo del lead con el CUIL   (def: "CUIL")
//    KOMMO_CAMPO_AUTO         nombre del campo del lead con el auto   (def: "Auto buscado")
//    KOMMO_CAMPO_CALIFICACION nombre del campo donde escribir el resultado (def: "Calificación")
//    KOMMO_STATUS_CALIFICA    id de la etapa a la que mover el lead si califica      (opcional)
//    KOMMO_STATUS_NO_CALIFICA id de la etapa si ningún banco aprueba                (opcional)
//    KOMMO_PIPELINE_ID        id del embudo de esas etapas                           (opcional)
//    KOMMO_STATUS_DISPARADOR  id de la etapa que dispara la consulta (ej. "Calificar"); se pueden poner varias separadas por coma
//                             (recomendado; sin esto, cualquier lead nuevo o cambio de etapa con CUIL y auto la dispara)
//
//    CONSULTA_BANCOS_CLAVE    el código de acceso de Consulta Créditos (APP_CLAVE)   [para la consulta automática]
//    CONSULTA_BANCOS_URL      def: https://consulta-bancor-production.up.railway.app
//    CONSULTA_AUTOMATICA      "no" para apagarla (def: prendida si hay clave)
// ═══════════════════════════════════════════════════════════════════════════

const fetch = require('node-fetch')
const express = require('express')

const BANCOS = [
  { key: 'bancor',     label: 'Bancor',      monto: 'monto_bancor' },
  { key: 'nacion',     label: 'Nación',      monto: 'monto_nacion' },
  { key: 'galicia',    label: 'Galicia',     monto: 'monto_galicia' },
  { key: 'decreditos', label: 'decreditos',  monto: null }
]

// ── utilidades ─────────────────────────────────────────────────────────────
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
const soloDigitos = s => String(s || '').replace(/\D/g, '')

function validarCuil(cuil) {
  if (!/^\d{11}$/.test(cuil)) return false
  const w = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2]
  const suma = w.reduce((acc, p, i) => acc + p * Number(cuil[i]), 0)
  let dv = 11 - (suma % 11)
  if (dv === 11) dv = 0
  if (dv === 10) dv = 9
  return dv === Number(cuil[10])
}

function formatearCuil(c) {
  return c.length === 11 ? `${c.slice(0, 2)}-${c.slice(2, 10)}-${c.slice(10)}` : c
}

// separa "Gol Trend 2015" en { modelo: "Gol Trend", anio: "2015" }
function separarAnio(texto, anioDado) {
  let modelo = String(texto || '').trim()
  let anio = soloDigitos(anioDado).slice(0, 4)
  const m = modelo.match(/\b(19[89]\d|20[0-4]\d)\b/)
  if (m) {
    if (!anio) anio = m[1]
    modelo = modelo.replace(m[0], ' ').replace(/\s+/g, ' ').trim()
  }
  return { modelo, anio }
}

function primero(obj, claves) {
  for (const k of claves) {
    if (obj && obj[k] !== undefined && obj[k] !== null && String(obj[k]).trim() !== '') return String(obj[k]).trim()
  }
  return ''
}

function fmtPrecio(a) {
  if (!a.precio) return 'consultar precio'
  const p = String(a.precio)
  if (/[$]|usd|u\$s/i.test(p)) return p
  const n = Number(p.replace(/\./g, '').replace(',', '.'))
  const num = isNaN(n) ? p : n.toLocaleString('es-AR')
  return (a.moneda === 'USD' ? 'U$S ' : '$ ') + num
}

function textoAutos(pedido, autos) {
  const busq = [pedido.auto, pedido.anio].filter(Boolean).join(' ')
  if (!autos.length) return `🔍 Ruthina: no hay "${busq}" en el stock ahora. El cliente quedó cargado en Ruthina y avisa cuando entre uno.`
  const lineas = autos.slice(0, 5).map((a, i) => {
    const km = a.km ? ` · ${Number(a.km).toLocaleString('es-AR')} km` : ''
    const ub = a.ubicacion || 'Tutu Automotores'
    return `${i + 1}. ${[a.marca, a.modelo, a.version].filter(Boolean).join(' ')} ${a.anio || ''}${km} · ${fmtPrecio(a)} · ${ub}`
  })
  const extra = autos.length > 5 ? `\n…y ${autos.length - 5} más en Ruthina.` : ''
  return `🚗 Ruthina encontró ${autos.length} auto${autos.length !== 1 ? 's' : ''} para "${busq}":\n${lineas.join('\n')}${extra}`
}

// ── Kommo API ──────────────────────────────────────────────────────────────
function kommoListo() { return !!(process.env.KOMMO_DOMINIO && process.env.KOMMO_TOKEN) }
function kommoBase() {
  const raw = String(process.env.KOMMO_DOMINIO || '').trim()
  if (/^http:\/\//.test(raw)) return raw.replace(/\/+$/, '')   // solo para pruebas locales
  return 'https://' + raw.replace(/^https?:\/\//, '').replace(/\/.*$/, '')
}
async function kommo(path, opts = {}) {
  const r = await fetch(kommoBase() + path, {
    method: opts.method || 'GET',
    headers: { Authorization: 'Bearer ' + process.env.KOMMO_TOKEN, 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    timeout: 15000
  })
  if (r.status === 204) return null
  const txt = await r.text()
  let data = null
  try { data = txt ? JSON.parse(txt) : null } catch (e) { data = txt }
  if (!r.ok) {
    const txt = typeof data === 'string' ? data : JSON.stringify(data || {})
    const lead = (path.match(/\/leads\/(\d+)/) || [])[1]
    // 226 = el elemento no existe; 404 en un lead = idem
    if (lead && (/"code":\s*226/.test(txt) || r.status === 404)) {
      throw new Error(`El lead #${lead} no existe en Kommo (¿era un número de prueba?). El resultado quedó guardado en Ruthina.`)
    }
    if (r.status === 401) throw new Error('Kommo rechazó el token (401): revisá KOMMO_TOKEN en Railway')
    throw new Error(`Kommo ${r.status} en ${path}: ${txt.slice(0, 300)}`)
  }
  return data
}

function valorCampo(entidad, nombres) {
  const lista = (entidad && entidad.custom_fields_values) || []
  const buscados = nombres.map(norm)
  for (const f of lista) {
    if (buscados.includes(norm(f.field_name)) || buscados.includes(norm(f.field_code))) {
      const v = f.values && f.values[0] && f.values[0].value
      if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim()
    }
  }
  return ''
}

// lee el lead (y su contacto principal) para sacar CUIL, auto, nombre y teléfono
async function leerLeadKommo(leadId) {
  const lead = await kommo(`/api/v4/leads/${leadId}?with=contacts`)
  const campoCuil = process.env.KOMMO_CAMPO_CUIL || 'CUIL'
  const campoAuto = process.env.KOMMO_CAMPO_AUTO || 'Auto buscado'
  const out = {
    lead_id: String(leadId),
    cuil: valorCampo(lead, [campoCuil, 'CUIL', 'CUIT', 'CUIL/CUIT', 'DNI']),
    auto: valorCampo(lead, [campoAuto, 'Auto buscado', 'Auto', 'Vehículo', 'Vehiculo', 'Modelo', 'Auto de interés']),
    anio: valorCampo(lead, ['Año', 'Anio', 'Año buscado']),
    nombre: '', telefono: '', vendedor: ''
  }
  const contactos = (lead._embedded && lead._embedded.contacts) || []
  const principal = contactos.find(c => c.is_main) || contactos[0]
  if (principal) {
    try {
      const c = await kommo(`/api/v4/contacts/${principal.id}`)
      out.nombre = c.name || ''
      out.telefono = valorCampo(c, ['PHONE', 'Teléfono', 'Telefono', 'Celular'])
      if (!out.cuil) out.cuil = valorCampo(c, [campoCuil, 'CUIL', 'CUIT', 'DNI'])
    } catch (e) { console.error('[kommo] contacto:', e.message) }
  }
  if (!out.nombre) out.nombre = lead.name || ''
  if (lead.responsible_user_id) {
    try {
      const u = await kommo(`/api/v4/users/${lead.responsible_user_id}`)
      out.vendedor = (u && u.name) || ''
    } catch (e) { /* sin permiso para usuarios: no importa */ }
  }
  return out
}

async function notaEnLead(leadId, texto) {
  if (!kommoListo() || !leadId) return
  await kommo(`/api/v4/leads/${leadId}/notes`, {
    method: 'POST',
    body: [{ note_type: 'common', params: { text: texto } }]
  })
}

let _camposCache = null
async function campoLead(nombre) {
  if (!_camposCache) {
    _camposCache = []
    let page = 1
    while (page < 20) {
      const r = await kommo(`/api/v4/leads/custom_fields?limit=250&page=${page}`)
      const lista = (r && r._embedded && r._embedded.custom_fields) || []
      _camposCache.push(...lista)
      if (!r || !r._links || !r._links.next) break
      page++
    }
    setTimeout(() => { _camposCache = null }, 10 * 60 * 1000)
  }
  return _camposCache.find(f => norm(f.name) === norm(nombre))
}

async function actualizarLead(leadId, califica, textoCorto) {
  if (!kommoListo() || !leadId) return
  const body = {}
  try {
    const campo = await campoLead(process.env.KOMMO_CAMPO_CALIFICACION || 'Calificación')
    if (campo) {
      if (Array.isArray(campo.enums) && campo.enums.length) {
        // campo tipo lista: elegimos la opción que diga "Califica"/"Sí" o "No califica"/"No"
        const quiero = califica ? ['califica', 'si', 'sí', 'aprobado', 'sirve'] : ['no califica', 'no', 'rechazado', 'denegado', 'no sirve']
        const op = campo.enums.find(e => quiero.map(norm).includes(norm(e.value)))
        if (op) body.custom_fields_values = [{ field_id: campo.id, values: [{ enum_id: op.id }] }]
      } else {
        body.custom_fields_values = [{ field_id: campo.id, values: [{ value: textoCorto }] }]
      }
    }
  } catch (e) { console.error('[kommo] campo calificación:', e.message) }

  const etapa = califica ? process.env.KOMMO_STATUS_CALIFICA : process.env.KOMMO_STATUS_NO_CALIFICA
  if (etapa) {
    body.status_id = Number(etapa)
    if (process.env.KOMMO_PIPELINE_ID) body.pipeline_id = Number(process.env.KOMMO_PIPELINE_ID)
  }
  if (Object.keys(body).length) await kommo(`/api/v4/leads/${leadId}`, { method: 'PATCH', body })
}

// continuar un Salesbot que llamó con "widget_request"
async function responderSalesbot(returnUrl, datos, texto) {
  if (!returnUrl) return
  const headers = { 'Content-Type': 'application/json' }
  if (process.env.KOMMO_TOKEN) headers.Authorization = 'Bearer ' + process.env.KOMMO_TOKEN
  await fetch(returnUrl, {
    method: 'POST', headers, timeout: 15000,
    body: JSON.stringify({
      data: datos,
      execute_handlers: [{ handler: 'show', params: { type: 'text', value: texto } }]
    })
  })
}

// ── Consulta Créditos (consulta-bancor) ────────────────────────────────────
function bancosUrl() {
  return String(process.env.CONSULTA_BANCOS_URL || 'https://consulta-bancor-production.up.railway.app').trim().replace(/\/+$/, '')
}
function autoActiva() {
  return !!String(process.env.CONSULTA_BANCOS_CLAVE || '').trim() && norm(process.env.CONSULTA_AUTOMATICA) !== 'no'
}
async function bancosApi(ruta, opts = {}) {
  const r = await fetch(bancosUrl() + ruta, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', 'x-clave': String(process.env.CONSULTA_BANCOS_CLAVE || '').trim() },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    timeout: opts.timeout || 20000
  })
  let data = {}
  try { data = await r.json() } catch (e) { data = {} }
  if (r.status === 401) throw new Error('El código de Consulta Créditos (CONSULTA_BANCOS_CLAVE) es incorrecto')
  return { ok: r.ok, status: r.status, data }
}
// "30.868.289,50" → "30868289"
const montoEntero = m => soloDigitos(String(m || '').split(',')[0])
// APROBADO / PREAPROBADO / DENEGADO / REVISAR / ERROR  →  estado del formulario
function estadoForm(e) {
  if (e === 'APROBADO' || e === 'PREAPROBADO') return 'aprobado'
  if (e === 'DENEGADO') return 'rechazado'
  return 'no_consultado'
}

// ═══════════════════════════════════════════════════════════════════════════
module.exports = registrarKommo
function registrarKommo(app, pool, buscarEnStock) {

  // tablas
  ;(async () => {
    await pool.query(`CREATE TABLE IF NOT EXISTS calificaciones_kommo (
      id SERIAL PRIMARY KEY,
      cliente_id INTEGER,
      lead_id TEXT DEFAULT '',
      cuil TEXT NOT NULL,
      cuil_valido BOOLEAN DEFAULT true,
      nombre TEXT DEFAULT '',
      telefono TEXT DEFAULT '',
      auto TEXT DEFAULT '',
      anio TEXT DEFAULT '',
      vendedor TEXT DEFAULT '',
      autos_encontrados INTEGER DEFAULT 0,
      estado TEXT DEFAULT 'pendiente',
      tomado_por TEXT DEFAULT '',
      resultados JSONB DEFAULT '{}'::jsonb,
      resultado TEXT DEFAULT '',
      observaciones TEXT DEFAULT '',
      resuelto_por TEXT DEFAULT '',
      kommo_error TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      resuelto_at TIMESTAMP
    )`)
    await pool.query(`ALTER TABLE clientes_busqueda ADD COLUMN IF NOT EXISTS kommo_lead_id TEXT DEFAULT ''`).catch(() => {})
    await pool.query(`ALTER TABLE calificaciones_kommo ADD COLUMN IF NOT EXISTS auto_resultados JSONB DEFAULT '{}'::jsonb`).catch(() => {})
    await pool.query(`ALTER TABLE calificaciones_kommo ADD COLUMN IF NOT EXISTS auto_msg TEXT DEFAULT ''`).catch(() => {})
    await pool.query(`ALTER TABLE calificaciones_kommo ADD COLUMN IF NOT EXISTS callback_url TEXT DEFAULT ''`).catch(() => {})
    await pool.query(`ALTER TABLE calificaciones_kommo ADD COLUMN IF NOT EXISTS origen TEXT DEFAULT ''`).catch(() => {})
    console.log('✅ Webhook Kommo listo: POST /api/kommo/webhook?key=***  (Kommo API ' + (kommoListo() ? 'configurada' : 'SIN configurar') + ')')
    console.log('🏦 Consulta automática de bancos: ' + (autoActiva() ? 'PRENDIDA → ' + bancosUrl() : 'apagada (falta CONSULTA_BANCOS_CLAVE)'))
  })().catch(e => console.error('Error init Kommo:', e.message))

  function claveOk(req) {
    const k = process.env.KOMMO_WEBHOOK_KEY
    if (!k) return false
    return req.query.key === k || req.get('x-webhook-key') === k
  }

  async function buscarAutos(modelo, anio) {
    let rows = await buscarEnStock(modelo)
    rows = rows.filter(r => !/vendid|reservad/i.test(r.estado || ''))
    if (!anio) return rows
    const n = parseInt(anio)
    const exactos = rows.filter(r => Math.abs(parseInt(r.anio) - n) <= 1)
    const aprox = rows.filter(r => { const d = Math.abs(parseInt(r.anio) - n); return d > 1 && d <= 8 })
      .sort((a, b) => Math.abs(parseInt(a.anio) - n) - Math.abs(parseInt(b.anio) - n))
    const sinAnio = rows.filter(r => isNaN(parseInt(r.anio)))
    return [...exactos, ...aprox, ...sinAnio]
  }

  async function guardarCliente(p) {
    const ex = await pool.query(
      `SELECT id FROM clientes_busqueda WHERE dni=$1 AND estado='Buscando' ORDER BY created_at DESC LIMIT 1`, [p.cuil])
    if (ex.rows.length) {
      const id = ex.rows[0].id
      await pool.query(
        `UPDATE clientes_busqueda SET
           modelo=$1, anio=CASE WHEN $2<>'' THEN $2 ELSE anio END,
           telefono=CASE WHEN $3<>'' THEN $3 ELSE telefono END,
           nombre=CASE WHEN $4<>'' THEN $4 ELSE nombre END,
           kommo_lead_id=CASE WHEN $5<>'' THEN $5 ELSE kommo_lead_id END,
           vendedor=CASE WHEN $6<>'' AND COALESCE(vendedor,'')='' THEN $6 ELSE vendedor END,
           updated_at=NOW()
         WHERE id=$7`,
        [p.auto, p.anio, p.telefono, p.nombre, p.lead_id, p.vendedor, id])
      return id
    }
    const nombre = p.nombre || (p.lead_id ? `Lead Kommo #${p.lead_id}` : `Cliente ${formatearCuil(p.cuil)}`)
    const ins = await pool.query(
      `INSERT INTO clientes_busqueda (nombre,telefono,modelo,anio,dni,notas,asesor,vendedor,estado,kommo_lead_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'Buscando',$9) RETURNING id`,
      [nombre, p.telefono, p.auto, p.anio, p.cuil,
       'Pedido desde Kommo' + (p.lead_id ? ` (lead #${p.lead_id})` : ''), p.vendedor, p.vendedor, p.lead_id])
    return ins.rows[0].id
  }

  // núcleo: recibe un pedido ya normalizado
  async function procesarPedido(p) {
    const cuil = soloDigitos(p.cuil)
    if (cuil.length !== 11 && !(cuil.length >= 7 && cuil.length <= 8)) {
      const err = new Error('CUIL inválido o faltante: mandá los 11 números del CUIL')
      err.status = 400; throw err
    }
    const { modelo, anio } = separarAnio(p.auto, p.anio)
    if (!modelo && !p.sinAuto) { const err = new Error('Falta el auto que busca el cliente'); err.status = 400; throw err }

    const pedido = {
      cuil, auto: modelo || '(a definir)', anio,
      nombre: p.nombre || '', telefono: soloDigitos(p.telefono), lead_id: soloDigitos(p.lead_id),
      vendedor: p.vendedor || ''
    }
    const cuilValido = cuil.length === 11 && validarCuil(cuil)

    const autos = modelo ? await buscarAutos(modelo, anio) : []
    const clienteId = await guardarCliente(pedido)

    // evitar duplicados: si ya hay un pedido abierto para este CUIL, se reutiliza
    let sol = await pool.query(
      `SELECT * FROM calificaciones_kommo WHERE cuil=$1 AND estado IN ('pendiente','en_proceso') ORDER BY created_at DESC LIMIT 1`, [cuil])
    let reutilizado = false
    if (sol.rows.length) {
      reutilizado = true
      sol = await pool.query(
        `UPDATE calificaciones_kommo SET auto=$1, anio=CASE WHEN $2<>'' THEN $2 ELSE anio END, autos_encontrados=$3,
           lead_id=CASE WHEN $4<>'' THEN $4 ELSE lead_id END,
           nombre=CASE WHEN $5<>'' THEN $5 ELSE nombre END,
           telefono=CASE WHEN $6<>'' THEN $6 ELSE telefono END,
           cliente_id=$7, updated_at=NOW()
         WHERE id=$8 RETURNING *`,
        [modelo || sol.rows[0].auto, anio, autos.length, pedido.lead_id, pedido.nombre, pedido.telefono, clienteId, sol.rows[0].id])
    } else {
      sol = await pool.query(
        `INSERT INTO calificaciones_kommo (cliente_id,lead_id,cuil,cuil_valido,nombre,telefono,auto,anio,vendedor,autos_encontrados)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [clienteId, pedido.lead_id, cuil, cuilValido, pedido.nombre, pedido.telefono, modelo || '', anio, pedido.vendedor, autos.length])
    }
    if (p.callback_url) {
      sol = await pool.query(`UPDATE calificaciones_kommo SET callback_url=$1, origen='bot' WHERE id=$2 RETURNING *`, [p.callback_url, sol.rows[0].id])
    } else if (p.origen) {
      sol = await pool.query(`UPDATE calificaciones_kommo SET origen=$1 WHERE id=$2 RETURNING *`, [p.origen, sol.rows[0].id])
    }
    const solicitud = sol.rows[0]
    if (autoActiva() && cuil.length === 11) setTimeout(() => registrarKommo.cicloAuto && registrarKommo.cicloAuto(), 500)

    const texto = (modelo ? textoAutos(pedido, autos) + '\n\n' : '') +
      `🏦 Calificación bancaria (CUIL ${formatearCuil(cuil)}): PENDIENTE — ` +
      (autoActiva() ? 'Ruthina la consulta automáticamente en los bancos con sesión abierta y deja el resultado acá.' : 'un vendedor la está consultando en Bancor / Nación / Galicia / decreditos.') +
      (cuilValido ? '' : `\n⚠️ El CUIL no pasa la validación (dígito verificador). Revisalo con el cliente.`)

    return {
      ok: true,
      solicitud_id: solicitud.id,
      solicitud,
      reutilizado,
      cliente_id: clienteId,
      cuil, cuil_formateado: formatearCuil(cuil), cuil_valido: cuilValido,
      busqueda: { auto: modelo, anio },
      calificacion: 'pendiente',
      autos_encontrados: autos.length,
      _autos: autos,
      autos: autos.slice(0, 10).map(a => ({
        id: a.id, marca: a.marca, modelo: a.modelo, version: a.version, anio: a.anio, km: a.km,
        color: a.color, precio: a.precio, moneda: a.moneda, ubicacion: a.ubicacion || 'Tutu Automotores',
        telefono: a.telefono || ''
      })),
      texto
    }
  }

  // ── POST /api/kommo/webhook ─────────────────────────────────────────────
  // Acepta 3 formatos:
  //  A) JSON simple:   { "cuil": "20301234567", "auto": "Gol Trend 2015", "lead_id": 123, "nombre": "...", "telefono": "..." }
  //  B) Salesbot widget_request de Kommo: { "data": {cuil, auto, lead_id...}, "return_url": "..." }
  //  C) Webhook estándar de Kommo (Ajustes → Integraciones → Webhooks): leads[add][0][id]=123
  //     → Ruthina lee el lead por API y saca el CUIL y el auto de los campos del lead
  app.post('/api/kommo/webhook', express.urlencoded({ extended: true, limit: '2mb' }), async (req, res) => {
    if (!claveOk(req)) return res.status(401).json({ ok: false, error: 'Clave del webhook incorrecta (falta ?key=...)' })
    const b = req.body || {}
    try {
      // ── C) webhook estándar de Kommo
      if (b.leads && typeof b.leads === 'object') {
        res.json({ ok: true, recibido: true })   // Kommo exige respuesta rápida; procesamos después
        const ids = []
        // Si está KOMMO_STATUS_DISPARADOR, solo cuentan los leads que entran a esa etapa
        // (así no se dispara cuando Ruthina mueve el lead a "Califica" / "No califica")
        const disparador = String(process.env.KOMMO_STATUS_DISPARADOR || '').split(',').map(s => s.trim()).filter(Boolean)
        const propias = [process.env.KOMMO_STATUS_CALIFICA, process.env.KOMMO_STATUS_NO_CALIFICA].filter(Boolean).map(String)
        ;['add', 'status'].forEach(ev => (b.leads[ev] || []).forEach(l => {
          if (!l || !l.id) return
          const st = String(l.status_id || '')
          if (propias.includes(st)) return
          if (disparador.length && !disparador.includes(st)) return
          ids.push(String(l.id))
        }))
        for (const id of [...new Set(ids)]) {
          try {
            if (!kommoListo()) { console.error('[kommo] llegó el lead', id, 'pero faltan KOMMO_DOMINIO / KOMMO_TOKEN'); continue }
            // anti-bucle: si este lead ya se procesó hace menos de 10 min, no repetir
            const rec = await pool.query(
              `SELECT 1 FROM calificaciones_kommo WHERE lead_id=$1 AND created_at > NOW() - INTERVAL '10 minutes'`, [id])
            if (rec.rows.length) continue
            const datos = await leerLeadKommo(id)
            if (!datos.cuil || !datos.auto) {
              console.log(`[kommo] lead ${id} sin CUIL o sin auto todavía — se ignora`)
              continue
            }
            const r = await procesarPedido(datos)
            await notaEnLead(id, r.texto)
          } catch (e) { console.error('[kommo] lead', id, e.message) }
        }
        return
      }

      // ── B) Salesbot widget_request
      if (b.return_url && b.data) {
        res.json({ ok: true })   // el salesbot espera 200 en < 2 s
        try {
          const d = b.data || {}
          const r = await procesarPedido({
            cuil: primero(d, ['cuil', 'cuit', 'dni']),
            auto: primero(d, ['auto', 'auto_buscado', 'modelo', 'vehiculo']),
            anio: primero(d, ['anio', 'año', 'year']),
            nombre: primero(d, ['nombre', 'name']),
            telefono: primero(d, ['telefono', 'phone']),
            lead_id: primero(d, ['lead_id', 'leadId', 'lead']),
            vendedor: primero(d, ['vendedor', 'responsable'])
          })
          await responderSalesbot(b.return_url, {
            ok: 'si', autos_encontrados: String(r.autos_encontrados), solicitud_id: String(r.solicitud_id),
            calificacion: 'pendiente', texto: r.texto
          }, r.texto)
          if (r && b.data.lead_id) await notaEnLead(soloDigitos(b.data.lead_id), r.texto).catch(e => console.error('[kommo] nota:', e.message))
        } catch (e) {
          console.error('[kommo] salesbot:', e.message)
          await responderSalesbot(b.return_url, { ok: 'no', error: e.message }, '⚠️ ' + e.message).catch(() => {})
        }
        return
      }

      // ── A) JSON simple (n8n, Make, Salesbot "webhook", Postman…)
      const r = await procesarPedido({
        cuil: primero(b, ['cuil', 'cuit', 'dni', 'CUIL', 'CUIT']),
        auto: primero(b, ['auto', 'auto_buscado', 'modelo', 'vehiculo', 'Auto']),
        anio: primero(b, ['anio', 'año', 'year']),
        nombre: primero(b, ['nombre', 'name']),
        telefono: primero(b, ['telefono', 'phone']),
        lead_id: primero(b, ['lead_id', 'leadId', 'lead']),
        vendedor: primero(b, ['vendedor', 'responsable'])
      })
      const { _autos, solicitud, ...publico } = r
      res.json(publico)
      if (r.busqueda && soloDigitos(b.lead_id || b.leadId || b.lead)) {
        notaEnLead(soloDigitos(b.lead_id || b.leadId || b.lead), r.texto).catch(e => console.error('[kommo] nota:', e.message))
      }
    } catch (e) {
      console.error('[kommo] webhook:', e.message)
      if (!res.headersSent) res.status(e.status || 500).json({ ok: false, error: e.message })
    }
  })

  // ── Estado de la integración (para probar desde el navegador) ──────────
  app.get('/api/kommo/estado', async (req, res) => {
    const out = {
      webhook_key: !!process.env.KOMMO_WEBHOOK_KEY,
      kommo_dominio: process.env.KOMMO_DOMINIO || '',
      kommo_token: !!process.env.KOMMO_TOKEN,
      conexion_kommo: false
    }
    if (kommoListo()) {
      try { const a = await kommo('/api/v4/account'); out.conexion_kommo = true; out.cuenta = a && a.name }
      catch (e) { out.error_kommo = e.message }
    }
    try {
      const r = await pool.query(`SELECT estado, COUNT(*)::int c FROM calificaciones_kommo GROUP BY estado`)
      out.pedidos = Object.fromEntries(r.rows.map(x => [x.estado, x.c]))
    } catch (e) { out.pedidos = {} }
    res.json(out)
  })

  // ── Lista de embudos y etapas con sus números (para configurar las variables) ──
  app.get('/api/kommo/etapas', async (req, res) => {
    if (!kommoListo()) return res.status(400).json({ error: 'Faltan KOMMO_DOMINIO / KOMMO_TOKEN' })
    try {
      const r = await kommo('/api/v4/leads/pipelines')
      const embudos = ((r && r._embedded && r._embedded.pipelines) || []).map(p => ({
        embudo: p.name, pipeline_id: p.id,
        etapas: ((p._embedded && p._embedded.statuses) || []).map(s => ({ etapa: s.name, status_id: s.id }))
      }))
      const campos = []
      try {
        _camposCache = null
        for (const n of [process.env.KOMMO_CAMPO_CUIL || 'CUIL', process.env.KOMMO_CAMPO_AUTO || 'Auto buscado', process.env.KOMMO_CAMPO_CALIFICACION || 'Calificación']) {
          const f = await campoLead(n)
          campos.push({ campo: n, encontrado: !!f, id: f ? f.id : null })
        }
      } catch (e) { campos.push({ error: e.message }) }
      res.json({ embudos, campos_del_lead: campos })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // ── Pedidos de calificación (los usa el panel "Pedidos Kommo" de Ruthina) ──
  app.get('/api/calificaciones', async (req, res) => {
    try {
      const estado = req.query.estado || 'abiertos'
      let q, params = []
      if (estado === 'abiertos') q = `SELECT * FROM calificaciones_kommo WHERE estado IN ('pendiente','en_proceso') ORDER BY created_at ASC`
      else if (estado === 'todos') q = `SELECT * FROM calificaciones_kommo ORDER BY created_at DESC LIMIT 200`
      else { q = `SELECT * FROM calificaciones_kommo WHERE estado=$1 ORDER BY created_at DESC LIMIT 200`; params = [estado] }
      const r = await pool.query(q, params)
      res.json(r.rows)
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  app.get('/api/calificaciones/contador', async (req, res) => {
    try {
      const r = await pool.query(`SELECT COUNT(*)::int c FROM calificaciones_kommo WHERE estado IN ('pendiente','en_proceso')`)
      res.json({ abiertos: r.rows[0].c })
    } catch (e) { res.json({ abiertos: 0 }) }
  })

  // tomar un pedido ("lo estoy consultando yo")
  app.patch('/api/calificaciones/:id', async (req, res) => {
    try {
      const { estado, tomado_por } = req.body || {}
      const permitidos = ['pendiente', 'en_proceso', 'descartado']
      if (estado && !permitidos.includes(estado)) return res.status(400).json({ error: 'Estado no permitido' })
      const r = await pool.query(
        `UPDATE calificaciones_kommo SET estado=COALESCE($1,estado), tomado_por=COALESCE($2,tomado_por), updated_at=NOW()
         WHERE id=$3 RETURNING *`, [estado || null, tomado_por === undefined ? null : tomado_por, req.params.id])
      if (!r.rows.length) return res.status(404).json({ error: 'No existe' })
      res.json({ ok: true, pedido: r.rows[0] })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // ── Cerrar un pedido con el resultado de los bancos (manual o automático) ──
  // entrada: { bancor:{estado:'aprobado'|'rechazado'|'no_consultado', monto:'8000000'}, nacion:{...}, galicia:{...}, decreditos:{...} }
  async function resolverPedido(sol, entrada, obs, quien, automatico) {
    const resultados = {}
    BANCOS.forEach(bk => {
      const v = entrada[bk.key] || {}
      const estado = ['aprobado', 'rechazado'].includes(v.estado) ? v.estado : 'no_consultado'
      resultados[bk.key] = { estado, monto: estado === 'aprobado' ? soloDigitos(v.monto) : '' }
    })
    const consultados = BANCOS.filter(bk => resultados[bk.key].estado !== 'no_consultado')
    if (!consultados.length) { const e = new Error('Marcá el resultado de al menos un banco'); e.status = 400; throw e }
    const aprobados = BANCOS.filter(bk => resultados[bk.key].estado === 'aprobado')
    const califica = aprobados.length > 0
    const resultado = califica ? 'califica' : 'no_califica'

    const lineas = BANCOS.map(bk => {
      const r = resultados[bk.key]
      if (r.estado === 'aprobado') return `✅ ${bk.label}: APROBADO${r.monto ? ' hasta $ ' + Number(r.monto).toLocaleString('es-AR') : ''}`
      if (r.estado === 'rechazado') return `❌ ${bk.label}: rechazado`
      return `➖ ${bk.label}: no consultado`
    })
    const texto = `🏦 Calificación bancaria — CUIL ${formatearCuil(sol.cuil)}\n` +
      (califica ? `RESULTADO: CALIFICA (${aprobados.map(x => x.label).join(', ')})` : 'RESULTADO: NO CALIFICA en los bancos consultados') +
      `\n${lineas.join('\n')}` + (obs ? `\n📝 ${obs}` : '') +
      (automatico ? '\n🤖 Consultado automáticamente por Ruthina' : (quien ? `\n👤 Consultó: ${quien}` : ''))

    // actualizar el cliente en Ruthina
    if (sol.cliente_id) {
      const sets = [], params = []
      BANCOS.forEach(bk => {
        if (bk.monto && resultados[bk.key].estado === 'aprobado' && resultados[bk.key].monto) {
          params.push(resultados[bk.key].monto); sets.push(`${bk.monto}=$${params.length}`)
        }
      })
      params.push(aprobados.map(x => x.label).join(', ')); sets.push(`bancos=$${params.length}`)
      if (califica) { params.push('sirve'); sets.push(`calificacion=$${params.length}`) }
      const nota = `[Bancos ${new Date().toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })}] ` +
        (califica ? 'Califica: ' + aprobados.map(x => x.label).join(', ') : 'No califica en: ' + consultados.map(x => x.label).join(', ')) + (obs ? ' — ' + obs : '')
      params.push(nota); sets.push(`observaciones=TRIM(BOTH E'\\n' FROM COALESCE(observaciones,'') || E'\\n' || $${params.length})`)
      params.push(sol.cliente_id)
      await pool.query(`UPDATE clientes_busqueda SET ${sets.join(',')}, updated_at=NOW() WHERE id=$${params.length}`, params)
        .catch(e => console.error('[kommo] actualizar cliente:', e.message))
    }

    // mandar a Kommo
    let kommoOk = false, kommoError = ''
    if (sol.lead_id && kommoListo()) {
      try {
        await notaEnLead(sol.lead_id, texto)
        await actualizarLead(sol.lead_id, califica, califica ? 'Califica: ' + aprobados.map(x => x.label).join(', ') : 'No califica')
        kommoOk = true
      } catch (e) { kommoError = e.message; console.error('[kommo] resultado:', e.message) }
    }
    // Sin KOMMO_TOKEN, Ruthina no escribe en Kommo: el bot se entera por /api/bot/calificar (o callback_url).
    // No es un error, así que no se marca nada.

    const up = await pool.query(
      `UPDATE calificaciones_kommo SET estado='resuelto', resultados=$1, resultado=$2, observaciones=$3, resuelto_por=$4,
         kommo_error=$5, resuelto_at=NOW(), updated_at=NOW() WHERE id=$6 RETURNING *`,
      [JSON.stringify(resultados), resultado, obs, automatico ? 'Ruthina (automático)' : quien, kommoError, sol.id])

    if (up.rows[0] && up.rows[0].callback_url) avisarCallback(up.rows[0])
    return { ok: true, resultado, kommo_enviado: kommoOk, kommo_error: kommoError, texto, pedido: up.rows[0] }
  }

  // cargar el resultado a mano desde el panel → se guarda en Ruthina y se manda a Kommo
  app.post('/api/calificaciones/:id/resultado', async (req, res) => {
    try {
      const b = req.body || {}
      const sel = await pool.query(`SELECT * FROM calificaciones_kommo WHERE id=$1`, [req.params.id])
      if (!sel.rows.length) return res.status(404).json({ error: 'No existe el pedido' })
      if (sel.rows[0].estado === 'resuelto') return res.status(409).json({ error: 'Este pedido ya se resolvió (quizás automáticamente). Actualizá la lista.' })
      const r = await resolverPedido(sel.rows[0], b, String(b.observaciones || '').trim(), String(b.vendedor || '').trim(), false)
      res.json(r)
    } catch (e) { res.status(e.status || 500).json({ error: e.message }) }
  })

  // ═════════════════════════════════════════════════════════════════════════
  //  CONSULTA AUTOMÁTICA en Consulta Créditos mientras las sesiones estén abiertas
  // ═════════════════════════════════════════════════════════════════════════
  const auto = { corriendo: false, ultimoChequeo: null, sesiones: {}, error: '', consultandoAhora: '' }
  const MAX_INTENTOS = 2

  function bancoListo(id, s) {
    if (!s) return false
    if (id === 'decreditos' && s.modo === 'extension') return false   // la extensión solo corre en el navegador
    return s.estado === 'conectado'
  }
  // bancos que hay que esperar para poder decir "no califica" (los que no están configurados no cuentan)
  function bancoCuenta(id, s) {
    if (!s) return true
    if (s.estado === 'no_configurado') return false
    if (id === 'decreditos' && s.modo === 'extension') return false
    return true
  }

  function resumenAuto(ar, sesiones) {
    return BANCOS.map(bk => {
      const r = ar[bk.key]
      if (r && r.estado && r.estado !== 'ERROR') return `${bk.label}: ${r.estado}${r.monto ? ' $' + r.monto : ''}`
      if (r && r.estado === 'ERROR' && (r.intentos || 0) >= MAX_INTENTOS) return `${bk.label}: error (${String(r.error || '').slice(0, 60)})`
      if (r && r.estado === 'ERROR') return `${bk.label}: falló, se reintenta`
      if (!bancoCuenta(bk.key, sesiones[bk.key])) return null
      if (!bancoListo(bk.key, sesiones[bk.key])) return `${bk.label}: esperando sesión`
      return `${bk.label}: en cola`
    }).filter(Boolean).join(' · ')
  }

  async function consultarBancoAuto(sol, id) {
    try {
      const r = await bancosApi('/api/consultar', {
        method: 'POST', timeout: 6 * 60 * 1000,
        body: { banco: id, cuit: sol.cuil, vendedor: 'Kommo (automático)' }
      })
      if (r.ok && r.data && r.data.estado) {
        return { estado: r.data.estado, monto: r.data.monto || '', cliente: r.data.cliente || '', resumen: r.data.resumen || r.data.nota || '',
                 captura: r.data.captura || '', fecha: new Date().toISOString() }
      }
      return { estado: 'ERROR', error: (r.data && r.data.error) || ('HTTP ' + r.status), fecha: new Date().toISOString() }
    } catch (e) {
      return { estado: 'ERROR', error: e.message, fecha: new Date().toISOString() }
    }
  }

  async function guardarAuto(id, ar, msg) {
    await pool.query(`UPDATE calificaciones_kommo SET auto_resultados=$1, auto_msg=$2, updated_at=NOW() WHERE id=$3`,
      [JSON.stringify(ar), msg, id])
  }

  async function cicloAuto() {
    if (auto.corriendo || !autoActiva()) return
    auto.corriendo = true
    try {
      const est = await bancosApi('/api/estado')
      if (!est.ok) throw new Error('Consulta Créditos respondió ' + est.status)
      auto.sesiones = (est.data && est.data.sesiones) || {}
      auto.ultimoChequeo = new Date().toISOString()
      auto.error = ''

      const pedidos = await pool.query(
        `SELECT * FROM calificaciones_kommo WHERE estado IN ('pendiente','en_proceso') AND LENGTH(cuil)=11 ORDER BY created_at ASC LIMIT 10`)
      for (const sol of pedidos.rows) {
        const ar = sol.auto_resultados || {}
        const faltan = BANCOS.map(b => b.key).filter(k => {
          const r = ar[k]
          const pendiente = !r || (r.estado === 'ERROR' && (r.intentos || 0) < MAX_INTENTOS)
          return pendiente && bancoListo(k, auto.sesiones[k])
        })

        if (faltan.length) {
          if (sol.estado === 'pendiente') {
            await pool.query(`UPDATE calificaciones_kommo SET estado='en_proceso', tomado_por='Ruthina (automático)' WHERE id=$1 AND estado='pendiente'`, [sol.id])
          }
          auto.consultandoAhora = `${formatearCuil(sol.cuil)} en ${faltan.join(', ')}`
          await guardarAuto(sol.id, ar, 'Consultando automáticamente: ' + faltan.map(k => BANCOS.find(b => b.key === k).label).join(', ') + '…')
          console.log(`[auto-bancos] pedido ${sol.id} · CUIL ${sol.cuil} → ${faltan.join(', ')}`)
          const res = await Promise.all(faltan.map(k => consultarBancoAuto(sol, k)))
          faltan.forEach((k, i) => {
            const nuevo = res[i]
            if (nuevo.estado === 'ERROR') nuevo.intentos = ((ar[k] && ar[k].intentos) || 0) + 1
            ar[k] = nuevo
          })
          auto.consultandoAhora = ''
        }

        // ¿se puede cerrar solo?
        const actual = await pool.query(`SELECT * FROM calificaciones_kommo WHERE id=$1`, [sol.id])
        if (!actual.rows.length || !['pendiente', 'en_proceso'].includes(actual.rows[0].estado)) continue   // lo cerró un vendedor mientras tanto

        const aprobado = BANCOS.some(b => ar[b.key] && estadoForm(ar[b.key].estado) === 'aprobado')
        const cuentan = BANCOS.filter(b => bancoCuenta(b.key, auto.sesiones[b.key]))
        const todosRechazan = cuentan.length > 0 && cuentan.every(b => ar[b.key] && ar[b.key].estado === 'DENEGADO')

        if (aprobado || todosRechazan) {
          const entrada = {}
          BANCOS.forEach(b => {
            const r = ar[b.key]
            entrada[b.key] = r ? { estado: estadoForm(r.estado), monto: montoEntero(r.monto) } : { estado: 'no_consultado' }
          })
          const notas = BANCOS.filter(b => ar[b.key] && (ar[b.key].estado === 'REVISAR' || ar[b.key].estado === 'PREAPROBADO'))
            .map(b => `${b.label}: ${ar[b.key].estado === 'PREAPROBADO' ? 'pre-aprobado' : 'revisar'}${ar[b.key].resumen ? ' (' + String(ar[b.key].resumen).slice(0, 120) + ')' : ''}`)
          const cliente = (BANCOS.map(b => ar[b.key] && ar[b.key].cliente).find(Boolean)) || ''
          const obs = [cliente ? 'Titular: ' + cliente : '', ...notas].filter(Boolean).join(' · ')
          await guardarAuto(sol.id, ar, resumenAuto(ar, auto.sesiones))
          const r = await resolverPedido(actual.rows[0], entrada, obs, '', true)
          console.log(`[auto-bancos] pedido ${sol.id} cerrado: ${r.resultado}${r.kommo_enviado ? ' (enviado a Kommo)' : ' — Kommo: ' + r.kommo_error}`)
        } else {
          // queda abierto con lo que se sabe; si nadie lo está consultando, vuelve a pendiente para un vendedor
          const msg = resumenAuto(ar, auto.sesiones)
          await guardarAuto(sol.id, ar, msg)
          if (actual.rows[0].tomado_por === 'Ruthina (automático)') {
            await pool.query(`UPDATE calificaciones_kommo SET estado='pendiente', tomado_por='' WHERE id=$1 AND tomado_por='Ruthina (automático)'`, [sol.id])
          }
        }
      }
    } catch (e) {
      auto.error = e.message
      if (!/ECONNREFUSED|ENOTFOUND|timeout/i.test(e.message)) console.error('[auto-bancos]', e.message)
    } finally {
      auto.corriendo = false
      auto.consultandoAhora = ''
    }
  }
  setInterval(cicloAuto, Math.max(10, Number(process.env.CONSULTA_INTERVALO_SEG || 30)) * 1000)
  setTimeout(cicloAuto, 8000)
  registrarKommo.cicloAuto = cicloAuto

  // estado de la consulta automática (lo muestra el panel)
  app.get('/api/calificaciones/auto', (req, res) => {
    const sesiones = {}
    BANCOS.forEach(b => {
      const s = auto.sesiones[b.key]
      sesiones[b.key] = !s ? 'desconocido' : (b.key === 'decreditos' && s.modo === 'extension') ? 'extension' : s.estado
    })
    res.json({ activa: autoActiva(), url: bancosUrl(), ultimo_chequeo: auto.ultimoChequeo, error: auto.error,
               consultando: auto.consultandoAhora, sesiones })
  })

  // volver a consultar automáticamente un pedido (borra lo que se sabía)
  app.post('/api/calificaciones/:id/reconsultar', async (req, res) => {
    try {
      await pool.query(`UPDATE calificaciones_kommo SET auto_resultados='{}'::jsonb, auto_msg='' WHERE id=$1 AND estado IN ('pendiente','en_proceso')`, [req.params.id])
      setTimeout(cicloAuto, 200)
      res.json({ ok: true })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // reintentar el envío a Kommo de un pedido ya resuelto
  app.post('/api/calificaciones/:id/reenviar', async (req, res) => {
    try {
      const sel = await pool.query(`SELECT * FROM calificaciones_kommo WHERE id=$1`, [req.params.id])
      if (!sel.rows.length) return res.status(404).json({ error: 'No existe' })
      const s = sel.rows[0]
      if (s.estado !== 'resuelto') return res.status(400).json({ error: 'Todavía no tiene resultado' })
      if (!s.lead_id) return res.status(400).json({ error: 'Sin lead_id de Kommo' })
      const califica = s.resultado === 'califica'
      const aprob = BANCOS.filter(bk => s.resultados && s.resultados[bk.key] && s.resultados[bk.key].estado === 'aprobado').map(x => x.label)
      const texto = `🏦 Calificación bancaria — CUIL ${formatearCuil(s.cuil)}\n` +
        (califica ? `RESULTADO: CALIFICA (${aprob.join(', ')})` : 'RESULTADO: NO CALIFICA') + (s.observaciones ? `\n📝 ${s.observaciones}` : '')
      await notaEnLead(s.lead_id, texto)
      await actualizarLead(s.lead_id, califica, califica ? 'Califica: ' + aprob.join(', ') : 'No califica')
      await pool.query(`UPDATE calificaciones_kommo SET kommo_error='' WHERE id=$1`, [s.id])
      res.json({ ok: true })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // ═════════════════════════════════════════════════════════════════════════
  //  API PARA EL BOT DE KOMMO (habla con el cliente)
  //    POST /api/bot/autos              → qué autos hay en stock
  //    POST /api/bot/calificar          → califica el CUIL en los bancos
  //    GET  /api/bot/calificar/:id      → estado/resultado de una calificación
  //  Clave: header  x-api-key: <RUTHINA_BOT_KEY>   (o ?key=<RUTHINA_BOT_KEY>)
  // ═════════════════════════════════════════════════════════════════════════
  function botClave() { return String(process.env.RUTHINA_BOT_KEY || process.env.KOMMO_WEBHOOK_KEY || '').trim() }
  function botAuth(req, res, next) {
    const k = botClave()
    const dada = String(req.get('x-api-key') || req.query.key || (req.get('authorization') || '').replace(/^Bearer\s+/i, '')).trim()
    if (!k) return res.status(503).json({ ok: false, codigo: 'sin_configurar', error: 'Falta RUTHINA_BOT_KEY en Railway' })
    if (dada !== k) return res.status(401).json({ ok: false, codigo: 'clave_incorrecta', error: 'API key incorrecta' })
    next()
  }
  const esPropio = a => !a.ubicacion || /tutu/i.test(a.ubicacion)

  function autoParaBot(a) {
    const nombre = [a.marca, a.modelo, a.version].filter(Boolean).join(' ')
    const km = a.km ? Number(a.km).toLocaleString('es-AR') + ' km' : ''
    return {
      id: a.id, marca: a.marca || '', modelo: a.modelo || '', version: a.version || '', anio: a.anio || '',
      km: a.km || 0, color: a.color || '', precio: a.precio || '', moneda: a.moneda || 'ARS',
      precio_texto: a.precio ? fmtPrecio(a) : 'Consultar',
      ubicacion: a.ubicacion || 'Tutu Automotores',
      texto: [`${nombre} ${a.anio || ''}`.trim(), km, a.precio ? fmtPrecio(a) : 'precio a consultar'].filter(Boolean).join(' · ')
    }
  }

  function mensajeAutos(busq, lista) {
    if (!lista.length) return `En este momento no tenemos ${busq} disponible. Te anotamos y te avisamos apenas entre uno. ¿Querés que te muestre opciones parecidas?`
    return `Tenemos ${lista.length === 1 ? 'esta opción' : 'estas opciones'} de ${busq}:\n` +
      lista.map((a, i) => `${i + 1}. ${a.texto}`).join('\n') +
      `\n¿Te interesa alguna? Te puedo pasar más fotos y datos.`
  }

  // POST /api/bot/autos   { "auto": "Etios 2018", "anio": "", "limite": 5, "incluir_externos": false }
  app.post('/api/bot/autos', express.json(), botAuth, async (req, res) => {
    try {
      const b = req.body || {}
      const { modelo, anio } = separarAnio(primero(b, ['auto', 'modelo', 'vehiculo', 'busqueda']), primero(b, ['anio', 'año']))
      if (!modelo) return res.status(400).json({ ok: false, codigo: 'falta_auto', error: 'Mandá el auto que busca el cliente en "auto"' })
      const limite = Math.min(Math.max(parseInt(b.limite) || 5, 1), 20)
      let autos = await buscarAutos(modelo, anio)
      if (!(b.incluir_externos === true || b.incluir_externos === 'true' || b.incluir_externos === 'si')) autos = autos.filter(esPropio)
      const lista = autos.slice(0, limite).map(autoParaBot)
      const busq = [modelo, anio].filter(Boolean).join(' ')
      res.json({ ok: true, busqueda: { auto: modelo, anio }, encontrados: autos.length, hay_stock: autos.length > 0,
                 autos: lista, mensaje_cliente: mensajeAutos(busq, lista) })
    } catch (e) { res.status(500).json({ ok: false, codigo: 'error', error: e.message }) }
  })

  // arma la respuesta de calificación para el bot a partir del pedido guardado
  function respuestaCalificacion(sol, extra = {}) {
    const resuelto = sol.estado === 'resuelto'
    const descartado = sol.estado === 'descartado'
    const res = sol.resultados || {}
    const ar = sol.auto_resultados || {}
    const bancos = {}
    BANCOS.forEach(bk => {
      if (resuelto) {
        const r = res[bk.key] || {}
        bancos[bk.key] = { estado: r.estado || 'no_consultado', monto: r.monto || '' }
      } else {
        const r = ar[bk.key]
        bancos[bk.key] = r ? { estado: r.estado === 'ERROR' ? 'error' : estadoForm(r.estado) === 'no_consultado' ? 'revisar' : estadoForm(r.estado), monto: montoEntero(r.monto) }
                           : { estado: 'pendiente', monto: '' }
      }
    })
    const montos = Object.values(bancos).map(x => Number(x.monto) || 0)
    const montoMax = Math.max(0, ...montos)
    const nombre = (sol.nombre || '').split(' ')[0]
    let estado = resuelto ? 'resuelto' : descartado ? 'descartado' : 'pendiente'
    let resultado = resuelto ? sol.resultado : null
    let mensaje
    if (resultado === 'califica') {
      mensaje = `¡Buenas noticias${nombre ? ', ' + nombre : ''}! Tenés una línea de crédito disponible para financiar tu auto. Un asesor te contacta para armar la propuesta con las cuotas.`
    } else if (resultado === 'no_califica') {
      mensaje = `${nombre ? nombre + ', p' : 'P'}or ahora los bancos con los que trabajamos no tienen una oferta de crédito para tu CUIL. Igual hay otras opciones (contado, permuta o con garante): un asesor te contacta para verlas.`
    } else if (descartado) {
      mensaje = 'Un asesor va a revisar tu consulta y te contacta.'
    } else {
      mensaje = 'Estamos consultando tu CUIL con los bancos. En unos minutos te confirmamos.'
    }
    return {
      ok: true,
      solicitud_id: sol.id,
      estado,                       // pendiente | resuelto | descartado
      resultado,                    // califica | no_califica | null (todavía no)
      califica: resultado === 'califica' ? true : resultado === 'no_califica' ? false : null,
      monto_maximo: montoMax ? String(montoMax) : '',
      bancos,                       // detalle interno por banco (no mandar tal cual al cliente)
      cuil: sol.cuil, cuil_valido: sol.cuil_valido !== false,
      lead_id: sol.lead_id || '',
      detalle: sol.auto_msg || '',
      mensaje_cliente: mensaje,
      consultar_de_nuevo_en_seg: estado === 'pendiente' ? 30 : 0,
      ...extra
    }
  }

  async function avisarCallback(sol) {
    if (!sol.callback_url || !/^(https:\/\/|http:\/\/localhost[:\/])/i.test(sol.callback_url)) return
    try {
      const headers = { 'Content-Type': 'application/json' }
      if (/kommo\.com|amocrm/i.test(sol.callback_url) && process.env.KOMMO_TOKEN) headers.Authorization = 'Bearer ' + process.env.KOMMO_TOKEN
      const r = await fetch(sol.callback_url, { method: 'POST', headers, timeout: 15000,
        body: JSON.stringify({ evento: 'calificacion_lista', ...respuestaCalificacion(sol) }) })
      console.log(`[bot] callback pedido ${sol.id} → ${r.status}`)
    } catch (e) { console.error('[bot] callback:', e.message) }
  }

  // POST /api/bot/calificar
  // { "cuil": "20301234563", "auto": "Etios 2018", "nombre": "Juan", "telefono": "351...", "lead_id": "123",
  //   "esperar_segundos": 20, "callback_url": "https://..." }
  app.post('/api/bot/calificar', express.json(), botAuth, async (req, res) => {
    try {
      const b = req.body || {}
      const cuil = soloDigitos(primero(b, ['cuil', 'cuit', 'CUIL', 'CUIT']))
      if (cuil.length !== 11) {
        return res.status(400).json({ ok: false, codigo: 'cuil_invalido',
          error: 'El CUIL tiene que tener 11 números',
          mensaje_cliente: 'Para consultar tu crédito necesito tu CUIL completo (11 números, por ejemplo 20-12345678-3). Lo encontrás en tu recibo de sueldo o en la web de ANSES.' })
      }
      if (!validarCuil(cuil)) {
        return res.status(400).json({ ok: false, codigo: 'cuil_invalido',
          error: 'El CUIL no pasa la validación (dígito verificador)',
          mensaje_cliente: 'Ese CUIL no parece correcto. ¿Me lo pasás de nuevo? Son 11 números, por ejemplo 20-12345678-3.' })
      }

      // si ya se calificó hace poco, se devuelve ese resultado sin volver a consultar los bancos
      const horas = Math.max(0, Number(process.env.BOT_CACHE_HORAS || 24))
      if (horas && !(b.forzar === true || b.forzar === 'true')) {
        const prev = await pool.query(
          `SELECT * FROM calificaciones_kommo WHERE cuil=$1 AND estado='resuelto' AND resuelto_at > NOW() - ($2 || ' hours')::interval
           ORDER BY resuelto_at DESC LIMIT 1`, [cuil, String(horas)])
        if (prev.rows.length) return res.json(respuestaCalificacion(prev.rows[0], { desde_cache: true }))
      }

      const r = await procesarPedido({
        cuil,
        auto: primero(b, ['auto', 'auto_buscado', 'modelo', 'vehiculo']),
        anio: primero(b, ['anio', 'año']),
        nombre: primero(b, ['nombre', 'name']),
        telefono: primero(b, ['telefono', 'phone', 'celular']),
        lead_id: primero(b, ['lead_id', 'leadId', 'lead']),
        vendedor: primero(b, ['vendedor', 'responsable']),
        callback_url: /^(https:\/\/|http:\/\/localhost[:\/])/i.test(String(b.callback_url || '')) ? String(b.callback_url) : '',
        origen: 'bot',
        sinAuto: true
      })
      if (r.solicitud && r.solicitud.lead_id && kommoListo() && !r.reutilizado) {
        notaEnLead(r.solicitud.lead_id, r.texto).catch(e => console.error('[bot] nota:', e.message))
      }

      // esperar un rato por si los bancos contestan rápido
      const esperar = Math.min(Math.max(parseInt(b.esperar_segundos) || 0, 0), 25)
      let sol = r.solicitud
      const hasta = Date.now() + esperar * 1000
      while (esperar && sol.estado !== 'resuelto' && Date.now() < hasta) {
        await new Promise(ok => setTimeout(ok, 1500))
        const q = await pool.query(`SELECT * FROM calificaciones_kommo WHERE id=$1`, [sol.id])
        if (q.rows.length) sol = q.rows[0]
      }

      const autos = (r._autos || []).filter(esPropio).slice(0, 5).map(autoParaBot)
      const extra = { reutilizado: r.reutilizado }
      if (r.busqueda && r.busqueda.auto) {
        extra.autos = autos
        extra.hay_stock = autos.length > 0
        extra.mensaje_autos = mensajeAutos([r.busqueda.auto, r.busqueda.anio].filter(Boolean).join(' '), autos)
      }
      res.json(respuestaCalificacion(sol, extra))
    } catch (e) { res.status(e.status || 500).json({ ok: false, codigo: 'error', error: e.message }) }
  })

  // GET /api/bot/calificar/:id      (o /api/bot/calificar?cuil=20301234563)
  async function leerCalificacion(req, res) {
    try {
      let q
      if (req.params.id) q = await pool.query(`SELECT * FROM calificaciones_kommo WHERE id=$1`, [parseInt(req.params.id) || 0])
      else {
        const cuil = soloDigitos(req.query.cuil)
        if (cuil.length !== 11) return res.status(400).json({ ok: false, codigo: 'cuil_invalido', error: 'Mandá ?cuil= con 11 números o el id' })
        q = await pool.query(`SELECT * FROM calificaciones_kommo WHERE cuil=$1 ORDER BY created_at DESC LIMIT 1`, [cuil])
      }
      if (!q.rows.length) return res.status(404).json({ ok: false, codigo: 'no_existe', error: 'No hay una calificación con ese dato' })
      res.json(respuestaCalificacion(q.rows[0]))
    } catch (e) { res.status(500).json({ ok: false, codigo: 'error', error: e.message }) }
  }
  app.get('/api/bot/calificar/:id', botAuth, leerCalificacion)
  app.get('/api/bot/calificar', botAuth, leerCalificacion)
}
