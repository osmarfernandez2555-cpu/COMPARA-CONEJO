const express = require('express')
const cors = require('cors')
const fetch = require('node-fetch')
const path = require('path')
const { Pool } = require('pg')

const app = express()
app.use(cors())
app.use(express.json({ limit: '50mb' }))
// ── PostgreSQL ──────────────────────────────────────────────
const dbUrl = process.env.DATABASE_URL || process.env.DATABASE_PRIVATE_URL || process.env.POSTGRES_URL
const isInternal = (dbUrl || '').includes('railway.internal')
const pool = new Pool({
  connectionString: dbUrl,
  ssl: isInternal ? false : { rejectUnauthorized: false }
})

async function initDB() {
  try {
    await pool.query('SELECT 1')
    console.log('✅ PostgreSQL conectado OK')
  } catch(e) {
    console.error('❌ PostgreSQL NO conectado:', e.message)
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS stock (
      id SERIAL PRIMARY KEY,
      marca TEXT NOT NULL,
      modelo TEXT NOT NULL,
      version TEXT DEFAULT '',
      anio TEXT DEFAULT '',
      km INTEGER DEFAULT 0,
      color TEXT DEFAULT '',
      precio TEXT DEFAULT '',
      moneda TEXT DEFAULT 'ARS',
      estado TEXT DEFAULT 'Disponible',
      notas TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `)
  // Agregar columnas nuevas si no existen
  await pool.query(`ALTER TABLE clientes_busqueda ADD COLUMN IF NOT EXISTS vendedor TEXT DEFAULT ''`).catch(()=>{})
  await pool.query(`ALTER TABLE clientes_busqueda ADD COLUMN IF NOT EXISTS presupuesto TEXT DEFAULT ''`).catch(()=>{})
  await pool.query(`ALTER TABLE clientes_busqueda ADD COLUMN IF NOT EXISTS dni TEXT DEFAULT ''`).catch(()=>{})
  await pool.query(`ALTER TABLE clientes_busqueda ADD COLUMN IF NOT EXISTS tiene_permuta TEXT DEFAULT 'no'`).catch(()=>{})
  await pool.query(`ALTER TABLE clientes_busqueda ADD COLUMN IF NOT EXISTS auto_permuta TEXT DEFAULT ''`).catch(()=>{})
  await pool.query(`ALTER TABLE clientes_busqueda ADD COLUMN IF NOT EXISTS tiene_garantes TEXT DEFAULT 'no'`).catch(()=>{})
  await pool.query(`ALTER TABLE clientes_busqueda ADD COLUMN IF NOT EXISTS dni_garante TEXT DEFAULT ''`).catch(()=>{})
  await pool.query(`ALTER TABLE clientes_busqueda ADD COLUMN IF NOT EXISTS nombre_garante TEXT DEFAULT ''`).catch(()=>{})
  await pool.query(`ALTER TABLE clientes_busqueda ADD COLUMN IF NOT EXISTS calificacion TEXT DEFAULT ''`).catch(()=>{})
  await pool.query(`ALTER TABLE clientes_busqueda ADD COLUMN IF NOT EXISTS vendedor TEXT DEFAULT ''`).catch(()=>{})
  await pool.query(`ALTER TABLE clientes_busqueda ADD COLUMN IF NOT EXISTS observaciones TEXT DEFAULT ''`).catch(()=>{})
  await pool.query(`ALTER TABLE clientes_busqueda ADD COLUMN IF NOT EXISTS estado_lead TEXT DEFAULT ''`).catch(()=>{})
  await pool.query(`ALTER TABLE clientes_busqueda ADD COLUMN IF NOT EXISTS motivo_perdida TEXT DEFAULT ''`).catch(()=>{})
  await pool.query(`ALTER TABLE clientes_busqueda ADD COLUMN IF NOT EXISTS bancos TEXT DEFAULT ''`).catch(()=>{})
  await pool.query(`ALTER TABLE clientes_busqueda ADD COLUMN IF NOT EXISTS monto_galicia TEXT DEFAULT ''`).catch(()=>{})
  await pool.query(`ALTER TABLE clientes_busqueda ADD COLUMN IF NOT EXISTS monto_bancor TEXT DEFAULT ''`).catch(()=>{})
  await pool.query(`ALTER TABLE clientes_busqueda ADD COLUMN IF NOT EXISTS monto_nacion TEXT DEFAULT ''`).catch(()=>{})
  await pool.query(`ALTER TABLE clientes_busqueda ADD COLUMN IF NOT EXISTS monto_santander TEXT DEFAULT ''`).catch(()=>{})
  await pool.query(`ALTER TABLE clientes_busqueda ADD COLUMN IF NOT EXISTS monto_mg TEXT DEFAULT ''`).catch(()=>{})
  await pool.query(`ALTER TABLE clientes_busqueda ADD COLUMN IF NOT EXISTS presupuesto TEXT DEFAULT ''`).catch(()=>{})
  await pool.query(`ALTER TABLE clientes_busqueda ADD COLUMN IF NOT EXISTS dni TEXT DEFAULT ''`).catch(()=>{})
  await pool.query(`ALTER TABLE clientes_busqueda ADD COLUMN IF NOT EXISTS tiene_permuta TEXT DEFAULT 'no'`).catch(()=>{})
  await pool.query(`ALTER TABLE clientes_busqueda ADD COLUMN IF NOT EXISTS auto_permuta TEXT DEFAULT ''`).catch(()=>{})
  await pool.query(`ALTER TABLE clientes_busqueda ADD COLUMN IF NOT EXISTS tiene_garantes TEXT DEFAULT 'no'`).catch(()=>{})
  await pool.query(`ALTER TABLE clientes_busqueda ADD COLUMN IF NOT EXISTS dni_garante TEXT DEFAULT ''`).catch(()=>{})
  await pool.query(`ALTER TABLE clientes_busqueda ADD COLUMN IF NOT EXISTS nombre_garante TEXT DEFAULT ''`).catch(()=>{})
  await pool.query(`ALTER TABLE stock ADD COLUMN IF NOT EXISTS telefono TEXT DEFAULT ''`).catch(()=>{})
  await pool.query(`ALTER TABLE stock ADD COLUMN IF NOT EXISTS origen TEXT DEFAULT ''`).catch(()=>{})
  await pool.query(`ALTER TABLE stock ADD COLUMN IF NOT EXISTS ubicacion TEXT DEFAULT 'Tutu Automotores'`).catch(()=>{})
  console.log('✅ DB lista')
}
initDB().catch(e => console.error('DB init error:', e.message))

console.log('=== RUTHINA SERVER ===')
console.log('ANTHROPIC_API_KEY:', !!process.env.ANTHROPIC_API_KEY)
console.log('DATABASE_URL:', !!process.env.DATABASE_URL)
console.log('DATABASE_URL valor:', (process.env.DATABASE_URL||'').substring(0, 60))
console.log('DATABASE_PRIVATE_URL:', !!process.env.DATABASE_PRIVATE_URL)
console.log('PGHOST:', process.env.PGHOST || 'no definido')

// ── Health check ────────────────────────────────────────────
app.get('/api/ping', async (req, res) => {
  let dbOk = false
  let dbMsg = 'no DATABASE_URL'
  if (process.env.DATABASE_URL) {
    try {
      await pool.query('SELECT 1')
      dbOk = true
      dbMsg = 'conectado'
    } catch(e) {
      dbMsg = e.message.substring(0, 80)
    }
  }
  res.json({ 
    ok: true, 
    key: !!process.env.ANTHROPIC_API_KEY, 
    db: dbOk,
    db_msg: dbMsg,
    db_url_presente: !!process.env.DATABASE_URL,
    internal: (process.env.DATABASE_URL||'').includes('railway.internal')
  })
})

// ── Stock: leer ─────────────────────────────────────────────
app.get('/api/stock', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM stock ORDER BY marca, modelo, anio')
    res.json(r.rows)
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── Stock: guardar / actualizar ──────────────────────────────
app.post('/api/stock', async (req, res) => {
  try {
    const { marca, modelo, version='', anio='', km=0, color='', precio='', moneda='ARS', estado='Disponible', notas='', ubicacion='Tutu Automotores', telefono='' } = req.body
    if (!marca || !modelo) return res.status(400).json({ error: 'Marca y modelo son requeridos' })

    // Buscar si ya existe
    const existe = await pool.query(
      'SELECT id FROM stock WHERE LOWER(marca)=LOWER($1) AND LOWER(modelo)=LOWER($2) AND anio=$3',
      [marca, modelo, String(anio)]
    )

    if (existe.rows.length > 0) {
      await pool.query(
        'UPDATE stock SET version=$1,km=$2,color=$3,precio=$4,moneda=$5,estado=$6,notas=$7,ubicacion=$8,telefono=$9,updated_at=NOW() WHERE id=$10',
        [version, Number(km)||0, color, String(precio), moneda, estado, notas, ubicacion, telefono, existe.rows[0].id]
      )
      res.json({ ok: true, accion: 'actualizado' })
    } else {
      await pool.query(
        'INSERT INTO stock (marca,modelo,version,anio,km,color,precio,moneda,estado,notas,ubicacion,telefono) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
        [marca, modelo, version, String(anio), Number(km)||0, color, String(precio), moneda, estado, notas, ubicacion, telefono]
      )
      res.json({ ok: true, accion: 'guardado' })
    }
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── Stock: importación automática (bot de grupos de WhatsApp) ──
// Distinto de /api/stock: acá el mismo auto de DISTINTOS vendedores se guarda por
// separado (la clave incluye la ubicación = nombre + teléfono de quien lo publica),
// y si el mismo vendedor lo vuelve a publicar se actualiza precio/km en vez de duplicar.
// Si definís IMPORT_KEY en las variables de Railway, el bot tiene que mandarla.
app.post('/api/stock/import', async (req, res) => {
  try {
    if (process.env.IMPORT_KEY && req.headers['x-import-key'] !== process.env.IMPORT_KEY) {
      return res.status(401).json({ error: 'No autorizado' })
    }
    const {
      marca, modelo, version='', anio='', km=0, color='', precio='', moneda='ARS',
      estado='Disponible', notas='', ubicacion='', telefono='', origen='grupo'
    } = req.body
    if (!marca || !modelo) return res.status(400).json({ error: 'Marca y modelo son requeridos' })
    if (!ubicacion) return res.status(400).json({ error: 'Ubicación requerida' })
    const kmNum = Number(km) || 0

    const existe = await pool.query(
      `SELECT id FROM stock
       WHERE LOWER(marca)=LOWER($1) AND LOWER(modelo)=LOWER($2) AND anio=$3 AND LOWER(ubicacion)=LOWER($4)
         AND (COALESCE(km,0)=0 OR $5::int=0 OR km=$5::int)
         AND (COALESCE(version,'')='' OR $6='' OR LOWER(version)=LOWER($6))
       ORDER BY id LIMIT 1`,
      [marca, modelo, String(anio), ubicacion, kmNum, version]
    )

    if (existe.rows.length > 0) {
      await pool.query(
        `UPDATE stock SET
           version = COALESCE(NULLIF($1,''), version),
           km = CASE WHEN $2::int > 0 THEN $2::int ELSE km END,
           color = COALESCE(NULLIF($3,''), color),
           precio = COALESCE(NULLIF($4,''), precio),
           moneda = $5, estado = $6, notas = $7, telefono = COALESCE(NULLIF($8,''), telefono),
           updated_at = NOW()
         WHERE id = $9`,
        [version, kmNum, color, String(precio), moneda, estado, notas, telefono, existe.rows[0].id]
      )
      return res.json({ ok: true, accion: 'actualizado', id: existe.rows[0].id })
    }
    const ins = await pool.query(
      `INSERT INTO stock (marca,modelo,version,anio,km,color,precio,moneda,estado,notas,ubicacion,telefono,origen)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [marca, modelo, version, String(anio), kmNum, color, String(precio), moneda, estado, notas, ubicacion, telefono, origen]
    )
    res.json({ ok: true, accion: 'guardado', id: ins.rows[0].id })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// Limpieza: los avisos cargados desde grupos que nadie volvió a publicar en N días
// se borran solos (se asume que ya se vendieron). Cambiable con STOCK_GRUPO_DIAS; 0 = no borrar nunca.
setInterval(async () => {
  try {
    const dias = Number(process.env.STOCK_GRUPO_DIAS ?? 21)
    if (!dias || dias < 1) return
    const r = await pool.query(
      `DELETE FROM stock WHERE origen='grupo' AND COALESCE(updated_at, created_at) < NOW() - ($1 || ' days')::interval`,
      [String(dias)]
    )
    if (r.rowCount > 0) console.log(`[STOCK] Limpieza: ${r.rowCount} avisos de grupos con más de ${dias} días sin repostear`)
  } catch(e) { console.error('[STOCK] Error en limpieza:', e.message) }
}, 6 * 60 * 60 * 1000)


// ── Stock: eliminar por ID ───────────────────────────────────
app.delete('/api/stock/:id', async (req, res) => {
  try {
    const { id } = req.params
    const r = await pool.query('DELETE FROM stock WHERE id=$1 RETURNING id', [parseInt(id)])
    if (r.rowCount === 0) return res.status(404).json({ error: 'Auto no encontrado' })
    res.json({ ok: true, id })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── Stock: eliminar ──────────────────────────────────────────
app.delete('/api/stock', async (req, res) => {
  try {
    const { marca, modelo, anio } = req.body
    if (!marca || !modelo) return res.status(400).json({ error: 'Marca y modelo requeridos' })
    let q = 'DELETE FROM stock WHERE LOWER(marca)=LOWER($1) AND LOWER(modelo)=LOWER($2)'
    let params = [marca, modelo]
    if (anio) { q += ' AND anio=$3'; params.push(String(anio)) }
    const r = await pool.query(q, params)
    res.json({ ok: true, eliminados: r.rowCount })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── Chat proxy: inyecta stock de DB + procesa comandos ───────
// "hace 3 días · 7/9/2026" a partir de la fecha de carga (misma lógica que el Match del frontend)
function textoFechaCarga(fecha) {
  if (!fecha) return ''
  const d = new Date(fecha)
  if (isNaN(d.getTime())) return ''
  const diffMs = Date.now() - d.getTime()
  const dias = Math.floor(diffMs / 86400000)
  let rel
  if (dias <= 0) { const h = Math.floor(diffMs / 3600000); rel = h <= 0 ? 'recién cargado' : 'hace ' + h + (h === 1 ? ' hora' : ' horas') }
  else if (dias === 1) rel = 'hace 1 día'
  else if (dias < 30) rel = 'hace ' + dias + ' días'
  else if (dias < 365) { const m = Math.floor(dias / 30); rel = 'hace ' + m + (m === 1 ? ' mes' : ' meses') }
  else { const a = Math.floor(dias / 365); rel = 'hace ' + a + (a === 1 ? ' año' : ' años') }
  return rel + ' · ' + d.toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Cordoba' })
}

// ── Borrado de una lista por agencia + fecha de carga (con confirmación obligatoria) ──
// Paso 1: la IA pide [PREPARAR_BORRADO:{ubicacion,fecha}] → el servidor NO borra: cuenta, muestra
//         la lista y deja una marca invisible en el mensaje con lo que se va a borrar.
// Paso 2: si el siguiente mensaje del usuario es una confirmación, el servidor (sin pasar por la IA)
//         vuelve a contar, verifica que sea la misma cantidad y recién ahí borra.
const MARCA_BORRADO = /<!--BORRADO:([A-Za-z0-9+\/=]+)-->/
const CONFIRMA_BORRADO = /^\s*(?:s[ií][\s,]+)?(?:confirmo|confirmar|dale|ok|okey|borr[aá]los?|borrarlos?|elimin[aá]los?|eliminarlos?|borrar|eliminar)\s*[.!¡]*\s*$|^\s*s[ií]\s*[.!¡]*\s*$/i

function fechaISOArg(fecha) { // 'YYYY-MM-DD' según la hora de Argentina (la misma que ve el usuario)
  const d = new Date(fecha)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Cordoba' })
}
function normalizarFechaPedida(txt) { // acepta 2026-08-27, 27/8/2026, 27-8-26 → 'YYYY-MM-DD' ('' si no se entiende)
  const t = String(txt || '').trim()
  let y, m, d
  let mm = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  if (mm) { y = +mm[1]; m = +mm[2]; d = +mm[3] }
  else if ((mm = t.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2}|\d{4})$/))) { d = +mm[1]; m = +mm[2]; y = +mm[3]; if (y < 100) y += 2000 }
  else return ''
  const f = new Date(Date.UTC(y, m - 1, d))
  if (f.getUTCFullYear() !== y || f.getUTCMonth() !== m - 1 || f.getUTCDate() !== d) return '' // 31/2, etc.
  return String(y).padStart(4, '0') + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0')
}
function fechaLegible(iso) { const [y, m, d] = iso.split('-').map(Number); return d + '/' + m + '/' + y }
function textoDeMensaje(m) {
  if (!m) return ''
  if (typeof m.content === 'string') return m.content
  if (Array.isArray(m.content)) return m.content.map(b => (b && b.type === 'text' ? b.text : '')).join('\n')
  return ''
}
async function buscarListaParaBorrar(ubicacion, fechaISO) {
  const patron = '%' + String(ubicacion).trim().replace(/[\\%_]/g, '\\$&') + '%'
  const r = await pool.query(
    `SELECT id, marca, modelo, version, anio, ubicacion, created_at FROM stock
     WHERE LOWER(COALESCE(ubicacion,'')) LIKE LOWER($1) ESCAPE '\\' ORDER BY ubicacion, marca, modelo, anio`, [patron])
  if (!fechaISO) return { filas: r.rows, todasDeLaAgencia: r.rows }
  return { filas: r.rows.filter(a => a.created_at && fechaISOArg(a.created_at) === fechaISO), todasDeLaAgencia: r.rows }
}
function armarVistaPreviaBorrado(ubicacion, fechaISO, filas, todasDeLaAgencia) {
  const cuando = fechaISO ? 'cargados el ' + fechaLegible(fechaISO) : 'de cualquier fecha de carga'
  if (!filas.length) {
    if (!todasDeLaAgencia.length) return 'No encontré ningún auto cuya ubicación contenga «' + ubicacion + '». No borré nada.'
    const porFecha = {}
    todasDeLaAgencia.forEach(a => { const f = a.created_at ? fechaLegible(fechaISOArg(a.created_at)) : 'sin fecha'; porFecha[f] = (porFecha[f] || 0) + 1 })
    return 'Hay autos de «' + ubicacion + '», pero ninguno cargado el ' + fechaLegible(fechaISO) + '. No borré nada.\n\nFechas de carga que tiene esa agencia:\n' +
      Object.entries(porFecha).map(([f, n]) => '• ' + f + ' — ' + n + (n === 1 ? ' auto' : ' autos')).join('\n')
  }
  const porUbic = {}
  filas.forEach(a => { const u = a.ubicacion || 'Tutu Automotores'; porUbic[u] = (porUbic[u] || 0) + 1 })
  const lineas = filas.slice(0, 40).map((a, i) => (i + 1) + '. ' + [a.marca, a.modelo, a.version].filter(Boolean).join(' ') + (a.anio ? ' | ' + a.anio : ''))
  let txt = '🗑️ **Esto es lo que se borraría** (' + filas.length + (filas.length === 1 ? ' auto' : ' autos') + ' ' + cuando + '):\n\n'
  txt += Object.entries(porUbic).map(([u, n]) => '📍 ' + u + ' — ' + n + (n === 1 ? ' auto' : ' autos')).join('\n') + '\n\n'
  txt += lineas.join('\n')
  if (filas.length > 40) txt += '\n... y ' + (filas.length - 40) + ' más'
  txt += '\n\n⚠️ Todavía **no borré nada**. Respondé **CONFIRMO** para borrarlos definitivamente (no se puede deshacer), o escribí cualquier otra cosa para cancelar.'
  const marca = Buffer.from(JSON.stringify({ u: ubicacion, f: fechaISO || '', n: filas.length }), 'utf8').toString('base64')
  return txt + '<!--BORRADO:' + marca + '-->'
}
async function procesarPreparacionBorrado(jsonTexto) {
  let cmd
  try { cmd = JSON.parse(jsonTexto) } catch (e) { return 'No pude entender el pedido de borrado. No borré nada.' }
  const ubicacion = String(cmd.ubicacion || '').trim()
  if (ubicacion.length < 3) return 'Necesito el nombre de la agencia (al menos 3 letras) para armar la lista. No borré nada.'
  let fechaISO = ''
  if (cmd.fecha) {
    fechaISO = normalizarFechaPedida(cmd.fecha)
    if (!fechaISO) return 'No entendí la fecha «' + cmd.fecha + '». Decime el día así: 27/8/2026. No borré nada.'
  }
  const { filas, todasDeLaAgencia } = await buscarListaParaBorrar(ubicacion, fechaISO)
  return armarVistaPreviaBorrado(ubicacion, fechaISO, filas, todasDeLaAgencia)
}
// Devuelve el texto de respuesta si el último mensaje confirma un borrado preparado; null si no aplica.
async function ejecutarBorradoConfirmado(messages) {
  if (!Array.isArray(messages) || messages.length < 2) return null
  const ultimo = messages[messages.length - 1], previo = messages[messages.length - 2]
  if (!ultimo || ultimo.role !== 'user' || !previo || previo.role !== 'assistant') return null
  const textoUsuario = textoDeMensaje(ultimo)
  if (textoUsuario.length > 40 || !CONFIRMA_BORRADO.test(textoUsuario)) return null
  const mm = textoDeMensaje(previo).match(MARCA_BORRADO)
  if (!mm) return null
  let pedido
  try { pedido = JSON.parse(Buffer.from(mm[1], 'base64').toString('utf8')) } catch (e) { return null }
  const ubicacion = String(pedido.u || '').trim()
  const fechaISO = pedido.f ? normalizarFechaPedida(pedido.f) : ''
  const esperado = Number(pedido.n)
  if (ubicacion.length < 3 || (pedido.f && !fechaISO) || !Number.isInteger(esperado) || esperado < 1) return null
  const { filas } = await buscarListaParaBorrar(ubicacion, fechaISO)
  if (filas.length === 0) return 'Esa lista ya no tiene autos (puede que ya se haya borrado). No borré nada más.'
  if (filas.length !== esperado) return '⚠️ La lista cambió desde que te la mostré (eran ' + esperado + ' y ahora son ' + filas.length + '). Por seguridad **no borré nada**. Pedime la lista de nuevo para revisarla.'
  const r = await pool.query('DELETE FROM stock WHERE id = ANY($1::int[])', [filas.map(a => a.id)])
  console.log('🗑️ Lista borrada: ' + r.rowCount + ' autos de «' + ubicacion + '»' + (fechaISO ? ' del ' + fechaISO : ''))
  return '✅ Listo: borré **' + r.rowCount + (r.rowCount === 1 ? ' auto' : ' autos') + '** de «' + ubicacion + '»' + (fechaISO ? ' cargados el ' + fechaLegible(fechaISO) : '') + '.'
}
function limpiarMarcasBorrado(messages) { // la IA no necesita ver la marca interna
  if (!Array.isArray(messages)) return messages
  const quitar = t => String(t).replace(/<!--BORRADO:[A-Za-z0-9+\/=]+-->/g, '')
  return messages.map(m => {
    if (typeof m.content === 'string') return { ...m, content: quitar(m.content) }
    if (Array.isArray(m.content)) return { ...m, content: m.content.map(b => (b && b.type === 'text' ? { ...b, text: quitar(b.text) } : b)) }
    return m
  })
}

app.post('/api/chat', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return res.status(500).json({ error: 'API key no configurada en el servidor' })

  try {
    // ¿El usuario está confirmando un borrado que se le mostró en el mensaje anterior? Se resuelve acá, sin IA.
    const respuestaBorrado = await ejecutarBorradoConfirmado(req.body.messages)
    if (respuestaBorrado) {
      return res.json({ id: 'local-borrado', type: 'message', role: 'assistant', model: 'local', stop_reason: 'end_turn', content: [{ type: 'text', text: respuestaBorrado }] })
    }

    // Leer stock dinámico de la DB
    const stockRows = await pool.query('SELECT * FROM stock ORDER BY marca, modelo, anio')
    const stock = stockRows.rows

    let stockExtra = ''
    if (stock.length > 0) {
      const lineas = stock.map(a =>
        `• ${a.marca} ${a.modelo}${a.version ? ' '+a.version : ''} ${a.anio} | ` +
        `KM: ${Number(a.km).toLocaleString('es-AR')} | Color: ${a.color||'-'} | ` +
        `Precio: ${a.precio} ${a.moneda} | Ubicación: ${a.ubicacion||'Tutu Automotores'} | Estado: ${a.estado}${a.created_at ? ' | Cargado: '+textoFechaCarga(a.created_at) : ''}${a.notas ? ' | '+a.notas : ''}`
      ).join('\n')
      stockExtra = `\n\n== STOCK CARGADO POR EMPLEADOS (${stock.length} vehículos — PRIORIDAD ALTA) ==\n${lineas}\n== FIN STOCK EMPLEADOS ==\n\nIMPORTANTE: Siempre indicá la Ubicación de cada auto TAL CUAL aparece en los datos de arriba, copiándola literalmente — nunca la resumas, parafrasees ni la reemplaces por una descripción genérica como "(a revisar/tasar)". Si la Ubicación incluye un nombre de persona y/o un número de teléfono (por ejemplo, autos cargados desde el bot de WhatsApp), esos datos son importantes y SIEMPRE tienen que aparecer completos, nunca se omiten. NUNCA uses tablas markdown. Listá cada auto en una línea con formato: Marca Modelo Versión Año — KM: X — Precio: $ X — Ubicación: X (copiada literal) — Cargado: X (copiado literal, ej \"hace 3 días · 7/9/2026\"). La fecha de carga SÍ la tenés en los datos: nunca digas que no registrás fechas de carga`
    }

    const hoyArg = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Cordoba' })
    const comandos = `

== FORMATO DE RESPUESTAS ==
NUNCA uses tablas markdown (| col | col |). Cuando listes autos usá SIEMPRE este formato numerado:

1. Toyota Etios XLS 1.5 | 2015
- KM: 141.771 | Color: Gris
- Precio: $14.500.000 ARS
- 📍 Ubicación: Mediterráneo
- 🕐 Cargado: hace 3 días · 7/9/2026

2. Toyota Hilux SRX 4x4 AT 2.8 | 2022
- KM: 76.500 | Color: Blanco
- Precio: $60.000.000 ARS
- 📍 Ubicación: Tutu Automotores
- 🕐 Cargado: hace 12 días · 25/9/2026

Siempre incluí la Ubicación y la fecha de Cargado en cada auto (copiá la fecha tal cual figura en los datos del stock). Si no hay ubicación conocida, poné "Tutu Automotores". Si un auto no trae fecha de carga en los datos, omití esa línea.

== GESTIÓN DE STOCK ==
Cuando el usuario diga "guardá", "agregá", "cargá" o "actualizá" un auto:
• Extraé todos los datos disponibles del mensaje
• Si no menciona ubicación, usá "Tutu Automotores"
• Si menciona otra agencia o lugar, usá ese nombre en ubicacion
• Confirmá con un mensaje claro al usuario
• Al FINAL de tu respuesta agregá EXACTAMENTE (una sola línea, sin saltos dentro del JSON):
[GUARDAR_STOCK:{"marca":"Ford","modelo":"Ranger","version":"XLT 4x4","anio":"2022","km":45000,"color":"Blanca","precio":"58000000","moneda":"ARS","estado":"Disponible","notas":"","ubicacion":"Tutu Automotores"}]

Cuando el usuario diga que un cliente busca un auto ("X busca", "X quiere", "X está buscando"):
• Extraé nombre del cliente, modelo, año, teléfono, DNI y presupuesto si lo hay
• Si el cliente entrega un auto propio como parte de pago (permuta), extraé tiene_permuta:"si" y describí en "auto_permuta" TODOS los datos del auto que entrega en una sola frase (marca, modelo, versión/motorización, año, km, color, valor estimado si lo menciona) — ej: "Chevrolet Corsa 1.4 2015, 90000 km". Si no hay permuta, tiene_permuta:"no" y auto_permuta vacío
• Si el cliente menciona garante/s o co-firmante, extraé tiene_garantes:"si" junto con nombre_garante y dni_garante si los menciona. Si no, tiene_garantes:"no"
• Si el cliente menciona un RANGO de años para lo que busca (ej: "de 2013 a 2018"), guardalo en "anio" como "2013-2018", no un solo año inventado.
• Confirmá con un mensaje
• Al FINAL agregá: [GUARDAR_CLIENTE:{"nombre":"Juan Perez","telefono":"351-1234567","dni":"","modelo":"Gol Trend","anio":"2012","presupuesto":"","notas":"","asesor":"","tiene_permuta":"no","auto_permuta":"","tiene_garantes":"no","nombre_garante":"","dni_garante":""}]

Cuando el usuario diga "eliminá", "borrá" o "sacá" un auto:
• Confirmá con un mensaje claro
• Al FINAL agregá: [ELIMINAR_STOCK:{"marca":"Ford","modelo":"Ranger","anio":"2022"}]

Cuando diga "mostrá el stock", "qué autos tenemos", "listá vehículos cargados":
• Mostrá el stock de la sección STOCK CARGADO POR EMPLEADOS de forma ordenada y clara.

== BORRAR LA LISTA DE UNA AGENCIA POR FECHA DE CARGA ==
Cuando el usuario pida eliminar o borrar la lista, los autos o lo cargado de una AGENCIA (ubicación) en una FECHA de carga (ej: "necesito eliminar la lista de adrian yacir del 27/8/2026"):
• NO uses [ELIMINAR_STOCK] para esto: borraría autos de otras agencias.
• Respondé con UNA frase corta (por ejemplo "Reviso qué autos tiene cargados esa agencia en esa fecha.") y al FINAL agregá, en una línea: [PREPARAR_BORRADO:{"ubicacion":"adrian yacir","fecha":"2026-08-27"}]
• "ubicacion" es el nombre de la agencia como lo escribió el usuario, sin teléfono. "fecha" va SIEMPRE en formato AAAA-MM-DD. Si el usuario no dijo el año, usá el año de la fecha de hoy. Fecha de hoy: ${hoyArg}.
• Si el usuario no dijo qué fecha, preguntale de qué fecha de carga antes de usar el comando. Solo omití "fecha" si pide expresamente borrar TODO lo de esa agencia.
• Este comando NO borra nada: el sistema le muestra la lista y le pide confirmación al usuario. Nunca digas que ya borraste algo y nunca pidas la confirmación vos: la pide el sistema.

IMPORTANTE: Los bloques [GUARDAR_STOCK:...], [ELIMINAR_STOCK:...] y [PREPARAR_BORRADO:...] van siempre al final, en una línea, sin saltos de línea adentro del JSON.`

    // Inyectar stock y comandos en el system prompt
    // Detectar si la pregunta es sobre precio de un auto (InfoAuto)
    let infoautoExtra = ''
    const lastMsg = req.body.messages?.[req.body.messages.length - 1]?.content || ''
    const esPrecio = /precio|vale|cuesta|cuanto|infoauto|cotiz/i.test(lastMsg)
    const noEsStock = !/tenemos|stock|disponible|tutu/i.test(lastMsg)
    if (esPrecio && noEsStock) {
      // Extraer el modelo del mensaje para buscar en InfoAuto
      const queryMatch = lastMsg.match(/(?:precio|vale|cuesta|cuanto|infoauto|cotiz)[^\w]*(?:de|del|un|una|el|la)?\s+([a-zA-Z0-9\s]{3,40}?)(?:\?|$|\.|,)/i)
      const query = queryMatch ? queryMatch[1].trim() : lastMsg.replace(/precio|vale|cuesta|cuanto|infoauto|cotiz|de|del|un|una|el|la|\?/gi, ' ').trim().slice(0, 40)
      if (query.length > 2) {
        try {
          const token = await getInfoautoToken()
          const iaResp = await fetch(`${INFOAUTO_API}/pub/search/?page=1&page_size=5&query_string=${encodeURIComponent(query)}`, {
            headers: { 'Authorization': `Bearer ${token}` }
          })
          const iaData = await iaResp.json()
          const items = Array.isArray(iaData) ? iaData : []
          if (items.length > 0) {
            // Para cada resultado buscar precios
            const preciosPromises = items.slice(0, 3).map(async item => {
              try {
                const pr = await fetch(`${INFOAUTO_API}/pub/models/${item.codia}/prices/`, {
                  headers: { 'Authorization': `Bearer ${token}` }
                })
                const precios = await pr.json()
                const nombre = (item.brand?.name || '') + ' ' + (item.description || '')
                if (Array.isArray(precios) && precios.length > 0) {
                  const sorted = precios.sort((a,b) => (b.year||0)-(a.year||0)).slice(0,5)
                  const lineas = sorted.map(p => '  ' + p.year + ': $' + Number(p.price||0).toLocaleString('es-AR')).join('\n')
                  return `• ${nombre.trim()}:
${lineas}`
                }
                return null
              } catch(e) { return null }
            })
            const precios = (await Promise.all(preciosPromises)).filter(Boolean)
            if (precios.length > 0) {
              const preciosStr = precios.join('\n')
              infoautoExtra = '\n\n== PRECIOS INFOAUTO (busqueda: ' + query + ') ==\n' + preciosStr + '\n== FIN INFOAUTO ==\nUsa estos precios de InfoAuto para responder sobre el valor del auto. Aclara que son precios de referencia de InfoAuto.'
            }
          }
        } catch(e) { console.error('InfoAuto chat error:', e.message) }
      }
    }

    const body = {
      ...req.body,
      messages: limpiarMarcasBorrado(req.body.messages),
      system: req.body.system + stockExtra + comandos + infoautoExtra
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body)
    })

    const data = await response.json()

    if (!response.ok) {
      console.error('❌ Error de Anthropic API:', response.status, JSON.stringify(data))
      return res.status(response.status).json({ error: data.error || data })
    }

    // Procesar comandos de stock en la respuesta
    if (data.content?.[0]?.text) {
      let reply = data.content[0].text

      const guardar = reply.match(/\[GUARDAR_STOCK:(\{[^\]]+\})\]/)
      const preparar = reply.match(/\[PREPARAR_BORRADO:(\{[^\]]+\})\]/)
      const eliminar = preparar ? null : reply.match(/\[ELIMINAR_STOCK:(\{[^\]]+\})\]/) // si pidió preparar un borrado por lista, jamás se ejecuta además el borrado por modelo
      const guardarCliente = reply.match(/\[GUARDAR_CLIENTE:(\{[^\]]+\})\]/)

      if (guardar) {
        try {
          const auto = JSON.parse(guardar[1])
          const { marca, modelo, version='', anio='', km=0, color='', precio='', moneda='ARS', estado='Disponible', notas='', ubicacion='Tutu Automotores' } = auto
          const existe = await pool.query(
            'SELECT id FROM stock WHERE LOWER(marca)=LOWER($1) AND LOWER(modelo)=LOWER($2) AND anio=$3',
            [marca, modelo, String(anio)]
          )
          if (existe.rows.length > 0) {
            await pool.query(
              'UPDATE stock SET version=$1,km=$2,color=$3,precio=$4,moneda=$5,estado=$6,notas=$7,ubicacion=$8,updated_at=NOW() WHERE id=$9',
              [version, Number(km)||0, color, String(precio), moneda, estado, notas, ubicacion, existe.rows[0].id]
            )
          } else {
            await pool.query(
              'INSERT INTO stock (marca,modelo,version,anio,km,color,precio,moneda,estado,notas,ubicacion) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
              [marca, modelo, version, String(anio), Number(km)||0, color, String(precio), moneda, estado, notas, ubicacion]
            )
          }
          console.log('✅ Stock guardado:', marca, modelo, anio)
        } catch(e) { console.error('Error guardando stock:', e.message) }
        data.content[0].text = reply.replace(/\[GUARDAR_STOCK:[^\]]+\]/g, '').trim()
      }

      if (eliminar) {
        try {
          const { marca, modelo, anio } = JSON.parse(eliminar[1])
          let q = 'DELETE FROM stock WHERE LOWER(marca)=LOWER($1) AND LOWER(modelo)=LOWER($2)'
          let params = [marca, modelo]
          if (anio) { q += ' AND anio=$3'; params.push(String(anio)) }
          await pool.query(q, params)
          console.log('🗑️ Stock eliminado:', marca, modelo, anio)
        } catch(e) { console.error('Error eliminando stock:', e.message) }
        data.content[0].text = data.content[0].text.replace(/\[ELIMINAR_STOCK:[^\]]+\]/g, '').trim()
      }

      if (guardarCliente) {
        try {
          const cli = JSON.parse(guardarCliente[1])
          const {
            nombre, telefono='', dni='', modelo='', anio='', presupuesto='', notas='', asesor='',
            tiene_permuta='no', auto_permuta='', tiene_garantes='no', nombre_garante='', dni_garante=''
          } = cli
          if (nombre) {
            await pool.query(
              `INSERT INTO clientes_busqueda (nombre,telefono,modelo,anio,presupuesto,dni,tiene_permuta,auto_permuta,tiene_garantes,dni_garante,nombre_garante,notas,asesor)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
              [nombre, telefono, modelo, String(anio), String(presupuesto), dni, tiene_permuta, auto_permuta, tiene_garantes, dni_garante, nombre_garante, notas, asesor]
            )
            console.log('✅ Cliente guardado:', nombre, modelo)
          }
        } catch(e) { console.error('Error guardando cliente:', e.message) }
        data.content[0].text = data.content[0].text.replace(/\[GUARDAR_CLIENTE:[^\]]+\]/g, '').trim()
      }

      if (preparar) {
        let vistaPrevia
        try { vistaPrevia = await procesarPreparacionBorrado(preparar[1]) }
        catch (e) { console.error('Error preparando borrado:', e.message); vistaPrevia = 'No pude armar la lista para borrar. No borré nada.' }
        const base = data.content[0].text.replace(/\[PREPARAR_BORRADO:[^\]]+\]/g, '').replace(/\[ELIMINAR_STOCK:[^\]]+\]/g, '').trim()
        data.content[0].text = (base ? base + '\n\n' : '') + vistaPrevia
      }
    }

    res.json(data)
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})


// ── Match: buscar autos por modelo y/o año ──────────────────
app.get('/api/match', async (req, res) => {
  try {
    const { modelo, anio } = req.query
    if (!modelo && !anio) return res.status(400).json({ error: 'Ingresá modelo y/o año' })

    let stockRows = modelo ? await buscarEnStock(modelo) : []

    if (!modelo && anio) {
      // Solo año: buscar ±8 años
      const anioNum = parseInt(anio)
      const result = await pool.query(
        'SELECT * FROM stock WHERE anio::integer BETWEEN $1 AND $2 ORDER BY marca, modelo',
        [anioNum - 8, anioNum + 8]
      )
      return res.json(result.rows)
    }

    if (anio) {
      const anioNum = parseInt(anio)
      const RANGO = 8

      // Separar en exactos y aproximados
      const exactos = stockRows.filter(r => {
        const a = parseInt(r.anio)
        return !isNaN(a) && Math.abs(a - anioNum) <= 1
      })
      const aprox = stockRows.filter(r => {
        const a = parseInt(r.anio)
        return !isNaN(a) && Math.abs(a - anioNum) > 1 && Math.abs(a - anioNum) <= RANGO
      })
      const sinAnio = stockRows.filter(r => isNaN(parseInt(r.anio)))

      // Ordenar aprox por cercanía al año buscado
      aprox.sort((a, b) => Math.abs(parseInt(a.anio) - anioNum) - Math.abs(parseInt(b.anio) - anioNum))

      return res.json([...exactos, ...aprox, ...sinAnio])
    }

    res.json(stockRows)
  } catch(e) { res.status(500).json({ error: e.message }) }
})



// ── Clientes: carga masiva desde texto/lista ────────────────
app.post('/api/clientes/bulk', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return res.status(500).json({ error: 'API key no configurada' })
  
  const { texto: textoRaw } = req.body
  if (!textoRaw) return res.status(400).json({ error: 'Texto requerido' })

  // Limpiar el texto: juntar lineas que son continuacion de un garante
  // Si una linea no empieza con nombre+telefono ni con DNI, es continuacion de la anterior
  const lineas = textoRaw.split('\n')
  const lineasLimpias = []
  for (let i = 0; i < lineas.length; i++) {
    const l = lineas[i].trim()
    if (!l) { lineasLimpias.push(''); continue; }
    // Si la linea anterior termina con datos de garante y esta linea parece ser continuacion
    // (solo tiene nombre y/o DNI sin pipes) -> juntarla con la anterior
    const esNuevoCliente = /\|/.test(l) || /^\d{8,}/.test(l)
    if (!esNuevoCliente && lineasLimpias.length > 0 && lineasLimpias[lineasLimpias.length-1]) {
      lineasLimpias[lineasLimpias.length-1] += ' ' + l
    } else {
      lineasLimpias.push(l)
    }
  }
  const texto = lineasLimpias.filter(l => l.trim()).join('\n')

  try {
    // Usar Claude para parsear la lista
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        system: 'Sos un parser de datos de clientes de una concesionaria. Recibís texto con una lista de clientes y sus búsquedas de autos. Devolvés SOLO un JSON array sin texto extra ni markdown. Cada objeto debe tener EXACTAMENTE estos campos: {"nombre":"Juan Perez","telefono":"351123","modelo":"Gol Trend","anio":"2018","presupuesto":"12000000","dni":"12345678","tiene_permuta":"si","auto_permuta":"Ford Focus 2015","tiene_garantes":"si","dni_garante":"87654321","nombre_garante":"Maria Lopez","notas":""}. REGLAS IMPORTANTES: 1) modelo es el auto que BUSCA el cliente (marca+modelo+version). 2) anio puede ser rango como 2015-2018. 3) presupuesto es el monto disponible en pesos o dolares (solo numeros, sin simbolos). 4) dni es el DNI del CLIENTE (el numero que aparece junto a su nombre o despues de "DNI:"). 5) tiene_garantes es "si" si aparece la palabra "garante" o "garantes" o "aval". 6) dni_garante es el DNI del garante (el numero que aparece junto al nombre del garante o despues de "Garantes:"). 7) nombre_garante es el nombre completo del garante. 8) Si un numero aparece junto al nombre del garante, ese numero es su DNI. 9) tiene_permuta es "si" si menciona permuta, canje o auto en parte de pago. 10) Si no hay dato deja el campo en cadena vacia. 11) Si el vehiculo dice "No especificado" o similar, pone modelo vacio. SOLO el array JSON sin texto ni markdown. IMPORTANTE: si hay saltos de linea dentro de los datos de garantes, unilos en un solo campo. dni_garante y nombre_garante pueden tener multiples garantes separados por coma. EJEMPLO: "DNI:34988826 | Garantes:Cufre Sebastiano 32314376 Ana Graciela 13150923" -> dni_garante="32314376, 13150923", nombre_garante="Cufre Sebastiano, Ana Graciela", tiene_garantes="si". EJEMPLO2: "Maria Lopez 12345678 | 351999 | Toyota Corolla 2020 | 15 millones | DNI:12345678 | Garantes:Pedro Gomez 87654321" -> dni_garante="87654321", nombre_garante="Pedro Gomez", tiene_garantes="si".',
        messages: [{ role: 'user', content: 'Parsea esta lista:\n' + texto }]
      })
    })
    const data = await response.json()
    let raw = data.content?.[0]?.text || '[]'
    raw = raw.replace(/```json|```/g, '').trim()
    let clientes = []
    try {
      clientes = raw.startsWith('[') ? JSON.parse(raw) : JSON.parse((raw.match(/\[[\s\S]*\]/) || ['[]'])[0])
    } catch(e) { return res.status(400).json({ error: 'No se pudo parsear la lista' }) }
    let guardados = 0, errores = 0

    for (const c of clientes) {
      try {
        if (!c.nombre) continue
        await pool.query(
          `INSERT INTO clientes_busqueda (nombre,telefono,modelo,anio,presupuesto,dni,tiene_permuta,auto_permuta,tiene_garantes,dni_garante,nombre_garante,notas)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [c.nombre, c.telefono||'', c.modelo||'', c.anio||'', c.presupuesto||'', c.dni||'', c.tiene_permuta||'no', c.auto_permuta||'', c.tiene_garantes||'no', c.dni_garante||'', c.nombre_garante||'', c.notas||'']
        )
        guardados++
      } catch(e) { errores++ }
    }

    // Buscar matches en stock para toda la lista
    const conModelo = clientes.filter(c => c.modelo && c.modelo.length > 2)
    let matches = []
    for (const c of conModelo) {
      const rows = await buscarEnStock(c.modelo)
      if (rows.length > 0) {
        matches.push({ cliente: c.nombre, busca: c.modelo, autos: rows })
      }
    }

    res.json({ ok: true, guardados, errores, matches, clientes })
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})



