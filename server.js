const express = require('express')
const cors = require('cors')
const fetch = require('node-fetch')
const path = require('path')
const { Pool } = require('pg')

const app = express()
app.use(cors())
app.use(express.json({ limit: '50mb' }))
app.use(express.static(path.join(__dirname, 'public')))

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
    const { marca, modelo, version='', anio='', km=0, color='', precio='', moneda='ARS', estado='Disponible', notas='', ubicacion='Tutu Automotores' } = req.body
    if (!marca || !modelo) return res.status(400).json({ error: 'Marca y modelo son requeridos' })

    // Buscar si ya existe
    const existe = await pool.query(
      'SELECT id FROM stock WHERE LOWER(marca)=LOWER($1) AND LOWER(modelo)=LOWER($2) AND anio=$3',
      [marca, modelo, String(anio)]
    )

    if (existe.rows.length > 0) {
      await pool.query(
        'UPDATE stock SET version=$1,km=$2,color=$3,precio=$4,moneda=$5,estado=$6,notas=$7,ubicacion=$8,updated_at=NOW() WHERE id=$9',
        [version, Number(km)||0, color, String(precio), moneda, estado, notas, ubicacion, existe.rows[0].id]
      )
      res.json({ ok: true, accion: 'actualizado' })
    } else {
      await pool.query(
        'INSERT INTO stock (marca,modelo,version,anio,km,color,precio,moneda,estado,notas) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [marca, modelo, version, String(anio), Number(km)||0, color, String(precio), moneda, estado, notas]
      )
      res.json({ ok: true, accion: 'guardado' })
    }
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
app.post('/api/chat', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return res.status(500).json({ error: 'API key no configurada en el servidor' })

  try {
    // Leer stock dinámico de la DB
    const stockRows = await pool.query('SELECT * FROM stock ORDER BY marca, modelo, anio')
    const stock = stockRows.rows

    let stockExtra = ''
    if (stock.length > 0) {
      const lineas = stock.map(a =>
        `• ${a.marca} ${a.modelo}${a.version ? ' '+a.version : ''} ${a.anio} | ` +
        `KM: ${Number(a.km).toLocaleString('es-AR')} | Color: ${a.color||'-'} | ` +
        `Precio: ${a.precio} ${a.moneda} | Estado: ${a.estado}${a.notas ? ' | '+a.notas : ''}`
      ).join('\n')
      stockExtra = `\n\n== STOCK CARGADO POR EMPLEADOS (${stock.length} vehículos — PRIORIDAD ALTA) ==\n${lineas}\n== FIN STOCK EMPLEADOS ==`
    }

    const comandos = `

== GESTIÓN DE STOCK ==
Cuando el usuario diga "guardá", "agregá", "cargá" o "actualizá" un auto:
• Extraé todos los datos disponibles del mensaje
• Si no menciona ubicación, usá "Tutu Automotores"
• Si menciona otra agencia o lugar, usá ese nombre en ubicacion
• Confirmá con un mensaje claro al usuario
• Al FINAL de tu respuesta agregá EXACTAMENTE (una sola línea, sin saltos dentro del JSON):
[GUARDAR_STOCK:{"marca":"Ford","modelo":"Ranger","version":"XLT 4x4","anio":"2022","km":45000,"color":"Blanca","precio":"58000000","moneda":"ARS","estado":"Disponible","notas":"","ubicacion":"Tutu Automotores"}]

Cuando el usuario diga que un cliente busca un auto ("X busca", "X quiere", "X está buscando"):
• Extraé nombre del cliente, modelo, año, teléfono si lo hay
• Confirmá con un mensaje
• Al FINAL agregá: [GUARDAR_CLIENTE:{"nombre":"Juan Perez","telefono":"351-1234567","modelo":"Gol Trend","anio":"2012","presupuesto":"","notas":"","asesor":""}]

Cuando el usuario diga "eliminá", "borrá" o "sacá" un auto:
• Confirmá con un mensaje claro
• Al FINAL agregá: [ELIMINAR_STOCK:{"marca":"Ford","modelo":"Ranger","anio":"2022"}]

Cuando diga "mostrá el stock", "qué autos tenemos", "listá vehículos cargados":
• Mostrá el stock de la sección STOCK CARGADO POR EMPLEADOS de forma ordenada y clara.

IMPORTANTE: Los bloques [GUARDAR_STOCK:...] y [ELIMINAR_STOCK:...] van siempre al final, en una línea, sin saltos de línea adentro del JSON.`

    // Inyectar stock y comandos en el system prompt
    const body = {
      ...req.body,
      system: req.body.system + stockExtra + comandos
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

    // Procesar comandos de stock en la respuesta
    if (data.content?.[0]?.text) {
      let reply = data.content[0].text

      const guardar = reply.match(/\[GUARDAR_STOCK:(\{[^\]]+\})\]/)
      const eliminar = reply.match(/\[ELIMINAR_STOCK:(\{[^\]]+\})\]/)

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
    
    let conditions = []
    let params = []
    let i = 1
    
    if (modelo) {
      conditions.push(`(LOWER(marca) LIKE LOWER($${i}) OR LOWER(modelo) LIKE LOWER($${i}) OR LOWER(CONCAT(marca,' ',modelo)) LIKE LOWER($${i}) OR LOWER(version) LIKE LOWER($${i}))`)
      params.push(`%${modelo}%`)
      i++
    }
    if (anio) {
      conditions.push(`anio = $${i}`)
      params.push(String(anio))
      i++
    }
    
    const query = `SELECT * FROM stock WHERE ${conditions.join(' AND ')} ORDER BY ubicacion, marca, modelo, anio`
    const result = await pool.query(query, params)
    res.json(result.rows)
  } catch(e) { res.status(500).json({ error: e.message }) }
})


