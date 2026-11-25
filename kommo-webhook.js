// ═══════════════════════════════════════════════════════════════════════════
//  RUTHINA ⇄ KOMMO — Webhook para pedir autos y calificar clientes por banco
// ───────────────────────────────────────────────────────────────────────────
//  Kommo manda CUIL + auto que busca el cliente  →  Ruthina:
//    1. Busca el auto en el stock y lo devuelve (y lo deja como nota en el lead)
//    2. NO crea leads en Ruthina (Kommo ya tiene el lead; así no se duplican). El pedido queda en "Pedidos Kommo".
//       Para volver al comportamiento viejo (crear el lead en Match → Clientes cargados): KOMMO_CREAR_LEADS=si
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
//    CONSULTA_ROBOT_CLAVE     la ROBOT_CLAVE de Consulta Créditos. Con esto, los bancos que se consultan con la
//                             extensión de Chrome (Galicia, Santander, decreditos) los consulta la PC robot
//                             (la app abierta en …/?robot=1). Sin esto, esos bancos quedan para hacer a mano.
// ═══════════════════════════════════════════════════════════════════════════

const fetch = require('node-fetch')
const express = require('express')

const BANCOS = [
  { key: 'bancor',     label: 'Bancor',      monto: 'monto_bancor' },
  { key: 'nacion',     label: 'Nación',      monto: 'monto_nacion' },
  { key: 'galicia',    label: 'Galicia',     monto: 'monto_galicia' },
  { key: 'decreditos', label: 'decreditos',  monto: 'monto_decreditos' },
  { key: 'santander',  label: 'Santander',   monto: 'monto_santander' }
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


// ── CUIL a partir de DNI + sexo (regla de AFIP) ──────────────────────────────
//   hombre → 20, mujer → 27; si el dígito verificador da 10, el prefijo pasa a 23 y se recalcula
function cuilDesdeDni(dni, sexo) {
  const d = soloDigitos(dni)
  if (d.length < 7 || d.length > 8) return ''
  const num = d.padStart(8, '0')
  const w = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2]
  const calc = pre => { const b = pre + num; const r = 11 - (w.reduce((a, x, i) => a + x * Number(b[i]), 0) % 11); return r === 11 ? 0 : r }
  let pre = sexo === 'F' ? '27' : '20'
  let dv = calc(pre)
  if (dv === 10) { pre = '23'; dv = calc(pre) }
  return pre + num + dv
}
function normalizarSexo(v) {
  const t = String(v || '').trim().toLowerCase()
  if (/^(f|femenino|mujer|female|ella)$/.test(t)) return 'F'
  if (/^(m|masculino|hombre|varon|varón|male|el)$/.test(t)) return 'M'
  return ''
}
// Si el bot no pudo deducir el sexo por la charla, se intenta con el nombre de pila
const NOMBRES_F = new Set(('maria ana laura carolina florencia lucia sofia valeria natalia romina gabriela claudia silvia patricia mariana paula veronica andrea camila julieta agustina micaela belen daniela vanesa vanessa noelia sandra marta graciela susana alejandra cecilia celeste carla soledad lorena yamila jazmin milagros rocio ayelen lucrecia analia elena rosa norma liliana monica adriana fernanda marcela cintia cynthia melina brenda antonella candela maite mercedes ines beatriz carmen luz sol miriam ariana abril delfina emilia guadalupe isabel josefina karina leticia magali mara nadia olga pilar rita ruth sabrina stella tamara teresa victoria viviana yesica zoe').split(' '))
const NOMBRES_M = new Set(('juan jose carlos luis miguel jorge pedro marcos martin diego javier fernando sergio daniel ricardo roberto eduardo gustavo pablo matias nicolas lucas facundo agustin santiago mateo tomas franco gonzalo ezequiel ramiro leandro alejandro cristian maximiliano hernan ariel walter hugo oscar raul rodrigo federico emiliano ivan damian julio cesar mario nestor ruben omar claudio osvaldo leonardo lautaro joaquin benjamin bruno dante enzo gaston horacio jonatan lisandro marcelo mauro nahuel ramon sebastian thiago ulises victor david adrian alberto andres antonio armando bautista cristobal edgardo emanuel esteban fabian felipe gerardo guillermo hector ignacio jeremias kevin luciano manuel marcelo patricio rafael ricardo salvador tobias valentin').split(' '))
function inferirSexo(nombre) {
  const n = String(nombre || '').trim().split(/\s+/)[0] || ''
  const t = n.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '')
  if (t.length < 3) return ''
  if (NOMBRES_F.has(t)) return 'F'
  if (NOMBRES_M.has(t)) return 'M'
  if (/(luca|nicola|joshua|bautista)$/.test(t)) return 'M'
  if (/a$/.test(t)) return 'F'
  return ''
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
// Robot de Consulta Créditos (PC de la oficina con la extensión): consulta Galicia, Santander y decreditos
function robotClave() { return String(process.env.CONSULTA_ROBOT_CLAVE || '').trim() }
async function robotApi(ruta, opts = {}) {
  const sep = ruta.includes('?') ? '&' : '?'
  const r = await fetch(bancosUrl() + ruta + sep + 'clave=' + encodeURIComponent(robotClave()), {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    timeout: opts.timeout || 20000
  })
  let data = {}
  try { data = await r.json() } catch (e) { data = {} }
  if (r.status === 401) throw new Error('La clave del robot (CONSULTA_ROBOT_CLAVE) no coincide con ROBOT_CLAVE de Consulta Créditos')
  return { ok: r.ok, status: r.status, data }
}
// "30.868.289,50" → "30868289"
const montoEntero = m => soloDigitos(String(m || '').split(',')[0])
// APROBADO / PREAPROBADO / DENEGADO / REVISAR / ERROR  →  estado del formulario
function estadoForm(e) {
  if (e === 'APROBADO' || e === 'PREAPROBADO') return 'aprobado'
  if (e === 'DENEGADO') return 'rechazado'
  if (e === 'REVISAR') return 'rechazado'   // "revisar manualmente" = para el bot es rechazado (queda la nota para el asesor)
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
    // rol del pedido: 'titular' (el cliente) o 'garante' (cotitular / segundo DNI)
    await pool.query(`ALTER TABLE calificaciones_kommo ADD COLUMN IF NOT EXISTS rol TEXT DEFAULT 'titular'`).catch(() => {})
    // id de la consulta en otra app (Club Tutu+ → 'tutuplus:<id>')
    await pool.query(`ALTER TABLE calificaciones_kommo ADD COLUMN IF NOT EXISTS externo_id TEXT DEFAULT ''`).catch(() => {})
    for (const col of ['monto_decreditos', 'gar_galicia', 'gar_bancor', 'gar_nacion', 'gar_santander', 'gar_decreditos', 'gar_bancos', 'gar_cuil', 'rechazados', 'gar_rechazados']) {
      await pool.query(`ALTER TABLE clientes_busqueda ADD COLUMN IF NOT EXISTS ${col} TEXT DEFAULT ''`).catch(() => {})
    }
    // lo que antes se cargaba en "MG" pasa a decreditos
    await pool.query(`UPDATE clientes_busqueda SET monto_decreditos = monto_mg WHERE COALESCE(monto_decreditos,'')='' AND COALESCE(monto_mg,'')<>''`).catch(() => {})
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

  // Por defecto el pedido de Kommo NO crea un lead en Ruthina (Match → Clientes cargados): el lead ya vive en Kommo.
  const crearLeads = () => /^(si|sí|true|1|yes)$/i.test(String(process.env.KOMMO_CREAR_LEADS || ''))

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
    const clienteId = (crearLeads() && !p.sinCliente) ? await guardarCliente(pedido) : null

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
           cliente_id=COALESCE($7::integer, cliente_id), updated_at=NOW()
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
    if (p.rol) sol = await pool.query(`UPDATE calificaciones_kommo SET rol=$1 WHERE id=$2 RETURNING *`, [p.rol, sol.rows[0].id])
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
  // ── Limpieza de leads que ya creó Kommo ─────────────────────────────────
  // Solo toca los que creó el webhook (nota "Pedido desde Kommo"); nunca un lead cargado por el bot o a mano.
  // Se pide con la misma clave del webhook (?key=...). Lo que se borra queda guardado en clientes_borrados_kommo.
  const FILTRO_LEADS_KOMMO = `notas LIKE 'Pedido desde Kommo%'`
  ;(async () => {
    await pool.query(`CREATE TABLE IF NOT EXISTS clientes_borrados_kommo (
      id SERIAL PRIMARY KEY, cliente_id INTEGER, datos JSONB, borrado_en TIMESTAMP DEFAULT NOW())`).catch(e => console.error('clientes_borrados_kommo:', e.message))
  })()
  app.get('/api/kommo/leads-creados', async (req, res) => {
    if (!claveOk(req)) return res.status(401).json({ error: 'Falta ?key=...' })
    try {
      const r = await pool.query(`SELECT id, nombre, telefono, dni, modelo, anio, asesor, vendedor, estado, created_at FROM clientes_busqueda WHERE ${FILTRO_LEADS_KOMMO} ORDER BY created_at DESC`)
      res.json({ cantidad: r.rowCount, leads: r.rows, aviso: 'Para borrarlos: POST /api/kommo/leads-creados/borrar?key=... con {"todos":true} o {"ids":[1,2]}. Quedan guardados y se pueden restaurar.' })
    } catch(e) { res.status(500).json({ error: e.message }) }
  })
  app.post('/api/kommo/leads-creados/borrar', express.json(), async (req, res) => {
    if (!claveOk(req)) return res.status(401).json({ error: 'Falta ?key=...' })
    try {
      const b = req.body || {}
      const ids = Array.isArray(b.ids) ? b.ids.map(Number).filter(Number.isInteger) : null
      if (!b.todos && !(ids && ids.length)) return res.status(400).json({ error: 'Mandá {"todos":true} o {"ids":[...]}' })
      const sel = await pool.query(`SELECT id FROM clientes_busqueda WHERE ${FILTRO_LEADS_KOMMO}` + (b.todos ? '' : ' AND id = ANY($1::int[])'), b.todos ? [] : [ids])
      const lista = sel.rows.map(x => x.id)
      if (!lista.length) return res.json({ ok: true, borrados: 0 })
      await pool.query(
        `WITH del AS (DELETE FROM clientes_busqueda WHERE id = ANY($1::int[]) AND ${FILTRO_LEADS_KOMMO} RETURNING *)
         INSERT INTO clientes_borrados_kommo (cliente_id, datos) SELECT id, to_jsonb(del) FROM del`, [lista])
      await pool.query(`UPDATE calificaciones_kommo SET cliente_id = NULL WHERE cliente_id = ANY($1::int[])`, [lista])
      res.json({ ok: true, borrados: lista.length })
    } catch(e) { res.status(500).json({ error: e.message }) }
  })
  app.post('/api/kommo/leads-creados/restaurar', express.json(), async (req, res) => {
    if (!claveOk(req)) return res.status(401).json({ error: 'Falta ?key=...' })
    try {
      const horas = Math.min(Math.max(Number(req.body && req.body.horas) || 48, 1), 24 * 90)
      const r = await pool.query(
        `WITH rest AS (DELETE FROM clientes_borrados_kommo WHERE borrado_en > NOW() - ($1 || ' hours')::interval RETURNING datos)
         INSERT INTO clientes_busqueda SELECT (jsonb_populate_record(NULL::clientes_busqueda, datos)).* FROM rest ON CONFLICT (id) DO NOTHING`, [String(horas)])
      res.json({ ok: true, restaurados: r.rowCount, horas })
    } catch(e) { res.status(500).json({ error: e.message }) }
  })

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
  async function resolverPedido(sol, entrada, obs, quien, automatico, forzar) {
    const resultados = {}
    BANCOS.forEach(bk => {
      const v = entrada[bk.key] || {}
      const estado = ['aprobado', 'rechazado'].includes(v.estado) ? v.estado : 'no_consultado'
      resultados[bk.key] = { estado, monto: estado === 'aprobado' ? soloDigitos(v.monto) : '' }
    })
    const consultados = BANCOS.filter(bk => resultados[bk.key].estado !== 'no_consultado')
    if (!consultados.length && !forzar) { const e = new Error('Marcá el resultado de al menos un banco'); e.status = 400; throw e }
    const aprobados = BANCOS.filter(bk => resultados[bk.key].estado === 'aprobado')
    const califica = aprobados.length > 0
    const resultado = califica ? 'califica' : 'no_califica'

    const lineas = BANCOS.map(bk => {
      const r = resultados[bk.key]
      if (r.estado === 'aprobado') return `✅ ${bk.label}: APROBADO${r.monto ? ' hasta $ ' + Number(r.monto).toLocaleString('es-AR') : ''}`
      if (r.estado === 'rechazado') return `❌ ${bk.label}: rechazado`
      return `➖ ${bk.label}: ${forzar ? 'sin respuesta' : 'no consultado'}`
    })
    const texto = `🏦 Calificación bancaria — CUIL ${formatearCuil(sol.cuil)}\n` +
      (califica ? `RESULTADO: CALIFICA (${aprobados.map(x => x.label).join(', ')})` : !consultados.length ? 'RESULTADO: SIN RESPUESTA — ningún banco alcanzó a contestar en el tiempo límite' : 'RESULTADO: NO CALIFICA en los bancos consultados') +
      `\n${lineas.join('\n')}` + (obs ? `\n📝 ${obs}` : '') +
      (automatico ? '\n🤖 Consultado automáticamente por Ruthina' : (quien ? `\n👤 Consultó: ${quien}` : ''))

    // actualizar el cliente en Ruthina (el titular en sus casilleros; el garante en los suyos)
    const esGarante = sol.rol === 'garante'
    if (sol.cliente_id) {
      const sets = [], params = []
      BANCOS.forEach(bk => {
        if (bk.monto && resultados[bk.key].estado === 'aprobado' && resultados[bk.key].monto) {
          params.push(resultados[bk.key].monto); sets.push(`${esGarante ? 'gar_' + bk.key : bk.monto}=$${params.length}`)
        }
      })
      // bancos que rechazaron: se marcan en rojo en la tarjeta (y se borra un monto viejo de ese banco)
      BANCOS.forEach(bk => {
        if (bk.monto && resultados[bk.key].estado === 'rechazado') sets.push(`${esGarante ? 'gar_' + bk.key : bk.monto}=''`)
      })
      params.push(BANCOS.filter(bk => resultados[bk.key].estado === 'rechazado').map(bk => bk.key).join(',')); sets.push(`${esGarante ? 'gar_rechazados' : 'rechazados'}=$${params.length}`)
      params.push(aprobados.map(x => x.label).join(', ')); sets.push(`${esGarante ? 'gar_bancos' : 'bancos'}=$${params.length}`)
      if (!esGarante) {
        if (califica) { params.push('sirve'); sets.push(`calificacion=$${params.length}`) }
        else if (automatico && consultados.length) { params.push('no_sirve'); sets.push(`calificacion=$${params.length}`) }
      }
      const nota = `[${esGarante ? 'Garante ' + formatearCuil(sol.cuil) + ' · bancos' : 'Bancos'} ${new Date().toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })}] ` +
        (califica ? 'Califica: ' + aprobados.map(x => x.label).join(', ') : !consultados.length ? 'Sin respuesta de los bancos en el tiempo límite' : 'No califica en: ' + consultados.map(x => x.label).join(', ')) + (obs ? ' — ' + obs : '')
      params.push(nota); sets.push(`observaciones=TRIM(BOTH E'\\n' FROM COALESCE(observaciones,'') || E'\\n' || $${params.length})`)
      params.push(sol.cliente_id)
      await pool.query(`UPDATE clientes_busqueda SET ${sets.join(',')}, updated_at=NOW() WHERE id=$${params.length}`, params)
        .catch(e => console.error('[kommo] actualizar cliente:', e.message))
    }

    // mandar a Kommo
    let kommoOk = false, kommoError = ''
    if (!esGarante && sol.lead_id && kommoListo() && consultados.length) {
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
  const auto = { corriendo: false, ultimoChequeo: null, sesiones: {}, robot: null, error: '', consultandoAhora: '' }
  const MAX_INTENTOS = 2
  // A los AUTO_LIMITE_MIN minutos de empezar, el pedido se cierra SÍ o SÍ con lo que haya (aprobó 1, varios, o ninguno)
  const AUTO_LIMITE_MIN = Math.max(0.1, Number(process.env.AUTO_LIMITE_MIN || 2))
  // Si el robot no devuelve un banco en este tiempo, cuenta como error (y se reintenta)
  const ROBOT_MAX_MIN = Math.max(5, Number(process.env.CONSULTA_ROBOT_MAX_MIN || 20))

  // Bancos que se consultan con la extensión de Chrome: los hace la PC robot (si está configurada)
  function porRobot(id, s) {
    return !!s && s.modo === 'extension' && !!robotClave() && !!(auto.robot && auto.robot.configurado)
  }
  function bancoListo(id, s) {
    if (!s) return false
    if (s.modo === 'extension') return porRobot(id, s)   // la extensión solo corre en el navegador: va por el robot
    return s.estado === 'conectado'
  }
  // bancos que hay que esperar para poder decir "no califica" (los que no están configurados no cuentan)
  function bancoCuenta(id, s) {
    if (!s) return true
    if (s.estado === 'no_configurado') return false
    if (s.modo === 'extension') return porRobot(id, s)
    return true
  }

  function resumenAuto(ar, sesiones) {
    return BANCOS.map(bk => {
      const r = ar[bk.key]
      if (r && r.estado === 'EN_ROBOT') return `${bk.label}: en el robot${auto.robot && !auto.robot.conectado ? ' (la PC robot está apagada)' : ''}`
      if (r && r.estado && r.estado !== 'ERROR') return `${bk.label}: ${r.estado}${r.monto ? ' $' + r.monto : ''}`
      if (r && r.estado === 'ERROR' && (r.intentos || 0) >= MAX_INTENTOS) return `${bk.label}: error (${String(r.error || '').slice(0, 60)})`
      if (r && r.estado === 'ERROR') return `${bk.label}: falló, se reintenta${r.error ? ' (' + String(r.error).slice(0, 80) + ')' : ''}`
      if (!bancoCuenta(bk.key, sesiones[bk.key])) return null
      if (!bancoListo(bk.key, sesiones[bk.key])) return `${bk.label}: esperando sesión`
      return `${bk.label}: en cola`
    }).filter(Boolean).join(' · ')
  }

  async function consultarBancoAuto(sol, id, maxMs) {
    try {
      const r = await bancosApi('/api/consultar', {
        method: 'POST', timeout: Math.max(15000, Math.min(6 * 60 * 1000, maxMs || 6 * 60 * 1000)),
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

  // Tutu+ (Express): mientras la landing espera al robot, el pedido está 'en_proceso' con tomado_por 'Tutu+ …' y Ruthina no lo toca.
  // Cuando llega express_resultado, Ruthina lo toma (tomado_por 'Ruthina (automático)') y lo sigue hasta cerrarlo,
  // incluso los bancos que tuvo que volver a pedirle al robot.
  async function cicloAuto() {
    if (auto.corriendo || !autoActiva()) return
    auto.corriendo = true
    try {
      const est = await bancosApi('/api/estado')
      if (!est.ok) throw new Error('Consulta Créditos respondió ' + est.status)
      auto.sesiones = (est.data && est.data.sesiones) || {}
      auto.robot = (est.data && est.data.robot) || null
      auto.ultimoChequeo = new Date().toISOString()
      auto.error = ''

      const pedidos = await pool.query(
        `SELECT * FROM calificaciones_kommo WHERE estado IN ('pendiente','en_proceso') AND LENGTH(cuil)=11 AND NOT (origen='tutu-plus' AND estado='en_proceso' AND COALESCE(tomado_por,'') LIKE 'Tutu+%') ORDER BY created_at ASC LIMIT 10`)
      auto.pendientes = pedidos.rows.length
      for (const sol of pedidos.rows) {
        const ar = sol.auto_resultados || {}
        if (!ar._inicio) ar._inicio = Date.now()          // arranca el reloj de los 5 minutos la primera vez que Ruthina toma el pedido
        const restanteMs = () => AUTO_LIMITE_MIN * 60000 - (Date.now() - ar._inicio)
        const ahora = () => new Date().toISOString()
        const pendienteK = k => { const r = ar[k]; return !r || (r.estado === 'ERROR' && (r.intentos || 0) < MAX_INTENTOS) }
        const errorK = (k, error) => ({ estado: 'ERROR', error, intentos: ((ar[k] && ar[k].intentos) || 0) + 1, fecha: ahora() })

        // 1) Bancos de la extensión → se los pide al robot de Consulta Créditos (una sola vez por pedido)
        const faltanRobot = BANCOS.map(b => b.key).filter(k => pendienteK(k) && porRobot(k, auto.sesiones[k]))
        if (faltanRobot.length) {
          try {
            const r = await robotApi('/api/robot/consultar', { method: 'POST', body: { cuit: sol.cuil, bancos: faltanRobot.join(',') } })
            if (r.ok && r.data && r.data.id) {
              faltanRobot.forEach(k => { ar[k] = { estado: 'EN_ROBOT', robotId: String(r.data.id), desde: ahora(), intentos: (ar[k] && ar[k].intentos) || 0 } })
              console.log(`[auto-bancos] pedido ${sol.id} · CUIL ${sol.cuil} → robot (${faltanRobot.join(', ')})`)
            } else faltanRobot.forEach(k => { ar[k] = errorK(k, (r.data && r.data.error) || ('HTTP ' + r.status)) })
          } catch (e) { faltanRobot.forEach(k => { ar[k] = errorK(k, e.message) }) }
          if (sol.estado === 'pendiente') {
            await pool.query(`UPDATE calificaciones_kommo SET estado='en_proceso', tomado_por='Ruthina (automático)' WHERE id=$1 AND estado='pendiente'`, [sol.id])
          }
          await guardarAuto(sol.id, ar, resumenAuto(ar, auto.sesiones))
        }

        // 2) Lo que ya terminó el robot
        const idsRobot = [...new Set(BANCOS.map(b => b.key).filter(k => ar[k] && ar[k].estado === 'EN_ROBOT').map(k => ar[k].robotId))]
        for (const rid of idsRobot) {
          const ks = BANCOS.map(b => b.key).filter(k => ar[k] && ar[k].estado === 'EN_ROBOT' && ar[k].robotId === rid)
          try {
            const r = await robotApi('/api/robot/resultado?id=' + encodeURIComponent(rid))
            if (r.status === 404) { ks.forEach(k => { ar[k] = errorK(k, 'Consulta Créditos se reinició y perdió el pedido') }); continue }
            const listo = r.ok && r.data && r.data.estado === 'listo'
            if (r.ok && r.data) {
              // Cada banco apenas el robot lo termina (no hace falta esperar al más lento)
              const hechos = []
              ks.forEach(k => {
                const x = (r.data.resultados || []).find(z => z.banco === k)
                if (!x) { if (listo) ar[k] = errorK(k, 'el robot no consultó este banco'); return }
                if (x.estado === 'ERROR') ar[k] = errorK(k, x.resumen || 'error en el robot')
                else ar[k] = { estado: x.estado, monto: x.monto || '', cliente: x.cliente || '', resumen: x.resumen || x.nota || '', fecha: ahora(), robot: true }
                hechos.push(k + ' ' + ar[k].estado)
              })
              if (hechos.length) console.log(`[auto-bancos] pedido ${sol.id} · robot: ${hechos.join(', ')}`)
            }
            if (!listo) {
              // sigue en la fila del robot: si pasó demasiado tiempo, cuenta como error y se reintenta
              ks.forEach(k => { if (ar[k].estado === 'EN_ROBOT' && Date.now() - new Date(ar[k].desde).getTime() > ROBOT_MAX_MIN * 60000) ar[k] = errorK(k, 'el robot no respondió a tiempo') })
            }
          } catch (e) { /* sin conexión: se vuelve a mirar en la próxima vuelta */ }
        }
        if (idsRobot.length) await guardarAuto(sol.id, ar, resumenAuto(ar, auto.sesiones))

        // 3) Bancos con sesión en el servidor (Bancor, Nación): se consultan directo, como siempre
        const faltan = BANCOS.map(b => b.key).filter(k => pendienteK(k) && bancoListo(k, auto.sesiones[k]) && !porRobot(k, auto.sesiones[k]))

        if (faltan.length) {
          if (sol.estado === 'pendiente') {
            await pool.query(`UPDATE calificaciones_kommo SET estado='en_proceso', tomado_por='Ruthina (automático)' WHERE id=$1 AND estado='pendiente'`, [sol.id])
          }
          auto.consultandoAhora = `${formatearCuil(sol.cuil)} en ${faltan.join(', ')}`
          await guardarAuto(sol.id, ar, 'Consultando automáticamente: ' + faltan.map(k => BANCOS.find(b => b.key === k).label).join(', ') + '…')
          console.log(`[auto-bancos] pedido ${sol.id} · CUIL ${sol.cuil} → ${faltan.join(', ')}`)
          const res = await Promise.all(faltan.map(k => consultarBancoAuto(sol, k, restanteMs())))
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
        const todosRechazan = cuentan.length > 0 && cuentan.every(b => ar[b.key] && ['DENEGADO', 'REVISAR'].includes(ar[b.key].estado))

        const vencido = restanteMs() <= 0
        // Mientras el robot tenga bancos en curso se espera (así el resultado llega completo), salvo que se cumpla el tiempo límite
        const robotEnCurso = BANCOS.some(b => ar[b.key] && ar[b.key].estado === 'EN_ROBOT')
        if (((aprobado || todosRechazan) && !robotEnCurso) || vencido) {
          // Lo que siga en la fila del robot ya no hace falta: se cancela para no atrasar a los pedidos nuevos
          const pendRobot = [...new Set(BANCOS.map(b => b.key).filter(k => ar[k] && ar[k].estado === 'EN_ROBOT').map(k => ar[k].robotId))]
          pendRobot.forEach(rid => robotApi('/api/robot/cancelar?id=' + encodeURIComponent(rid), { method: 'POST', body: {} }).catch(() => {}))
          const entrada = {}
          BANCOS.forEach(b => {
            const r = ar[b.key]
            entrada[b.key] = r ? { estado: estadoForm(r.estado), monto: montoEntero(r.monto) } : { estado: 'no_consultado' }
          })
          const notas = BANCOS.filter(b => ar[b.key] && (ar[b.key].estado === 'REVISAR' || ar[b.key].estado === 'PREAPROBADO'))
            .map(b => `${b.label}: ${ar[b.key].estado === 'PREAPROBADO' ? 'pre-aprobado' : 'revisar'}${ar[b.key].resumen ? ' (' + String(ar[b.key].resumen).slice(0, 120) + ')' : ''}`)
          const cliente = (BANCOS.map(b => ar[b.key] && ar[b.key].cliente).find(Boolean)) || ''
          const sinResp = BANCOS.filter(b => !ar[b.key] || (ar[b.key].estado === 'ERROR') || estadoForm(ar[b.key].estado) === 'no_consultado' && !['REVISAR'].includes(ar[b.key].estado))
            .map(b => b.label + (!bancoListo(b.key, auto.sesiones[b.key]) ? ' (sin sesión abierta)' : ''))
          const nota5 = (!aprobado && !todosRechazan && vencido && sinResp.length) ? `Pasaron ${AUTO_LIMITE_MIN} min: sin respuesta de ${sinResp.join(', ')}` : ''
          const filaT = actual.rows[0]
          const datosTutu = filaT.origen === 'tutu-plus' ? ['Tutu+ (Express)' + (filaT.telefono ? ' · WhatsApp ' + filaT.telefono : ''), filaT.auto ? 'Le interesa: ' + filaT.auto : ''].filter(Boolean).join(' · ') : ''
          const obs = [datosTutu, cliente ? 'Titular: ' + cliente : '', ...notas, nota5].filter(Boolean).join(' · ')
          await guardarAuto(sol.id, ar, resumenAuto(ar, auto.sesiones))
          const r = await resolverPedido(actual.rows[0], entrada, obs, '', true, vencido)
          console.log(`[auto-bancos] pedido ${sol.id} cerrado: ${r.resultado}${r.kommo_enviado ? ' (enviado a Kommo)' : ' — Kommo: ' + r.kommo_error}`)
        } else {
          // queda abierto con lo que se sabe; si nadie lo está consultando, vuelve a pendiente para un vendedor
          const msg = resumenAuto(ar, auto.sesiones)
          await guardarAuto(sol.id, ar, msg)
          if (actual.rows[0].tomado_por === 'Ruthina (automático)' && !robotEnCurso) {
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
  // Mientras haya pedidos abiertos se revisa cada 4 s (para levantar enseguida lo que devuelve la PC robot)
  setInterval(() => { if (auto.pendientes > 0) cicloAuto() }, 4000)
  setTimeout(cicloAuto, 8000)
  registrarKommo.cicloAuto = cicloAuto

  // ═════════════════════════════════════════════════════════════════════════
  //  CALIFICAR SOLO a un cliente cuando se carga su tarjeta en Ruthina
  //  Con el DNI + el sexo (que el bot saca de la charla) se arma el CUIL y se abre
  //  el pedido de calificación; la consulta automática lo resuelve y actualiza la tarjeta.
  //  Se apaga con CALIFICAR_AUTO=no
  // ═════════════════════════════════════════════════════════════════════════
  async function notaEnTarjeta(clienteId, texto) {
    if (!clienteId) return
    await pool.query(
      `UPDATE clientes_busqueda SET observaciones=TRIM(BOTH E'\\n' FROM COALESCE(observaciones,'') || E'\\n' || $1), updated_at=NOW() WHERE id=$2`,
      [texto, clienteId]).catch(e => console.error('[auto-calificar] nota:', e.message))
  }
  async function calificarTitular(p) {
    if (/^(no|false|0)$/i.test(String(process.env.CALIFICAR_AUTO || ''))) return { ok: false, motivo: 'apagado' }
    const dni = soloDigitos(p.dni)
    if (dni.length < 7) return { ok: false, motivo: 'sin_dni' }
    if (dni.length > 8 && dni.length !== 11) return { ok: false, motivo: 'dni_invalido' }
    // no repetir: si esta tarjeta ya tiene un pedido de calificación, no se abre otro
    if (p.clienteId) {
      const ex = await pool.query(`SELECT id, estado FROM calificaciones_kommo WHERE cliente_id=$1 AND COALESCE(rol,'titular')='titular' ORDER BY created_at DESC LIMIT 1`, [p.clienteId])
      if (ex.rows.length) return { ok: true, ya_existia: true, solicitud_id: ex.rows[0].id }
    }
    let cuil, sexo = '', via = ''
    if (dni.length === 11) { cuil = dni; via = 'CUIL cargado' }
    else {
      sexo = normalizarSexo(p.sexo); via = 'sexo deducido de la charla'
      if (!sexo) { sexo = inferirSexo(p.nombre); via = 'sexo deducido por el nombre' }
      if (!sexo) {
        await notaEnTarjeta(p.clienteId, '🏦 No se calificó solo: no se pudo saber si es hombre o mujer para armar el CUIL. Cargá el CUIL completo en el campo DNI (11 números).')
        return { ok: false, motivo: 'sin_sexo' }
      }
      cuil = cuilDesdeDni(dni, sexo)
    }
    const r = await procesarPedido({
      cuil, auto: p.modelo || '', anio: p.anio || '', nombre: p.nombre || '', telefono: p.telefono || '',
      vendedor: p.vendedor || '', origen: 'ruthina-auto', sinAuto: true
    })
    if (p.clienteId && r.solicitud) await pool.query(`UPDATE calificaciones_kommo SET cliente_id=$1 WHERE id=$2`, [p.clienteId, r.solicitud.id])
    await notaEnTarjeta(p.clienteId, `🏦 Calificación automática pedida — CUIL ${formatearCuil(cuil)}${sexo ? ' (' + (sexo === 'F' ? 'mujer' : 'hombre') + ', ' + via + ')' : ''}. ` +
      (autoActiva() ? 'Ruthina consulta los bancos y deja el resultado acá.' : 'Pendiente en Pedidos Kommo (la consulta automática está apagada).') +
      (sexo && via.includes('nombre') ? ' ⚠️ Verificá el CUIL: el sexo se dedujo por el nombre.' : ''))
    console.log(`[auto-calificar] cliente ${p.clienteId || '-'} → CUIL ${cuil} (${via})`)
    return { ok: true, solicitud_id: r.solicitud && r.solicitud.id, cuil }
  }
  // Garante / cotitular (segundo DNI): se consulta en los mismos bancos y el resultado va a SUS casilleros en la tarjeta
  async function calificarGarante(p) {
    if (/^(no|false|0)$/i.test(String(process.env.CALIFICAR_AUTO || ''))) return { ok: false, motivo: 'apagado' }
    if (!/^(si|sí|true|yes|1)$/i.test(String(p.tiene_garantes || '')) && !p.dni_garante) return { ok: false, motivo: 'sin_garante' }
    const limpio = String(p.dni_garante || '').replace(/(\d)[.\s](?=\d{3}\b)/g, '$1')
    const m = limpio.match(/\d{7,11}/)
    if (!m) return { ok: false, motivo: 'sin_dni_garante' }
    const dni = m[0]
    if (dni.length > 8 && dni.length !== 11) return { ok: false, motivo: 'dni_garante_invalido' }
    const nombreG = String(p.nombre_garante || '').split(/[,;]/)[0].trim()
    let cuil, sexo = ''
    if (dni.length === 11) cuil = dni
    else {
      sexo = normalizarSexo(p.sexo_garante) || inferirSexo(nombreG)
      if (!sexo) {
        await notaEnTarjeta(p.clienteId, `🏦 Garante (DNI ${dni}): no se calificó solo porque no se pudo saber si es hombre o mujer. Cargá su CUIL completo (11 números) en "DNI del garante".`)
        return { ok: false, motivo: 'sin_sexo_garante' }
      }
      cuil = cuilDesdeDni(dni, sexo)
    }
    if (p.clienteId) {
      const ex = await pool.query(`SELECT id FROM calificaciones_kommo WHERE cliente_id=$1 AND rol='garante' AND cuil=$2 LIMIT 1`, [p.clienteId, cuil])
      if (ex.rows.length) return { ok: true, ya_existia: true, solicitud_id: ex.rows[0].id }
    }
    const r = await procesarPedido({
      cuil, auto: p.modelo || '', anio: p.anio || '', nombre: nombreG ? `${nombreG} (garante de ${p.nombre || 'cliente'})` : `Garante de ${p.nombre || 'cliente'}`,
      telefono: '', vendedor: p.vendedor || '', origen: 'ruthina-auto', sinAuto: true, sinCliente: true, rol: 'garante'
    })
    if (p.clienteId && r.solicitud) await pool.query(`UPDATE calificaciones_kommo SET cliente_id=$1 WHERE id=$2`, [p.clienteId, r.solicitud.id])
    if (p.clienteId) await pool.query(`UPDATE clientes_busqueda SET gar_cuil=$1 WHERE id=$2`, [cuil, p.clienteId]).catch(() => {})
    await notaEnTarjeta(p.clienteId, `🏦 Garante: calificación automática pedida — CUIL ${formatearCuil(cuil)}${sexo ? ' (' + (sexo === 'F' ? 'mujer' : 'hombre') + ')' : ''}. El resultado queda en la fila "Garante".`)
    console.log(`[auto-calificar] cliente ${p.clienteId || '-'} garante → CUIL ${cuil}`)
    return { ok: true, solicitud_id: r.solicitud && r.solicitud.id, cuil }
  }
  async function calificarCliente(p) {
    const titular = await calificarTitular(p).catch(e => { console.error('[auto-calificar] titular:', e.message); return { ok: false, motivo: 'error' } })
    const garante = await calificarGarante(p).catch(e => { console.error('[auto-calificar] garante:', e.message); return { ok: false, motivo: 'error' } })
    return Object.assign({}, titular, { garante })
  }
  registrarKommo.calificarCliente = calificarCliente

  // estado de la consulta automática (lo muestra el panel)
  app.get('/api/calificaciones/auto', (req, res) => {
    const sesiones = {}
    BANCOS.forEach(b => {
      const s = auto.sesiones[b.key]
      sesiones[b.key] = !s ? 'desconocido'
        : s.modo === 'extension' ? (porRobot(b.key, s) ? (auto.robot && auto.robot.conectado ? 'robot' : 'robot_apagado') : 'extension')
        : s.estado
    })
    const robotInfo = () => auto.robot ? { configurado: !!auto.robot.configurado && !!robotClave(), conectado: !!auto.robot.conectado, enCola: auto.robot.enCola || 0 } : null
    extensionesEstado().then(extensiones => {
      res.json({ activa: autoActiva(), url: bancosUrl(), ultimo_chequeo: auto.ultimoChequeo, error: auto.error,
                 consultando: auto.consultandoAhora, sesiones, extensiones, robot: robotInfo() })
    }).catch(() => res.json({ activa: autoActiva(), url: bancosUrl(), ultimo_chequeo: auto.ultimoChequeo, error: auto.error,
                 consultando: auto.consultandoAhora, sesiones, extensiones: [], robot: robotInfo() }))
  })

  // ── PC "robot" con las extensiones de Chrome: la extensión avisa cada ~30 s que está viva ──
  //    POST /api/extension/latido   (header x-clave = CONSULTA_BANCOS_CLAVE)
  //    { "pc": "Oficina", "bancos": ["galicia","decreditos"], "version": "1.2", "detalle": "texto opcional" }
  const EXTENSION_TIMEOUT_SEG = Math.max(30, Number(process.env.EXTENSION_TIMEOUT_SEG || 90))
  pool.query(`CREATE TABLE IF NOT EXISTS extension_latidos (
    pc TEXT PRIMARY KEY, bancos JSONB DEFAULT '[]'::jsonb, version TEXT DEFAULT '', detalle TEXT DEFAULT '', visto TIMESTAMP DEFAULT NOW())`)
    .catch(e => console.error('extension_latidos:', e.message))
  async function extensionesEstado() {
    const r = await pool.query(`SELECT pc, bancos, version, detalle, visto, EXTRACT(EPOCH FROM (NOW() - visto))::int AS segundos FROM extension_latidos ORDER BY pc`)
    return r.rows.map(x => ({ pc: x.pc, bancos: x.bancos || [], version: x.version, detalle: x.detalle, visto: x.visto, segundos: x.segundos,
                              conectada: x.segundos <= EXTENSION_TIMEOUT_SEG }))
  }
  app.post('/api/extension/latido', express.json(), async (req, res) => {
    try {
      const clave = String(process.env.CONSULTA_BANCOS_CLAVE || '').trim()
      if (!clave || String(req.get('x-clave') || req.query.clave || '').trim() !== clave) return res.status(401).json({ ok: false, error: 'Clave incorrecta' })
      const b = req.body || {}
      const pc = String(b.pc || 'PC').trim().slice(0, 60) || 'PC'
      await pool.query(
        `INSERT INTO extension_latidos (pc, bancos, version, detalle, visto) VALUES ($1,$2,$3,$4,NOW())
         ON CONFLICT (pc) DO UPDATE SET bancos=EXCLUDED.bancos, version=EXCLUDED.version, detalle=EXCLUDED.detalle, visto=NOW()`,
        [pc, JSON.stringify(Array.isArray(b.bancos) ? b.bancos.slice(0, 10) : []), String(b.version || '').slice(0, 30), String(b.detalle || '').slice(0, 200)])
      res.json({ ok: true })
    } catch (e) { res.status(500).json({ ok: false, error: e.message }) }
  })
  app.get('/api/extension/estado', async (req, res) => {
    try { res.json({ extensiones: await extensionesEstado() }) } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // ═════════════════════════════════════════════════════════════════════════
  //  CLUB TUTU+ (Tutu Express): la landing consulta sola al robot y le avisa a Ruthina para que
  //  la consulta aparezca en "Pedidos Bancos" con su etiqueta.
  //    POST /api/tutuplus/webhook?key=...   (key = CLUB_WEBHOOK_KEY, o KOMMO_WEBHOOK_KEY si no hay otra)
  //    Eventos de Club Tutu+: express_nuevo · express_resultado · express_vehiculo (mystery_avisame se ignora)
  //    En Club Tutu+ → variable LEADS_WEBHOOK = https://<ruthina>/api/tutuplus/webhook?key=<la misma clave>
  // ═════════════════════════════════════════════════════════════════════════
  const claveClub = () => String(process.env.CLUB_WEBHOOK_KEY || process.env.KOMMO_WEBHOOK_KEY || '').trim()
  app.post('/api/tutuplus/webhook', express.json({ limit: '1mb' }), async (req, res) => {
    try {
      const k = claveClub()
      if (!k || (req.query.key !== k && req.get('x-webhook-key') !== k)) return res.status(401).json({ ok: false, error: 'Clave incorrecta (falta ?key=...)' })
      const b = req.body || {}
      const evento = String(b.evento || '')
      if (!/^express_/.test(evento)) return res.json({ ok: true, ignorado: evento })
      const cuil = soloDigitos(b.cuit)
      const ext = 'tutuplus:' + String(b.id || cuil)
      const nombre = String(b.nombre || '').slice(0, 80)
      const tel = soloDigitos(b.telefono)

      let sol = (await pool.query(`SELECT * FROM calificaciones_kommo WHERE externo_id=$1 LIMIT 1`, [ext])).rows[0]
      if (!sol) {
        sol = (await pool.query(
          `INSERT INTO calificaciones_kommo (cuil,cuil_valido,nombre,telefono,origen,externo_id,estado,tomado_por,observaciones)
           VALUES ($1,$2,$3,$4,'tutu-plus',$5,'en_proceso','Tutu+ (el robot lo está evaluando)','Cliente de Tutu+ (Tutu Express)') RETURNING *`,
          [cuil, validarCuil(cuil), nombre, tel, ext])).rows[0]
      }

      if (evento === 'express_resultado') {
        let det = b.detalle
        if (typeof det === 'string') { try { det = JSON.parse(det) } catch (e) { det = [] } }
        det = Array.isArray(det) ? det : []
        const resultados = {}
        BANCOS.forEach(bk => {
          const it = det.find(d => String(d.banco || '').toLowerCase() === bk.key)
          const estado = it ? estadoForm(String(it.estado || '').toUpperCase()) : 'no_consultado'
          resultados[bk.key] = { estado, monto: estado === 'aprobado' && it ? montoEntero(it.monto) : '' }
        })
        const aprobados = BANCOS.filter(bk => resultados[bk.key].estado === 'aprobado')
        const res_ = String(b.resultado || '')
        if (autoActiva()) {
          // Tutu+ solo consulta los bancos del robot (Galicia, Santander, decreditos). Lo del robot se guarda como ya
          // consultado y Ruthina completa Bancor y Nación por su cuenta; recién después se cierra el pedido.
          const ar = { _inicio: Date.now() }
          det.forEach(it => {
            const k = String(it.banco || '').toLowerCase()
            if (!BANCOS.some(bk => bk.key === k)) return
            const est = String(it.estado || '').toUpperCase()
            ar[k] = est === 'ERROR'
              ? { estado: 'ERROR', error: String(it.resumen || 'error en el robot').slice(0, 120), intentos: 1, fecha: new Date().toISOString() }
              : { estado: est, monto: it.monto || '', cliente: it.cliente || '', resumen: it.resumen || it.nota || '', fecha: new Date().toISOString(), robot: true }
          })
          await pool.query(
            `UPDATE calificaciones_kommo SET estado='pendiente', tomado_por='', resultados='{}'::jsonb, resultado='', resuelto_at=NULL,
               auto_resultados=$1::jsonb, auto_msg='Tutu+: el robot ya consultó; Ruthina completa Bancor y Nación…', updated_at=NOW() WHERE id=$2`,
            [JSON.stringify(ar), sol.id])
          setTimeout(() => registrarKommo.cicloAuto && registrarKommo.cicloAuto(), 300)
        } else if (res_ === 'revisar') {
          // la consulta automática está apagada: queda ABIERTO para que lo vea un vendedor
          await pool.query(
            `UPDATE calificaciones_kommo SET estado='pendiente', tomado_por='', resultados=$1, resultado='', resuelto_at=NULL,
               observaciones=$2, updated_at=NOW() WHERE id=$3`,
            [JSON.stringify(resultados), 'Tutu+: el robot no pudo decidir (algún banco no respondió). Revisar / volver a consultar.', sol.id])
        } else {
          const califica = aprobados.length > 0 || res_ === 'aprobado'
          await pool.query(
            `UPDATE calificaciones_kommo SET estado='resuelto', tomado_por='', resultados=$1, resultado=$2, resuelto_por='Tutu+ (robot)',
               resuelto_at=NOW(), updated_at=NOW(),
               observaciones=$3 WHERE id=$4`,
            [JSON.stringify(resultados), califica ? 'califica' : 'no_califica',
             califica ? 'Tutu+: califica' + (aprobados.length ? ' (' + aprobados.map(x => x.label).join(', ') + ')' : '') : 'Tutu+: ningún banco ofreció crédito', sol.id])
        }
      }

      if (evento === 'express_vehiculo' && b.vehiculo) {
        await pool.query(
          `UPDATE calificaciones_kommo SET auto=$1, observaciones=TRIM(BOTH E'\\n' FROM COALESCE(observaciones,'') || E'\\n' || $2), updated_at=NOW() WHERE id=$3`,
          [String(b.vehiculo).slice(0, 160), 'Le interesa: ' + String(b.vehiculo).slice(0, 160) + (tel ? ' — WhatsApp ' + tel : ''), sol.id])
      }
      res.json({ ok: true, solicitud_id: sol.id })
    } catch (e) { console.error('[tutuplus]', e.message); res.status(500).json({ ok: false, error: e.message }) }
  })

  // volver a consultar automáticamente un pedido (borra lo que se sabía)
  app.post('/api/calificaciones/:id/reconsultar', async (req, res) => {
    try {
      // si ya estaba resuelto se REABRE: se borra el resultado y se vuelve a consultar en los bancos (el reloj de 5 min arranca de nuevo)
      const up = await pool.query(
        `UPDATE calificaciones_kommo SET estado='pendiente', tomado_por='', resultados='{}'::jsonb, resultado='', observaciones='', resuelto_por='',
           kommo_error='', resuelto_at=NULL, auto_resultados='{}'::jsonb, auto_msg='', updated_at=NOW()
         WHERE id=$1 AND estado <> 'descartado' RETURNING id`, [req.params.id])
      if (!up.rows.length) return res.status(404).json({ error: 'No existe o está descartado' })
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
  // Respuesta para el bot: trae los montos para uso interno del bot,
  // pero mensaje_cliente NUNCA los menciona (solo nombra los bancos que aprobaron).
  const NOMBRE_BANCO = { bancor: 'Bancor', nacion: 'Banco Nación', galicia: 'Banco Galicia', decreditos: 'decreditos', santander: 'Santander' }
  function listaBancos(nombres) {
    if (nombres.length <= 1) return nombres.join('')
    return nombres.slice(0, -1).join(', ') + ' y ' + nombres[nombres.length - 1]
  }
  // Pasados PARCIAL_MIN minutos sin cerrarse, el bot recibe lo que hay hasta ese momento (estado "parcial")
  // en vez de seguir viendo "pendiente" para siempre. El pedido sigue abierto para que un asesor lo termine.
  const PARCIAL_MIN = Math.max(1, Number(process.env.CALIFICAR_PARCIAL_MIN || 2))
  function respuestaCalificacion(sol, extra = {}) {
    const resuelto = sol.estado === 'resuelto'
    const descartado = sol.estado === 'descartado'
    const edadMin = sol.created_at ? (Date.now() - new Date(sol.created_at).getTime()) / 60000 : 0
    const parcial = !resuelto && !descartado && edadMin >= PARCIAL_MIN
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
                           : { estado: parcial ? 'sin_respuesta' : 'pendiente', monto: '' }
      }
    })
    const montoMax = Math.max(0, ...Object.values(bancos).map(x => Number(x.monto) || 0))
    const aprobados = BANCOS.filter(bk => bancos[bk.key].estado === 'aprobado').map(bk => NOMBRE_BANCO[bk.key])
    const nombre = (sol.nombre || '').split(' ')[0]
    const estado = resuelto ? 'resuelto' : descartado ? 'descartado' : parcial ? 'parcial' : 'pendiente'
    const resultado = resuelto ? sol.resultado : null
    let mensaje
    if (resultado === 'califica') {
      mensaje = `¡Buenas noticias${nombre ? ', ' + nombre : ''}! Tenés crédito aprobado en ${listaBancos(aprobados) || 'uno de nuestros bancos'} para financiar tu auto. Un asesor te contacta para armar la propuesta con las cuotas.`
    } else if (resultado === 'no_califica') {
      mensaje = `${nombre ? nombre + ', p' : 'P'}or ahora los bancos con los que trabajamos no tienen una oferta de crédito para tu CUIL. Igual hay otras opciones (contado, permuta o con garante): un asesor te contacta para verlas.`
    } else if (descartado) {
      mensaje = 'Un asesor va a revisar tu consulta y te contacta.'
    } else if (parcial && aprobados.length) {
      mensaje = `¡Buenas noticias${nombre ? ', ' + nombre : ''}! Ya tenés crédito aprobado en ${listaBancos(aprobados)}. Un asesor te contacta para armar la propuesta con las cuotas.`
    } else if (parcial) {
      mensaje = `${nombre ? nombre + ', ya' : 'Ya'} hicimos la consulta de tu CUIL. Algunos bancos todavía no respondieron, así que un asesor la termina de revisar y te contacta en breve.`
    } else {
      mensaje = 'Estamos consultando tu CUIL con los bancos. En unos minutos te confirmamos.'
    }
    const ETQ = { aprobado: 'aprobado', rechazado: 'rechazado', no_consultado: 'no consultado', pendiente: 'pendiente', sin_respuesta: 'sin respuesta', revisar: 'a revisar', error: 'con error' }
    const detalle = BANCOS.filter(bk => bancos[bk.key].estado !== 'no_consultado')
      .map(bk => `${NOMBRE_BANCO[bk.key]}: ${ETQ[bancos[bk.key].estado] || bancos[bk.key].estado}` +
        (bancos[bk.key].monto ? ` $${Number(bancos[bk.key].monto).toLocaleString('es-AR')}` : '')).join(' · ')
    return {
      ok: true,
      solicitud_id: sol.id,
      estado,                       // pendiente | parcial (pasaron ${PARCIAL_MIN} min: es lo que hay) | resuelto | descartado
      respuesta_final: estado !== 'pendiente',   // true = el bot ya puede contestarle al cliente, no hace falta seguir consultando
      parcial,
      resultado,                    // califica | no_califica | null (todavía no)
      califica: resultado === 'califica' ? true : resultado === 'no_califica' ? false : null,
      monto_maximo: montoMax ? String(montoMax) : '',   // uso interno del bot: NO mostrar al cliente
      bancos_aprobados: aprobados,  // ej. ["Bancor", "Banco Nación"]
      bancos,                       // estado y monto por banco (uso interno: NO mostrar al cliente)
      cuil: sol.cuil, cuil_valido: sol.cuil_valido !== false,
      lead_id: sol.lead_id || '',
      detalle,
      mensaje_cliente: mensaje,
      consultar_de_nuevo_en_seg: estado === 'pendiente' ? Math.max(5, Math.min(30, Math.ceil((PARCIAL_MIN - edadMin) * 60) + 2)) : 0,
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
      // arrancar la consulta en los bancos ya (sin esperar la próxima vuelta)
      auto.pendientes = Math.max(1, auto.pendientes || 0)
      setTimeout(cicloAuto, 100)

      // esperar un rato por si los bancos contestan rápido
      const esperar = Math.min(Math.max(parseInt(b.esperar_segundos) || 0, 0), PARCIAL_MIN * 60)
      let sol = r.solicitud
      const hasta = Date.now() + esperar * 1000
      const edadOk = () => !sol.created_at || (Date.now() - new Date(sol.created_at).getTime()) / 60000 < PARCIAL_MIN
      while (esperar && sol.estado !== 'resuelto' && sol.estado !== 'descartado' && edadOk() && Date.now() < hasta) {
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
