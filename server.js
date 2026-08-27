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
  // Agregar columnas nuevas si no existen
  await pool.query(`ALTER TABLE stock ADD COLUMN IF NOT EXISTS telefono TEXT DEFAULT ''`).catch(()=>{})
  await pool.query(`ALTER TABLE clientes_busqueda ADD COLUMN IF NOT EXISTS telefono TEXT DEFAULT ''`).catch(()=>{})
  await pool.query(`ALTER TABLE clientes_busqueda ADD COLUMN IF NOT EXISTS presupuesto TEXT DEFAULT ''`).catch(()=>{})
  await pool.query(`ALTER TABLE clientes_busqueda ADD COLUMN IF NOT EXISTS vendedor TEXT DEFAULT ''`).catch(()=>{})
  await pool.query(`ALTER TABLE clientes_busqueda ADD COLUMN IF NOT EXISTS calificacion TEXT DEFAULT ''`).catch(()=>{})
  await pool.query(`ALTER TABLE clientes_busqueda ADD COLUMN IF NOT EXISTS tiene_permuta TEXT DEFAULT ''`).catch(()=>{})
  await pool.query(`ALTER TABLE clientes_busqueda ADD COLUMN IF NOT EXISTS permuta_marca TEXT DEFAULT ''`).catch(()=>{})
  await pool.query(`ALTER TABLE clientes_busqueda ADD COLUMN IF NOT EXISTS permuta_modelo TEXT DEFAULT ''`).catch(()=>{})
  await pool.query(`ALTER TABLE clientes_busqueda ADD COLUMN IF NOT EXISTS permuta_version TEXT DEFAULT ''`).catch(()=>{})
  await pool.query(`ALTER TABLE clientes_busqueda ADD COLUMN IF NOT EXISTS permuta_anio TEXT DEFAULT ''`).catch(()=>{})
  await pool.query(`ALTER TABLE clientes_busqueda ADD COLUMN IF NOT EXISTS permuta_km TEXT DEFAULT ''`).catch(()=>{})
  await pool.query(`ALTER TABLE clientes_busqueda ADD COLUMN IF NOT EXISTS permuta_color TEXT DEFAULT ''`).catch(()=>{})
  await pool.query(`ALTER TABLE clientes_busqueda ADD COLUMN IF NOT EXISTS permuta_valor TEXT DEFAULT ''`).catch(()=>{})
  await pool.query(`ALTER TABLE clientes_busqueda ADD COLUMN IF NOT EXISTS monto_galicia TEXT DEFAULT ''`).catch(()=>{})
  await pool.query(`ALTER TABLE clientes_busqueda ADD COLUMN IF NOT EXISTS monto_bancor TEXT DEFAULT ''`).catch(()=>{})
  await pool.query(`ALTER TABLE clientes_busqueda ADD COLUMN IF NOT EXISTS monto_nacion TEXT DEFAULT ''`).catch(()=>{})
  await pool.query(`ALTER TABLE clientes_busqueda ADD COLUMN IF NOT EXISTS monto_santander TEXT DEFAULT ''`).catch(()=>{})
  await pool.query(`ALTER TABLE clientes_busqueda ADD COLUMN IF NOT EXISTS monto_mg TEXT DEFAULT ''`).catch(()=>{})
  await pool.query(`ALTER TABLE clientes_busqueda ADD COLUMN IF NOT EXISTS dni TEXT DEFAULT ''`).catch(()=>{})
  await pool.query(`ALTER TABLE clientes_busqueda ADD COLUMN IF NOT EXISTS tiene_garantes TEXT DEFAULT ''`).catch(()=>{})
  await pool.query(`ALTER TABLE clientes_busqueda ADD COLUMN IF NOT EXISTS garante_nombre TEXT DEFAULT ''`).catch(()=>{})
  await pool.query(`ALTER TABLE clientes_busqueda ADD COLUMN IF NOT EXISTS garante_dni TEXT DEFAULT ''`).catch(()=>{})
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
        `Precio: ${a.precio} ${a.moneda} | Ubicación: ${a.ubicacion||'Tutu Automotores'} | Estado: ${a.estado}${a.notas ? ' | '+a.notas : ''}`
      ).join('\n')
      stockExtra = `\n\n== STOCK CARGADO POR EMPLEADOS (${stock.length} vehículos — PRIORIDAD ALTA) ==\n${lineas}\n== FIN STOCK EMPLEADOS ==\n\nIMPORTANTE: Siempre indicá la Ubicación de cada auto. NUNCA uses tablas markdown. Listá cada auto en una línea con formato: Marca Modelo Versión Año — KM: X — Precio: $ X — Ubicación: X`
    }

    const comandos = `

== FORMATO DE RESPUESTAS ==
NUNCA uses tablas markdown (| col | col |). Cuando listes autos usá SIEMPRE este formato numerado:

1. Toyota Etios XLS 1.5 | 2015
- KM: 141.771 | Color: Gris
- Precio: $14.500.000 ARS
- 📍 Ubicación: Mediterráneo

2. Toyota Hilux SRX 4x4 AT 2.8 | 2022
- KM: 76.500 | Color: Blanco
- Precio: $60.000.000 ARS
- 📍 Ubicación: Tutu Automotores

Siempre incluí la Ubicación en cada auto. Si no hay ubicación conocida, poné "Tutu Automotores".

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
• Si el cliente entrega un auto propio como parte de pago (permuta), extraé tiene_permuta:"si" y los datos del auto que entrega (marca, modelo, versión, año, km, color, valor estimado si lo menciona). Si no hay permuta, tiene_permuta:"no"
• Si el cliente menciona garante/s o co-firmante, extraé tiene_garantes:"si" junto con nombre y DNI del garante si los menciona. Si no, tiene_garantes:"no"
• Confirmá con un mensaje
• Al FINAL agregá: [GUARDAR_CLIENTE:{"nombre":"Juan Perez","telefono":"351-1234567","dni":"","modelo":"Gol Trend","anio":"2012","presupuesto":"","notas":"","asesor":"","tiene_permuta":"no","permuta_marca":"","permuta_modelo":"","permuta_version":"","permuta_anio":"","permuta_km":"","permuta_color":"","permuta_valor":"","tiene_garantes":"no","garante_nombre":"","garante_dni":""}]

Cuando el usuario diga "eliminá", "borrá" o "sacá" un auto:
• Confirmá con un mensaje claro
• Al FINAL agregá: [ELIMINAR_STOCK:{"marca":"Ford","modelo":"Ranger","anio":"2022"}]

Cuando diga "mostrá el stock", "qué autos tenemos", "listá vehículos cargados", "mostrame todo", "todos los autos" o similar:
• Mostrá el stock de la sección STOCK CARGADO POR EMPLEADOS de forma ordenada y clara.
• IMPORTANTE: Listá SIEMPRE la totalidad de los autos que haya en esa sección, sin resumir, sin cortar y sin decir "hay más pero no los muestro". Si hay 90 autos, listá los 90. Nunca digas "y otros X vehículos más" en lugar de listarlos.

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

    if (!response.ok) {
      console.error('❌ Error de Anthropic API:', response.status, JSON.stringify(data))
      return res.status(response.status).json({ error: data.error || data })
    }

    // Procesar comandos de stock en la respuesta
    if (data.content?.[0]?.text) {
      let reply = data.content[0].text

      const guardar = reply.match(/\[GUARDAR_STOCK:(\{[^\]]+\})\]/)
      const eliminar = reply.match(/\[ELIMINAR_STOCK:(\{[^\]]+\})\]/)
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
              'INSERT INTO stock (marca,modelo,version,anio,km,color,precio,moneda,estado,notas,ubicacion,telefono) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
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
            tiene_permuta='', permuta_marca='', permuta_modelo='', permuta_version='',
            permuta_anio='', permuta_km='', permuta_color='', permuta_valor='',
            tiene_garantes='', garante_nombre='', garante_dni=''
          } = cli
          if (nombre) {
            await pool.query(
              `INSERT INTO clientes_busqueda
               (nombre,telefono,dni,modelo,anio,presupuesto,notas,asesor,tiene_permuta,permuta_marca,permuta_modelo,permuta_version,permuta_anio,permuta_km,permuta_color,permuta_valor,tiene_garantes,garante_nombre,garante_dni)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
              [nombre, telefono, dni, modelo, String(anio), String(presupuesto), notas, asesor,
               tiene_permuta, permuta_marca, permuta_modelo, permuta_version, String(permuta_anio), String(permuta_km), permuta_color, String(permuta_valor),
               tiene_garantes, garante_nombre, garante_dni]
            )
            console.log('✅ Cliente guardado:', nombre, modelo)
          }
        } catch(e) { console.error('Error guardando cliente:', e.message) }
        data.content[0].text = data.content[0].text.replace(/\[GUARDAR_CLIENTE:[^\]]+\]/g, '').trim()
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
    
    if (modelo) {
      const stockRows = await buscarEnStock(modelo)
      const filtered = anio ? stockRows.filter(r => r.anio === String(anio)) : stockRows
      return res.json(filtered)
    }
    
    // Solo año
    const result = await pool.query('SELECT * FROM stock WHERE anio=$1 ORDER BY marca, modelo', [String(anio)])
    res.json(result.rows)
  } catch(e) { res.status(500).json({ error: e.message }) }
})