// ── Clientes busqueda: leer ──────────────────────────────────
app.get('/api/clientes', async (req, res) => {
  try {
    const { modelo, anio } = req.query
    let q = 'SELECT * FROM clientes_busqueda WHERE estado=$1'
    let params = ['Buscando']
    if (modelo) { q += ` AND (LOWER(modelo) LIKE LOWER($2) OR LOWER(marca) LIKE LOWER($2))`; params.push(`%${modelo}%`) }
    if (anio) { q += ` AND anio=$${params.length+1}`; params.push(String(anio)) }
    q += ' ORDER BY created_at DESC'
    const r = await pool.query(q, params)
    res.json(r.rows)
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── Clientes busqueda: guardar ───────────────────────────────
app.post('/api/clientes', async (req, res) => {
  try {
    const { nombre, telefono='', marca='', modelo, anio='', presupuesto='', notas='', asesor='' } = req.body
    if (!nombre || !modelo) return res.status(400).json({ error: 'Nombre y modelo requeridos' })
    await pool.query(
      'INSERT INTO clientes_busqueda (nombre,telefono,marca,modelo,anio,presupuesto,notas,asesor) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [nombre, telefono, marca, modelo, String(anio), String(presupuesto), notas, asesor]
    )
    // Buscar si hay match en stock
    const stockMatch = await pool.query(
      `SELECT * FROM stock WHERE (LOWER(modelo) LIKE LOWER($1) OR LOWER(marca) LIKE LOWER($1)) ${anio ? 'AND anio=$2' : ''}`,
      anio ? [`%${modelo}%`, String(anio)] : [`%${modelo}%`]
    )
    res.json({ ok: true, matches: stockMatch.rows })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── Clientes busqueda: marcar encontrado ─────────────────────
app.patch('/api/clientes/:id', async (req, res) => {
  try {
    await pool.query('UPDATE clientes_busqueda SET estado=$1,updated_at=NOW() WHERE id=$2', [req.body.estado||'Encontrado', req.params.id])
    res.json({ ok: true })
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

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`🚀 Servidor en puerto ${PORT}`))