// ── Función centralizada de búsqueda inteligente ────────────
async function buscarEnStock(texto) {
  if (!texto || texto.length < 2) return []

  const stopWords = new Set(['con','los','las','del','una','por','para','que','año','auto','autos','vehiculo','nuevo','nueva'])

  const palabras = texto.split(/\s+/)
    .filter(p => p.length >= 2 && !stopWords.has(p.toLowerCase()) && isNaN(p))

  if (palabras.length === 0) return []

  // 1. Traer candidatos: autos que contengan AL MENOS UNA de las palabras buscadas
  //    en marca, modelo o versión (sin importar en qué campo esté cada palabra,
  //    porque la IA no siempre las guarda en el mismo campo)
  const orClauses = palabras.map((_, i) =>
    `LOWER(CONCAT(marca,' ',modelo,' ',version)) LIKE LOWER($${i+1})`
  ).join(' OR ')
  const params = palabras.map(p => `%${p}%`)
  const candidatos = await pool.query(`SELECT * FROM stock WHERE ${orClauses} ORDER BY marca, modelo`, params)
  if (candidatos.rows.length === 0) return []

  // 2. Puntuar cada auto según cuántas palabras de la búsqueda contiene
  //    (sumando marca+modelo+version), y quedarnos con los mejor puntuados
  const scored = candidatos.rows.map(r => {
    const campo = `${r.marca||''} ${r.modelo||''} ${r.version||''}`.toLowerCase()
    const score = palabras.filter(p => campo.includes(p.toLowerCase())).length
    return { row: r, score }
  })
  const maxScore = Math.max(...scored.map(s => s.score))
  // Si hay 2+ palabras relevantes, exigimos que matcheen al menos 2 (o todas, si solo hay 1)
  const minScore = palabras.length >= 2 ? Math.min(2, maxScore) : 1
  return scored.filter(s => s.score >= minScore).sort((a, b) => b.score - a.score).map(s => s.row)
}

