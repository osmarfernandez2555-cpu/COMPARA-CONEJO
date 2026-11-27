// ═══════════════════════════════════════════════════════════════════════════
//  TUTU MARKET: web pública con todos los autos del stock de Ruthina
//
//  Lo público NUNCA muestra: precio, teléfono, origen, notas ni ubicación.
//  Solo: marca, modelo, versión, año, km, color y fotos.
//
//  Fotos, en este orden:
//   1. Fotos reales de la unidad (columna stock.fotos, o links .jpg/.png/.webp en las notas).
//   2. Si no tiene: FOTO DE REFERENCIA DEL MODELO, sacada de Wikimedia Commons
//      (fotos reales con licencia libre, que se pueden publicar dando el crédito).
//      La web la marca como "Foto del modelo, no es la unidad" y muestra autor y licencia.
//   3. Si Commons no tiene nada del modelo: dibujo genérico con el aviso.
//
//  Las fotos de referencia se buscan en segundo plano (una por vez, sin trabar la web) y
//  quedan guardadas en la tabla market_ref por marca+modelo: cada modelo se busca una sola vez.
//
//    GET  /market                     -> la web (public/market.html)
//    GET  /api/market/autos           -> lista pública (sin precio)
//    GET  /api/market/autos/:id       -> un auto (sin precio)
//    POST /api/market/fotos/:id       -> cargar fotos reales {fotos:[url,...]}       (header x-market-key)
//    POST /api/market/ref/descartar   -> "esta foto no corresponde" {marca, modelo, url} (header x-market-key)
//    POST /api/market/ref/rebuscar    -> volver a buscar {marca, modelo} o todo {}     (header x-market-key)
//    GET  /api/market/ref/estado      -> cuántos modelos tienen foto de referencia
//
//  Variables opcionales en Railway:
//    MARKET_KEY             clave para cargar fotos (si no está, usa IMPORT_KEY)
//    MARKET_SOLO_TUTU=1     mostrar solo autos propios (ocultar los que vienen de grupos de reventa)
//    MARKET_WHATSAPP        número de contacto que muestra la web (por defecto 5493515171111)
//    MARKET_FOTOS_REF=0     apagar las fotos de referencia de internet
// ═══════════════════════════════════════════════════════════════════════════
const path = require('path')
const fetch = require('node-fetch')

const CAMPOS_PUBLICOS = 'id, marca, modelo, version, anio, km, color, estado, fotos, notas, origen, created_at'
const UA = 'TutuMarket/1.0 (+https://tutuautomotores.com)'

function driveDirecto(url) {
  const m = String(url).match(/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:export=\w+&)?id=)([\w-]{20,})/)
  return m ? `https://drive.google.com/thumbnail?id=${m[1]}&sz=w1200` : url
}