// ── Clientes: carga masiva desde texto/lista ────────────────
app.post('/api/clientes/bulk', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return res.status(500).json({ error: 'API key no configurada' })
  
  const { texto } = req.body
  if (!texto) return res.status(400).json({ error: 'Texto requerido' })

  try {
    // Usar Claude para parsear la lista
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        system: 'Sos un parser de datos. Recibís texto con una lista de clientes y sus búsquedas de autos. Devolvés SOLO un JSON array sin texto extra ni markdown. Formato: [{"nombre":"Juan Perez","telefono":"351123","dni":"30123456","modelo":"Gol Trend","anio":"","presupuesto":"15000000","notas":"","tiene_permuta":"si","permuta_marca":"Chevrolet","permuta_modelo":"Corsa","permuta_version":"","permuta_anio":"2015","permuta_km":"120000","permuta_color":"Gris","permuta_valor":"3000000","tiene_garantes":"si","garante_nombre":"Maria Lopez","garante_dni":"28123456"}]. Extraé el presupuesto/dinero disponible si lo hay, y el DNI del cliente si lo menciona. Si el cliente menciona que tiene un auto para entregar, permuta, parte de pago con vehiculo o similar, completá tiene_permuta:"si" junto con los datos del auto que entrega (marca, modelo, version, año, km, color y valor estimado si lo menciona). Si no hay permuta o no se menciona, tiene_permuta:"no" y dejá los demas campos de permuta vacios. Si el cliente menciona que tiene garante/s o co-firmante, completá tiene_garantes:"si" junto con nombre y DNI del garante si los menciona. Si no hay garante o no se menciona, tiene_garantes:"no" y dejá esos campos vacios. Si el vehiculo buscado dice "No especificado", "A definir" o similar, pone modelo vacío. SOLO el array JSON.',
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
          `INSERT INTO clientes_busqueda
           (nombre,telefono,dni,modelo,anio,presupuesto,notas,tiene_permuta,permuta_marca,permuta_modelo,permuta_version,permuta_anio,permuta_km,permuta_color,permuta_valor,tiene_garantes,garante_nombre,garante_dni)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
          [c.nombre, c.telefono||'', c.dni||'', c.modelo||'', c.anio||'', c.presupuesto||'', c.notas||'',
           c.tiene_permuta||'', c.permuta_marca||'', c.permuta_modelo||'', c.permuta_version||'',
           c.permuta_anio||'', c.permuta_km||'', c.permuta_color||'', c.permuta_valor||'',
           c.tiene_garantes||'', c.garante_nombre||'', c.garante_dni||'']
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
        'INSERT INTO stock (marca,modelo,version,anio,km,color,precio,moneda,estado,notas,ubicacion,telefono) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
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
      nombre, telefono='', dni='', marca='', modelo, anio='', presupuesto='', notas='', asesor='',
      tiene_permuta='', permuta_marca='', permuta_modelo='', permuta_version='',
      permuta_anio='', permuta_km='', permuta_color='', permuta_valor='',
      tiene_garantes='', garante_nombre='', garante_dni=''
    } = req.body
    if (!nombre || !modelo) return res.status(400).json({ error: 'Nombre y modelo requeridos' })
    await pool.query(
      `INSERT INTO clientes_busqueda
       (nombre,telefono,dni,marca,modelo,anio,presupuesto,notas,asesor,tiene_permuta,permuta_marca,permuta_modelo,permuta_version,permuta_anio,permuta_km,permuta_color,permuta_valor,tiene_garantes,garante_nombre,garante_dni)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
      [nombre, telefono, dni, marca, modelo, String(anio), String(presupuesto), notas, asesor,
       tiene_permuta, permuta_marca, permuta_modelo, permuta_version, String(permuta_anio), String(permuta_km), permuta_color, String(permuta_valor),
       tiene_garantes, garante_nombre, garante_dni]
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
    const {
      estado, vendedor, calificacion, presupuesto, dni,
      tiene_permuta, permuta_marca, permuta_modelo, permuta_version,
      permuta_anio, permuta_km, permuta_color, permuta_valor,
      monto_galicia, monto_bancor, monto_nacion, monto_santander, monto_mg,
      tiene_garantes, garante_nombre, garante_dni
    } = req.body
    const sets = []
    const params = []
    if (estado !== undefined) { params.push(estado); sets.push('estado=$'+params.length) }
    if (vendedor !== undefined) { params.push(vendedor); sets.push('vendedor=$'+params.length) }
    if (calificacion !== undefined) { params.push(calificacion); sets.push('calificacion=$'+params.length) }
    if (presupuesto !== undefined) { params.push(String(presupuesto)); sets.push('presupuesto=$'+params.length) }
    if (dni !== undefined) { params.push(dni); sets.push('dni=$'+params.length) }
    if (tiene_permuta !== undefined) { params.push(tiene_permuta); sets.push('tiene_permuta=$'+params.length) }
    if (permuta_marca !== undefined) { params.push(permuta_marca); sets.push('permuta_marca=$'+params.length) }
    if (permuta_modelo !== undefined) { params.push(permuta_modelo); sets.push('permuta_modelo=$'+params.length) }
    if (permuta_version !== undefined) { params.push(permuta_version); sets.push('permuta_version=$'+params.length) }
    if (permuta_anio !== undefined) { params.push(String(permuta_anio)); sets.push('permuta_anio=$'+params.length) }
    if (permuta_km !== undefined) { params.push(String(permuta_km)); sets.push('permuta_km=$'+params.length) }
    if (permuta_color !== undefined) { params.push(permuta_color); sets.push('permuta_color=$'+params.length) }
    if (permuta_valor !== undefined) { params.push(String(permuta_valor)); sets.push('permuta_valor=$'+params.length) }
    if (monto_galicia !== undefined) { params.push(String(monto_galicia)); sets.push('monto_galicia=$'+params.length) }
    if (monto_bancor !== undefined) { params.push(String(monto_bancor)); sets.push('monto_bancor=$'+params.length) }
    if (monto_nacion !== undefined) { params.push(String(monto_nacion)); sets.push('monto_nacion=$'+params.length) }
    if (monto_santander !== undefined) { params.push(String(monto_santander)); sets.push('monto_santander=$'+params.length) }
    if (monto_mg !== undefined) { params.push(String(monto_mg)); sets.push('monto_mg=$'+params.length) }
    if (tiene_garantes !== undefined) { params.push(tiene_garantes); sets.push('tiene_garantes=$'+params.length) }
    if (garante_nombre !== undefined) { params.push(garante_nombre); sets.push('garante_nombre=$'+params.length) }
    if (garante_dni !== undefined) { params.push(garante_dni); sets.push('garante_dni=$'+params.length) }
    if (sets.length === 0) return res.status(400).json({ error: 'Nada que actualizar' })
    params.push(req.params.id)
    sets.push('updated_at=NOW()')
    await pool.query('UPDATE clientes_busqueda SET '+sets.join(',')+' WHERE id=$'+params.length, params)
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

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`🚀 Servidor en puerto ${PORT}`))