// ── Migración: cargar stock hardcodeado a la DB ─────────────
app.post('/api/migrar-stock', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return res.status(500).json({ error: 'API key no configurada' })

  const stockData = [
    {marca:'Shineray',modelo:'M7 Pasajeros',version:'7AS MT 2.0 Nafta',anio:'2026',km:0,color:'Blanco',precio:'29300',moneda:'USD',estado:'Disponible',ubicacion:'Tutu Automotores'},
    {marca:'Shineray',modelo:'M7 Pasajeros',version:'9AS MT 2.0 Nafta',anio:'2026',km:0,color:'Blanco',precio:'29400',moneda:'USD',estado:'Disponible',ubicacion:'Tutu Automotores'},
    {marca:'Shineray',modelo:'M7 Furgon',version:'MT 2.0 Nafta',anio:'2026',km:0,color:'Blanco',precio:'23700',moneda:'USD',estado:'Disponible',ubicacion:'Tutu Automotores'},
    {marca:'Shineray',modelo:'M7 Pasajeros',version:'11AS',anio:'2026',km:0,color:'Blanco',precio:'29700',moneda:'USD',estado:'Disponible',ubicacion:'Tutu Automotores'},
    {marca:'Shineray',modelo:'G03F',version:'1.5 AUT Hibrida SUV 7AS',anio:'2026',km:0,color:'Blanco',precio:'24200',moneda:'USD',estado:'Disponible',ubicacion:'Tutu Automotores'},
    {marca:'Shineray',modelo:'SWM G03F',version:'1.5 MT Nafta 108HP',anio:'2026',km:0,color:'Negro/Gris',precio:'24200',moneda:'USD',estado:'Disponible',ubicacion:'Tutu Automotores'},
    {marca:'Shineray',modelo:'T30',version:'1.6 Cabina Simple',anio:'2026',km:0,color:'Blanco',precio:'23600',moneda:'USD',estado:'Disponible',ubicacion:'Tutu Automotores'},
    {marca:'Shineray',modelo:'T30 Box Refrigerado',version:'1.6',anio:'2026',km:0,color:'Blanco',precio:'35600',moneda:'USD',estado:'Disponible',ubicacion:'Tutu Automotores'},
    {marca:'Shineray',modelo:'X30 L EV',version:'Electrica 7AS',anio:'2026',km:0,color:'Blanco',precio:'24600',moneda:'USD',estado:'Disponible',ubicacion:'Tutu Automotores'},
    {marca:'JMC',modelo:'Grand Avenue',version:'GL MT 4x2 Nafta 241HP',anio:'2026',km:0,color:'Varios',precio:'28300',moneda:'USD',estado:'Disponible',ubicacion:'Tutu Automotores'},
    {marca:'JMC',modelo:'Grand Avenue',version:'GL AT 4x2 Nafta 241HP',anio:'2026',km:0,color:'Varios',precio:'31100',moneda:'USD',estado:'Disponible',ubicacion:'Tutu Automotores'},
    {marca:'JMC',modelo:'Grand Avenue',version:'GL MT 4x4 Diesel Puma 174HP',anio:'2026',km:0,color:'Gris Azulada',precio:'37500',moneda:'USD',estado:'Disponible',ubicacion:'Tutu Automotores'},
    {marca:'JMC',modelo:'Grand Avenue',version:'GL AT 4x4 Diesel Puma 174HP',anio:'2026',km:0,color:'Negro/Gris',precio:'41300',moneda:'USD',estado:'Disponible',ubicacion:'Tutu Automotores'},
    {marca:'JMC',modelo:'Grand Avenue',version:'GL AT 4x4 Nafta Off Road',anio:'2026',km:0,color:'Amarillo',precio:'44700',moneda:'USD',estado:'Disponible',ubicacion:'Tutu Automotores'},
    {marca:'JMC',modelo:'Grand Avenue',version:'SLX AT 4x4 Nafta 241HP',anio:'2026',km:0,color:'Blanco/Negro',precio:'45800',moneda:'USD',estado:'Disponible',ubicacion:'Tutu Automotores'},
    {marca:'JMC',modelo:'Grand Avenue PRO',version:'DADAO 252HP',anio:'2026',km:0,color:'Rojo/Negro',precio:'54200',moneda:'USD',estado:'Disponible',ubicacion:'Tutu Automotores'},
    {marca:'JMC',modelo:'N900',version:'Camion 4000kg Ind.Arg',anio:'2025',km:0,color:'Blanco',precio:'41500',moneda:'USD',estado:'Disponible',ubicacion:'Tutu Automotores'},
    {marca:'Domy',modelo:'K2',version:'C/D 1.5 Cabina Doble',anio:'2026',km:0,color:'Blanco',precio:'19900',moneda:'USD',estado:'Disponible',ubicacion:'Tutu Automotores'},
    {marca:'Domy',modelo:'Victory Furgon',version:'V1 1.5 104HP',anio:'2026',km:0,color:'Blanco',precio:'19900',moneda:'USD',estado:'Disponible',ubicacion:'Tutu Automotores'},
    {marca:'Chevrolet',modelo:'Cruze',version:'5P 1.4 Turbo LT MT',anio:'2018',km:73900,color:'Blanco',precio:'21500000',moneda:'ARS',estado:'Disponible',ubicacion:'Tutu Automotores'},
    {marca:'Chevrolet',modelo:'Tracker',version:'1.2T AT',anio:'2025',km:15000,color:'Gris',precio:'35500000',moneda:'ARS',estado:'Disponible',ubicacion:'Tutu Automotores'},
    {marca:'Ford',modelo:'Bronco Sport',version:'Wildtrak 2.0L AT',anio:'2022',km:73500,color:'Blanco',precio:'55000000',moneda:'ARS',estado:'Disponible',ubicacion:'Tutu Automotores'},
    {marca:'Ford',modelo:'Ranger',version:'3.0 TDI DC 4x4 LTD+ V6 10AT',anio:'2024',km:39000,color:'Naranja',precio:'71000000',moneda:'ARS',estado:'Disponible',ubicacion:'Tutu Automotores'},
    {marca:'Toyota',modelo:'Hilux',version:'DC 4x4 SRX AT 2.8 TDI',anio:'2022',km:76500,color:'Blanco',precio:'60000000',moneda:'ARS',estado:'Disponible',ubicacion:'Tutu Automotores'},
    {marca:'Toyota',modelo:'RAV4',version:'2.5 Hibrido Sport',anio:'2023',km:19000,color:'Gris',precio:'72000000',moneda:'ARS',estado:'Disponible',ubicacion:'Tutu Automotores'},
    {marca:'Toyota',modelo:'Corolla Cross',version:'XEI 2.0',anio:'2023',km:38000,color:'Blanco',precio:'51000000',moneda:'ARS',estado:'Disponible',ubicacion:'Tutu Automotores'},
    {marca:'Toyota',modelo:'Hilux',version:'DC 4x4 SRV AT 2.8 TDI',anio:'2021',km:108000,color:'Plata',precio:'52000000',moneda:'ARS',estado:'Disponible',ubicacion:'Tutu Automotores'},
    {marca:'Volkswagen',modelo:'Amarok',version:'2.0 TDI 4x4 Highline AT',anio:'2019',km:113000,color:'Gris',precio:'52000000',moneda:'ARS',estado:'Disponible',ubicacion:'Tutu Automotores'},
    {marca:'Ford',modelo:'Ranger Raptor',version:'2.0L BIT 4x4 10AT',anio:'2022',km:91700,color:'Azul',precio:'65000000',moneda:'ARS',estado:'Disponible',ubicacion:'Tutu Automotores'},
    {marca:'Peugeot',modelo:'3008',version:'Allure Plus 1.6T AT8',anio:'2022',km:48000,color:'Blanco',precio:'47000000',moneda:'ARS',estado:'Disponible',ubicacion:'Tutu Automotores'},
    {marca:'Jeep',modelo:'Compass',version:'Sport 1.3T DCT',anio:'2022',km:65000,color:'Gris',precio:'42000000',moneda:'ARS',estado:'Disponible',ubicacion:'Tutu Automotores'},
    {marca:'Jeep',modelo:'Renegade',version:'Longitude 1.8 AT',anio:'2022',km:44000,color:'Blanco',precio:'36000000',moneda:'ARS',estado:'Disponible',ubicacion:'Tutu Automotores'},
    {marca:'Honda',modelo:'HRV',version:'LX CVT',anio:'2017',km:130000,color:'Blanco',precio:'26000000',moneda:'ARS',estado:'Disponible',ubicacion:'Tutu Automotores'},
    {marca:'Mini',modelo:'Cooper',version:'1.5 3P S',anio:'2019',km:50000,color:'Negro',precio:'35000000',moneda:'ARS',estado:'Disponible',ubicacion:'Tutu Automotores'},
    {marca:'Renault',modelo:'Koleos',version:'Bose 2.5 CVT 4WD',anio:'2018',km:100000,color:'Gris Plata',precio:'32000000',moneda:'ARS',estado:'Disponible',ubicacion:'Tutu Automotores'},
    {marca:'Citroen',modelo:'C3 Aircross',version:'T200 Shine 7 MY24',anio:'2024',km:38500,color:'Gris Bitono',precio:'30500000',moneda:'ARS',estado:'Disponible',ubicacion:'Tutu Automotores'},
    {marca:'Hyundai',modelo:'H1',version:'2.5 CRDI 12 Pasajeros',anio:'2016',km:163400,color:'Gris Topo',precio:'31500',moneda:'USD',estado:'Disponible',ubicacion:'Tutu Automotores'},
    {marca:'Ford',modelo:'Ranger',version:'DC 4x4 XLT AT 3.2L D',anio:'2019',km:169000,color:'Gris Oscuro',precio:'37000000',moneda:'ARS',estado:'Disponible',ubicacion:'Tutu Automotores'},
    {marca:'Chevrolet',modelo:'S10',version:'2.8 TD 4x2 LS MT',anio:'2020',km:76000,color:'Gris Plata',precio:'35000000',moneda:'ARS',estado:'Disponible',ubicacion:'Tutu Automotores'},
    {marca:'Chrysler',modelo:'Town & Country',version:'Limited 3.6',anio:'2012',km:150000,color:'Gris Plata',precio:'26000000',moneda:'ARS',notas:'Blindado',estado:'Disponible',ubicacion:'Tutu Automotores'},
    {marca:'Fiat',modelo:'Cronos',version:'Like 1.3 GSE BZ',anio:'2026',km:0,color:'Gris Plata',precio:'33207820',moneda:'ARS',estado:'Disponible',ubicacion:'Tutu Automotores'},
    {marca:'Dodge',modelo:'RAM 1500',version:'5.7 V8 Laramie 4x4',anio:'2015',km:99000,color:'Negro',precio:'33300',moneda:'USD',estado:'Disponible',ubicacion:'Tutu Automotores'},
    {marca:'Iveco',modelo:'Daily',version:'55C16 Paso 3750',anio:'2013',km:220000,color:'Blanco',precio:'75000',moneda:'USD',estado:'Disponible',ubicacion:'Tutu Automotores'},
  ]

  let guardados = 0, errores = 0, saltados = 0
  for (const a of stockData) {
    try {
      const existe = await pool.query(
        'SELECT id FROM stock WHERE LOWER(marca)=LOWER($1) AND LOWER(modelo)=LOWER($2) AND anio=$3',
        [a.marca, a.modelo, String(a.anio)]
      )
      if (existe.rows.length > 0) { saltados++; continue }
      await pool.query(
        'INSERT INTO stock (marca,modelo,version,anio,km,color,precio,moneda,estado,notas,ubicacion) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        [a.marca, a.modelo, a.version||'', String(a.anio), Number(a.km)||0, a.color||'', String(a.precio), a.moneda||'ARS', a.estado||'Disponible', a.notas||'', a.ubicacion||'Tutu Automotores']
      )
      guardados++
    } catch(e) { errores++; console.error('Error migrando:', a.marca, a.modelo, e.message) }
  }
  res.json({ ok: true, guardados, saltados, errores, total: stockData.length })
})