function fotosDe(row) {
  let lista = []
  try {
    const f = JSON.parse(row.fotos || '[]')
    if (Array.isArray(f)) lista = f
  } catch (e) {
    lista = String(row.fotos || '').split(/[\s,]+/)
  }
  const enNotas = String(row.notas || '').match(/https?:\/\/\S+?\.(?:jpe?g|png|webp)(?:\?\S*)?/gi) || []
  return [...new Set([...lista, ...enNotas].map(s => String(s).trim()).filter(s => /^https?:\/\//.test(s)).map(driveDirecto))].slice(0, 12)
}

// ── Fotos de referencia (Wikimedia Commons) ─────────────────────────────────
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
// Modelo "limpio": las dos primeras palabras (en Ruthina a veces viene con la versión pegada)
const modeloBase = m => norm(m).split(' ').filter(w => !/^\d\.\d$/.test(w)).slice(0, 2).join(' ')
const claveRef = (marca, modelo) => norm(marca) + '|' + modeloBase(modelo)

const MALAS = /\b(interior|interieur|innenraum|cockpit|dashboard|tablero|engine|motor|moteur|trunk|baul|boot|kofferraum|door|puerta|seat|asiento|wheel|rueda|llanta|rim|logo|badge|emblem|emblema|insignia|steering|volante|detail|detalle|headlight|faro|taillight|grille|parrilla|tc2000|tc 2000|turismo carretera|rally|rallye|race|racing|carrera|competicion|stock car|wrc|dakar|crash|accidente|choque|wreck|police|policia|patrullero|taxi|remis|ambulance|ambulancia|bomberos|model|maqueta|toy|juguete|matchbox|hot wheels|lego|brochure|folleto|advert|publicidad|poster|drawing|sketch|render|patent|concept|prototype|prototipo|mule|camouflage|camuflado)\b/
const BUENAS = /\b(front|frontal|frente|three quarter|3 4|vista|side|lateral|left|right|izquierda|derecha)\b/

function puntaje(titulo, w, h, marca, modelo, anio) {
  const t = norm(titulo.replace(/^File:/, '').replace(/\.[a-z]+$/i, ''))
  const [m1, m2] = modeloBase(modelo).split(' ')
  if (!m1 || !t.includes(norm(marca).split(' ')[0])) return -1
  if (!new RegExp('\\b' + m1 + '\\b').test(t)) return -1   // el modelo tiene que estar sí o sí
  if (MALAS.test(t)) return -1
  if (!w || !h || w < 640 || w / h < 1.15) return -1 // solo apaisadas: un frente recortado o una vertical no sirve de tapa
  let p = 10
  if (m2 && new RegExp('\\b' + m2 + '\\b').test(t)) p += 5   // "Gol Trend", "Ranger Raptor": mejor si coincide también
  if (BUENAS.test(t)) p += 4
  if (/\brear|trasera|heck|back\b/.test(t)) p -= 3
  if (/cropped|recortad/.test(t)) p += 1
  const y = (t.match(/\b(19[89]\d|20[0-4]\d)\b/) || [])[1]
  const ya = parseInt(anio)
  if (y && ya) p += Math.max(0, 6 - Math.abs(Number(y) - ya)) // la foto más cerca del año del auto
  return p
}

const sinHtml = s => String(s || '').replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)

async function buscarCommons(marca, modelo, anio, descartadas) {
  const q = `${marca} ${modeloBase(modelo).split(' ')[0]} filetype:bitmap`
  const url = 'https://commons.wikimedia.org/w/api.php?' + new URLSearchParams({
    action: 'query', format: 'json', generator: 'search', gsrnamespace: '6', gsrsearch: q, gsrlimit: '40',
    prop: 'imageinfo', iiprop: 'url|size|extmetadata', iiextmetadatafilter: 'LicenseShortName|Artist|UsageTerms', iiurlwidth: '1200'
  })
  const r = await fetch(url, { headers: { 'User-Agent': UA }, timeout: 15000 })
  if (!r.ok) throw new Error('Commons ' + r.status)
  const j = await r.json()
  const pages = Object.values((j.query && j.query.pages) || {})
  const cand = []
  for (const p of pages) {
    const ii = (p.imageinfo || [])[0]; if (!ii) continue
    const lic = sinHtml(ii.extmetadata && ii.extmetadata.LicenseShortName && ii.extmetadata.LicenseShortName.value)
    if (!/^(cc0|public domain|dominio publico|pd|cc[ -]by)/i.test(lic)) continue // solo licencias libres conocidas
    const src = (ii.thumburl || ii.url || '').replace(/[?&]utm_[^&]*/g, '').replace(/\?$/, '')
    if (!src || (descartadas || []).includes(src)) continue
    const s = puntaje(p.title, ii.width, ii.height, marca, modelo, anio)
    if (s < 0) continue
    cand.push({ s, idx: p.index || 99, url: src, autor: sinHtml(ii.extmetadata.Artist && ii.extmetadata.Artist.value) || 'Autor en Wikimedia Commons', licencia: lic, pagina: ii.descriptionurl })
  }
  cand.sort((a, b) => b.s - a.s || a.idx - b.idx)
  return cand.slice(0, 3).map(({ s, idx, ...c }) => c)
}

module.exports = function (app, pool) {
  pool.query(`ALTER TABLE stock ADD COLUMN IF NOT EXISTS fotos TEXT DEFAULT ''`)
    .then(() => console.log('✅ Market: columna fotos lista'))
    .catch(e => console.error('Market fotos:', e.message))
  pool.query(`CREATE TABLE IF NOT EXISTS market_ref (
      clave TEXT PRIMARY KEY, fotos TEXT DEFAULT '[]', descartadas TEXT DEFAULT '[]', buscado_en TIMESTAMP DEFAULT NOW())`)
    .catch(e => console.error('Market ref:', e.message))

  const refActivo = () => process.env.MARKET_FOTOS_REF !== '0'
  const cache = new Map()      // clave -> fotos[] (copia en memoria de market_ref)
  const cola = new Map()       // clave -> {marca, modelo, anio}
  let trabajando = false

  async function cargarCache() {
    try {
      const r = await pool.query(`SELECT clave, fotos, buscado_en FROM market_ref`)
      for (const row of r.rows) {
        const f = JSON.parse(row.fotos || '[]')
        // Las búsquedas que no encontraron nada se reintentan a los 15 días
        if (!f.length && Date.now() - new Date(row.buscado_en).getTime() > 15 * 864e5) continue
        cache.set(row.clave, f)
      }
    } catch (e) { console.error('Market ref cache:', e.message) }
  }
  const listo = cargarCache()

  function encolar(row) {
    if (!refActivo()) return
    const k = claveRef(row.marca, row.modelo)
    if (!modeloBase(row.modelo) || cache.has(k) || cola.has(k)) return
    cola.set(k, { marca: row.marca, modelo: row.modelo, anio: row.anio })
    if (!trabajando) procesar()
  }
  async function procesar() {
    trabajando = true
    while (cola.size) {
      const [k, a] = cola.entries().next().value
      cola.delete(k)
      try {
        const d = await pool.query(`SELECT descartadas FROM market_ref WHERE clave=$1`, [k])
        const desc = d.rows.length ? JSON.parse(d.rows[0].descartadas || '[]') : []
        const fotos = await buscarCommons(a.marca, a.modelo, a.anio, desc)
        cache.set(k, fotos)
        await pool.query(`INSERT INTO market_ref (clave, fotos, buscado_en) VALUES ($1,$2,NOW())
          ON CONFLICT (clave) DO UPDATE SET fotos=EXCLUDED.fotos, buscado_en=NOW()`, [k, JSON.stringify(fotos)])
        console.log(`Market ref: ${k} -> ${fotos.length} foto(s)`)
      } catch (e) {
        console.error('Market ref', k, e.message) // queda sin cache: se vuelve a intentar en la próxima visita
      }
      await new Promise(r => setTimeout(r, 1200)) // de a una, para no abusar de Wikimedia
    }
    trabajando = false
  }

  function publico(row) {
    const fotos = fotosDe(row)
    const ref = !fotos.length && refActivo() ? (cache.get(claveRef(row.marca, row.modelo)) || []) : []
    if (!fotos.length && refActivo() && !cache.has(claveRef(row.marca, row.modelo))) encolar(row)
    return {
      id: row.id,
      marca: row.marca || '',
      modelo: row.modelo || '',
      version: row.version || '',
      anio: row.anio || '',
      km: Number(row.km) || 0,
      color: row.color || '',
      reservado: /reserv/i.test(row.estado || ''),
      fotos,
      fotos_reales: fotos.length > 0,
      ref,                      // fotos del modelo (no de la unidad), con autor y licencia
      nuevo: row.created_at ? (Date.now() - new Date(row.created_at).getTime()) < 7 * 864e5 : false
    }
  }

  const filtro = () => {
    let w = `COALESCE(estado,'') !~* 'vendid|baja'`
    if (process.env.MARKET_SOLO_TUTU === '1') w += ` AND COALESCE(origen,'') <> 'grupo'`
    return w
  }
  const conClave = req => {
    const clave = process.env.MARKET_KEY || process.env.IMPORT_KEY
    return clave && req.headers['x-market-key'] === clave
  }

  app.get('/api/market/autos', async (req, res) => {
    try {
      await listo
      const r = await pool.query(`SELECT ${CAMPOS_PUBLICOS} FROM stock WHERE ${filtro()} ORDER BY created_at DESC NULLS LAST, marca, modelo`)
      res.set('Cache-Control', 'public, max-age=120')
      res.json({ whatsapp: process.env.MARKET_WHATSAPP || '5493515171111', autos: r.rows.map(publico), buscando: cola.size })
    } catch (e) { console.error('Market autos:', e.message); res.status(500).json({ error: 'No se pudo cargar el stock' }) }
  })

  app.get('/api/market/autos/:id', async (req, res) => {
    try {
      await listo
      const r = await pool.query(`SELECT ${CAMPOS_PUBLICOS} FROM stock WHERE id=$1 AND ${filtro()}`, [parseInt(req.params.id) || 0])
      if (!r.rows.length) return res.status(404).json({ error: 'Auto no encontrado' })
      res.json(publico(r.rows[0]))
    } catch (e) { res.status(500).json({ error: 'No se pudo cargar el auto' }) }
  })

  app.post('/api/market/fotos/:id', async (req, res) => {
    try {
      if (!conClave(req)) return res.status(401).json({ error: 'Clave incorrecta' })
      const fotos = (Array.isArray(req.body && req.body.fotos) ? req.body.fotos : [])
        .map(s => String(s).trim()).filter(s => /^https?:\/\//.test(s)).slice(0, 12)
      const r = await pool.query('UPDATE stock SET fotos=$1 WHERE id=$2 RETURNING id', [JSON.stringify(fotos), parseInt(req.params.id) || 0])
      if (!r.rowCount) return res.status(404).json({ error: 'Auto no encontrado' })
      res.json({ ok: true, id: r.rows[0].id, fotos: fotos.map(driveDirecto) })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // Marcar una foto de referencia como incorrecta: se saca y no vuelve a elegirse
  app.post('/api/market/ref/descartar', async (req, res) => {
    try {
      if (!conClave(req)) return res.status(401).json({ error: 'Clave incorrecta' })
      const { marca, modelo, url } = req.body || {}
      const k = claveRef(marca, modelo)
      const d = await pool.query(`SELECT fotos, descartadas FROM market_ref WHERE clave=$1`, [k])
      const fotos = d.rows.length ? JSON.parse(d.rows[0].fotos || '[]').filter(f => f.url !== url) : []
      const desc = [...new Set([...(d.rows.length ? JSON.parse(d.rows[0].descartadas || '[]') : []), url])]
      await pool.query(`INSERT INTO market_ref (clave, fotos, descartadas) VALUES ($1,$2,$3)
        ON CONFLICT (clave) DO UPDATE SET fotos=EXCLUDED.fotos, descartadas=EXCLUDED.descartadas`, [k, JSON.stringify(fotos), JSON.stringify(desc)])
      cache.set(k, fotos)
      if (!fotos.length) { cache.delete(k); encolar({ marca, modelo }) } // busca otra
      res.json({ ok: true, fotos })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // Volver a buscar un modelo (o todos, con {} vacío)
  app.post('/api/market/ref/rebuscar', async (req, res) => {
    try {
      if (!conClave(req)) return res.status(401).json({ error: 'Clave incorrecta' })
      const { marca, modelo } = req.body || {}
      if (marca && modelo) { const k = claveRef(marca, modelo); cache.delete(k); encolar({ marca, modelo }) }
      else { cache.clear(); await pool.query(`UPDATE market_ref SET fotos='[]', buscado_en=NOW() - interval '30 days'`) }
      res.json({ ok: true })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  app.get('/api/market/ref/estado', async (req, res) => {
    await listo
    const con = [...cache.values()].filter(f => f.length).length
    res.json({ activo: refActivo(), modelos_con_foto: con, modelos_sin_foto: cache.size - con, en_cola: cola.size })
  })

  app.get('/market', (req, res) => res.sendFile(path.join(__dirname, 'public', 'market.html')))
}