// ── Stock: carga masiva desde texto (con chunking) ──────────
app.post('/api/stock/bulk', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return res.status(500).json({ error: 'API key no configurada' })
  const { texto, ubicacion='Tutu Automotores', moneda='ARS', telefono='' } = req.body
  if (!texto) return res.status(400).json({ error: 'Texto requerido' })
  try {
    // Dividir en líneas y procesar en grupos de 30 autos
    const lineas = texto.split('\n').filter(l => l.trim())
    const CHUNK_SIZE = 30
    let todosLosAutos = []

    for (let i = 0; i < lineas.length; i += CHUNK_SIZE) {
      const chunk = lineas.slice(i, i + CHUNK_SIZE).join('\n')
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 8000,
          system: 'Sos un parser de autos. Extraé los datos y devolvé SOLO un JSON array válido y completo. Cada auto: {"marca":"Ford","modelo":"Fiesta","version":"1.6 SE","anio":"2015","km":225000,"color":"Blanco","precio":"11100000","moneda":"' + moneda + '","estado":"Disponible","notas":""}. Precio sin $ ni puntos. SOLO el array JSON.',
          messages: [{ role: 'user', content: 'Parsea estos autos:\n' + chunk }]
        })
      })
      const data = await response.json()
      if (data.error) { console.error('API error en chunk:', data.error.message); continue }
      let raw = (data.content?.[0]?.text || '[]').replace(/```json|```/g, '').trim()
      try {
        const parsed = raw.startsWith('[') ? JSON.parse(raw) : JSON.parse((raw.match(/\[[\s\S]*\]/) || ['[]'])[0])
        todosLosAutos = todosLosAutos.concat(parsed)
      } catch(e) { console.error('Parse error en chunk:', e.message, raw.substring(0, 100)) }
    }

    console.log('Total autos parseados:', todosLosAutos.length)
    const result = await guardarAutosEnDB(todosLosAutos, ubicacion, telefono)
    const matches = await buscarMatchesClientes(todosLosAutos)
    res.json({ ...result, matches })
  } catch(e) { res.status(500).json({ error: e.message }) }
})


// ── Stock: carga desde PDF ────────────────────────────────────
app.post('/api/stock/bulk-pdf', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return res.status(500).json({ error: 'API key no configurada' })
  const { pdf, ubicacion='Tutu Automotores', moneda='ARS', telefono='' } = req.body
  if (!pdf) return res.status(400).json({ error: 'PDF requerido' })
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4000,
        system: `Sos un parser de PDFs de autos usados. Extraés todos los vehículos del documento y devolvés SOLO un JSON array sin texto extra ni markdown.
Formato: {"marca":"Ford","modelo":"Fiesta","version":"1.6 SE","anio":"2015","km":225000,"color":"Blanco","precio":"11100000","moneda":"${moneda}","estado":"Disponible","notas":""}
- Extraé TODOS los autos del PDF
- Convertí precios a número limpio sin $ ni puntos
- moneda: "${moneda}" salvo que diga explícitamente USD
- SOLO el array JSON`,
        messages: [{
          role: 'user',
          content: [
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf } },
            { type: 'text', text: 'Extraé todos los autos de este PDF y devolvé el JSON array.' }
          ]
        }]
      })
    })
    const data = await response.json()
    let raw = data.content?.[0]?.text || '[]'
    raw = raw.replace(/```json|```/g, '').trim()
    let autos = []
    try {
      if (raw.startsWith('[')) {
        autos = JSON.parse(raw)
      } else {
        const matchArr = raw.match(/\[[\s\S]*\]/)
        if (!matchArr) return res.status(400).json({ error: 'No se encontraron autos en el PDF' })
        autos = JSON.parse(matchArr[0])
      }
    } catch(e) {
      return res.status(400).json({ error: 'JSON inválido en PDF: ' + e.message })
    }
    const result = await guardarAutosEnDB(autos, ubicacion, telefono)
    const matches = await buscarMatchesClientes(autos)
    res.json({ ...result, matches })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── Helpers compartidos ──────────────────────────────────────
async function guardarAutosEnDB(autos, ubicacion, telefono='') {
  let guardados = 0, saltados = 0, errores = 0
  for (const a of autos) {
    if (!a.modelo) { errores++; continue }
    var marca = a.marca || '';
    try {
      const existe = await pool.query(
        'SELECT id FROM stock WHERE LOWER(marca)=LOWER($1) AND LOWER(modelo)=LOWER($2) AND anio=$3 AND LOWER(ubicacion)=LOWER($4)',
        [marca, a.modelo, String(a.anio||''), ubicacion]
      )
      if (existe.rows.length > 0) { saltados++; continue }
      await pool.query(
        'INSERT INTO stock (marca,modelo,version,anio,km,color,precio,moneda,estado,notas,ubicacion,telefono) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
        [marca, a.modelo, a.version||'', String(a.anio||''), Number(a.km)||0, a.color||'', String(a.precio||''), a.moneda||'ARS', a.estado||'Disponible', a.notas||'', ubicacion, telefono]
      )
      guardados++
    } catch(e) { errores++; console.error('Error guardando auto:', e.message) }
  }
  return { guardados, saltados, errores }
}

async function buscarMatchesClientes(autos) {
  const matches = []
  for (const a of autos) {
    if (!a.modelo) continue
    const r = await pool.query(
      `SELECT nombre, modelo FROM clientes_busqueda WHERE estado='Buscando' AND LOWER(modelo) LIKE LOWER($1)`,
      [`%${a.modelo.split(' ')[0]}%`]
    )
    for (const c of r.rows) {
      if (!matches.find(m => m.cliente === c.nombre && m.busca === c.modelo)) {
        matches.push({ cliente: c.nombre, busca: c.modelo })
      }
    }
  }
  return matches
}

// ── Clientes busqueda: leer ──────────────────────────────────
app.get('/api/clientes', async (req, res) => {
  try {
    const { modelo, anio } = req.query
    let where = ['estado=$1']
    let params = ['Buscando']
    if (modelo) {
      const pals = modelo.split(/\s+/).filter(p => p.length >= 3 && !['con','los','las','del','una','por'].includes(p.toLowerCase()))
      if (pals.length > 0) {
        const subs = pals.map(p => { params.push('%'+p+'%'); return 'LOWER(modelo) LIKE LOWER($'+params.length+')' })
        where.push('('+subs.join(' OR ')+')')
      }
    }
    if (anio) { params.push(String(anio)); where.push('anio=$'+params.length) }
    const q = 'SELECT DISTINCT ON (LOWER(nombre), LOWER(telefono)) * FROM clientes_busqueda WHERE '+where.join(' AND ')+' ORDER BY LOWER(nombre), LOWER(telefono), created_at DESC'
    const r = await pool.query(q, params)
    res.json(r.rows)
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── Clientes busqueda: guardar ───────────────────────────────
app.post('/api/clientes', async (req, res) => {
  try {
    const {
      nombre, telefono='', marca='', modelo, anio='', presupuesto='', notas='', asesor='',
      dni='', tiene_permuta='no', auto_permuta='', tiene_garantes='no', nombre_garante='', dni_garante=''
    } = req.body
    if (!nombre || !modelo) return res.status(400).json({ error: 'Nombre y modelo requeridos' })
    await pool.query(
      `INSERT INTO clientes_busqueda
       (nombre,telefono,marca,modelo,anio,presupuesto,notas,asesor,dni,tiene_permuta,auto_permuta,tiene_garantes,nombre_garante,dni_garante)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [nombre, telefono, marca, modelo, String(anio), String(presupuesto), notas, asesor,
       dni, tiene_permuta, auto_permuta, tiene_garantes, nombre_garante, dni_garante]
    )
    // Buscar si hay match en stock
    const stockMatch = await pool.query(
      `SELECT * FROM stock WHERE (LOWER(modelo) LIKE LOWER($1) OR LOWER(marca) LIKE LOWER($1)) ${anio ? 'AND anio=$2' : ''}`,
      anio ? [`%${modelo}%`, String(anio)] : [`%${modelo}%`]
    )
    res.json({ ok: true, matches: stockMatch.rows })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── Clientes busqueda: eliminar ──────────────────────────────
app.delete('/api/clientes/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM clientes_busqueda WHERE id=$1', [req.params.id])
    res.json({ ok: true })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── Clientes busqueda: marcar encontrado ─────────────────────
app.patch('/api/clientes/:id', async (req, res) => {
  try {
    const campos = ['estado','vendedor','calificacion','observaciones','estado_lead','motivo_perdida','bancos','monto_galicia','monto_bancor','monto_nacion','monto_santander','monto_mg',
      'nombre','telefono','dni','modelo','anio','presupuesto','tiene_permuta','auto_permuta','tiene_garantes','nombre_garante','dni_garante']
    const sets = []
    const params = []
    campos.forEach(campo => {
      if (req.body[campo] !== undefined) {
        params.push(req.body[campo])
        sets.push(campo + '=$' + params.length)
      }
    })
    if (sets.length === 0) return res.status(400).json({ error: 'Nada que actualizar' })
    sets.push('updated_at=NOW()')
    params.push(req.params.id)
    await pool.query('UPDATE clientes_busqueda SET ' + sets.join(',') + ' WHERE id=$' + params.length, params)
    res.json({ ok: true })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── Dashboard por vendedor ────────────────────────────────────
app.get('/api/dashboard/vendedores', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT 
        COALESCE(NULLIF(vendedor,''), 'Sin asignar') as vendedor,
        COUNT(*) as total,
        SUM(CASE WHEN calificacion = 'sirve' THEN 1 ELSE 0 END) as sirve,
        SUM(CASE WHEN calificacion = 'no_sirve' THEN 1 ELSE 0 END) as no_sirve,
        SUM(CASE WHEN calificacion = '' OR calificacion IS NULL THEN 1 ELSE 0 END) as sin_calificar,
        SUM(CASE WHEN estado = 'Encontrado' THEN 1 ELSE 0 END) as encontrados
      FROM clientes_busqueda
      WHERE estado IN ('Buscando', 'Encontrado')
      GROUP BY COALESCE(NULLIF(vendedor,''), 'Sin asignar')
      ORDER BY total DESC
    `)
    res.json(r.rows)
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── Clientes por vendedor ─────────────────────────────────────
app.get('/api/dashboard/vendedores/:vendedor', async (req, res) => {
  try {
    const v = req.params.vendedor === 'Sin asignar' ? '' : req.params.vendedor
    const { calificacion } = req.query
    let where = ["estado IN ('Buscando','Encontrado')"]
    const params = []
    if (v === '') {
      where.push("(vendedor='' OR vendedor IS NULL)")
    } else {
      params.push(v)
      where.push('vendedor=$'+params.length)
    }
    if (calificacion) { params.push(calificacion); where.push('calificacion=$'+params.length) }
    const r = await pool.query(
      'SELECT * FROM clientes_busqueda WHERE '+where.join(' AND ')+' ORDER BY created_at DESC',
      params
    )
    res.json(r.rows)
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── Comparador de precios (ML) ────────────────────────────────
app.post('/api/buscar', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return res.status(500).json({ error: 'API key no configurada' })
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(req.body)
    })
    res.json(await response.json())
  } catch(e) { res.status(500).json({ error: e.message }) }
})


// ── INFOAUTO ─────────────────────────────────────────────────────────────────
const INFOAUTO_API   = 'https://api.infoauto.com.ar/cars'
const INFOAUTO_EMAIL = process.env.INFOAUTO_EMAIL || 'ventas@tutuautomotores.com'
const INFOAUTO_PASS  = process.env.INFOAUTO_PASS  || 'Tutunadiecomotutu'

let infoautoToken    = null
let infoautoExpiry   = 0
let infoautoRefresh  = null

async function infoautoLogin() {
  const basicToken = Buffer.from(`${INFOAUTO_EMAIL}:${INFOAUTO_PASS}`).toString('base64')
  const r = await fetch(`${INFOAUTO_API}/auth/login`, {
    method: 'POST',
    headers: {
      'Content-type': 'application/json',
      'Authorization': `Basic ${basicToken}`
    }
  })
  if (!r.ok) throw new Error('InfoAuto login falló: ' + r.status)
  const d = await r.json()
  infoautoToken   = d.access_token
  infoautoRefresh = d.refresh_token
  infoautoExpiry  = Date.now() + 55 * 60 * 1000 // 55 min
  console.log('✅ InfoAuto autenticado')
  return infoautoToken
}

async function infoautoRefreshToken() {
  try {
    const r = await fetch(`${INFOAUTO_API}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${infoautoRefresh}` }
    })
    if (!r.ok) return infoautoLogin()
    const d = await r.json()
    infoautoToken  = d.access_token
    infoautoExpiry = Date.now() + 55 * 60 * 1000
    return infoautoToken
  } catch(e) { return infoautoLogin() }
}

async function getInfoautoToken() {
  if (!infoautoToken || Date.now() > infoautoExpiry) {
    if (infoautoRefresh && infoautoToken) return infoautoRefreshToken()
    return infoautoLogin()
  }
  return infoautoToken
}

async function infoautoFetch(path) {
  const token = await getInfoautoToken()
  const r = await fetch(`${INFOAUTO_API}${path}`, {
    headers: { 'Authorization': `Bearer ${token}` }
  })
  if (r.status === 401) {
    // Token expirado, hacer login de nuevo
    await infoautoLogin()
    const r2 = await fetch(`${INFOAUTO_API}${path}`, {
      headers: { 'Authorization': `Bearer ${infoautoToken}` }
    })
    return r2.json()
  }
  return r.json()
}

// Buscar autos en InfoAuto
app.get('/api/infoauto/search', async (req, res) => {
  try {
    const { q, page = 1, pageSize = 20 } = req.query
    if (!q) return res.status(400).json({ error: 'Falta query' })
    const token = await getInfoautoToken()
    const r = await fetch(`${INFOAUTO_API}/pub/search/?page=${page}&page_size=${pageSize}&query_string=${encodeURIComponent(q)}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    })
    const data = await r.json()
    res.json(data)
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// Ver precio de un modelo especifico
app.get('/api/infoauto/precio/:id', async (req, res) => {
  try {
    const token = await getInfoautoToken()
    const r = await fetch(`${INFOAUTO_API}/pub/models/${req.params.id}/prices/`, {
      headers: { 'Authorization': `Bearer ${token}` }
    })
    const data = await r.json()
    res.json(data)
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// Iniciar sesion en InfoAuto al arrancar
infoautoLogin().catch(e => console.error('⚠️ InfoAuto login inicial falló:', e.message))
console.log('✅ Endpoint /api/infoauto/search registrado')
console.log('✅ Endpoint /api/infoauto/precio/:id registrado')
// ── FIN INFOAUTO ──────────────────────────────────────────────────────────────


// ── VENDEDORES ────────────────────────────────────────────────────────────────
// Crear tabla vendedores en PostgreSQL si no existe e insertar defaults
;(async () => {
  await pool.query(`CREATE TABLE IF NOT EXISTS vendedores (
    id SERIAL PRIMARY KEY,
    nombre TEXT UNIQUE NOT NULL
  )`);
  const { rows } = await pool.query('SELECT COUNT(*) as c FROM vendedores');
  if (parseInt(rows[0].c) === 0) {
    for (const n of ['Joaquin','Agustin','Rodrigo','Nahuel','Lucas','Matias']) {
      await pool.query('INSERT INTO vendedores (nombre) VALUES ($1) ON CONFLICT DO NOTHING', [n]);
    }
  }
})().catch(e => console.error('Error init vendedores:', e.message));

// GET /api/vendedores — lista de nombres
app.get('/api/vendedores', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT nombre FROM vendedores ORDER BY nombre');
    res.json(rows.map(r => r.nombre));
  } catch(e) { res.status(500).json({ error: e.message }) }
});

// POST /api/vendedores — agregar vendedor
app.post('/api/vendedores', async (req, res) => {
  const { nombre } = req.body;
  if (!nombre) return res.status(400).json({ error: 'Falta nombre' });
  try {
    await pool.query('INSERT INTO vendedores (nombre) VALUES ($1)', [nombre.trim()]);
    res.json({ ok: true });
  } catch(e) { res.status(409).json({ error: 'Ya existe' }); }
});

// PATCH /api/vendedores/:nombre — renombrar vendedor
app.patch('/api/vendedores/:nombre', async (req, res) => {
  const { nombre } = req.params;
  const { nombre: nuevo } = req.body;
  if (!nuevo) return res.status(400).json({ error: 'Falta nombre nuevo' });
  try {
    await pool.query('UPDATE vendedores SET nombre=$1 WHERE nombre=$2', [nuevo.trim(), nombre]);
    await pool.query('UPDATE clientes_busqueda SET vendedor=$1 WHERE vendedor=$2', [nuevo.trim(), nombre]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }) }
});

// DELETE /api/vendedores/:nombre — eliminar vendedor
app.delete('/api/vendedores/:nombre', async (req, res) => {
  const { nombre } = req.params;
  try {
    await pool.query('DELETE FROM vendedores WHERE nombre=$1', [nombre]);
    await pool.query("UPDATE clientes_busqueda SET vendedor='' WHERE vendedor=$1", [nombre]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }) }
});
// ── FIN VENDEDORES ────────────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, 'public')))

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`🚀 Servidor en puerto ${PORT}`))
