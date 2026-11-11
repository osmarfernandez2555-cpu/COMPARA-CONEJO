// server.js — App "Consulta Créditos" de Tutu Automotores (Bancor + Banco Nación + Banco Galicia + decreditos + Santander)
// Railway: las variables vienen de la configuración del servicio.
// PC: se leen del archivo .env y se abre con "Iniciar Bancor.bat".
//
// Bancor: login con captcha que se resuelve desde la app (vista remota).
// Nación y Galicia: login con código/token que se escribe en la app.
// Santander: código de Google Authenticator que se escribe en la app.

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

// ---------- Configuración ----------
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch {}

const CFG = {
  bancor: {
    cuitEmpresa: process.env.BANCOR_CUIT_EMPRESA,
    cuitOperador: process.env.BANCOR_CUIT_OPERADOR,
    clave: process.env.BANCOR_CLAVE,
    rubro: process.env.BANCOR_RUBRO || '1676',
  },
  nacion: {
    cuil: process.env.BNA_CUIL,
    clave: process.env.BNA_CLAVE,
  },
  galicia: {
    usuario: process.env.GALICIA_USUARIO,
    // Valores por defecto para simular (el vendedor puede cambiar ingresos y valor del auto en la app)
    ingresos: process.env.GALICIA_INGRESOS || '6000000',
    valorAuto: process.env.GALICIA_VALOR_AUTO || '45000000',
    marca: process.env.GALICIA_MARCA || 'FIAT',
    modelo: process.env.GALICIA_MODELO || 'PULSE',
  },
  decreditos: {
    usuario: (process.env.DECREDITOS_USUARIO || '').trim(),
    clave: process.env.DECREDITOS_CLAVE || '',
    // Simulación de referencia (se puede cambiar con variables)
    anio: process.env.DECREDITOS_ANIO || '2025',
    modelo: process.env.DECREDITOS_MODELO || 'AMAROK',
    modeloItem: process.env.DECREDITOS_MODELO_EXACTO || '',
    monto: process.env.DECREDITOS_MONTO || '26000000',
    plazo: process.env.DECREDITOS_PLAZO || '36',
    tipo: process.env.DECREDITOS_TIPO || 'Tradicional',
  },
  santander: {
    usuario: (process.env.SANTANDER_USUARIO || '').trim(),
    clave: process.env.SANTANDER_CLAVE || '',
    // Simulación de referencia (el vendedor puede cambiar los ingresos en la app)
    ingresos: process.env.SANTANDER_INGRESOS || '12000000',
    marca: process.env.SANTANDER_MARCA || 'RENAULT',
    modelo: process.env.SANTANDER_MODELO || 'KWID L/25 1.0 ICONIC BITONO',
    anio: process.env.SANTANDER_ANIO || '2026 0Km',
  },
};
const APP_CLAVE = (process.env.APP_CLAVE || '').trim();
// Ayudante de decreditos: en la PC de la oficina corre con MODO=agente-decreditos;
// en Railway, AGENTE_CLAVE hace que decreditos se consulte a través de esa PC.
const MODO_AGENTE = (process.env.MODO || '').trim().toLowerCase() === 'agente-decreditos';
const AGENTE_CLAVE = (process.env.AGENTE_CLAVE || '').trim();
// Extensión de Chrome: DECREDITOS_MODO=extension → decreditos lo consulta la extensión instalada en cada computadora
const DECREDITOS_EXTENSION = (process.env.DECREDITOS_MODO || '').trim().toLowerCase() === 'extension';
const DECREDITOS_REMOTO = !MODO_AGENTE && !DECREDITOS_EXTENSION && AGENTE_CLAVE.length >= 8;
// SANTANDER_MODO=extension → Santander lo consulta la extensión de Chrome (Santander bloquea Railway)
const SANTANDER_EXTENSION = (process.env.SANTANDER_MODO || '').trim().toLowerCase() === 'extension';
// GALICIA_MODO=extension → Galicia lo consulta la extensión de Chrome con el usuario de cada vendedor
const GALICIA_EXTENSION = (process.env.GALICIA_MODO || '').trim().toLowerCase() === 'extension';
const PORT = Number(process.env.PORT || 3000);
// BANCOR_VENTANA=si muestra las ventanas de los bancos (solo en PC); =no las oculta
const VENTANA_VISIBLE = (process.env.BANCOR_VENTANA || 'no').toLowerCase() === 'si';

const URL_BANCOR = 'https://aplicaciones.bancor.com.ar/731_PortalEmpresas';
const URL_NACION = 'https://masautos.bna.com.ar/';
const URL_GALICIA = 'https://financiaciones.bancogalicia.com.ar/login';
const URL_DECREDITOS = 'https://agencias2.decreditos.com';
const URL_SANTANDER_LOGIN = process.env.SANTANDER_URL_LOGIN || 'https://login-prendarios.santanderconsumer.com.ar/ingresar';
const URL_SANTANDER_PORTAL = process.env.SANTANDER_URL_PORTAL || 'https://autoloans.santanderautos.com.ar/portalsanrio/#/pre-proposal/identification';
// Carpeta de datos: en Railway se apunta a un Volume (DATA_DIR=/data) para que no se borre en cada deploy
const DATA_DIR = process.env.DATA_DIR || __dirname;
const CARPETA_RESULTADOS = path.join(DATA_DIR, 'resultados');
const ARCHIVO_HISTORIAL = path.join(DATA_DIR, 'historial.json');
const ESTADO_NACION = path.join(DATA_DIR, 'nacion-sesion.json');
const ESTADO_GALICIA = path.join(DATA_DIR, 'galicia-sesion.json');
const ESTADO_DECREDITOS = path.join(DATA_DIR, 'decreditos-sesion.json');
const ESTADO_SANTANDER = path.join(DATA_DIR, 'santander-sesion.json');
fs.mkdirSync(CARPETA_RESULTADOS, { recursive: true });
const DIAS_CAPTURAS = Number(process.env.DIAS_CAPTURAS || 90);
const MAX_HISTORIAL = 20000;

const VIEWPORT = { width: 1280, height: 900 };

// Selectores de Bancor
const SEL = {
  rubro: '#ctl00_ContenedorPrincipal_drp_Busqueda_Rubro',
  documento: '#ctl00_ContenedorPrincipal_txt_Busqueda_NumeroDocumento',
  sinDemostracion: '#ctl00_ContenedorPrincipal_rbt_SinDemostracion',
  cancelarTitular: '#ctl00_ContenedorPrincipal_btnCancelarTitular',
  usoVehiculo: '#ctl00_ContenedorPrincipal_drpTipoUsoVehiculo',
};

// Palabras para interpretar las respuestas
const BANCOR_DENEGADO = ['no calificad', 'no califica', 'rechaz', 'deneg', 'no cumple', 'no posee oferta', 'sin oferta', 'no registra oferta'];
const NACION_DENEGADO = ['propuesta rechazada', 'ninguna oferta', 'no se encontr', 'sin ofertas', 'no califica', 'no calificad', 'rechaz', 'deneg', 'no cumple', 'no es posible', 'no posee', 'no tiene oferta', 'sin oferta', 'no apto', 'no aprobad', 'no puede acceder', 'no corresponde'];
const NACION_APROBADO = ['aprobad', 'preaprobad', 'pre-aprobad', 'califica', 'monto máximo', 'monto maximo', 'monto disponible', 'oferta'];
const GALICIA_DENEGADO = ['no tenemos una oferta', 'no tenemos oferta', 'rechaz', 'no califica', 'no calificad', 'no aprobad', 'no es posible', 'no cumple', 'no tiene oferta', 'sin oferta', 'ninguna oferta', 'no se encontr', 'deneg', 'no apto'];
// Aprobado: aparece "Simular" o un monto después de evaluar (palabras sueltas como "oferta" no alcanzan)
const GALICIA_APROBADO = ['aprobad', 'preaprobad', 'pre-aprobad', 'simular', 'disponible'];
const NACION_ESPERA = /evaluando|cargando|procesando|aguarde|espere/i;
const RE_MONTO = /\$\s?\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?|\b\d{1,3}(?:[.,]\d{3}){2,}(?:[.,]\d{2})?\b/;

// ---------- Estado de cada banco ----------
function nuevoBanco(id, nombre) {
  return {
    id, nombre,
    context: null, page: null, app: null, urlBusqueda: null,
    sesion: { estado: 'desconectado', mensaje: 'Sin sesión iniciada', por: '' },
    cola: Promise.resolve(), ocupado: false, ultimaActividad: Date.now(), intento: 0,
  };
}
const B = {
  bancor: nuevoBanco('bancor', 'Bancor'),
  nacion: nuevoBanco('nacion', 'Banco Nación'),
  galicia: nuevoBanco('galicia', 'Banco Galicia'),
  decreditos: nuevoBanco('decreditos', 'decreditos'),
  santander: nuevoBanco('santander', 'Santander'),
};

if (!CFG.bancor.cuitEmpresa || !CFG.bancor.cuitOperador || !CFG.bancor.clave) {
  B.bancor.sesion = { estado: 'no_configurado', mensaje: 'Faltan las variables BANCOR_CUIT_EMPRESA, BANCOR_CUIT_OPERADOR y BANCOR_CLAVE', por: '' };
}
if (!CFG.nacion.cuil || !CFG.nacion.clave) {
  B.nacion.sesion = { estado: 'no_configurado', mensaje: 'Faltan las variables BNA_CUIL y BNA_CLAVE', por: '' };
}
if (GALICIA_EXTENSION) {
  B.galicia.sesion = { estado: 'extension', mensaje: 'Se consulta con la extensión de Chrome de cada computadora', por: '' };
} else if (!CFG.galicia.usuario) {
  B.galicia.sesion = { estado: 'no_configurado', mensaje: 'Falta la variable GALICIA_USUARIO', por: '' };
}
if (DECREDITOS_EXTENSION) {
  B.decreditos.sesion = { estado: 'extension', mensaje: 'Se consulta con la extensión de Chrome de cada computadora', por: '' };
} else if (!DECREDITOS_REMOTO && (!CFG.decreditos.usuario || !CFG.decreditos.clave)) {
  B.decreditos.sesion = { estado: 'no_configurado', mensaje: 'Faltan las variables DECREDITOS_USUARIO y DECREDITOS_CLAVE', por: '' };
}

if (SANTANDER_EXTENSION) {
  B.santander.sesion = { estado: 'extension', mensaje: 'Se consulta con la extensión de Chrome de cada computadora', por: '' };
} else if (!CFG.santander.usuario || !CFG.santander.clave) {
  B.santander.sesion = { estado: 'no_configurado', mensaje: 'Faltan las variables SANTANDER_USUARIO y SANTANDER_CLAVE', por: '' };
}

// Historial de consultas (se guarda en disco y se recupera al arrancar)
const historial = (() => {
  try {
    const datos = JSON.parse(fs.readFileSync(ARCHIVO_HISTORIAL, 'utf8'));
    return Array.isArray(datos) ? datos : [];
  } catch { return []; }
})();
let guardadoPendiente = null;
function guardarHistorial() {
  if (guardadoPendiente) return;
  guardadoPendiente = setTimeout(() => {
    guardadoPendiente = null;
    const tmp = ARCHIVO_HISTORIAL + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(historial));
      fs.renameSync(tmp, ARCHIVO_HISTORIAL);
    } catch (err) { console.log('[Historial] no se pudo guardar:', err.message); }
  }, 1000);
}

// Borra capturas viejas para no llenar el disco (el historial de resultados se conserva)
function limpiarCapturas() {
  const limite = Date.now() - DIAS_CAPTURAS * 24 * 3600 * 1000;
  let borradas = 0;
  for (const f of fs.readdirSync(CARPETA_RESULTADOS)) {
    const ruta = path.join(CARPETA_RESULTADOS, f);
    try { if (fs.statSync(ruta).mtimeMs < limite) { fs.unlinkSync(ruta); borradas++; } } catch {}
  }
  if (borradas) console.log(`[Capturas] borradas ${borradas} de más de ${DIAS_CAPTURAS} días`);
}
limpiarCapturas();
setInterval(limpiarCapturas, 24 * 3600 * 1000);

// Búsqueda por CUIT (parcial), nombre del cliente o vendedor
function buscarEnHistorial(q) {
  const texto = String(q || '').trim().toLowerCase();
  const digitos = texto.replace(/\D/g, '');
  if (!texto) return [];
  const coincide = r => {
    if (digitos.length >= 3 && String(r.cuit).includes(digitos)) return true;
    if (/[a-zñáéíóú]/i.test(texto)) {
      const nombre = `${r.cliente || ''} ${r.vendedor || ''}`.toLowerCase();
      return texto.split(/\s+/).every(p => nombre.includes(p));
    }
    return false;
  };
  return agruparPorCuit(historial.filter(coincide));
}

// Agrupa por CUIT: el último resultado de cada banco y la cantidad de consultas (lista del más nuevo al más viejo)
function agruparPorCuit(lista) {
  const grupos = new Map();
  for (const r of lista) {
    let g = grupos.get(r.cuit);
    if (!g) { g = { cuit: r.cuit, cliente: '', ultima: r.fecha, consultas: 0, bancos: {} }; grupos.set(r.cuit, g); }
    g.consultas++;
    if (!g.cliente && r.cliente) g.cliente = r.cliente;
    if (!g.bancos[r.banco]) g.bancos[r.banco] = r; // el historial va del más nuevo al más viejo
  }
  return [...grupos.values()].slice(0, 50);
}

// ---------- Base de datos (PostgreSQL de Railway) ----------
// Si existe DATABASE_URL, el historial y las capturas se guardan en Postgres (no se borran con los deploys).
// Si no, se usa el archivo historial.json en DATA_DIR como antes.
const DATABASE_URL = process.env.DATABASE_URL || '';
let db = null;
if (DATABASE_URL) {
  try {
    const { Pool } = require('pg');
    const conSSL = /sslmode=require/i.test(DATABASE_URL) || /proxy\.rlwy\.net/i.test(DATABASE_URL);
    db = new Pool({ connectionString: DATABASE_URL, ssl: conSSL ? { rejectUnauthorized: false } : false, max: 4 });
    db.on('error', err => console.log('[DB]', err.message));
  } catch (err) {
    db = null;
    console.log('[DB] Falta la librería pg (subí el package.json nuevo): se usa el archivo local.');
  }
}
let dbLista = false;

async function iniciarDB() {
  if (!db) return;
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS cc_consultas (
        id SERIAL PRIMARY KEY,
        fecha TIMESTAMPTZ NOT NULL DEFAULT now(),
        banco TEXT NOT NULL,
        cuit TEXT NOT NULL,
        estado TEXT,
        monto TEXT,
        cliente TEXT,
        vendedor TEXT,
        datos JSONB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS cc_consultas_cuit ON cc_consultas (cuit);
      CREATE INDEX IF NOT EXISTS cc_consultas_fecha ON cc_consultas (fecha DESC);
      CREATE TABLE IF NOT EXISTS cc_capturas (
        nombre TEXT PRIMARY KEY,
        fecha TIMESTAMPTZ NOT NULL DEFAULT now(),
        png BYTEA NOT NULL
      );
    `);
    dbLista = true;
    // Traer las últimas consultas para "Últimas consultas"
    const { rows } = await db.query('SELECT datos FROM cc_consultas ORDER BY fecha DESC LIMIT 300');
    historial.length = 0;
    for (const r of rows) historial.push(r.datos);
    const { rows: [c] } = await db.query('SELECT count(*)::int AS n FROM cc_consultas');
    console.log(`[DB] Conectado a PostgreSQL: ${c.n} consultas guardadas`);
  } catch (err) {
    console.log('[DB] No se pudo conectar a PostgreSQL, se usa el archivo local:', err.message);
  }
}

// Guarda una consulta (y su captura) en la base
async function guardarEnDB(r) {
  if (!dbLista) return;
  try {
    await db.query(
      'INSERT INTO cc_consultas (fecha, banco, cuit, estado, monto, cliente, vendedor, datos) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [r.fecha, r.banco, r.cuit, r.estado, r.monto || '', r.cliente || '', r.vendedor || '', r]
    );
    if (r.captura) {
      const nombre = path.basename(r.captura);
      const archivo = path.join(CARPETA_RESULTADOS, nombre);
      if (fs.existsSync(archivo)) {
        await db.query(
          'INSERT INTO cc_capturas (nombre, png) VALUES ($1, $2) ON CONFLICT (nombre) DO NOTHING',
          [nombre, fs.readFileSync(archivo)]
        );
      }
    }
  } catch (err) {
    console.log('[DB] No se pudo guardar la consulta:', err.message);
  }
}

// Guarda una captura suelta (por ejemplo, la de un error)
async function guardarCapturaDB(nombre) {
  if (!dbLista) return;
  const archivo = path.join(CARPETA_RESULTADOS, nombre);
  if (!fs.existsSync(archivo)) return;
  await db.query('INSERT INTO cc_capturas (nombre, png) VALUES ($1, $2) ON CONFLICT (nombre) DO NOTHING',
    [nombre, fs.readFileSync(archivo)]).catch(() => {});
}

async function leerCapturaDB(nombre) {
  if (!dbLista) return null;
  const { rows } = await db.query('SELECT png FROM cc_capturas WHERE nombre = $1', [nombre]).catch(() => ({ rows: [] }));
  return rows[0]?.png || null;
}

async function limpiarCapturasDB() {
  if (!dbLista) return;
  const r = await db.query(`DELETE FROM cc_capturas WHERE fecha < now() - ($1 || ' days')::interval`, [String(DIAS_CAPTURAS)]).catch(() => null);
  if (r?.rowCount) console.log(`[DB] Capturas borradas: ${r.rowCount} de más de ${DIAS_CAPTURAS} días`);
}
setInterval(limpiarCapturasDB, 24 * 3600 * 1000);

// Búsqueda: en la base si está conectada; si no, en el historial en memoria
async function buscarConsultas(q) {
  const texto = String(q || '').trim().toLowerCase();
  if (!texto) return [];
  if (!dbLista) return buscarEnHistorial(q);

  const digitos = texto.replace(/\D/g, '');
  const palabras = /[a-zñáéíóú]/i.test(texto) ? texto.split(/\s+/).filter(Boolean) : [];
  const condiciones = [], params = [];
  if (digitos.length >= 3) { params.push(`%${digitos}%`); condiciones.push(`cuit LIKE $${params.length}`); }
  if (palabras.length) {
    const ys = palabras.map(p => { params.push(`%${p}%`); return `lower(coalesce(cliente,'') || ' ' || coalesce(vendedor,'')) LIKE $${params.length}`; });
    condiciones.push(`(${ys.join(' AND ')})`);
  }
  if (!condiciones.length) return [];
  const { rows } = await db.query(
    `SELECT datos FROM cc_consultas WHERE ${condiciones.join(' OR ')} ORDER BY fecha DESC LIMIT 2000`, params
  ).catch(() => ({ rows: [] }));
  return agruparPorCuit(rows.map(r => r.datos));
}

let ultimaCaptura = { t: 0, buf: null, clip: null };

// Paso en curso de una consulta (para decir dónde falló)
function paso(b, texto) { b.paso = texto; }

function setSesion(b, estado, mensaje, por) {
  if (estado === 'iniciando') b.codigoMail = null;
  if (MODO_AGENTE && b.id === 'decreditos') setTimeout(() => avisarEstadoAgente(), 0);
  b.sesion = { estado, mensaje, por: por ?? b.sesion.por };
  console.log(`[${new Date().toLocaleTimeString('es-AR')}] ${b.nombre}: ${estado} — ${mensaje}`);
}

// ---------- Utilidades ----------
const limpiarCuit = t => (t || '').replace(/\D/g, '');
const fechaArchivo = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const limpiarNombre = t => (t || '').toString().replace(/[<>]/g, '').trim().slice(0, 40) || 'Sin nombre';
const lineasDe = texto => texto.split('\n').map(l => l.trim()).filter(Boolean);

async function visible(page, selector, ms = 1500) {
  return esperar(page.locator(selector), ms);
}

async function esperar(locator, ms = 1500) {
  try {
    await locator.first().waitFor({ state: 'visible', timeout: ms });
    return true;
  } catch {
    return false;
  }
}

function encolar(b, fn) {
  const tarea = b.cola.then(fn, fn);
  b.cola = tarea.catch(() => {});
  return tarea;
}

function ipsLocales() {
  const ips = [];
  for (const lista of Object.values(os.networkInterfaces())) {
    for (const n of lista || []) if (n.family === 'IPv4' && !n.internal) ips.push(n.address);
  }
  return ips;
}

// Un solo navegador para todos los bancos (cada banco tiene su propia sesión aislada).
// --disable-dev-shm-usage evita que las páginas se cuelguen ("Page crashed") en servidores como Railway.
let navegador = null;
let abriendoNavegador = null;

function limpiarBanco(b, mensaje) {
  b.context = null; b.page = null; b.app = null;
  if (b.sesion.estado !== 'no_configurado') setSesion(b, 'desconectado', mensaje, '');
}

async function obtenerNavegador() {
  if (navegador && navegador.isConnected()) return navegador;
  if (abriendoNavegador) return abriendoNavegador;
  abriendoNavegador = (async () => {
    const br = await chromium.launch({
      headless: !VENTANA_VISIBLE,
      args: ['--disable-dev-shm-usage', '--disable-gpu', '--disable-extensions', '--mute-audio'],
    });
    br.on('disconnected', () => {
      if (navegador !== br) return;
      navegador = null;
      for (const b of Object.values(B)) if (b.context) limpiarBanco(b, 'Se reinició el navegador. Hay que iniciar la sesión de nuevo.');
    });
    navegador = br;
    return br;
  })();
  try { return await abriendoNavegador; } finally { abriendoNavegador = null; }
}

async function abrirNavegador(b, opcionesContexto = {}) {
  const viejo = b.context;
  b.context = null; b.page = null; b.app = null;
  if (viejo) await viejo.close().catch(() => {});

  const br = await obtenerNavegador();
  const ctx = await br.newContext({ viewport: VIEWPORT, locale: 'es-AR', ...opcionesContexto });
  b.context = ctx;

  ctx.on('close', () => {
    if (b.context !== ctx) return; // sesión vieja que ya se reemplazó
    limpiarBanco(b, 'Se cerró la sesión del banco');
  });
  // Si una pestaña del banco se cuelga, avisar para iniciar de nuevo
  const vigilar = p => p.on('crash', () => {
    if (b.context !== ctx) return;
    ctx.close().catch(() => {});
    limpiarBanco(b, `La página de ${b.nombre} se colgó. Tocá "Iniciar sesión" de nuevo.`);
  });
  ctx.on('page', vigilar);
  return ctx;
}

function guardarConsulta(b, datos) {
  const r = { banco: b.id, bancoNombre: b.nombre, fecha: new Date().toISOString(), ...datos };
  historial.unshift(r);
  if (historial.length > MAX_HISTORIAL) historial.length = MAX_HISTORIAL;
  if (dbLista) guardarEnDB(r); else guardarHistorial();
  console.log(`[${new Date().toLocaleTimeString('es-AR')}] ${b.nombre} · ${r.vendedor} consultó ${r.cuit}: ${r.estado}${r.monto ? ' $' + r.monto : ''}`);
  return r;
}

function escribirTxt(nombre, contenido) {
  try { fs.writeFileSync(path.join(CARPETA_RESULTADOS, `${nombre}.txt`), contenido, 'utf8'); } catch {}
}

// =====================================================================
//  BANCOR
// =====================================================================
async function loginBancor(quien) {
  const b = B.bancor;
  const mio = ++b.intento;
  try {
    setSesion(b, 'iniciando', 'Abriendo el portal de Bancor...', quien);
    const ctx = await abrirNavegador(b);
    const page = await ctx.newPage();
    b.page = page;
    await page.goto(URL_BANCOR);

    await page.getByRole('textbox', { name: 'CUIT de la empresa' }).fill(CFG.bancor.cuitEmpresa);
    await page.getByRole('textbox', { name: 'CUIT/CUIL del operador' }).fill(CFG.bancor.cuitOperador);
    await page.getByRole('textbox', { name: 'Contraseña' }).fill(CFG.bancor.clave);

    setSesion(b, 'esperando_captcha', 'Falta resolver el captcha de Bancor', quien);

    const linkIngresar = page.getByRole('link', { name: 'Ingresar' });
    await linkIngresar.waitFor({ state: 'visible', timeout: 10 * 60 * 1000 });

    setSesion(b, 'iniciando', 'Entrando a Préstamos Web Express...', quien);
    const popupPromise = page.waitForEvent('popup');
    await linkIngresar.click();
    b.app = await popupPromise;
    await b.app.setViewportSize(VIEWPORT).catch(() => {});
    await b.app.waitForLoadState('domcontentloaded');
    await b.app.locator(SEL.rubro).waitFor({ timeout: 60000 });
    b.urlBusqueda = b.app.url();
    b.ultimaActividad = Date.now();

    if (mio === b.intento) setSesion(b, 'conectado', 'Sesión activa en Bancor', quien);
  } catch (err) {
    if (mio === b.intento) setSesion(b, 'error', `No se pudo iniciar sesión: ${err.message.split('\n')[0]}`, '');
  }
}

// Vista remota del captcha
async function zonaCaptcha(page) {
  const [sx, sy] = await page.evaluate(() => [window.scrollX, window.scrollY]).catch(() => [0, 0]);
  const cajas = [];
  const iframes = page.locator('iframe[src*="recaptcha"]');
  const n = await iframes.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const c = await iframes.nth(i).boundingBox().catch(() => null);
    if (c && c.width > 20 && c.height > 20 && c.y + c.height > 0 && c.y < VIEWPORT.height && c.x < VIEWPORT.width) cajas.push(c);
  }
  const boton = await page.getByRole('button', { name: 'Ingresar' }).boundingBox().catch(() => null);
  if (boton) cajas.push(boton);

  if (!cajas.length) return { x: sx, y: sy, width: VIEWPORT.width, height: VIEWPORT.height, sx, sy };

  const pad = 24;
  const x1 = Math.max(0, Math.min(...cajas.map(c => c.x)) - pad);
  const y1 = Math.max(0, Math.min(...cajas.map(c => c.y)) - pad);
  const x2 = Math.min(VIEWPORT.width, Math.max(...cajas.map(c => c.x + c.width)) + pad);
  const y2 = Math.min(VIEWPORT.height, Math.max(...cajas.map(c => c.y + c.height)) + pad);
  return { x: x1 + sx, y: y1 + sy, width: x2 - x1, height: y2 - y1, sx, sy };
}

async function capturaCaptcha() {
  const page = B.bancor.page;
  if (Date.now() - ultimaCaptura.t < 400 && ultimaCaptura.buf) return ultimaCaptura;
  const zona = await zonaCaptcha(page);
  const clip = { x: zona.x, y: zona.y, width: zona.width, height: zona.height };
  const buf = await page.screenshot({ clip, timeout: 8000 });
  ultimaCaptura = { t: Date.now(), buf, clip: { ...clip, sx: zona.sx, sy: zona.sy } };
  return ultimaCaptura;
}

async function irABusquedaBancor(b) {
  const app = b.app;
  if (await visible(app, SEL.rubro, 2000)) return;
  if (await visible(app, SEL.cancelarTitular, 1000)) {
    await app.locator(SEL.cancelarTitular).click().catch(() => {});
    if (await visible(app, SEL.rubro, 5000)) return;
  }
  await app.goto(b.urlBusqueda);
  if (!(await visible(app, SEL.rubro, 20000))) {
    setSesion(b, 'desconectado', 'La sesión de Bancor venció. Hay que iniciarla de nuevo.', '');
    throw new Error('SESION_VENCIDA');
  }
}

async function leerOfertasBancor(page) {
  return page.evaluate(() => {
    const limpiar = t => (t || '').replace(/\s+/g, ' ').trim();
    const esMonto = t => /\d{1,3}(\.\d{3})*,\d{2}/.test(t);
    const tabla = [...document.querySelectorAll('table')]
      .filter(t => /monto\s+disponible/i.test(t.innerText))
      .sort((a, b) => a.innerText.length - b.innerText.length)[0];
    if (tabla) {
      const filas = [...tabla.querySelectorAll('tr')]
        .map(tr => [...tr.querySelectorAll('td')].map(td => limpiar(td.innerText)).filter(Boolean))
        .filter(c => c.length >= 2 && c.some(esMonto));
      if (filas.length) {
        return filas.map(c => {
          const monto = c.find(esMonto) || '';
          const resto = c.filter(x => x !== monto);
          return { producto: resto[0] || '', tipo: resto[1] || '', monto };
        });
      }
    }
    const texto = document.body.innerText;
    const i = texto.search(/ofertas disponibles/i);
    if (i < 0) return [];
    return texto.slice(i).split('\n').map(limpiar).filter(Boolean).slice(0, 30).filter(esMonto).map(l => {
      const monto = (l.match(/\d{1,3}(\.\d{3})*,\d{2}/) || [''])[0];
      return { producto: limpiar(l.replace(monto, '')), tipo: '', monto };
    });
  }).catch(() => []);
}

function nombreClienteBancor(texto) {
  const lineas = lineasDe(texto);
  const i = lineas.findIndex(l => /^apellido y nombre/i.test(l));
  if (i >= 0 && lineas[i + 1] && !/:$/.test(lineas[i + 1])) return lineas[i + 1].slice(0, 80);
  return '';
}

async function consultarBancor(cuit, vendedor) {
  const b = B.bancor;
  if (!b.app || b.app.isClosed() || b.sesion.estado !== 'conectado') throw new Error('SIN_SESION');
  const app = b.app;
  b.ocupado = true;
  try {
    await irABusquedaBancor(b);
    await app.locator(SEL.rubro).selectOption(CFG.bancor.rubro);
    await app.locator(SEL.documento).fill(cuit);
    await app.getByRole('button', { name: 'Continuar' }).click();
    await app.waitForLoadState('networkidle').catch(() => {});

    // Bancor puede pedir uno o más "Confirmar" antes de mostrar la oferta:
    //  - "Datos del Cliente" → Confirmar (en algunos DNI aparece)
    //  - "CON / SIN demostración de ingresos" → SIN → Confirmar
    // Se repite hasta ver la oferta o el rechazo (máximo 4 pasos).
    const rechazo = app.getByText(/no calificad|error\(es\)/i).first();
    const ofertasVisibles = app.getByText(/ofertas disponibles/i).first();
    const confirmar = app.getByRole('button', { name: /^confirmar$/i }).filter({ visible: true }).first();
    const sinDemo = app.locator(SEL.sinDemostracion);

    for (let k = 0; k < 4; k++) {
      await sinDemo.or(rechazo).or(ofertasVisibles).or(confirmar).first()
        .waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
      await app.waitForTimeout(400);
      if (await esperar(rechazo, 200) || await esperar(ofertasVisibles, 200)) break;

      if (await esperar(sinDemo, 300)) {
        if (!(await sinDemo.isChecked().catch(() => false))) await sinDemo.check().catch(() => {});
      } else if (!(await esperar(confirmar, 300))) {
        break; // ni Confirmar ni oferta: se interpreta lo que haya en pantalla
      }
      const antes = await app.locator('body').innerText().catch(() => '');
      await confirmar.click({ timeout: 8000 }).catch(() => {});
      await app.waitForLoadState('networkidle').catch(() => {});
      // Esperar a que la pantalla cambie antes de mirar de nuevo
      for (let t = 0; t < 30; t++) {
        const ahora = await app.locator('body').innerText().catch(() => '');
        if (ahora !== antes) break;
        await app.waitForTimeout(300);
      }
    }
    await app.waitForTimeout(800);

    const texto = await app.locator('body').innerText().catch(() => '');
    const ofertas = await leerOfertasBancor(app);
    const errorBancor = lineasDe(texto).find(l => BANCOR_DENEGADO.some(p => l.toLowerCase().includes(p))) || '';

    let estado;
    if (errorBancor) estado = 'DENEGADO';
    else if (ofertas.length) estado = 'APROBADO';
    else if (await visible(app, SEL.usoVehiculo, 500)) estado = 'APROBADO';
    else estado = 'REVISAR';

    const cliente = nombreClienteBancor(texto);
    const nombre = `bancor_${cuit}_${fechaArchivo()}`;
    try {
      if (estado === 'APROBADO') {
        await app.getByText(/datos complementarios|ofertas disponibles/i).first().scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
        await app.waitForTimeout(300);
      } else {
        await app.evaluate(() => { window.scrollTo(0, 0); document.querySelectorAll('*').forEach(el => { if (el.scrollTop) el.scrollTop = 0; }); }).catch(() => {});
      }
      await app.screenshot({ path: path.join(CARPETA_RESULTADOS, `${nombre}.png`) });
    } catch {}
    escribirTxt(nombre, `Banco: Bancor\nCUIT: ${cuit}\nCliente: ${cliente}\nVendedor: ${vendedor}\nEstado: ${estado}\n` +
      `Ofertas: ${ofertas.map(o => `${o.producto} | ${o.tipo} | ${o.monto}`).join(' / ') || '-'}\nMensaje: ${errorBancor || '-'}\n\n${texto}`);

    if (await visible(app, SEL.cancelarTitular, 2000)) await app.locator(SEL.cancelarTitular).click().catch(() => {});

    return guardarConsulta(b, {
      cuit, estado, vendedor, cliente,
      monto: ofertas[0]?.monto || '',
      ofertas,
      resumen: errorBancor || (estado === 'REVISAR' ? lineasDe(texto).slice(0, 3).join(' · ').slice(0, 300) : ''),
      captura: `/resultados/${nombre}.png`,
    });
  } finally {
    b.ocupado = false;
    b.ultimaActividad = Date.now();
  }
}

async function mantenerBancor() {
  const b = B.bancor;
  await b.app.goto(b.urlBusqueda);
  if (!(await visible(b.app, SEL.rubro, 20000))) {
    setSesion(b, 'desconectado', 'La sesión de Bancor venció. Hay que iniciarla de nuevo.', '');
  }
}

// =====================================================================
//  BANCO NACIÓN
// =====================================================================
const nacion = {
  nuevo: p => p.getByRole('link', { name: 'Nuevo préstamo' }),
  inicio: p => p.getByRole('link', { name: 'Inicio' }),
  cuil: p => p.getByRole('textbox', { name: 'CUIL' }),
  password: p => p.getByRole('textbox', { name: 'Password' }),
  codigo: p => p.getByRole('textbox', { name: 'Código de verificación' }),
};

async function loginNacion(quien) {
  const b = B.nacion;
  const mio = ++b.intento;
  try {
    setSesion(b, 'iniciando', 'Abriendo Banco Nación...', quien);
    const opciones = fs.existsSync(ESTADO_NACION) ? { storageState: ESTADO_NACION } : {};
    const ctx = await abrirNavegador(b, opciones);
    const page = await ctx.newPage();
    b.page = page;
    await page.goto(URL_NACION, { waitUntil: 'domcontentloaded' });

    // ¿Quedó la sesión guardada de la vez anterior?
    if (!(await esperar(nacion.nuevo(page), 5000))) {
      await nacion.cuil(page).fill(CFG.nacion.cuil);
      await nacion.password(page).fill(CFG.nacion.clave);
      b.pedidoToken = Date.now();
      await page.getByRole('button', { name: 'Ingresar' }).click();

      await nacion.codigo(page).or(nacion.nuevo(page)).first().waitFor({ state: 'visible', timeout: 25000 }).catch(() => {});

      if (await esperar(nacion.codigo(page), 500)) {
        if (mio !== b.intento) return;
        setSesion(b, 'esperando_token', 'Nación mandó un código por mail. Escribilo abajo.', quien);
        autoTokenDesdeMail(b, b.pedidoToken || Date.now());
        await nacion.nuevo(page).first().waitFor({ state: 'visible', timeout: 15 * 60 * 1000 });
      } else if (!(await esperar(nacion.nuevo(page), 500))) {
        const texto = await page.locator('body').innerText().catch(() => '');
        const linea = lineasDe(texto).find(l => /incorrect|inválid|invalid|bloquead|error|no coincid/i.test(l));
        throw new Error(linea || 'Nación no aceptó el usuario o la clave');
      }
    }

    if (mio !== b.intento) return;
    await ctx.storageState({ path: ESTADO_NACION }).catch(() => {});
    b.app = page;
    b.ultimaActividad = Date.now();
    setSesion(b, 'conectado', 'Sesión activa en Banco Nación', quien);
  } catch (err) {
    if (mio === b.intento) setSesion(b, 'error', `No se pudo iniciar sesión: ${err.message.split('\n')[0]}`, '');
  }
}

async function enviarTokenNacion(codigo) {
  const b = B.nacion;
  if (b.sesion.estado !== 'esperando_token' || !b.page || b.page.isClosed()) {
    return { ok: false, error: 'No hay un código pendiente' };
  }
  const page = b.page;
  await nacion.codigo(page).fill(codigo);
  await page.getByRole('button', { name: 'Validar código' }).click();

  if (await esperar(nacion.nuevo(page), 15000)) return { ok: true };

  const texto = await page.locator('body').innerText().catch(() => '');
  const linea = lineasDe(texto).find(l => /incorrect|inválid|invalid|vencid|expir|error|no coincid/i.test(l));
  return { ok: false, error: linea || 'El código no fue aceptado. Revisalo o pedí uno nuevo.' };
}

async function reenviarTokenNacion() {
  const b = B.nacion;
  b.pedidoToken = Date.now();
  if (b.sesion.estado !== 'esperando_token' || !b.page) return { ok: false, error: 'No hay un código pendiente' };
  const p = b.page;
  try {
    await p.getByRole('button', { name: /reenviar|volver a enviar|nuevo código/i })
      .or(p.getByRole('link', { name: /reenviar|volver a enviar|nuevo código/i }))
      .first().click({ timeout: 4000 });
    return { ok: true };
  } catch {
    return { ok: false, error: 'No encontré el botón para reenviar. Tocá "Empezar de nuevo" para que mande otro código.' };
  }
}

async function irANuevoPrestamo(b) {
  const page = b.app;
  if (!(await esperar(nacion.nuevo(page), 1500))) {
    if (await esperar(nacion.inicio(page), 1500)) await nacion.inicio(page).first().click().catch(() => {});
    else await page.goto(URL_NACION, { waitUntil: 'domcontentloaded' }).catch(() => {});
  }
  if (!(await esperar(nacion.nuevo(page), 15000))) {
    if (await esperar(nacion.password(page), 1000)) {
      setSesion(b, 'desconectado', 'La sesión de Nación venció. Hay que iniciarla de nuevo.', '');
      throw new Error('SESION_VENCIDA');
    }
    throw new Error('No se encontró "Nuevo préstamo" en Nación');
  }
  await nacion.nuevo(page).first().click();
  await nacion.cuil(page).first().waitFor({ state: 'visible', timeout: 15000 });
}

// Espera el resultado de "Evaluar":
// - Aprobado: aparece "Seleccionar oferta" con las tarjetas "Financiá hasta".
// - Rechazado: aparece "Propuesta rechazada" en la misma pantalla (puede ser un aviso que desaparece),
//   por eso se saca la captura en el mismo momento en que se detecta.
async function esperarResultadoNacion(page, antes, rutaPng, maxMs = 30000) {
  const t0 = Date.now();
  let ultimo = '', quietoDesde = 0;
  while (Date.now() - t0 < maxMs) {
    const txt = await page.locator('body').innerText().catch(() => '');
    const bajo = txt.toLowerCase();

    const antesBajo = antes.toLowerCase();
    if (NACION_DENEGADO.some(p => bajo.includes(p) && !antesBajo.includes(p))) {
      await page.screenshot({ path: rutaPng }).catch(() => {});
      return { texto: txt, capturado: true };
    }
    if (/financi[aá] hasta|seleccionar oferta/i.test(txt)) {
      await page.waitForTimeout(800); // que terminen de cargar todas las tarjetas
      const final = await page.locator('body').innerText().catch(() => txt);
      return { texto: final, capturado: false };
    }
    // Cualquier otro cambio: esperar a que la pantalla quede quieta
    if (txt && txt !== antes && !NACION_ESPERA.test(txt)) {
      if (txt === ultimo) { if (Date.now() - quietoDesde > 2500) return { texto: txt, capturado: false }; }
      else { ultimo = txt; quietoDesde = Date.now(); }
    }
    await page.waitForTimeout(300);
  }
  return { texto: await page.locator('body').innerText().catch(() => ''), capturado: false };
}

// "$30,868,289" o "$30.868.289,50" → "30.868.289" / "30.868.289,50" (formato argentino)
function normalizarMonto(m) {
  let s = m.replace(/[$\s]/g, '');
  if (/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(s)) s = s.replace(/,/g, '#').replace('.', ',').replace(/#/g, '.');
  return s;
}

function interpretarNacion(texto, antes = '') {
  const lineas = lineasDe(texto);
  // Solo cuentan los mensajes que aparecieron después de "Evaluar"
  const previas = new Set(lineasDe(antes));
  const negativo = lineas.find(l => !previas.has(l) && NACION_DENEGADO.some(p => l.toLowerCase().includes(p))) || '';

  // Tarjetas de oferta: [PRODUCTO] [UVA?] FINANCIÁ HASTA [$monto] [46% TNA anual] ... Plazo máximo [72 meses]
  const ofertas = [];
  lineas.forEach((l, i) => {
    if (!/^financi[aá] hasta/i.test(l)) return;

    let monto = (l.match(RE_MONTO) || [])[0];
    if (!monto && lineas[i + 1]) monto = (lineas[i + 1].match(RE_MONTO) || [])[0];
    if (!monto) return;

    // Hacia atrás: ¿es UVA? y nombre del producto
    let uva = false, producto = '';
    for (let j = i - 1; j >= Math.max(0, i - 4); j--) {
      if (/^uva$/i.test(lineas[j])) { uva = true; continue; }
      if (/^(solicitar|seleccionar oferta|inicio)$/i.test(lineas[j]) || /meses$/i.test(lineas[j])) break;
      producto = lineas[j];
      break;
    }

    // Hacia adelante: tasa y plazo (hasta la próxima tarjeta)
    let tna = '', plazo = '';
    for (let j = i + 1; j < Math.min(lineas.length, i + 12); j++) {
      if (/^financi[aá] hasta/i.test(lineas[j])) break;
      const t = lineas[j].match(/(\d+(?:[.,]\d+)?)\s*%/);
      if (t && !tna) tna = t[1] + '%';
      if (/^plazo m[aá]ximo/i.test(lineas[j])) {
        plazo = (lineas[j].match(/\d+\s*meses/i) || [])[0] || (lineas[j + 1] || '').match(/\d+\s*meses/i)?.[0] || '';
      }
    }

    const detalle = [uva ? 'UVA' : '', tna ? `TNA ${tna}` : '', plazo ? `hasta ${plazo}` : ''].filter(Boolean).join(' · ');
    ofertas.push({ producto: producto.slice(0, 80), tipo: detalle, monto: normalizarMonto(monto) });
  });

  let estado;
  if (negativo) estado = 'DENEGADO';
  else if (ofertas.length || /seleccionar oferta/i.test(texto)) estado = 'APROBADO';
  else estado = 'REVISAR';

  return { estado, negativo, ofertas: ofertas.slice(0, 6) };
}

function nombreClienteNacion(texto) {
  const lineas = lineasDe(texto);
  const i = lineas.findIndex(l => /^(apellido y nombre|nombre y apellido|cliente|titular)\s*:?$/i.test(l));
  if (i >= 0 && lineas[i + 1]) return lineas[i + 1].slice(0, 80);
  const enLinea = lineas.find(l => /^(apellido y nombre|nombre y apellido|cliente|titular)\s*:\s*\S/i.test(l));
  return enLinea ? enLinea.split(':').slice(1).join(':').trim().slice(0, 80) : '';
}

async function consultarNacion(cuit, vendedor) {
  const b = B.nacion;
  if (!b.app || b.app.isClosed() || b.sesion.estado !== 'conectado') throw new Error('SIN_SESION');
  const page = b.app;
  b.ocupado = true;
  try {
    await irANuevoPrestamo(b);
    await nacion.cuil(page).first().fill(cuit);
    const antes = await page.locator('body').innerText().catch(() => '');

    const nombre = `nacion_${cuit}_${fechaArchivo()}`;
    const rutaPng = path.join(CARPETA_RESULTADOS, `${nombre}.png`);

    await page.getByRole('button', { name: 'Evaluar' }).click();
    const { texto, capturado } = await esperarResultadoNacion(page, antes, rutaPng);

    const { estado, negativo, ofertas } = interpretarNacion(texto, antes);
    const cliente = nombreClienteNacion(texto);

    if (!capturado) {
      await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
      await page.screenshot({ path: rutaPng }).catch(() => {});
    }
    escribirTxt(nombre, `Banco: Nación\nCUIT: ${cuit}\nCliente: ${cliente}\nVendedor: ${vendedor}\nEstado: ${estado}\n` +
      `Ofertas: ${ofertas.map(o => `${o.producto} | ${o.tipo} | ${o.monto}`).join(' / ') || '-'}\nMensaje: ${negativo || '-'}\n\n${texto}`);

    // El monto principal es el mayor de las ofertas
    const valor = m => Number(m.split(',')[0].replace(/\./g, '')) || 0;
    const mayor = [...ofertas].sort((a, b2) => valor(b2.monto) - valor(a.monto))[0];

    return guardarConsulta(b, {
      cuit, estado, vendedor, cliente,
      monto: mayor?.monto || '',
      ofertas,
      resumen: negativo || (estado === 'REVISAR' ? lineasDe(texto).slice(-4).join(' · ').slice(0, 300) : ''),
      captura: `/resultados/${nombre}.png`,
    });
  } finally {
    b.ocupado = false;
    b.ultimaActividad = Date.now();
  }
}

async function mantenerNacion() {
  const b = B.nacion;
  const page = b.app;
  if (await esperar(nacion.inicio(page), 1500)) await nacion.inicio(page).first().click().catch(() => {});
  else await page.goto(URL_NACION, { waitUntil: 'domcontentloaded' });
  if (await esperar(nacion.nuevo(page), 15000)) {
    await b.context.storageState({ path: ESTADO_NACION }).catch(() => {});
  } else {
    setSesion(b, 'desconectado', 'La sesión de Nación venció. Hay que iniciarla de nuevo.', '');
  }
}

// =====================================================================
//  BANCO GALICIA
// =====================================================================
const galicia = {
  usuario: p => p.getByRole('textbox', { name: 'username' }),
  evaluar: p => p.getByRole('button', { name: 'Evaluar CUIT/CUIL' }),
  cuit: p => p.locator('input[name="cuit"]'),
  digito: (p, i) => p.locator(`[id="${i}"]`),
  cerrar: p => p.getByRole('button', { name: 'Cerrar' }),
  continuar: p => p.getByRole('button', { name: 'Continuar' }),
  // Pantalla "Gestiones disponibles": tarjeta Préstamos para vehículos → Ir al producto
  irProducto: p => p.getByRole('link', { name: /ir al producto/i }).or(p.getByRole('button', { name: /ir al producto/i })),
  prestamos: p => p.getByRole('link', { name: /préstamos para vehículos/i }),
  // Logueado: se ve el inicio (Gestiones disponibles) o la pantalla de préstamos
  adentro: p => p.getByRole('button', { name: 'Evaluar CUIT/CUIL' }).or(p.getByRole('link', { name: /ir al producto/i })).or(p.getByRole('button', { name: /ir al producto/i })),
};

// Cierra los avisos que Galicia muestra al entrar
async function cerrarAvisosGalicia(page) {
  if (await aceptarSalidaGalicia(page, 300)) return;
  const avisos = page.getByRole('button', { name: /^(cerrar|listo|entendido|×|x)$/i });
  for (let k = 0; k < 4; k++) {
    if (await esperar(avisos, 700)) await avisos.first().click({ timeout: 3000 }).catch(() => {});
    else break;
  }
  await page.keyboard.press('Escape').catch(() => {});
}

async function loginGalicia(quien) {
  const b = B.galicia;
  const mio = ++b.intento;
  try {
    setSesion(b, 'iniciando', 'Abriendo Banco Galicia...', quien);
    const opciones = fs.existsSync(ESTADO_GALICIA) ? { storageState: ESTADO_GALICIA } : {};
    const ctx = await abrirNavegador(b, opciones);
    const page = await ctx.newPage();
    b.page = page;
    await page.goto(URL_GALICIA, { waitUntil: 'domcontentloaded' });

    // ¿Quedó la sesión guardada de la vez anterior?
    await galicia.usuario(page).or(galicia.adentro(page)).first().waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});
    await cerrarAvisosGalicia(page);

    if (!(await esperar(galicia.adentro(page), 1500))) {
      await galicia.usuario(page).fill(CFG.galicia.usuario);
      b.pedidoToken = Date.now();
      await page.getByRole('button', { name: 'Enviar token' }).click();

      await galicia.digito(page, 0).or(galicia.adentro(page)).first().waitFor({ state: 'visible', timeout: 25000 }).catch(() => {});

      if (await esperar(galicia.digito(page, 0), 500)) {
        if (mio !== b.intento) return;
        setSesion(b, 'esperando_token', 'Galicia mandó un token. Escribilo abajo.', quien);
        autoTokenDesdeMail(b, b.pedidoToken || Date.now());
        await galicia.adentro(page).first().waitFor({ state: 'visible', timeout: 15 * 60 * 1000 });
      } else if (!(await esperar(galicia.adentro(page), 500))) {
        const texto = await page.locator('body').innerText().catch(() => '');
        const linea = lineasDe(texto).find(l => /incorrect|inválid|invalid|bloquead|error|no exist/i.test(l));
        throw new Error(linea || 'Galicia no aceptó el usuario');
      }
    }

    if (mio !== b.intento) return;
    await cerrarAvisosGalicia(page);
    await ctx.storageState({ path: ESTADO_GALICIA }).catch(() => {});
    b.app = page;
    const actual = page.url();
    b.urlBusqueda = /\/login/i.test(actual) ? new URL(actual).origin + '/' : actual;
    console.log(`[Galicia] inicio en ${b.urlBusqueda}`);
    b.ultimaActividad = Date.now();
    setSesion(b, 'conectado', 'Sesión activa en Banco Galicia', quien);
  } catch (err) {
    if (mio === b.intento) setSesion(b, 'error', `No se pudo iniciar sesión: ${err.message.split('\n')[0]}`, '');
  }
}

async function enviarTokenGalicia(codigo) {
  const b = B.galicia;
  if (b.sesion.estado !== 'esperando_token' || !b.page || b.page.isClosed()) {
    return { ok: false, error: 'No hay un token pendiente' };
  }
  const digitos = codigo.replace(/\D/g, '');
  if (digitos.length !== 6) return { ok: false, error: 'El token de Galicia tiene 6 números' };

  const page = b.page;
  // Las casillas de Galicia muestran "•" en vez del número (lo ocultan), así que solo se puede
  // verificar que estén completas, no qué número tienen.
  const completas = async () => {
    let n = 0;
    for (let i = 0; i < 6; i++) if ((await galicia.digito(page, i).inputValue().catch(() => '')) !== '') n++;
    return n;
  };
  const casillasVisibles = () => esperar(galicia.digito(page, 0), 1500);
  const entro = ms => esperar(galicia.adentro(page).or(galicia.cerrar(page)), ms);
  // Borrar como una persona: desde la última casilla, tecla de borrar varias veces
  const borrarTodo = async () => {
    await galicia.digito(page, 5).click().catch(() => {});
    for (let k = 0; k < 14; k++) await page.keyboard.press('Backspace').catch(() => {});
    await page.waitForTimeout(200);
  };

  const estrategias = {
    // 1) Pegar el token entero en la primera casilla (como copiar y pegar del mail)
    pegar: async () => {
      await galicia.digito(page, 0).click();
      await page.evaluate(d => {
        const el = document.getElementById('0');
        el.focus();
        const dt = new DataTransfer();
        dt.setData('text/plain', d);
        dt.setData('text', d);
        el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      }, digitos);
    },
    // 2) Escribir de corrido y dejar que el portal salte solo de casilla
    corrido: async () => {
      await galicia.digito(page, 0).click();
      for (const d of digitos) { await page.keyboard.press(d); await page.waitForTimeout(220); }
    },
    // 3) Casilla por casilla, con clic en cada una
    casillas: async () => {
      for (let i = 0; i < 6; i++) {
        await galicia.digito(page, i).click();
        await page.keyboard.press(digitos[i]);
        await page.waitForTimeout(220);
      }
    },
  };

  let ultimoError = '';
  for (const [nombre, fn] of Object.entries(estrategias)) {
    // Si las casillas ya no están, Galicia aceptó el token y está entrando
    if (!(await casillasVisibles())) { console.log(`[Galicia] token aceptado (envío automático)`); break; }

    await borrarTodo();
    await fn().catch(() => {});
    await page.waitForTimeout(600);

    // ¿Galicia lo envió sola al completarlo?
    if (await entro(500) || !(await casillasVisibles())) { console.log(`[Galicia] token enviado solo con "${nombre}"`); break; }

    const n = await completas();
    console.log(`[Galicia] token con "${nombre}": ${n}/6 casillas completas`);
    if (n < 6) continue;

    // Tocar Ingresar (esperando a que se habilite)
    const ingresar = page.getByRole('button', { name: 'Ingresar' }).first();
    for (let k = 0; k < 15 && !(await ingresar.isEnabled().catch(() => false)); k++) await page.waitForTimeout(200);
    const tocado = await ingresar.click({ timeout: 5000 }).then(() => true).catch(() => false);
    if (!tocado) await page.keyboard.press('Enter').catch(() => {});

    // Esperar a ver si entra; si Galicia rechaza (por ejemplo, números en otro orden), probar la forma siguiente
    if (await entro(10000) || !(await casillasVisibles())) { console.log(`[Galicia] token aceptado con "${nombre}"`); break; }
    const texto = await page.locator('body').innerText().catch(() => '');
    ultimoError = lineasDe(texto).find(l => /incorrect|inválid|invalid|vencid|expir|error|no coincid/i.test(l)) || '';
    console.log(`[Galicia] "${nombre}" no entró${ultimoError ? ': ' + ultimoError : ''}`);
    if (/vencid|expir/i.test(ultimoError)) break; // token vencido: no tiene sentido seguir probando
  }

  if (await esperar(galicia.adentro(page).or(galicia.cerrar(page)), 20000)) {
    await cerrarAvisosGalicia(page);
    return { ok: true };
  }
  await page.screenshot({ path: path.join(CARPETA_RESULTADOS, 'galicia_token_error.png') }).catch(() => {});
  const texto = await page.locator('body').innerText().catch(() => '');
  const linea = lineasDe(texto).find(l => /incorrect|inválid|invalid|vencid|expir|error|no coincid/i.test(l));
  return { ok: false, error: linea || 'El token no fue aceptado. Revisalo o pedí uno nuevo.', captura: '/resultados/galicia_token_error.png' };
}

async function reenviarTokenGalicia() {
  const b = B.galicia;
  b.pedidoToken = Date.now();
  if (b.sesion.estado !== 'esperando_token' || !b.page) return { ok: false, error: 'No hay un token pendiente' };
  const p = b.page;
  try {
    await p.getByRole('button', { name: /reenviar|volver a enviar|nuevo token|enviar token/i })
      .or(p.getByRole('link', { name: /reenviar|volver a enviar|nuevo token|enviar token/i }))
      .first().click({ timeout: 4000 });
    return { ok: true };
  } catch {
    return { ok: false, error: 'No encontré el botón para reenviar. Tocá "Empezar de nuevo" para que mande otro token.' };
  }
}

// Galicia es una app de una sola página: recargarla puede perder la sesión.
// Para llegar a "Evaluar CUIT/CUIL" se usan sus propios botones:
//   - desde "Gestiones disponibles": Ir al producto (Préstamos para vehículos)
//   - desde un resultado o simulación: el link "Préstamos para vehículos", Volver o Cancelar
// Acepta carteles de confirmación del tipo "¿Querés salir de la simulación?"
// "¿Querés cancelar la simulación?" → "Sí, cancelar" (solo descarta la simulación de prueba)
async function aceptarSalidaGalicia(page, ms = 600) {
  const boton = page.getByRole('button', { name: /^s[ií],?\s*(cancelar|salir)/i }).first();
  if (!(await esperar(boton, ms))) return false;
  await boton.click({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(400);
  return true;
}

// "Evaluar CUIT/CUIL" está en la pantalla de Inicio (Gestiones disponibles).
// Para volver se usa el menú "Inicio" (izquierda o la ruta de arriba). Nunca se recarga la página.
async function volverAlInicioGalicia(page) {
  const listo = async ms => { await cerrarAvisosGalicia(page); return esperar(galicia.evaluar(page), ms); };
  if (await listo(800)) return true;

  const caminos = [
    page.getByRole('link', { name: /^inicio$/i }),
    page.getByRole('button', { name: /^inicio$/i }),
    page.getByText(/^inicio$/i),
    page.getByRole('button', { name: /^volver$/i }),
  ];
  for (let vuelta = 0; vuelta < 2; vuelta++) {
    for (const c of caminos) {
      if (!(await esperar(c, 500))) continue;
      await c.first().click({ timeout: 5000 }).catch(() => {});
      await aceptarSalidaGalicia(page, 2000);
      if (await listo(6000)) return true;
    }
  }
  return false;
}

async function irAEvaluarGalicia(b) {
  const page = b.app;
  paso(b, 'volviendo a Préstamos para vehículos');
  // Importante: Galicia NO se recarga nunca (recargar cierra la sesión)
  if (!(await volverAlInicioGalicia(page))) {
    if (await esperar(galicia.usuario(page), 1000)) {
      setSesion(b, 'desconectado', 'La sesión de Galicia venció. Hay que iniciarla de nuevo.', '');
      throw new Error('SESION_VENCIDA');
    }
    throw new Error('no pude volver a "Préstamos para vehículos"');
  }
  paso(b, 'tocando "Evaluar CUIT/CUIL"');
  await cerrarAvisosGalicia(page);
  const evaluar = galicia.evaluar(page).first();
  const tocado = await evaluar.click({ timeout: 6000 }).then(() => true).catch(() => false);
  // Si algo lo tapa (un cartel), disparar el clic directo sobre el botón
  if (!tocado) await evaluar.dispatchEvent('click').catch(() => {});
  paso(b, 'esperando el campo CUIT');
  await galicia.cuit(page).first().waitFor({ state: 'visible', timeout: 15000 });
}

// Carga el CUIT en el campo con máscara (XX-XXXXXXXX-X) y verifica que quedó bien
async function cargarCuitGalicia(page, cuit) {
  const campo = galicia.cuit(page).first();
  const conGuiones = `${cuit.slice(0, 2)}-${cuit.slice(2, 10)}-${cuit.slice(10)}`;
  const ok = async () => (await campo.inputValue().catch(() => '')).replace(/\D/g, '') === cuit;

  await campo.fill(conGuiones).catch(() => {});
  if (await ok()) return true;

  // Escribirlo tecla por tecla, como una persona (la máscara pone los guiones)
  await campo.click().catch(() => {});
  await campo.press('Control+A').catch(() => {});
  await page.keyboard.press('Backspace').catch(() => {});
  await campo.pressSequentially(cuit, { delay: 60 }).catch(() => {});
  return ok();
}

// ---------- Simulación en Galicia (para conocer el monto disponible) ----------
const escRegex = t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const soloNumeros = v => String(v ?? '').replace(/\D/g, '');
const conPuntos = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.');

// Escribe un número en un campo con máscara, tecla por tecla
async function escribirNumero(page, campo, numero) {
  await campo.waitFor({ state: 'visible', timeout: 15000 });
  await campo.click().catch(() => {});
  await campo.press('Control+A').catch(() => {});
  await page.keyboard.press('Backspace').catch(() => {});
  await campo.pressSequentially(String(numero), { delay: 15, timeout: 8000 });
  await page.keyboard.press('Tab').catch(() => {});
}

// Elige una opción en las listas desplegables del portal (react-select)
async function elegirOpcion(page, zona, indice, texto) {
  const campo = zona.locator('input[id^="react-select-"][id$="-input"]').nth(indice);
  await campo.waitFor({ state: 'attached', timeout: 15000 });
  for (let k = 0; k < 40 && await campo.isDisabled().catch(() => true); k++) await page.waitForTimeout(250);
  await campo.focus();
  await page.keyboard.press('Control+A').catch(() => {});
  await page.keyboard.type(texto, { delay: 25 });
  const opcion = page.locator('[id^="react-select-"][id*="-option-"]').filter({ hasText: new RegExp(escRegex(texto), 'i') }).first();
  if (await esperar(opcion, 8000)) await opcion.click({ timeout: 5000 });
  else await page.keyboard.press('Enter');
  await page.waitForTimeout(450);
}

async function tocarBoton(page, nombre) {
  const boton = page.getByRole('button', { name: nombre }).first();
  await boton.waitFor({ state: 'visible', timeout: 15000 });
  for (let k = 0; k < 40 && !(await boton.isEnabled().catch(() => false)); k++) await page.waitForTimeout(250);
  const ok = await boton.click({ timeout: 8000 }).then(() => true).catch(() => false);
  if (!ok) await boton.dispatchEvent('click');
}

// Lee las tarjetas de la Propuesta: "Prendario en UVAs · Tasa fija · Disponible $36.000.000,00 · TNA: 20% · Plazo: 60M"
function leerPropuestaGalicia(texto) {
  const lineas = lineasDe(texto);
  const ofertas = [];
  lineas.forEach((l, i) => {
    if (!/^disponible/i.test(l)) return;
    let monto = (l.match(RE_MONTO) || [])[0];
    if (!monto && lineas[i + 1]) monto = (lineas[i + 1].match(RE_MONTO) || [])[0];
    if (!monto) return;

    let producto = '', tasa = '';
    for (let j = i - 1; j >= Math.max(0, i - 4); j--) {
      if (/^tasa (fija|variable)/i.test(lineas[j])) { tasa = lineas[j]; continue; }
      if (/^(disponible|tna|plazo|continuar|cancelar)/i.test(lineas[j]) || RE_MONTO.test(lineas[j])) break;
      producto = lineas[j];
      break;
    }
    let tna = '', plazo = '';
    for (let j = i + 1; j < Math.min(lineas.length, i + 8); j++) {
      if (/^disponible/i.test(lineas[j])) break;
      const t = lineas[j].match(/tna:?\s*(\d+(?:[.,]\d+)?\s*%)/i) || (/^tna/i.test(lineas[j - 1] || '') && lineas[j].match(/^(\d+(?:[.,]\d+)?\s*%)$/));
      if (t && !tna) tna = t[1].replace(/\s/g, '');
      const p = lineas[j].match(/plazo:?\s*(\d+\s*m)/i) || (/^plazo/i.test(lineas[j - 1] || '') && lineas[j].match(/^(\d+\s*m)/i));
      if (p && !plazo) plazo = p[1].replace(/\s/g, '').replace(/m$/i, ' meses');
    }
    const detalle = [tasa, tna ? `TNA ${tna}` : '', plazo ? `hasta ${plazo}` : ''].filter(Boolean).join(' · ');
    ofertas.push({ producto: producto.slice(0, 80), tipo: detalle, monto: normalizarMonto(monto) });
  });
  return ofertas;
}

// Hace la simulación completa y vuelve con las ofertas. No confirma nada: al final toca Cancelar.
// ---------- Consulta en Galicia por "Simular" (Préstamos para vehículos) ----------
// Flujo: Préstamos para vehículos → Simular → DNI + ingresos → Continuar
//   - "No tenemos una oferta…"  → DENEGADO
//   - pasa a la pantalla del vehículo → APROBADO (y si se pidió, se completa para ver los montos)

const enPrestamosGalicia = page => page.getByText(/tus solicitudes|financiaciones ofrecidas/i).first();
const botonSimularGalicia = page => page.getByRole('button', { name: /^simular$/i }).or(page.getByRole('link', { name: /^simular$/i })).first();
const campoDniGalicia = page => page.locator('input[name="customer_dni"]').first();
const rechazoGalicia = page => page.getByText(/no tenemos (una )?oferta|no calific|rechaz/i).first();

// Llega a "Préstamos para vehículos" usando los botones del portal (nunca recarga)
async function irAPrestamosGalicia(b) {
  const page = b.app;
  const llegue = async ms => { await cerrarAvisosGalicia(page); return esperar(enPrestamosGalicia(page), ms); };

  paso(b, 'yendo a Préstamos para vehículos');
  if (await llegue(800)) return;

  const entrarDesdeInicio = async () => {
    if (!(await esperar(galicia.irProducto(page), 4000))) return false;
    await galicia.irProducto(page).first().click({ timeout: 5000 }).catch(() => {});
    return llegue(8000);
  };
  const caminos = [
    galicia.prestamos(page),                               // link de arriba "Préstamos para vehículos"
    page.getByRole('button', { name: /^volver$/i }),       // pantalla de rechazo
    page.getByRole('link', { name: /^inicio$/i }),         // menú de la izquierda
  ];
  for (let vuelta = 0; vuelta < 2; vuelta++) {
    if (await esperar(galicia.irProducto(page), 300) && await entrarDesdeInicio()) return;
    for (const c of caminos) {
      if (!(await esperar(c, 500))) continue;
      await c.first().click({ timeout: 5000 }).catch(() => {});
      await aceptarSalidaGalicia(page, 2000);   // "¿Querés cancelar la simulación?" → Sí, cancelar
      if (await llegue(4000)) return;
      if (await entrarDesdeInicio()) return;
    }
  }
  if (await esperar(galicia.usuario(page), 1000)) {
    setSesion(b, 'desconectado', 'La sesión de Galicia venció. Hay que iniciarla de nuevo.', '');
    throw new Error('SESION_VENCIDA');
  }
  throw new Error('no pude llegar a "Préstamos para vehículos"');
}

// Completa la pantalla del vehículo y lee la propuesta (montos disponibles)
async function completarVehiculoGalicia(b, valorAuto) {
  const page = b.app;
  paso(b, 'cargando el vehículo');
  const montoAuto = page.getByRole('textbox', { name: /monto del veh[ií]culo/i }).first();
  await escribirNumero(page, montoAuto, valorAuto);
  // Listas desplegables del vehículo, en orden: uso, condición, marca, modelo
  const zona = page.locator('form').filter({ has: montoAuto }).first();
  const zonaOk = (await zona.count().catch(() => 0)) > 0 ? zona : page.locator('body');
  paso(b, 'eligiendo uso del vehículo');
  await elegirOpcion(page, zonaOk, 0, 'Particular');
  paso(b, 'eligiendo condición 0KM');
  await elegirOpcion(page, zonaOk, 1, '0KM');
  paso(b, `eligiendo la marca ${CFG.galicia.marca}`);
  await elegirOpcion(page, zonaOk, 2, CFG.galicia.marca);
  paso(b, `eligiendo el modelo ${CFG.galicia.modelo}`);
  await elegirOpcion(page, zonaOk, 3, CFG.galicia.modelo);
  await tocarBoton(page, 'Continuar');

  paso(b, 'leyendo la propuesta');
  await page.getByText(/^disponible/i).or(rechazoGalicia(page)).first().waitFor({ state: 'visible', timeout: 25000 });
  await page.waitForTimeout(800);
  const texto = await page.locator('body').innerText().catch(() => '');
  return { ofertas: leerPropuestaGalicia(texto), texto };
}

async function consultarGalicia(cuit, vendedor, opciones = {}) {
  const b = B.galicia;
  if (!b.app || b.app.isClosed() || b.sesion.estado !== 'conectado') throw new Error('SIN_SESION');
  const page = b.app;
  b.ocupado = true;
  try {
    const nombre = `galicia_${cuit}_${fechaArchivo()}`;
    const rutaPng = path.join(CARPETA_RESULTADOS, `${nombre}.png`);
    const ingresos = soloNumeros(opciones.ingresos) || soloNumeros(CFG.galicia.ingresos) || '6000000';
    const valorAuto = soloNumeros(opciones.valorAuto) || soloNumeros(CFG.galicia.valorAuto) || '45000000';

    if (cuit.startsWith('3')) {
      return guardarConsulta(b, {
        cuit, estado: 'REVISAR', vendedor, cliente: '', monto: '', ofertas: [],
        resumen: 'Es una empresa (CUIT 30/33/34): la consulta automática de Galicia es para personas. Consultalo en el portal.',
        captura: '',
      });
    }
    const dni = cuit.slice(2, 10).replace(/^0+/, '');

    await irAPrestamosGalicia(b);

    paso(b, 'tocando "Simular"');
    const simular = botonSimularGalicia(page);
    const ok = await simular.click({ timeout: 8000 }).then(() => true).catch(() => false);
    if (!ok) await simular.dispatchEvent('click').catch(() => {});

    paso(b, 'esperando el formulario de simulación');
    await campoDniGalicia(page).waitFor({ state: 'visible', timeout: 15000 });

    // Galicia puede rechazar apenas se carga el DNI ("No tenemos una oferta…"):
    // si cualquier paso se traba y ese mensaje está en pantalla, es DENEGADO.
    const montoAuto = page.getByRole('textbox', { name: /monto del veh[ií]culo/i }).first();
    const ingresosCampo = page.getByRole('textbox', { name: /ingresos netos mensuales/i }).first();
    let antes = '';
    try {
      paso(b, 'cargando el DNI');
      await escribirNumero(page, campoDniGalicia(page), dni);
      // ¿Rechazó con el DNI?
      await rechazoGalicia(page).waitFor({ state: 'visible', timeout: 2500 }).catch(() => {});
      if (!(await esperar(rechazoGalicia(page), 200))) {
        paso(b, 'cargando los ingresos');
        await escribirNumero(page, ingresosCampo, ingresos);
        antes = await page.locator('body').innerText().catch(() => '');
        if (!(await esperar(rechazoGalicia(page), 300))) {
          paso(b, 'tocando "Continuar"');
          await tocarBoton(page, 'Continuar');
        }
      }
      paso(b, 'esperando la decisión de Galicia');
      await rechazoGalicia(page).or(montoAuto).waitFor({ state: 'visible', timeout: 30000 }).catch(() => {});
    } catch (err) {
      if (!(await esperar(rechazoGalicia(page), 5000))) throw err;
    }

    let estado, negativo = '', ofertas = [], nota = '', textoSim = '';
    let texto = await page.locator('body').innerText().catch(() => '');

    if (await esperar(rechazoGalicia(page), 300)) {
      estado = 'DENEGADO';
      negativo = lineasDe(texto).find(l => GALICIA_DENEGADO.some(p => l.toLowerCase().includes(p))) || 'Galicia no tiene oferta para este cliente';
      await page.screenshot({ path: rutaPng }).catch(() => {});
    } else if (await esperar(montoAuto, 300)) {
      estado = 'APROBADO';
      if (true) { // Galicia siempre calcula el monto
        try {
          const sim = await completarVehiculoGalicia(b, valorAuto);
          textoSim = sim.texto;
          if (await esperar(rechazoGalicia(page), 300)) {
            estado = 'DENEGADO';
            negativo = lineasDe(sim.texto).find(l => GALICIA_DENEGADO.some(p => l.toLowerCase().includes(p))) || 'Galicia no tiene oferta para este cliente';
          } else {
            ofertas = sim.ofertas;
            nota = `Simulado con ingresos $${conPuntos(ingresos)} y auto 0KM de $${conPuntos(valorAuto)} (${CFG.galicia.marca} ${CFG.galicia.modelo}).`;
          }
        } catch (err) {
          nota = `No se pudo calcular el monto (paso: ${b.paso}): ${err.message.split('\n')[0]}`;
          console.log(`[Galicia] ${nota}`);
        }
      } else {
        nota = `Califica con ingresos de $${conPuntos(ingresos)}.`;
      }
      await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
      await page.screenshot({ path: rutaPng }).catch(() => {});
    } else {
      // Ni rechazo ni vehículo: puede ser un aviso del formulario (por ejemplo, DNI no encontrado)
      estado = 'REVISAR';
      await page.screenshot({ path: rutaPng }).catch(() => {});
    }

    const cliente = nombreClienteNacion(texto);
    escribirTxt(nombre, `Banco: Galicia\nCUIT: ${cuit}\nDNI: ${dni}\nVendedor: ${vendedor}\nEstado: ${estado}\n` +
      `Montos: ${ofertas.map(o => `${o.producto} | ${o.tipo} | ${o.monto}`).join(' / ') || '-'}\nMensaje: ${negativo || '-'}\nNota: ${nota || '-'}\n\n${texto}${textoSim ? '\n\n--- Propuesta ---\n' + textoSim : ''}`);

    const valor = m => Number(m.split(',')[0].replace(/\./g, '')) || 0;
    const mayor = [...ofertas].sort((a, c) => valor(c.monto) - valor(a.monto))[0];
    const previas = new Set(lineasDe(antes));

    // (la vuelta a "Préstamos para vehículos" se hace al empezar la próxima consulta)
    return guardarConsulta(b, {
      cuit, estado, vendedor, cliente,
      monto: mayor?.monto || '',
      ofertas,
      nota,
      resumen: negativo || (estado === 'REVISAR' ? lineasDe(texto).filter(l => !previas.has(l)).slice(0, 4).join(' · ').slice(0, 300) : ''),
      captura: `/resultados/${nombre}.png`,
    });
  } finally {
    b.ocupado = false;
    b.ultimaActividad = Date.now();
  }
}

// Mantener viva la sesión sin recargar: ir a "Préstamos para vehículos" con los botones del portal
async function mantenerGalicia() {
  const b = B.galicia;
  const page = b.app;
  if (await esperar(galicia.usuario(page), 1000)) {
    setSesion(b, 'desconectado', 'La sesión de Galicia venció. Hay que iniciarla de nuevo.', '');
    return;
  }
  try { await irAPrestamosGalicia(b); } catch {}
  if (b.sesion.estado === 'conectado') await b.context.storageState({ path: ESTADO_GALICIA }).catch(() => {});
}

// Lee la pantalla hasta que aparece una respuesta. Si se queda quieta sin respuesta y hay
// un segundo "Continuar" (como en el recorrido grabado), lo toca una sola vez.
async function esperarResultadoGalicia(page, antes, rutaPng, maxMs = 40000) {
  const t0 = Date.now();
  const previas = new Set(lineasDe(antes).map(l => l.toLowerCase()));
  const nuevas = txt => lineasDe(txt).filter(l => !previas.has(l.toLowerCase())).map(l => l.toLowerCase());
  let ultimo = '', quietoDesde = 0, segundoContinuar = false;

  while (Date.now() - t0 < maxMs) {
    const txt = await page.locator('body').innerText().catch(() => '');
    const lineas = nuevas(txt);

    if (lineas.some(l => GALICIA_DENEGADO.some(p => l.includes(p)))) {
      await page.screenshot({ path: rutaPng }).catch(() => {});
      return { texto: txt, capturado: true };
    }
    if (lineas.some(l => RE_MONTO.test(l)) || lineas.some(l => GALICIA_APROBADO.some(p => l.includes(p)))) {
      await page.waitForTimeout(1000);
      return { texto: await page.locator('body').innerText().catch(() => txt), capturado: false };
    }

    if (txt && txt !== antes && !NACION_ESPERA.test(txt)) {
      if (txt === ultimo) {
        if (Date.now() - quietoDesde > 2500) {
          // (los dos "Continuar" ya los toca consultarGalicia)
          if (false && !segundoContinuar) {
            segundoContinuar = true;
            await galicia.continuar(page).first().click().catch(() => {});
            ultimo = ''; quietoDesde = 0;
            await page.waitForTimeout(600);
            continue;
          }
          return { texto: txt, capturado: false };
        }
      } else { ultimo = txt; quietoDesde = Date.now(); }
    }
    await page.waitForTimeout(300);
  }
  return { texto: await page.locator('body').innerText().catch(() => ''), capturado: false };
}

function interpretarGalicia(texto, antes = '') {
  const previas = new Set(lineasDe(antes));
  const lineas = lineasDe(texto);
  const nuevas = lineas.filter(l => !previas.has(l));
  const negativo = nuevas.find(l => GALICIA_DENEGADO.some(p => l.toLowerCase().includes(p))) || '';

  const ofertas = [];
  nuevas.forEach(l => {
    const m = l.match(RE_MONTO);
    if (!m) return;
    const i = lineas.indexOf(l);
    let etiqueta = l.replace(m[0], '').replace(/[:$]/g, '').trim();
    if (!etiqueta && i > 0) etiqueta = lineas[i - 1].replace(/:$/, '');
    ofertas.push({ producto: etiqueta.slice(0, 80), tipo: '', monto: normalizarMonto(m[0]) });
  });

  let estado;
  if (negativo) estado = 'DENEGADO';
  else if (ofertas.length || nuevas.some(l => GALICIA_APROBADO.some(p => l.toLowerCase().includes(p)))) estado = 'APROBADO';
  else estado = 'REVISAR';

  return { estado, negativo, ofertas: ofertas.slice(0, 6) };
}

// =====================================================================
//  Lectura automática del código (token) desde el correo — IMAP
// =====================================================================
// Variables: MAIL_USUARIO (tu mail), MAIL_CLAVE_APP (contraseña de aplicación),
//            MAIL_SERVIDOR (por defecto imap.gmail.com), MAIL_PUERTO (por defecto 993)
// Opcionales: MAIL_FILTRO_NACION, MAIL_FILTRO_GALICIA (texto que debe tener el remitente o el asunto)
const MAIL = {
  usuario: (process.env.MAIL_USUARIO || '').trim(),
  clave: (process.env.MAIL_CLAVE_APP || '').replace(/\s/g, ''),
  servidor: process.env.MAIL_SERVIDOR || 'imap.gmail.com',
  puerto: Number(process.env.MAIL_PUERTO || 993),
};
const MAIL_ACTIVO = !!(MAIL.usuario && MAIL.clave);
const FILTRO_MAIL = {
  nacion: new RegExp(process.env.MAIL_FILTRO_NACION || 'bna|naci[oó]n|masautos', 'i'),
  galicia: new RegExp(process.env.MAIL_FILTRO_GALICIA || 'galicia', 'i'),
};

let ImapFlow = null, simpleParser = null;
if (MAIL_ACTIVO) {
  try {
    ({ ImapFlow } = require('imapflow'));
    ({ simpleParser } = require('mailparser'));
  } catch {
    console.log('[Mail] Faltan las librerías imapflow/mailparser: la lectura automática del código queda desactivada.');
  }
}

function textoDeHtml(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n));
}

// Busca el código dentro del texto del mail
function extraerCodigo(texto) {
  const t = String(texto || '').replace(/\s+/g, ' ');
  const cerca = t.match(/(?:c[oó]digo|token|clave|verificaci[oó]n)[^0-9]{0,120}?\b(\d{4,8})\b/i);
  if (cerca) return cerca[1];
  const seis = t.match(/\b(\d{6})\b/);
  return seis ? seis[1] : '';
}

// Revisa los últimos mails y devuelve el código más nuevo del banco, recibido después de "desde"
async function buscarCodigoEnMail(banco, desde, usados) {
  const client = new ImapFlow({
    host: MAIL.servidor, port: MAIL.puerto, secure: true,
    auth: { user: MAIL.usuario, pass: MAIL.clave },
    logger: false,
  });
  await client.connect();
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const ayer = new Date(desde - 24 * 3600 * 1000);
      const uids = (await client.search({ since: ayer }, { uid: true })) || [];
      const ultimos = uids.slice(-15);
      if (!ultimos.length) return null;

      const candidatos = [];
      for await (const msg of client.fetch(ultimos, { envelope: true, internalDate: true, uid: true }, { uid: true })) {
        const fecha = new Date(msg.internalDate || msg.envelope?.date || 0).getTime();
        if (fecha < desde - 60 * 1000) continue;         // mails viejos no
        if (usados.has(msg.uid)) continue;               // ya probado
        const de = (msg.envelope?.from || []).map(f => `${f.name || ''} ${f.address || ''}`).join(' ');
        const asunto = msg.envelope?.subject || '';
        if (!FILTRO_MAIL[banco].test(`${de} ${asunto}`)) continue;
        candidatos.push({ uid: msg.uid, fecha });
      }
      candidatos.sort((a, c) => c.fecha - a.fecha);

      for (const cand of candidatos) {
        const msg = await client.fetchOne(String(cand.uid), { source: true }, { uid: true });
        if (!msg?.source) continue;
        const parsed = await simpleParser(msg.source);
        const codigo = extraerCodigo(`${parsed.subject || ''} ${parsed.text || textoDeHtml(parsed.html)}`);
        usados.add(cand.uid);
        if (codigo) return { codigo, uid: cand.uid };
      }
      return null;
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

// Mientras el banco espera el código: revisa el correo cada 5 segundos y lo ingresa solo
async function autoTokenDesdeMail(b, desde) {
  if (!MAIL_ACTIVO || !ImapFlow) return;
  const mio = b.intento;
  const usados = new Set();
  b.codigoMail = { estado: 'buscando', texto: 'Buscando el código en tu correo…' };
  const fin = Date.now() + 5 * 60 * 1000;

  while (Date.now() < fin && b.intento === mio && b.sesion.estado === 'esperando_token') {
    try {
      const r = await buscarCodigoEnMail(b.id, desde, usados);
      if (r && b.intento === mio && b.sesion.estado === 'esperando_token') {
        b.codigoMail = { estado: 'ingresando', codigo: r.codigo, texto: `Código leído del mail: ${r.codigo} — ingresando…` };
        console.log(`[${b.nombre}] código leído del mail, ingresando`);
        const res = await TOKEN[b.id](r.codigo).catch(err => ({ ok: false, error: err.message }));
        if (res.ok) {
          b.codigoMail = { estado: 'ok', codigo: r.codigo, texto: `Código ${r.codigo} ingresado desde el mail ✓` };
          return;
        }
        b.codigoMail = { estado: 'error', codigo: r.codigo, texto: `El código ${r.codigo} del mail no fue aceptado. Sigo buscando uno nuevo…` };
      }
    } catch (err) {
      const msg = /auth|credential|login|invalid/i.test(err.message)
        ? 'No pude entrar a tu correo: revisá MAIL_USUARIO y MAIL_CLAVE_APP.'
        : 'No pude leer el correo en este intento, reintento…';
      b.codigoMail = { estado: 'error', texto: msg };
      console.log(`[Mail] ${b.nombre}: ${err.message.split('\n')[0]}`);
      if (/auth|credential|login|invalid/i.test(err.message)) return;
    }
    await new Promise(r => setTimeout(r, 5000));
  }
  if (b.sesion.estado === 'esperando_token' && b.intento === mio) {
    b.codigoMail = { estado: 'error', texto: 'No encontré el código en el correo. Escribilo a mano o tocá "Reenviar código".' };
  }
}

// =====================================================================
//  DECREDITOS (agencias2.decreditos.com) — entra solo con correo y contraseña
// =====================================================================
// Flujo: Simulador (año, modelo, monto, uso) → Calcular cuotas → plazo + tipo → Confirmar plazo
//        → DNI → Buscar (se completa solo) → Obtener resolución
// Resultados: "Te ofrecemos $…" = APROBADO · "Operación Pre-Aprobada" = PREAPROBADO · "Propuesta rechazada" = DENEGADO
// "Desistir y continuar" (solicitud en curso) NO se toca: se avisa para revisarlo en el portal.

const dec = {
  usuario: p => p.getByRole('textbox', { name: /ingres[aá] tu usuario/i })
    .or(p.locator('input[type="email"], input[placeholder*="usuario" i], input[name*="user" i], input[name*="mail" i]')).first(),
  clave: p => p.getByRole('textbox', { name: /ingres[aá] tu contrase/i })
    .or(p.locator('input[type="password"]')).first(),
  modelo: p => p.getByRole('textbox', { name: /volkswagen vento/i })
    .or(p.locator('input[placeholder*="Vento" i]')).first(),
  dni: p => p.getByRole('textbox', { name: /^dni$/i }).first(),
  rechazo: p => p.getByText(/propuesta rechazada|no (es posible|podemos)|rechazad/i).first(),
  preaprobada: p => p.getByText(/operaci[oó]n pre-?\s?aprobada/i).first(),
  ofrecemos: p => p.getByText(/te ofrecemos/i).first(),
  desistir: p => p.getByRole('button', { name: /desistir/i }).first(),
};

// Si la página muestra el login, entra con correo y contraseña. Devuelve cuando ya está adentro.
async function entrarDecreditos(page) {
  paso(B.decreditos, 'esperando la pantalla de ingreso');
  await dec.usuario(page).or(dec.modelo(page)).first().waitFor({ state: 'visible', timeout: 40000 }).catch(() => {});
  if (!(await esperar(dec.usuario(page), 500))) return;
  paso(B.decreditos, 'cargando correo y contraseña');

  await dec.usuario(page).fill(CFG.decreditos.usuario);
  await dec.clave(page).fill(CFG.decreditos.clave);
  const boton = page.getByRole('button', { name: /^ingresar$/i }).or(page.locator('div').filter({ hasText: /^Ingresar$/ })).first();
  const ok = await boton.click({ timeout: 8000 }).then(() => true).catch(() => false);
  if (!ok) await dec.clave(page).press('Enter').catch(() => {});
  paso(B.decreditos, 'esperando entrar después del login');
  await page.waitForURL(u => !/\/login/i.test(String(u)), { timeout: 30000 }).catch(() => {});
  if (/\/login/i.test(page.url())) {
    const texto = await page.locator('body').innerText().catch(() => '');
    const linea = lineasDe(texto).find(l => /incorrect|inválid|invalid|error|no coincid|bloquead/i.test(l));
    throw new Error(linea || 'decreditos no aceptó el correo o la contraseña');
  }
}

async function irAlSimuladorDecreditos(page) {
  paso(B.decreditos, 'abriendo decreditos');
  await page.goto(URL_DECREDITOS + '/simulacion/grid', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await entrarDecreditos(page);
  if (!(await esperar(dec.modelo(page), 4000))) {
    paso(B.decreditos, 'abriendo el simulador');
    await page.goto(URL_DECREDITOS + '/simulacion/grid', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await entrarDecreditos(page); // por si la sesión pidió login de nuevo
  }
  paso(B.decreditos, 'esperando el simulador');
  await dec.modelo(page).waitFor({ state: 'visible', timeout: 40000 });
}

async function loginDecreditos(quien) {
  const b = B.decreditos;
  const mio = ++b.intento;
  try {
    setSesion(b, 'iniciando', 'Entrando a decreditos...', quien);
    // Se presenta como un Chrome común (algunos portales no cargan con navegadores automáticos)
    const opciones = {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      ...(fs.existsSync(ESTADO_DECREDITOS) ? { storageState: ESTADO_DECREDITOS } : {}),
    };
    const ctx = await abrirNavegador(b, opciones);
    const page = await ctx.newPage();
    b.page = page;
    await irAlSimuladorDecreditos(page);
    if (mio !== b.intento) return;
    await ctx.storageState({ path: ESTADO_DECREDITOS }).catch(() => {});
    b.app = page;
    b.ultimaActividad = Date.now();
    setSesion(b, 'conectado', 'Sesión activa en decreditos', quien);
  } catch (err) {
    if (mio !== b.intento) return;
    // Guardar cómo quedó la pantalla para poder ver qué pasó
    let captura = '';
    if (b.page && !b.page.isClosed()) {
      const nombre = `decreditos_login_${fechaArchivo()}.png`;
      const ok = await b.page.screenshot({ path: path.join(CARPETA_RESULTADOS, nombre) }).then(() => true).catch(() => false);
      if (ok) { captura = `/resultados/${nombre}`; guardarCapturaDB(nombre); }
      console.log(`[decreditos] login trabado en "${b.paso}" — página: ${b.page.url()}`);
    }
    // Si la sesión guardada quedó vieja, borrarla para el próximo intento
    try { fs.unlinkSync(ESTADO_DECREDITOS); } catch {}
    setSesion(b, 'error', `No se pudo iniciar sesión (paso: ${b.paso || '-'}): ${err.message.split('\n')[0]}`, '');
    b.sesion.captura = captura;
  }
}

// Lee las tarjetas de "Te ofrecemos": monto, plazo y etiquetas (Requiere análisis, etc.)
function leerOfertasDecreditos(texto) {
  const lineas = lineasDe(texto);
  const i = lineas.findIndex(l => /te ofrecemos/i.test(l));
  if (i < 0) return [];
  const ofertas = [];
  let etiquetas = [];
  for (let j = i + 1; j < Math.min(lineas.length, i + 40); j++) {
    const l = lineas[j];
    const m = l.match(RE_MONTO);
    if (m && l.replace(m[0], '').replace(/[$\s]/g, '').length < 3) {
      const plazo = (lineas[j + 1] || '').match(/en\s+(\d+)\s+meses/i);
      const extra = [];
      for (let k = j + 1; k < Math.min(lineas.length, j + 4); k++) {
        if (RE_MONTO.test(lineas[k])) break;
        if (/an[aá]lisis|analista|aprobad|revisar/i.test(lineas[k])) extra.push(lineas[k]);
      }
      const tipo = [...etiquetas, ...extra].filter((x, n, a) => a.indexOf(x) === n);
      ofertas.push({
        producto: plazo ? `en ${plazo[1]} meses` : '',
        tipo: tipo.join(' · '),
        monto: normalizarMonto(m[0]),
      });
      etiquetas = [];
    } else if (/an[aá]lisis|analista|pre-?aprobad|aprobad/i.test(l) && l.length < 40) {
      etiquetas.push(l.replace(/^[^\wáéíóúÁÉÍÓÚ]+/, ''));
    }
  }
  return ofertas.slice(0, 6);
}

async function consultarDecreditos(cuit, vendedor) {
  const b = B.decreditos;
  // Sin captcha ni código: si la sesión no está, se inicia sola
  if (!b.app || b.app.isClosed() || b.sesion.estado !== 'conectado') {
    await loginDecreditos(vendedor);
    if (b.sesion.estado !== 'conectado') throw new Error('SIN_SESION');
  }
  const page = b.app;
  b.ocupado = true;
  try {
    const nombre = `decreditos_${cuit}_${fechaArchivo()}`;
    const rutaPng = path.join(CARPETA_RESULTADOS, `${nombre}.png`);
    const resultado = datos => {
      escribirTxt(nombre, `Banco: decreditos\nCUIT: ${cuit}\nVendedor: ${vendedor}\nEstado: ${datos.estado}\n` +
        `Ofertas: ${(datos.ofertas || []).map(o => `${o.monto} ${o.producto} ${o.tipo}`).join(' / ') || '-'}\nMensaje: ${datos.resumen || '-'}\nNota: ${datos.nota || '-'}\n\n${datos.texto || ''}`);
      delete datos.texto;
      return guardarConsulta(b, { cuit, vendedor, captura: `/resultados/${nombre}.png`, monto: '', ofertas: [], cliente: '', ...datos });
    };

    if (cuit.startsWith('3')) {
      return guardarConsulta(b, {
        cuit, estado: 'REVISAR', vendedor, cliente: '', monto: '', ofertas: [], captura: '',
        resumen: 'Es una empresa (CUIT 30/33/34): decreditos consulta personas por DNI. Consultalo en el portal.',
      });
    }
    const dni = cuit.slice(2, 10).replace(/^0+/, '');
    const cfg = CFG.decreditos;

    paso(b, 'abriendo el simulador');
    await irAlSimuladorDecreditos(page);

    paso(b, `eligiendo el año ${cfg.anio}`);
    await page.locator('.modelForm_input > div > svg').first().click({ timeout: 8000 });
    await page.getByText(new RegExp(`^${escRegex(cfg.anio)}$`)).first().click({ timeout: 8000 });

    paso(b, `eligiendo el modelo ${cfg.modelo}`);
    const modelo = dec.modelo(page);
    await modelo.click();
    await modelo.fill('');
    await modelo.pressSequentially(cfg.modelo, { delay: 40, timeout: 8000 });
    const buscado = new RegExp(escRegex(cfg.modeloItem || cfg.modelo), 'i');
    const item = page.getByRole('listitem').filter({ hasText: buscado }).first();
    await item.waitFor({ state: 'visible', timeout: 15000 });
    await item.click();

    paso(b, 'cargando el monto');
    const monto = page.locator('[id="123"]').first();
    await escribirNumero(page, monto, cfg.monto);

    paso(b, 'eligiendo el uso');
    await page.getByRole('textbox', { name: /seleccione el uso/i }).first().click({ timeout: 8000 });
    await page.getByText(/^particular$/i).first().click({ timeout: 8000 });

    paso(b, 'calculando cuotas');
    await tocarBoton(page, /calcular cuotas/i);

    paso(b, `eligiendo ${cfg.plazo} cuotas ${cfg.tipo}`);
    await page.getByRole('cell', { name: String(cfg.plazo), exact: true }).first().click({ timeout: 15000 });
    await page.getByRole('button', { name: /selecciona una opci[oó]n/i }).first().click({ timeout: 8000 });
    await page.getByRole('button', { name: new RegExp(`^${escRegex(cfg.tipo)}$`, 'i') }).first().click({ timeout: 8000 });
    await tocarBoton(page, /confirmar plazo/i);

    paso(b, 'buscando el DNI');
    const dniCampo = dec.dni(page);
    await dniCampo.waitFor({ state: 'visible', timeout: 15000 });
    await dniCampo.fill(dni);
    await page.getByRole('button', { name: /^buscar$/i }).first().click({ timeout: 8000 });

    // Se completa solo; si hay más de una persona con ese DNI, se elige la que coincide con el CUIT (o la primera)
    paso(b, 'esperando los datos del cliente');
    await page.waitForTimeout(1500);
    if (await esperar(dec.rechazo(page), 1500)) {
      await page.screenshot({ path: rutaPng }).catch(() => {});
      const t = await page.locator('body').innerText().catch(() => '');
      return resultado({ estado: 'DENEGADO', resumen: lineasDe(t).find(l => /rechaz|no (es posible|podemos)/i.test(l)) || 'Propuesta rechazada', texto: t });
    }
    const personas = page.locator('label').filter({ has: page.locator('input[type="radio"]') });
    if ((await personas.count().catch(() => 0)) > 0) {
      const conCuit = personas.filter({ hasText: new RegExp(`${cuit.slice(0, 2)}\\D?${cuit.slice(2, 10)}\\D?${cuit.slice(10)}`) }).first();
      const elegida = (await conCuit.count().catch(() => 0)) ? conCuit : personas.first();
      await elegida.click({ timeout: 5000 }).catch(() => {});
    }
    // Listas que hayan quedado vacías: se elige la primera opción válida
    const selects = page.locator('select');
    const nSel = await selects.count().catch(() => 0);
    for (let k = 0; k < nSel; k++) {
      const sel = selects.nth(k);
      if (!(await sel.isVisible().catch(() => false))) continue;
      if ((await sel.inputValue().catch(() => '')) !== '') continue;
      const valor = await sel.evaluate(s => [...s.options].find(o => o.value && !o.disabled)?.value || '').catch(() => '');
      if (valor) await sel.selectOption(valor).catch(() => {});
    }

    const cliente = [
      await page.getByRole('textbox', { name: /^nombre$/i }).first().inputValue().catch(() => ''),
      await page.getByRole('textbox', { name: /^apellido$/i }).first().inputValue().catch(() => ''),
    ].filter(Boolean).join(' ').trim();

    // Solicitud en curso: NO se desiste (podría ser la operación de otro vendedor)
    if (await esperar(dec.desistir(page), 1500)) {
      await page.screenshot({ path: rutaPng }).catch(() => {});
      return resultado({
        estado: 'REVISAR', cliente,
        resumen: 'Tiene una solicitud en curso en decreditos. Revisala en el portal (la app no la cancela).',
        texto: await page.locator('body').innerText().catch(() => ''),
      });
    }

    const continuar = page.getByRole('button', { name: /^continuar$/i }).first();
    if (await esperar(continuar, 800)) await continuar.click({ timeout: 8000 }).catch(() => {});

    paso(b, 'pidiendo la resolución');
    await tocarBoton(page, /obtener resoluci[oó]n/i);

    paso(b, 'esperando la resolución');
    await dec.rechazo(page).or(dec.preaprobada(page)).or(dec.ofrecemos(page)).or(dec.desistir(page))
      .waitFor({ state: 'visible', timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(1200);
    const texto = await page.locator('body').innerText().catch(() => '');
    await page.screenshot({ path: rutaPng, fullPage: true }).catch(() => {});

    if (await esperar(dec.desistir(page), 300)) {
      return resultado({ estado: 'REVISAR', cliente, resumen: 'Tiene una solicitud en curso en decreditos. Revisala en el portal (la app no la cancela).', texto });
    }
    if (await esperar(dec.rechazo(page), 300)) {
      return resultado({ estado: 'DENEGADO', cliente, resumen: lineasDe(texto).find(l => /rechaz|no (es posible|podemos)/i.test(l)) || 'Propuesta rechazada', texto });
    }
    const ofertas = leerOfertasDecreditos(texto);
    const pedidoM = texto.match(/solicitaste\s+([\s\S]*?)\.?\s*te ofrecemos/i);
    const pedido = pedidoM ? `Pedido: ${pedidoM[1].replace(/\s+/g, ' ').trim()}.` : '';
    const nombreTexto = (texto.match(/^\s*([A-ZÁÉÍÓÚÑ][\wáéíóúñ]+(?: [A-ZÁÉÍÓÚÑ][\wáéíóúñ]+)*),\s*solicitaste/m) || [])[1] || '';
    if (ofertas.length) {
      const valor = m => Number(m.split(',')[0].replace(/\./g, '')) || 0;
      const mayor = [...ofertas].sort((a, c) => valor(c.monto) - valor(a.monto))[0];
      return resultado({ estado: 'APROBADO', cliente: cliente || nombreTexto, monto: mayor.monto, ofertas, nota: pedido, texto });
    }
    if (await esperar(dec.preaprobada(page), 300)) {
      return resultado({
        estado: 'PREAPROBADO', cliente: cliente || nombreTexto,
        nota: 'Operación pre-aprobada: para seguir hay que cargar mail y celular del cliente en el portal.',
        texto,
      });
    }
    return resultado({ estado: 'REVISAR', cliente, resumen: lineasDe(texto).slice(-4).join(' · ').slice(0, 300), texto });
  } finally {
    b.ocupado = false;
    b.ultimaActividad = Date.now();
  }
}

// Interpreta lo que devuelve la extensión de Chrome (texto de la pantalla de decreditos)
function interpretarDecreditos({ texto = '', desistir = false, cliente = '' }) {
  const lineas = lineasDe(texto);
  if (desistir) {
    return { estado: 'REVISAR', cliente, resumen: 'Tiene una solicitud en curso en decreditos. Revisala en el portal (la app no la cancela).' };
  }
  const rechazo = lineas.find(l => /propuesta rechazada|rechazad|no (es posible|podemos) (otorgar|ofrecer)/i.test(l));
  if (rechazo) return { estado: 'DENEGADO', cliente, resumen: rechazo };

  const ofertas = leerOfertasDecreditos(texto);
  const pedidoM = texto.match(/solicitaste\s+([\s\S]*?)\.?\s*te ofrecemos/i);
  const pedido = pedidoM ? `Pedido: ${pedidoM[1].replace(/\s+/g, ' ').trim()}.` : '';
  const nombreTexto = (texto.match(/^\s*([A-ZÁÉÍÓÚÑ][\wáéíóúñ]+(?: [A-ZÁÉÍÓÚÑ][\wáéíóúñ]+)*),\s*solicitaste/m) || [])[1] || '';
  if (ofertas.length) {
    const valor = m => Number(m.split(',')[0].replace(/\./g, '')) || 0;
    const mayor = [...ofertas].sort((a, c) => valor(c.monto) - valor(a.monto))[0];
    return { estado: 'APROBADO', cliente: cliente || nombreTexto, monto: mayor.monto, ofertas, nota: pedido };
  }
  if (/operaci[oó]n pre-?\s?aprobada/i.test(texto)) {
    return { estado: 'PREAPROBADO', cliente: cliente || nombreTexto, nota: 'Operación pre-aprobada: para seguir hay que cargar mail y celular del cliente en el portal.' };
  }
  return { estado: 'REVISAR', cliente, resumen: lineas.slice(-4).join(' · ').slice(0, 300) };
}

// Mantener la sesión: abrir el simulador (si se venció, vuelve a entrar sola)
async function mantenerDecreditos() {
  const b = B.decreditos;
  try {
    await irAlSimuladorDecreditos(b.app);
    await b.context.storageState({ path: ESTADO_DECREDITOS }).catch(() => {});
  } catch {
    setSesion(b, 'desconectado', 'Se cortó la sesión de decreditos. Se reconecta sola en la próxima consulta.', '');
  }
}

// =====================================================================
//  AYUDANTE DE DECREDITOS (PC de la oficina)
// =====================================================================
// decreditos bloquea las conexiones desde Railway (403). Por eso las consultas de decreditos
// las hace un "ayudante" en una PC de la concesionaria:
//   - En Railway: AGENTE_CLAVE=<clave larga>  → decreditos se consulta a través del ayudante.
//   - En la PC:   MODO=agente-decreditos, SERVIDOR_URL=<link de la app>, AGENTE_CLAVE=<la misma>,
//                 DECREDITOS_USUARIO y DECREDITOS_CLAVE.
// La PC le pregunta a Railway cada pocos segundos si hay trabajo (no hace falta abrir puertos).
const agente = {
  ultimoContacto: 0,
  sesion: null,
  cola: [],
  esperando: null,          // pedido del ayudante que está esperando trabajo
  pendientes: new Map(),    // id → { resolve, reject, timer }
  siguienteId: 1,
};
const agenteVivo = () => Date.now() - agente.ultimoContacto < 45000;

function entregarTrabajo() {
  if (!agente.esperando || !agente.cola.length) return;
  const { res, timer } = agente.esperando;
  agente.esperando = null;
  clearTimeout(timer);
  json(res, 200, agente.cola.shift());
}

function encolarAgente(trabajo, maxMs = 4 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const id = String(agente.siguienteId++);
    const timer = setTimeout(() => {
      agente.pendientes.delete(id);
      agente.cola = agente.cola.filter(t => t.id !== id);
      reject(new Error('El ayudante de la PC de la oficina no respondió a tiempo'));
    }, maxMs);
    agente.pendientes.set(id, { resolve, reject, timer });
    agente.cola.push({ id, ...trabajo });
    entregarTrabajo();
  });
}

// Estado de decreditos que ve la app (viene del ayudante)
function sesionDecreditosRemota() {
  if (!agenteVivo()) {
    return { estado: 'desconectado', mensaje: 'La PC de la oficina (ayudante de decreditos) está apagada o sin conexión.', por: '' };
  }
  const s = agente.sesion || { estado: 'desconectado', mensaje: '' };
  return { ...s, mensaje: s.estado === 'conectado' ? 'Sesión activa (desde la PC de la oficina)' : `${s.mensaje || ''} (PC de la oficina)`.trim() };
}

async function loginDecreditosRemoto(quien) {
  if (!agenteVivo()) return;
  encolarAgente({ tipo: 'login', quien }, 2 * 60 * 1000).catch(() => {});
}

async function consultarDecreditosRemoto(cuit, vendedor) {
  const b = B.decreditos;
  if (!agenteVivo()) throw new Error('La PC de la oficina (ayudante de decreditos) está apagada o sin conexión');
  b.paso = 'enviando la consulta a la PC de la oficina';
  const r = await encolarAgente({ tipo: 'consultar', cuit, vendedor });
  if (!r.ok) {
    b.paso = r.paso || '';
    const err = new Error(r.error || 'Error en el ayudante');
    err.captura = r.captura || '';
    throw err;
  }
  const { banco, bancoNombre, fecha, ...datos } = r.resultado;
  return guardarConsulta(b, datos);
}

// Guarda la captura que manda el ayudante
function guardarCapturaRecibida(c) {
  if (!c?.nombre || !c?.base64) return '';
  const nombre = path.basename(c.nombre);
  try {
    fs.writeFileSync(path.join(CARPETA_RESULTADOS, nombre), Buffer.from(c.base64, 'base64'));
    guardarCapturaDB(nombre);
    return `/resultados/${nombre}`;
  } catch { return ''; }
}

// Rutas del ayudante (protegidas con AGENTE_CLAVE)
async function rutasAgente(req, res, url) {
  if (!url.pathname.startsWith('/api/agente/')) return false;
  if (!DECREDITOS_REMOTO || req.headers['x-agente'] !== AGENTE_CLAVE) { json(res, 401, { error: 'Clave del ayudante incorrecta' }); return true; }

  if (req.method === 'POST' && url.pathname === '/api/agente/trabajo') {
    const body = await leerBody(req, 20000);
    agente.ultimoContacto = Date.now();
    if (body.sesion) agente.sesion = body.sesion;
    if (agente.esperando) { clearTimeout(agente.esperando.timer); json(agente.esperando.res, 200, {}); }
    const timer = setTimeout(() => { if (agente.esperando?.res === res) { agente.esperando = null; json(res, 200, {}); } }, 25000);
    agente.esperando = { res, timer };
    req.on('close', () => { if (agente.esperando?.res === res) { clearTimeout(timer); agente.esperando = null; } });
    entregarTrabajo();
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/agente/estado') {
    const body = await leerBody(req, 20000);
    agente.ultimoContacto = Date.now();
    if (body.sesion) agente.sesion = body.sesion;
    json(res, 200, { ok: true });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/agente/resultado') {
    const body = await leerBody(req, 15 * 1024 * 1024);
    agente.ultimoContacto = Date.now();
    const p = agente.pendientes.get(String(body.id));
    if (p) {
      clearTimeout(p.timer);
      agente.pendientes.delete(String(body.id));
      const captura = guardarCapturaRecibida(body.captura);
      if (body.resultado && captura) body.resultado.captura = captura;
      p.resolve({ ...body, captura });
    }
    json(res, 200, { ok: true });
    return true;
  }
  json(res, 404, { error: 'No encontrado' });
  return true;
}

// El ayudante le avisa a la app apenas cambia el estado de la sesión
function avisarEstadoAgente() {
  const SERVIDOR = (process.env.SERVIDOR_URL || '').trim().replace(/\/$/, '');
  if (!SERVIDOR || !AGENTE_CLAVE) return;
  fetch(`${SERVIDOR}/api/agente/estado`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-agente': AGENTE_CLAVE },
    body: JSON.stringify({ sesion: { ...B.decreditos.sesion, captura: '' } }),
  }).catch(() => {});
}

// ---------- Lo que corre en la PC de la oficina ----------
async function correrAgente() {
  const SERVIDOR = (process.env.SERVIDOR_URL || '').trim().replace(/\/$/, '');
  if (!SERVIDOR || !AGENTE_CLAVE || !CFG.decreditos.usuario || !CFG.decreditos.clave) {
    console.error('Faltan datos en el .env: SERVIDOR_URL, AGENTE_CLAVE, DECREDITOS_USUARIO y DECREDITOS_CLAVE.');
    process.exit(1);
  }
  console.log('\n=========================================');
  console.log('  Ayudante de decreditos - encendido');
  console.log('=========================================');
  console.log(`  Conectado a: ${SERVIDOR}`);
  console.log('  No cierres esta ventana: mientras esté abierta, la app puede consultar decreditos.\n');

  const cab = { 'Content-Type': 'application/json', 'x-agente': AGENTE_CLAVE };
  const enviar = datos => fetch(`${SERVIDOR}/api/agente/resultado`, { method: 'POST', headers: cab, body: JSON.stringify(datos) })
    .catch(err => console.log('[Ayudante] no se pudo enviar el resultado:', err.message));
  const leerCaptura = ruta => {
    if (!ruta) return null;
    const nombre = path.basename(ruta);
    try { return { nombre, base64: fs.readFileSync(path.join(CARPETA_RESULTADOS, nombre)).toString('base64') }; } catch { return null; }
  };
  const dormir = ms => new Promise(r => setTimeout(r, ms));

  await loginDecreditos('PC de la oficina');
  let avisado = false;

  for (;;) {
    let t;
    try {
      const r = await fetch(`${SERVIDOR}/api/agente/trabajo`, {
        method: 'POST', headers: cab,
        body: JSON.stringify({ sesion: { ...B.decreditos.sesion, captura: '' } }),
        signal: AbortSignal.timeout(35000),
      });
      if (r.status === 401) { console.log('[Ayudante] La clave AGENTE_CLAVE no coincide con la de Railway. Reintento en 1 minuto.'); await dormir(60000); continue; }
      t = await r.json();
      if (avisado) { console.log('[Ayudante] conexión con la app recuperada'); avisado = false; }
    } catch (err) {
      if (!avisado) { console.log('[Ayudante] sin conexión con la app, reintento…', err.message); avisado = true; }
      await dormir(5000);
      continue;
    }
    if (!t?.id) continue;

    if (t.tipo === 'login') {
      await loginDecreditos(t.quien || 'PC de la oficina');
      enviar({ id: t.id, ok: B.decreditos.sesion.estado === 'conectado' });
      continue;
    }
    if (t.tipo === 'consultar') {
      console.log(`[Ayudante] consultando ${t.cuit} (${t.vendedor})`);
      try {
        const resultado = await encolar(B.decreditos, () => consultarDecreditos(t.cuit, t.vendedor));
        enviar({ id: t.id, ok: true, resultado, captura: leerCaptura(resultado.captura) });
      } catch (err) {
        let captura = null;
        const pagina = B.decreditos.app || B.decreditos.page;
        if (pagina && !pagina.isClosed()) {
          const nombre = `decreditos_error_${t.cuit}_${fechaArchivo()}.png`;
          if (await pagina.screenshot({ path: path.join(CARPETA_RESULTADOS, nombre) }).then(() => true).catch(() => false)) captura = leerCaptura(nombre);
        }
        const mensaje = err.message === 'SIN_SESION' ? `No se pudo entrar a decreditos: ${B.decreditos.sesion.mensaje}` : err.message.split('\n')[0];
        console.log(`[Ayudante] error (paso: ${B.decreditos.paso}): ${mensaje}`);
        enviar({ id: t.id, ok: false, error: mensaje, paso: B.decreditos.paso, captura });
      }
    }
  }
}

// =====================================================================
//  SANTANDER (prendarios / autos)
// =====================================================================
const SANTANDER_DENEGADO = ['rechaz', 'no califica', 'no calificad', 'no aprobad', 'no es posible', 'no cumple', 'no tiene oferta',
  'sin oferta', 'ninguna oferta', 'no se encontr', 'deneg', 'no apto', 'no podemos', 'no puede acceder', 'no corresponde'];
const santander = {
  email: p => p.getByRole('textbox', { name: /email|correo|usuario/i }).or(p.locator('input[type=email], input[name*="mail" i], input[id*="mail" i], input[placeholder*="mail" i]')),
  clave: p => p.locator('input[type=password]'),
  codigo: p => p.getByRole('textbox', { name: /ingrese el c[oó]digo/i }),
  dni: p => p.getByRole('textbox', { name: 'Ingrese DNI' }),
  continuar: p => p.getByRole('button', { name: /^continuar/i }),
  inicio: p => p.getByRole('link', { name: 'Santander' }),
  // Ya adentro del portal: se ve el campo DNI o el botón Continuar de la identificación
  adentro: p => p.getByRole('textbox', { name: 'Ingrese DNI' }).or(p.getByRole('button', { name: /^continuar/i })),
};

async function loginSantander(quien) {
  const b = B.santander;
  const mio = ++b.intento;
  try {
    setSesion(b, 'iniciando', 'Abriendo Santander...', quien);
    // Se presenta como un Chrome común (algunos portales no cargan con navegadores automáticos)
    const opciones = {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      ...(fs.existsSync(ESTADO_SANTANDER) ? { storageState: ESTADO_SANTANDER } : {}),
    };
    const ctx = await abrirNavegador(b, opciones);
    const page = await ctx.newPage();
    b.page = page;

    // ¿Quedó la sesión guardada de la vez anterior?
    paso(b, 'abriendo el portal de autos');
    await page.goto(URL_SANTANDER_PORTAL, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await santander.adentro(page).or(santander.email(page)).first().waitFor({ state: 'visible', timeout: 30000 }).catch(() => {});

    if (!(await esperar(santander.adentro(page), 500))) {
      if (!(await esperar(santander.email(page), 500))) {
        paso(b, 'abriendo la pantalla de ingreso');
        await page.goto(URL_SANTANDER_LOGIN, { waitUntil: 'domcontentloaded', timeout: 45000 });
        if (!(await esperar(santander.email(page), 40000))) {
          const t = await page.locator('body').innerText().catch(() => '');
          throw new Error(/403|forbidden|denied|bloque/i.test(t) ? 'Santander bloqueó la conexión desde el servidor (403)'
            : !t.trim() ? 'la página de Santander quedó en blanco (no cargó)' : 'no apareció el campo Email en Santander');
        }
      }
      paso(b, 'cargando correo y contraseña');
      await santander.email(page).first().fill(CFG.santander.usuario);
      await santander.clave(page).first().fill(CFG.santander.clave);
      await page.getByRole('button', { name: /ingresar/i }).first().click();

      paso(b, 'esperando el pedido de código');
      await santander.codigo(page).or(santander.adentro(page)).first().waitFor({ state: 'visible', timeout: 30000 }).catch(() => {});

      if (await esperar(santander.codigo(page), 500)) {
        if (mio !== b.intento) return;
        setSesion(b, 'esperando_token', 'Santander pide el código de Google Authenticator. Escribilo abajo.', quien);
        await santander.adentro(page).first().waitFor({ state: 'visible', timeout: 15 * 60 * 1000 });
      } else if (!(await esperar(santander.adentro(page), 500))) {
        const texto = await page.locator('body').innerText().catch(() => '');
        const linea = lineasDe(texto).find(l => /incorrect|inválid|invalid|bloquead|error|no coincid/i.test(l));
        throw new Error(linea || 'Santander no aceptó el correo o la contraseña');
      }
    }

    if (mio !== b.intento) return;
    await ctx.storageState({ path: ESTADO_SANTANDER }).catch(() => {});
    b.app = page;
    b.ultimaActividad = Date.now();
    setSesion(b, 'conectado', 'Sesión activa en Santander', quien);
  } catch (err) {
    if (mio !== b.intento) return;
    // Guardar cómo quedó la pantalla para poder ver qué pasó
    let captura = '';
    if (b.page && !b.page.isClosed()) {
      const nombre = `santander_login_${fechaArchivo()}.png`;
      const ok = await b.page.screenshot({ path: path.join(CARPETA_RESULTADOS, nombre) }).then(() => true).catch(() => false);
      if (ok) { captura = `/resultados/${nombre}`; guardarCapturaDB(nombre); }
      console.log(`[Santander] login trabado en "${b.paso}" — página: ${b.page.url()}`);
    }
    try { fs.unlinkSync(ESTADO_SANTANDER); } catch {}
    setSesion(b, 'error', `No se pudo iniciar sesión (paso: ${b.paso || '-'}): ${err.message.split('\n')[0]}`, '');
    b.sesion.captura = captura;
  }
}

async function enviarTokenSantander(codigo) {
  const b = B.santander;
  if (b.sesion.estado !== 'esperando_token' || !b.page || b.page.isClosed()) {
    return { ok: false, error: 'No hay un código pendiente' };
  }
  const page = b.page;
  const campo = santander.codigo(page).first();
  // El campo tiene máscara: se escribe número por número
  await campo.click();
  await campo.press('Control+A').catch(() => {});
  await campo.press('Backspace').catch(() => {});
  await campo.pressSequentially(String(codigo).replace(/\D/g, ''), { delay: 60 });
  await page.getByRole('button', { name: 'Confirmar' }).click();

  // Si el código está bien, la caja desaparece
  const salio = await campo.waitFor({ state: 'hidden', timeout: 20000 }).then(() => true).catch(() => false);
  if (!salio) {
    const texto = await page.locator('body').innerText().catch(() => '');
    const linea = lineasDe(texto).find(l => /incorrect|inválid|invalid|vencid|expir|error|no coincid/i.test(l));
    return { ok: false, error: linea || 'El código no fue aceptado. Escribí el que muestra ahora Google Authenticator.' };
  }
  // Ir al portal de autos
  if (!(await esperar(santander.adentro(page), 5000))) {
    await page.goto(URL_SANTANDER_PORTAL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  }
  if (await esperar(santander.adentro(page), 30000)) return { ok: true };
  return { ok: false, error: 'Se aceptó el código pero no abrió el portal de autos. Tocá "Empezar de nuevo".' };
}

async function reenviarTokenSantander() {
  return { ok: false, error: 'Santander usa Google Authenticator: abrí la app y escribí el código que muestra ahora (cambia cada 30 segundos).' };
}

// Lleva a la pantalla donde se carga el DNI
async function irAIdentificacionSantander(b) {
  const page = b.app;
  if (!(await esperar(santander.dni(page), 1500))) {
    if (await esperar(santander.inicio(page), 1000)) await santander.inicio(page).first().click().catch(() => {});
    else await page.goto(URL_SANTANDER_PORTAL, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await santander.adentro(page).or(santander.email(page)).first().waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});
  }
  // Cartel "IMPORTANTE" con Continuar (tapa el formulario)
  if (await esperar(santander.continuar(page), 5000)) { await santander.continuar(page).first().click().catch(() => {}); await page.waitForTimeout(900); }
  if (!(await esperar(santander.dni(page), 15000))) {
    if (await esperar(santander.email(page), 500) || await esperar(santander.codigo(page), 500)) {
      setSesion(b, 'desconectado', 'La sesión de Santander venció. Hay que iniciarla de nuevo.', '');
      throw new Error('SESION_VENCIDA');
    }
    throw new Error('No apareció el campo DNI en Santander');
  }
  if (await esperar(santander.continuar(page), 1200)) { await santander.continuar(page).first().click().catch(() => {}); await page.waitForTimeout(900); }
}

// Escribe en un campo con máscara (número por número)
async function escribirEnCampo(locator, texto) {
  const campo = locator.first();
  await campo.click();
  await campo.press('Control+A').catch(() => {});
  await campo.press('Backspace').catch(() => {});
  await campo.pressSequentially(String(texto), { delay: 30 });
}

// Lista desplegable de Angular (ng-select): abrir, buscar y elegir la opción
async function elegirNgSelect(page, placeholder, buscar, opcion) {
  const caja = page.locator('ng-select').filter({ hasText: placeholder }).first();
  const combo = caja.getByRole('combobox');
  await combo.click();
  if (buscar) await combo.fill(buscar).catch(async () => { await combo.pressSequentially(buscar, { delay: 30 }); });
  const exacta = page.getByRole('option', { name: opcion, exact: true });
  if (await esperar(exacta, 6000)) { await exacta.first().click(); return; }
  const parecida = page.getByRole('option', { name: new RegExp(opcion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') });
  if (await esperar(parecida, 3000)) { await parecida.first().click(); return; }
  throw new Error(`no encontré "${opcion}" en la lista ${placeholder.replace(/^Seleccione /i, '')}`);
}

// Sexo según el CUIT: 20 masculino, 27 femenino; 23 → por el verificador (9 masc., 4 fem.)
function sexoDesdeCuit(cuit) {
  const pre = cuit.slice(0, 2), dv = cuit.slice(-1);
  if (pre === '27') return 'FEMENINO';
  if (pre === '23' && dv === '4') return 'FEMENINO';
  return 'MASCULINO';
}

async function esperarResultadoSantander(page, antes, maxMs = 45000) {
  const t0 = Date.now();
  let ultimo = '', quietoDesde = 0;
  const antesBajo = antes.toLowerCase();
  while (Date.now() - t0 < maxMs) {
    const txt = await page.locator('body').innerText().catch(() => '');
    const bajo = txt.toLowerCase();
    if (SANTANDER_DENEGADO.some(p => bajo.includes(p) && !antesBajo.includes(p))) return txt;
    if (txt && txt !== antes && !/cargando|procesando|aguarde|espere|simulando/i.test(txt)) {
      if (txt === ultimo) { if (Date.now() - quietoDesde > 2500) return txt; }
      else { ultimo = txt; quietoDesde = Date.now(); }
    }
    await page.waitForTimeout(300);
  }
  return page.locator('body').innerText().catch(() => '');
}

function interpretarSantander(texto, antes = '') {
  const lineas = lineasDe(texto);
  const previas = new Set(lineasDe(antes));
  const negativo = lineas.find(l => !previas.has(l) && SANTANDER_DENEGADO.some(p => l.toLowerCase().includes(p))) || '';

  // Montos que acompañan a palabras como "máximo", "financiar", "préstamo", "capital", "aprobado"
  const ofertas = [];
  lineas.forEach((l, i) => {
    if (!/m[aá]ximo|financi|pr[eé]stamo|capital|aprobad|otorg|monto/i.test(l)) return;
    let monto = (l.match(RE_MONTO) || [])[0];
    if (!monto && lineas[i + 1] && !/m[aá]ximo|financi|pr[eé]stamo|capital|monto/i.test(lineas[i + 1])) monto = (lineas[i + 1].match(RE_MONTO) || [])[0];
    if (!monto) return;
    const producto = l.replace(RE_MONTO, '').replace(/[:$]/g, '').trim().slice(0, 80);
    if (!ofertas.some(o => o.monto === normalizarMonto(monto) && o.producto === producto)) {
      ofertas.push({ producto, tipo: '', monto: normalizarMonto(monto) });
    }
  });

  let estado;
  if (negativo) estado = 'DENEGADO';
  else if (/pre-?\s?aprobad/i.test(texto) && !ofertas.length) estado = 'PREAPROBADO';
  else if (ofertas.length) estado = 'APROBADO';
  else estado = 'REVISAR';
  return { estado, negativo, ofertas: ofertas.slice(0, 6) };
}

async function consultarSantander(cuit, vendedor, opciones = {}) {
  const b = B.santander;
  if (!b.app || b.app.isClosed() || b.sesion.estado !== 'conectado') throw new Error('SIN_SESION');
  const page = b.app;
  const cfg = CFG.santander;
  b.ocupado = true;
  try {
    paso(b, 'abriendo la pantalla de identificación');
    await irAIdentificacionSantander(b);

    paso(b, 'cargando el DNI');
    const dni = String(Number(cuit.slice(2, 10)));
    await escribirEnCampo(santander.dni(page), dni);

    paso(b, 'eligiendo el sexo');
    const sexo = /^FEM/i.test(opciones.sexo || '') ? 'FEMENINO' : /^MAS/i.test(opciones.sexo || '') ? 'MASCULINO' : sexoDesdeCuit(cuit);
    const comboSexo = page.locator('app-customer').getByRole('combobox').first();
    await comboSexo.click({ timeout: 8000 });
    const op = page.getByRole('option', { name: sexo, exact: true });
    if (!(await esperar(op, 5000))) { await page.keyboard.press('Escape').catch(() => {}); throw new Error(`no encontré la opción ${sexo} en la lista de sexo`); }
    await op.first().click();

    paso(b, 'cargando los ingresos');
    const ingresos = String(opciones.ingresos || '').replace(/\D/g, '') || cfg.ingresos;
    await escribirEnCampo(page.getByRole('textbox', { name: 'Ingresos mensuales' }), ingresos);


    paso(b, `eligiendo la marca ${cfg.marca}`);
    await elegirNgSelect(page, 'Seleccione Marca', cfg.marca.slice(0, 4).toLowerCase(), cfg.marca);
    paso(b, `eligiendo el modelo ${cfg.modelo}`);
    await elegirNgSelect(page, 'Seleccione Modelo', cfg.modelo.split(/\s+/)[0].slice(0, 4).toLowerCase(), cfg.modelo);
    paso(b, `eligiendo el año ${cfg.anio}`);
    await elegirNgSelect(page, 'Seleccione Año', '', cfg.anio);

    paso(b, 'simulando');
    const antes = await page.locator('body').innerText().catch(() => '');
    await page.getByRole('button', { name: /simular/i }).first().click();
    paso(b, 'esperando el resultado');
    const texto = await esperarResultadoSantander(page, antes);

    const { estado, negativo, ofertas } = interpretarSantander(texto, antes);
    const cliente = nombreClienteNacion(texto);

    const nombre = `santander_${cuit}_${fechaArchivo()}`;
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    await page.screenshot({ path: path.join(CARPETA_RESULTADOS, `${nombre}.png`), fullPage: true }).catch(() => {});
    escribirTxt(nombre, `Banco: Santander\nCUIT: ${cuit}\nDNI: ${dni} (${sexo})\nCliente: ${cliente}\nVendedor: ${vendedor}\nEstado: ${estado}\n` +
      `Ingresos: ${ingresos}\nAuto: ${cfg.marca} ${cfg.modelo} ${cfg.anio}\n` +
      `Ofertas: ${ofertas.map(o => `${o.producto} | ${o.monto}`).join(' / ') || '-'}\nMensaje: ${negativo || '-'}\n\n${texto}`);

    const valor = m => Number(m.split(',')[0].replace(/\./g, '')) || 0;
    const mayor = [...ofertas].sort((a, b2) => valor(b2.monto) - valor(a.monto))[0];

    return guardarConsulta(b, {
      cuit, estado, vendedor, cliente,
      monto: mayor?.monto || '',
      ofertas,
      resumen: negativo || (estado === 'REVISAR' ? lineasDe(texto).slice(-4).join(' · ').slice(0, 300) : ''),
      nota: `Simulado con ingresos $ ${Number(ingresos).toLocaleString('es-AR')} · ${cfg.marca} ${cfg.modelo} ${cfg.anio}`,
      captura: `/resultados/${nombre}.png`,
    });
  } finally {
    b.ocupado = false;
    b.ultimaActividad = Date.now();
  }
}

async function mantenerSantander() {
  const b = B.santander;
  const page = b.app;
  if (await esperar(santander.inicio(page), 1500)) await santander.inicio(page).first().click().catch(() => {});
  else await page.goto(URL_SANTANDER_PORTAL, { waitUntil: 'domcontentloaded' });
  if (await esperar(santander.adentro(page), 15000)) {
    await b.context.storageState({ path: ESTADO_SANTANDER }).catch(() => {});
  } else {
    setSesion(b, 'desconectado', 'La sesión de Santander venció. Hay que iniciarla de nuevo.', '');
  }
}

// =====================================================================
//  ROBOT: consultas automáticas que manda Kommo (webhook)
// =====================================================================
// Kommo manda el CUIT a /api/robot/consultar (con ROBOT_CLAVE). El servidor lo pone en una fila y
// una PC de la oficina con la app abierta en modo robot (…/?robot=1) y la extensión de Chrome lo consulta
// sola. El resultado queda en el historial, se agrega como nota al lead de Kommo (KOMMO_SUBDOMINIO +
// KOMMO_TOKEN) y, si el webhook mandó "callback", se avisa a esa dirección.
const ROBOT_CLAVE = (process.env.ROBOT_CLAVE || '').trim();
const ROBOT_BANCOS_DEF = (process.env.ROBOT_BANCOS || 'galicia,santander,decreditos').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
const KOMMO = { sub: (process.env.KOMMO_SUBDOMINIO || '').trim(), token: (process.env.KOMMO_TOKEN || '').trim() };
const robot = { cola: [], trabajos: new Map(), esperando: null, ultimoContacto: 0, siguiente: 1, actual: null, usadosMail: new Set(), hechos: 0 };
// Conectado: habló hace menos de 1 minuto, o está en medio de una consulta (puede tardar varios minutos)
const robotVivo = () => Date.now() - robot.ultimoContacto < 60000
  || (!!robot.actual && Date.now() - new Date(robot.actual.inicio || 0).getTime() < 10 * 60000);

// El cuerpo del webhook puede venir como JSON o como formulario (Kommo usa formularios: leads[add][0][id]=…)
function leerCuerpo(req, max = 200000) {
  return new Promise(resolve => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > max) req.destroy(); });
    req.on('end', () => {
      const t = data.trim();
      if (!t) return resolve({});
      try { return resolve(JSON.parse(t)); } catch {}
      try { return resolve(Object.fromEntries(new URLSearchParams(t))); } catch {}
      resolve({ texto: t });
    });
  });
}
// Todas las parejas campo → valor (también dentro de objetos y listas)
function aplanar(obj, pre = '', out = []) {
  if (obj && typeof obj === 'object') { for (const [k, v] of Object.entries(obj)) aplanar(v, pre ? `${pre}[${k}]` : k, out); }
  else if (obj !== undefined && obj !== null) out.push([pre, String(obj)]);
  return out;
}
function buscarCuitEn(cuerpo, url) {
  const pares = [...aplanar(cuerpo), ...url.searchParams.entries()];
  const once = v => { const d = String(v).replace(/\D/g, ''); return d.length === 11 ? d : ''; };
  // Primero los campos que se llaman CUIT/CUIL; después cualquier valor con 11 números
  for (const [k, v] of pares) if (/cuit|cuil/i.test(k) && once(v)) return once(v);
  for (const [k, v] of pares) if (/cuit|cuil/i.test(v)) { const m = v.match(/\d{2}-?\d{8}-?\d/); if (m && once(m[0])) return once(m[0]); }
  for (const [, v] of pares) if (once(v) && /^\s*\d{2}-?\d{8}-?\d\s*$/.test(v)) return once(v);
  return '';
}
function buscarLeadEn(cuerpo, url) {
  const pares = [...aplanar(cuerpo), ...url.searchParams.entries()];
  for (const [k, v] of pares) if (/^(lead_?id|leadid|id_lead)$/i.test(k) && /^\d+$/.test(v)) return v;
  for (const [k, v] of pares) if (/^leads\[\w+\]\[\d+\]\[id\]$/i.test(k) && /^\d+$/.test(v)) return v;
  return '';
}

function entregarRobot() {
  if (!robot.esperando || !robot.cola.length) return;
  const { res, timer } = robot.esperando;
  robot.esperando = null;
  clearTimeout(timer);
  const t = robot.cola.shift();
  t.estado = 'en_curso'; t.inicio = new Date().toISOString();
  robot.actual = t;
  json(res, 200, { id: t.id, cuit: t.cuit, bancos: t.bancos });
}

function encolarRobot({ cuit, bancos, lead, callback, origen }) {
  // El mismo CUIT ya en la fila: se usa ese pedido (sumando los bancos que falten)
  const ya = robot.cola.find(x => x.cuit === cuit);
  if (ya) {
    ya.bancos = [...new Set([...ya.bancos, ...bancos])];
    if (lead && !ya.lead) ya.lead = lead;
    if (callback && !ya.callback) ya.callback = callback;
    return ya;
  }
  const t = { id: String(robot.siguiente++), cuit, bancos, lead, callback, origen, estado: 'en_cola', creado: new Date().toISOString(), resultados: [] };
  robot.trabajos.set(t.id, t);
  if (robot.trabajos.size > 500) robot.trabajos.delete(robot.trabajos.keys().next().value);
  robot.cola.push(t);
  console.log(`[Robot] CUIT ${cuit} en la fila (${origen || 'webhook'}${lead ? ', lead ' + lead : ''})`);
  entregarRobot();
  return t;
}

function resumenRobot(t) {
  const linea = r => {
    const b = B[r.banco]?.nombre || r.banco;
    const monto = r.monto ? ` $ ${r.monto}` : '';
    const det = r.estado === 'ERROR' || r.estado === 'DENEGADO' || r.estado === 'REVISAR' ? (r.resumen ? ` (${String(r.resumen).slice(0, 140)})` : '') : '';
    return `• ${b}: ${r.estado === 'PREAPROBADO' ? 'PRE-APROBADO' : r.estado}${monto}${det}`;
  };
  const cliente = t.resultados.find(r => r.cliente)?.cliente;
  return `Consulta de créditos · CUIT ${t.cuit.slice(0, 2)}-${t.cuit.slice(2, 10)}-${t.cuit.slice(10)}${cliente ? ' · ' + cliente : ''}\n` +
    t.resultados.map(linea).join('\n');
}

async function notaKommo(lead, texto) {
  if (!KOMMO.sub || !KOMMO.token || !lead) return;
  try {
    const r = await fetch(`https://${KOMMO.sub}.kommo.com/api/v4/leads/${encodeURIComponent(lead)}/notes`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KOMMO.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([{ note_type: 'common', params: { text: texto } }]),
      signal: AbortSignal.timeout(15000),
    });
    console.log(`[Robot] nota en Kommo (lead ${lead}): ${r.ok ? 'ok' : 'error ' + r.status}`);
  } catch (err) { console.log(`[Robot] no se pudo escribir en Kommo: ${err.message}`); }
}

async function avisarCallback(t) {
  if (!t.callback || !/^https?:\/\//i.test(t.callback)) return;
  try {
    await fetch(t.callback, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(datosTrabajo(t)), signal: AbortSignal.timeout(15000) });
  } catch (err) { console.log(`[Robot] no se pudo avisar a ${t.callback}: ${err.message}`); }
}

function datosTrabajo(t) {
  return { id: t.id, cuit: t.cuit, lead_id: t.lead || null, estado: t.estado, creado: t.creado, terminado: t.terminado || null,
    resultados: t.resultados, resumen: t.resultados.length ? resumenRobot(t) : '' };
}

const dormirMs = ms => new Promise(r => setTimeout(r, ms));
const clavesIguales = (a, b) => !!a && !!b && a.length === b.length && require('crypto').timingSafeEqual(Buffer.from(a), Buffer.from(b));

// Rutas del robot. Devuelve true si atendió el pedido.
async function rutasRobot(req, res, url) {
  if (!url.pathname.startsWith('/api/robot/')) return false;

  // ----- Webhook de Kommo (o de cualquier otro sistema) -----
  if (req.method === 'POST' && url.pathname === '/api/robot/consultar') {
    if (!ROBOT_CLAVE) { json(res, 503, { error: 'Falta la variable ROBOT_CLAVE en Railway' }); return true; }
    const clave = String(req.headers['x-robot'] || url.searchParams.get('clave') || url.searchParams.get('k') || '');
    if (!clavesIguales(clave, ROBOT_CLAVE)) { json(res, 401, { error: 'Clave del robot incorrecta' }); return true; }
    const cuerpo = await leerCuerpo(req);
    const cuit = buscarCuitEn(cuerpo, url);
    if (cuit.length !== 11) {
      console.log('[Robot] webhook sin CUIT válido:', JSON.stringify(cuerpo).slice(0, 300));
      json(res, 400, { error: 'No encontré un CUIT de 11 números en el pedido' }); return true;
    }
    const pedidos = String(cuerpo.bancos || url.searchParams.get('bancos') || '').toLowerCase().split(/[,\s]+/).filter(id => B[id]);
    const bancos = pedidos.length ? pedidos : ROBOT_BANCOS_DEF.filter(id => B[id]);
    const lead = String(cuerpo.lead_id || url.searchParams.get('lead_id') || buscarLeadEn(cuerpo, url) || '');
    const callback = String(cuerpo.callback || url.searchParams.get('callback') || '');
    const t = encolarRobot({ cuit, bancos, lead, callback, origen: 'webhook' });
    json(res, 200, { ok: true, id: t.id, cuit, bancos, estado: t.estado, robotConectado: robotVivo(),
      aviso: robotVivo() ? '' : 'La PC robot no está conectada: se consulta apenas se conecte.' });
    return true;
  }

  // ----- Consultar el resultado de un pedido -----
  if (req.method === 'GET' && url.pathname === '/api/robot/resultado') {
    const clave = String(req.headers['x-robot'] || url.searchParams.get('clave') || '');
    if (!(ROBOT_CLAVE && clavesIguales(clave, ROBOT_CLAVE)) && !autorizado(req, url)) { json(res, 401, { error: 'Clave incorrecta' }); return true; }
    const t = robot.trabajos.get(String(url.searchParams.get('id') || ''));
    if (!t) { json(res, 404, { error: 'No existe ese pedido' }); return true; }
    json(res, 200, datosTrabajo(t)); return true;
  }

  // ----- Lo que usa la PC robot (con el código de acceso de la app) -----
  if (!autorizado(req, url)) { json(res, 401, { error: 'Código de acceso incorrecto' }); return true; }

  if (req.method === 'POST' && url.pathname === '/api/robot/trabajo') {
    await leerBody(req, 20000);
    robot.ultimoContacto = Date.now();
    if (robot.esperando) { clearTimeout(robot.esperando.timer); json(robot.esperando.res, 200, {}); }
    const timer = setTimeout(() => { if (robot.esperando?.res === res) { robot.esperando = null; json(res, 200, {}); } }, 25000);
    robot.esperando = { res, timer };
    req.on('close', () => { if (robot.esperando?.res === res) { clearTimeout(timer); robot.esperando = null; } });
    entregarRobot();
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/robot/listo') {
    const body = await leerBody(req, 200000);
    robot.ultimoContacto = Date.now();
    const t = robot.trabajos.get(String(body.id || ''));
    if (!t) { json(res, 404, { error: 'No existe ese pedido' }); return true; }
    t.resultados = (Array.isArray(body.resultados) ? body.resultados : []).slice(0, 10).map(r => ({
      banco: String(r.banco || ''), estado: String(r.estado || 'ERROR').toUpperCase(), monto: String(r.monto || ''),
      cliente: String(r.cliente || '').slice(0, 80), resumen: String(r.resumen || '').slice(0, 400), nota: String(r.nota || '').slice(0, 300),
    }));
    t.estado = 'listo'; t.terminado = new Date().toISOString();
    if (robot.actual?.id === t.id) robot.actual = null;
    robot.hechos++;
    console.log(`[Robot] CUIT ${t.cuit} listo: ${t.resultados.map(r => `${r.banco} ${r.estado}`).join(', ')}`);
    json(res, 200, { ok: true });
    const texto = resumenRobot(t);
    notaKommo(t.lead, texto);
    avisarCallback(t);
    return true;
  }

  // Token de Galicia (u otro banco) leído del correo, para que el robot lo escriba solo
  if (req.method === 'GET' && url.pathname === '/api/robot/codigo') {
    const banco = String(url.searchParams.get('banco') || '');
    if (!FILTRO_MAIL[banco]) { json(res, 400, { error: 'Banco sin lectura de correo' }); return true; }
    if (!MAIL_ACTIVO || !ImapFlow) { json(res, 503, { error: 'Falta configurar el correo (MAIL_USUARIO y MAIL_CLAVE_APP)' }); return true; }
    const desde = Number(url.searchParams.get('desde')) || Date.now() - 2 * 60 * 1000;
    const fin = Date.now() + 110000;
    while (Date.now() < fin) {
      const r = await buscarCodigoEnMail(banco, desde, robot.usadosMail).catch(err => ({ error: err.message }));
      if (r?.codigo) { console.log(`[Robot] código de ${banco} leído del correo`); json(res, 200, { codigo: r.codigo }); return true; }
      if (r?.error) { json(res, 502, { error: `No pude leer el correo: ${r.error}` }); return true; }
      await dormirMs(5000);
    }
    json(res, 404, { error: 'No llegó el código al correo' }); return true;
  }

  json(res, 404, { error: 'No encontrado' });
  return true;
}

// =====================================================================
//  Funciones comunes
// =====================================================================
const LOGIN = { bancor: loginBancor, nacion: loginNacion, galicia: GALICIA_EXTENSION ? async () => {} : loginGalicia, santander: SANTANDER_EXTENSION ? async () => {} : loginSantander, decreditos: DECREDITOS_EXTENSION ? async () => {} : DECREDITOS_REMOTO ? loginDecreditosRemoto : loginDecreditos };
const CONSULTA = { bancor: consultarBancor, nacion: consultarNacion, galicia: GALICIA_EXTENSION ? async () => { throw new Error('Galicia se consulta con la extensión de Chrome: instalala en esta computadora'); } : consultarGalicia, santander: SANTANDER_EXTENSION ? async () => { throw new Error('Santander se consulta con la extensión de Chrome: instalala en esta computadora'); } : consultarSantander, decreditos: DECREDITOS_EXTENSION ? async () => { throw new Error('decreditos se consulta con la extensión de Chrome: instalala en esta computadora'); } : DECREDITOS_REMOTO ? consultarDecreditosRemoto : consultarDecreditos };
const MANTENER = { bancor: mantenerBancor, nacion: mantenerNacion, galicia: GALICIA_EXTENSION ? async () => {} : mantenerGalicia, santander: SANTANDER_EXTENSION ? async () => {} : mantenerSantander, decreditos: DECREDITOS_REMOTO ? async () => {} : mantenerDecreditos };
const TOKEN = { nacion: enviarTokenNacion, galicia: enviarTokenGalicia, santander: enviarTokenSantander };
const REENVIAR = { nacion: reenviarTokenNacion, galicia: reenviarTokenGalicia, santander: reenviarTokenSantander };

// Mantener vivas las sesiones: cada 4 minutos sin uso
setInterval(() => {
  for (const b of Object.values(B)) {
    if (b.sesion.estado !== 'conectado' || !b.app || b.app.isClosed() || b.ocupado) continue;
    if (Date.now() - b.ultimaActividad < 4 * 60 * 1000) continue;
    b.ultimaActividad = Date.now();
    encolar(b, async () => { try { await MANTENER[b.id](); } catch {} });
  }
}, 60 * 1000);

// ---------- Seguridad de acceso ----------
function esPcPrincipal(req) {
  const ip = req.socket.remoteAddress || '';
  const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip);
  const viaProxy = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'];
  return local && !viaProxy;
}

function autorizado(req, url) {
  if (esPcPrincipal(req)) return true;
  const clave = req.headers['x-clave'] || url.searchParams.get('k') || '';
  return clave === APP_CLAVE;
}

// ---------- Servidor HTTP ----------
function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function leerBody(req, max = 10000) {
  return new Promise(resolve => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > max) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
  });
}

function sesiones() {
  return Object.fromEntries(Object.values(B).map(b => [b.id, {
    ...(b.id === 'decreditos' && DECREDITOS_REMOTO ? sesionDecreditosRemota() : b.sesion), nombre: b.nombre,
    modo: b.id === 'decreditos' ? (DECREDITOS_EXTENSION ? 'extension' : DECREDITOS_REMOTO ? 'ayudante' : 'directo')
      : b.id === 'santander' ? (SANTANDER_EXTENSION ? 'extension' : 'directo')
      : b.id === 'galicia' ? (GALICIA_EXTENSION ? 'extension' : 'directo') : undefined,
    codigoMail: b.sesion.estado === 'esperando_token' || b.codigoMail?.estado === 'ok' ? (b.codigoMail || null) : null,
    mailActivo: MAIL_ACTIVO && !!ImapFlow,
  }]));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
  }

  if (await rutasAgente(req, res, url)) return;
  if (await rutasRobot(req, res, url)) return;

  if (!autorizado(req, url)) return json(res, 401, { error: 'Código de acceso incorrecto' });

  if (req.method === 'GET' && url.pathname.startsWith('/resultados/')) {
    const nombreArchivo = path.basename(url.pathname);
    const archivo = path.join(CARPETA_RESULTADOS, nombreArchivo);
    const tipoImg = /\.jpe?g$/i.test(nombreArchivo) ? 'image/jpeg' : 'image/png';
    if (fs.existsSync(archivo)) {
      res.writeHead(200, { 'Content-Type': tipoImg });
      return fs.createReadStream(archivo).pipe(res);
    }
    const png = await leerCapturaDB(nombreArchivo);
    if (!png) { res.writeHead(404); return res.end('No encontrado (la captura puede haber vencido)'); }
    res.writeHead(200, { 'Content-Type': tipoImg });
    return res.end(png);
  }

  if (req.method === 'GET' && url.pathname === '/api/buscar') {
    return json(res, 200, { resultados: await buscarConsultas(url.searchParams.get('q')) });
  }

  if (req.method === 'GET' && url.pathname === '/api/estado') {
    const c = CFG.decreditos;
    return json(res, 200, {
      sesiones: sesiones(), esPrincipal: esPcPrincipal(req), historial: historial.slice(0, 80),
      robot: { configurado: !!ROBOT_CLAVE, conectado: robotVivo(), enCola: robot.cola.length, actual: robot.actual?.cuit || '', hechos: robot.hechos, bancos: ROBOT_BANCOS_DEF },
      decreditosConfig: DECREDITOS_EXTENSION ? { anio: c.anio, modelo: c.modelo, modeloItem: c.modeloItem, monto: c.monto, plazo: c.plazo, tipo: c.tipo } : null,
      galiciaConfig: GALICIA_EXTENSION ? { ingresos: CFG.galicia.ingresos, valorAuto: CFG.galicia.valorAuto, marca: CFG.galicia.marca, modelo: CFG.galicia.modelo } : null,
      santanderConfig: SANTANDER_EXTENSION ? { ingresos: CFG.santander.ingresos, marca: CFG.santander.marca, modelo: CFG.santander.modelo, anio: CFG.santander.anio } : null,
    });
  }

  // Resultado de decreditos hecho con la extensión de Chrome: se interpreta y se guarda en el historial
  if (req.method === 'POST' && url.pathname === '/api/decreditos/extension') {
    const body = await leerBody(req, 12 * 1024 * 1024);
    const cuit = limpiarCuit(body.cuit);
    const vendedor = limpiarNombre(body.vendedor);
    if (cuit.length !== 11) return json(res, 400, { error: 'CUIT inválido' });
    let captura = '';
    if (body.captura) {
      const nombre = `decreditos_${cuit}_${fechaArchivo()}.jpg`;
      try {
        fs.writeFileSync(path.join(CARPETA_RESULTADOS, nombre), Buffer.from(String(body.captura), 'base64'));
        captura = `/resultados/${nombre}`;
      } catch {}
    }
    if (body.estadoFinal === 'error') {
      if (captura) guardarCapturaDB(path.basename(captura));
      const donde = body.paso ? ` (paso: ${String(body.paso).slice(0, 80)})` : '';
      console.log(`[decreditos · extensión] error${donde}: ${String(body.error || '').slice(0, 200)}`);
      return json(res, 200, { error: `Error consultando en decreditos${donde}: ${String(body.error || 'error en la extensión').slice(0, 300)}`, captura });
    }
    const datos = interpretarDecreditos({
      texto: String(body.texto || '').slice(0, 60000),
      desistir: !!body.desistir,
      cliente: String(body.cliente || '').slice(0, 80),
    });
    escribirTxt(`decreditos_${cuit}_${fechaArchivo()}`, `Banco: decreditos (extensión)\nCUIT: ${cuit}\nVendedor: ${vendedor}\nEstado: ${datos.estado}\n\n${body.texto || ''}`);
    const r = guardarConsulta(B.decreditos, { cuit, vendedor, monto: '', ofertas: [], cliente: '', captura, ...datos });
    return json(res, 200, r);
  }

  // Resultado de Galicia hecho con la extensión de Chrome
  if (req.method === 'POST' && url.pathname === '/api/galicia/extension') {
    const body = await leerBody(req, 12 * 1024 * 1024);
    const cuit = limpiarCuit(body.cuit);
    const vendedor = limpiarNombre(body.vendedor);
    if (cuit.length !== 11) return json(res, 400, { error: 'CUIT inválido' });
    let captura = '';
    if (body.captura) {
      const nombre = `galicia_${cuit}_${fechaArchivo()}.jpg`;
      try {
        fs.writeFileSync(path.join(CARPETA_RESULTADOS, nombre), Buffer.from(String(body.captura), 'base64'));
        captura = `/resultados/${nombre}`;
      } catch {}
    }
    if (body.estadoFinal === 'error') {
      if (captura) guardarCapturaDB(path.basename(captura));
      const donde = body.paso ? ` (paso: ${String(body.paso).slice(0, 80)})` : '';
      console.log(`[Galicia · extensión] error${donde}: ${String(body.error || '').slice(0, 200)}`);
      return json(res, 200, { error: `Error consultando en Banco Galicia${donde}: ${String(body.error || 'error en la extensión').slice(0, 300)}`, captura });
    }
    const c = CFG.galicia;
    const ingresos = soloNumeros(body.ingresos) || soloNumeros(c.ingresos);
    const valorAuto = soloNumeros(body.valorAuto) || soloNumeros(c.valorAuto);
    const texto = String(body.texto || '').slice(0, 60000);
    const textoSim = String(body.textoSim || '').slice(0, 60000);
    const antes = String(body.antes || '').slice(0, 60000);
    let estado, negativo = '', ofertas = [], nota = '', resumen = '';
    if (body.fase === 'empresa') {
      estado = 'REVISAR';
      resumen = 'Es una empresa (CUIT 30/33/34): la consulta automática de Galicia es para personas. Consultalo en el portal.';
    } else if (body.fase === 'rechazo' || (body.fase === 'propuesta' && /no tenemos (una )?oferta|no calific|rechaz/i.test(textoSim) && !leerPropuestaGalicia(textoSim).length)) {
      estado = 'DENEGADO';
      const previas = new Set(lineasDe(antes));
      negativo = lineasDe(textoSim || texto).filter(l => !previas.has(l)).find(l => GALICIA_DENEGADO.some(p => l.toLowerCase().includes(p))) || 'Galicia no tiene oferta para este cliente';
    } else if (body.fase === 'propuesta' || body.fase === 'vehiculo') {
      estado = 'APROBADO';
      ofertas = body.fase === 'propuesta' ? leerPropuestaGalicia(textoSim) : [];
      nota = body.nota ? String(body.nota).slice(0, 300)
        : `Simulado con ingresos $${conPuntos(ingresos)} y auto 0KM de $${conPuntos(valorAuto)} (${c.marca} ${c.modelo}).`;
    } else {
      estado = 'REVISAR';
      const previas = new Set(lineasDe(antes));
      resumen = lineasDe(texto).filter(l => !previas.has(l)).slice(0, 4).join(' · ').slice(0, 300);
    }
    // El nombre lo manda la extensión (Galicia lo muestra dentro de un campo); si no, se busca en el texto
    let cliente = limpiarNombre(body.cliente || '');
    if (cliente === 'Sin nombre') cliente = nombreClienteNacion(texto);
    if (/ingresos|dni|continuar|son los demostrables/i.test(cliente)) cliente = '';
    escribirTxt(`galicia_${cuit}_${fechaArchivo()}`, `Banco: Galicia (extensión)\nCUIT: ${cuit}\nVendedor: ${vendedor}\nEstado: ${estado}\nFase: ${body.fase || '-'}\n` +
      `Montos: ${ofertas.map(o => `${o.producto} | ${o.tipo} | ${o.monto}`).join(' / ') || '-'}\nMensaje: ${negativo || '-'}\nNota: ${nota || '-'}\n\n${texto}${textoSim ? '\n\n--- Propuesta ---\n' + textoSim : ''}`);
    const valor = m => Number(m.split(',')[0].replace(/\./g, '')) || 0;
    const mayor = [...ofertas].sort((a, b2) => valor(b2.monto) - valor(a.monto))[0];
    const r = guardarConsulta(B.galicia, { cuit, estado, vendedor, cliente, monto: mayor?.monto || '', ofertas, nota, resumen: negativo || resumen, captura });
    return json(res, 200, r);
  }

  // Resultado de Santander hecho con la extensión de Chrome
  if (req.method === 'POST' && url.pathname === '/api/santander/extension') {
    const body = await leerBody(req, 12 * 1024 * 1024);
    const cuit = limpiarCuit(body.cuit);
    const vendedor = limpiarNombre(body.vendedor);
    if (cuit.length !== 11) return json(res, 400, { error: 'CUIT inválido' });
    let captura = '';
    if (body.captura) {
      const nombre = `santander_${cuit}_${fechaArchivo()}.jpg`;
      try {
        fs.writeFileSync(path.join(CARPETA_RESULTADOS, nombre), Buffer.from(String(body.captura), 'base64'));
        captura = `/resultados/${nombre}`;
      } catch {}
    }
    if (body.estadoFinal === 'error') {
      if (captura) guardarCapturaDB(path.basename(captura));
      const donde = body.paso ? ` (paso: ${String(body.paso).slice(0, 80)})` : '';
      console.log(`[Santander · extensión] error${donde}: ${String(body.error || '').slice(0, 200)}`);
      return json(res, 200, { error: `Error consultando en Santander${donde}: ${String(body.error || 'error en la extensión').slice(0, 300)}`, captura });
    }
    const texto = String(body.texto || '').slice(0, 60000);
    const { estado, negativo, ofertas } = interpretarSantander(texto, String(body.antes || '').slice(0, 60000));
    const cliente = nombreClienteNacion(texto);
    const valor = m => Number(m.split(',')[0].replace(/\./g, '')) || 0;
    const mayor = [...ofertas].sort((a, b2) => valor(b2.monto) - valor(a.monto))[0];
    const c = CFG.santander;
    const ingresos = String(body.ingresos || c.ingresos).replace(/\D/g, '');
    escribirTxt(`santander_${cuit}_${fechaArchivo()}`, `Banco: Santander (extensión)\nCUIT: ${cuit}\nDNI: ${body.dni || ''} (${body.sexo || ''})\nVendedor: ${vendedor}\nEstado: ${estado}\nIngresos: ${ingresos}\n\n${texto}`);
    const r = guardarConsulta(B.santander, {
      cuit, estado, vendedor, cliente,
      monto: mayor?.monto || '',
      ofertas,
      resumen: negativo || (estado === 'REVISAR' ? lineasDe(texto).slice(-4).join(' · ').slice(0, 300) : ''),
      nota: `Simulado con ingresos $ ${Number(ingresos).toLocaleString('es-AR')} · ${c.marca} ${c.modelo} ${c.anio}`,
      captura,
    });
    return json(res, 200, r);
  }

  if (req.method === 'POST' && url.pathname === '/api/login') {
    const body = await leerBody(req);
    const b = B[body.banco];
    if (!b) return json(res, 400, { error: 'Banco desconocido' });
    if (b.sesion.estado === 'no_configurado') return json(res, 400, { error: b.sesion.mensaje });
    const enCurso = ['iniciando', 'esperando_captcha', 'esperando_token', 'conectado'].includes(b.sesion.estado);
    if (enCurso && !body.forzar) return json(res, 200, { ok: true });
    LOGIN[b.id](limpiarNombre(body.vendedor)); // corre en segundo plano
    return json(res, 200, { ok: true });
  }

  // ----- Captcha de Bancor -----
  const bancor = B.bancor;
  const captchaPendiente = () => bancor.sesion.estado === 'esperando_captcha' && bancor.page && !bancor.page.isClosed();

  if (req.method === 'GET' && url.pathname === '/api/captcha/pantalla') {
    if (!captchaPendiente()) return json(res, 409, { error: 'No hay captcha pendiente' });
    try {
      const c = await capturaCaptcha();
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'X-Clip': JSON.stringify(c.clip) });
      return res.end(c.buf);
    } catch {
      return json(res, 500, { error: 'No se pudo capturar la pantalla' });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/captcha/click') {
    if (!captchaPendiente()) return json(res, 409, { error: 'No hay captcha pendiente' });
    const body = await leerBody(req);
    const x = Number(body.x), y = Number(body.y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > VIEWPORT.width || y > VIEWPORT.height) {
      return json(res, 400, { error: 'Posición inválida' });
    }
    try { await bancor.page.mouse.click(x, y); ultimaCaptura.t = 0; return json(res, 200, { ok: true }); }
    catch { return json(res, 500, { error: 'No se pudo hacer el click' }); }
  }

  if (req.method === 'POST' && url.pathname === '/api/captcha/ingresar') {
    if (!captchaPendiente()) return json(res, 409, { error: 'No hay captcha pendiente' });
    try {
      await bancor.page.getByRole('button', { name: 'Ingresar' }).click({ timeout: 5000 });
      ultimaCaptura.t = 0;
      return json(res, 200, { ok: true });
    } catch {
      return json(res, 500, { error: 'No se encontró el botón Ingresar' });
    }
  }

  // ----- Código / token (Nación y Galicia) -----
  if (req.method === 'POST' && url.pathname === '/api/token') {
    const body = await leerBody(req);
    const fn = TOKEN[body.banco];
    if (!fn) return json(res, 400, { error: 'Este banco no usa token' });
    const codigo = String(body.codigo || '').replace(/\s/g, '');
    if (!/^[0-9A-Za-z]{4,10}$/.test(codigo)) return json(res, 400, { error: 'El código no parece válido' });
    try {
      const r = await fn(codigo);
      return json(res, r.ok ? 200 : 400, r);
    } catch (err) {
      return json(res, 500, { error: `Error validando el código: ${err.message.split('\n')[0]}` });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/reenviar') {
    const body = await leerBody(req);
    const fn = REENVIAR[body.banco];
    if (!fn) return json(res, 400, { error: 'Este banco no usa token' });
    const r = await fn();
    return json(res, r.ok ? 200 : 400, r);
  }

  // ----- Consulta -----
  if (req.method === 'POST' && url.pathname === '/api/consultar') {
    const body = await leerBody(req);
    const b = B[body.banco];
    if (!b) return json(res, 400, { error: 'Banco desconocido' });
    const cuit = limpiarCuit(body.cuit);
    const vendedor = limpiarNombre(body.vendedor);
    if (cuit.length !== 11) return json(res, 400, { error: 'El CUIT tiene que tener 11 números' });
    b.paso = '';
    try {
      const opciones = { ingresos: body.ingresos, valorAuto: body.valorAuto, sexo: body.sexo, simular: true };
      const t0 = Date.now();
      const r = await encolar(b, () => CONSULTA[b.id](cuit, vendedor, opciones));
      console.log(`[${b.nombre}] consulta lista en ${Math.round((Date.now() - t0) / 1000)} s`);
      return json(res, 200, r);
    } catch (err) {
      if (err.message === 'SIN_SESION') return json(res, 500, { error: `La sesión de ${b.nombre} no está activa. Iniciala arriba.` });
      if (err.message === 'SESION_VENCIDA') return json(res, 500, { error: `La sesión de ${b.nombre} venció. Iniciala de nuevo arriba.` });

      // Guardar cómo quedó la pantalla del banco para poder ver qué pasó
      let captura = err.captura || '';
      const pagina = b.app || b.page;
      if (!captura && pagina && !pagina.isClosed()) {
        const nombre = `${b.id}_error_${cuit}_${fechaArchivo()}.png`;
        const ok = await pagina.screenshot({ path: path.join(CARPETA_RESULTADOS, nombre) }).then(() => true).catch(() => false);
        if (ok) { captura = `/resultados/${nombre}`; guardarCapturaDB(nombre); }
      }
      const donde = b.paso ? ` (paso: ${b.paso})` : '';
      console.log(`[${b.nombre}] error${donde}: ${err.message.split('\n')[0]}`);
      return json(res, 500, { error: `Error consultando en ${b.nombre}${donde}: ${err.message.split('\n')[0]}`, captura });
    }
  }

  res.writeHead(404);
  res.end('No encontrado');
});

// ---------- Arranque ----------
if (MODO_AGENTE) {
  // PC de la oficina: no abre la app, solo hace las consultas de decreditos
  correrAgente();
} else if (APP_CLAVE.length < 4) {
  console.error('Falta APP_CLAVE (el código que van a usar los vendedores, mínimo 4 caracteres).');
  process.exit(1);
}

if (!MODO_AGENTE) iniciarDB().finally(() => server.listen(PORT, '0.0.0.0', () => {
  // decreditos no pide captcha ni código: la sesión se inicia sola al arrancar (si no va por la PC de la oficina)
  if (!DECREDITOS_REMOTO && !DECREDITOS_EXTENSION && B.decreditos.sesion.estado !== 'no_configurado') setTimeout(() => loginDecreditos('automático'), 3000);
  console.log('\n=========================================');
  console.log('  Consulta Créditos - servidor encendido');
  console.log('=========================================');
  console.log(`  Bancor: ${B.bancor.sesion.estado === 'no_configurado' ? 'NO configurado' : 'listo'}`);
  console.log(`  Nación: ${B.nacion.sesion.estado === 'no_configurado' ? 'NO configurado' : 'listo'}`);
  console.log(`  Galicia: ${GALICIA_EXTENSION ? 'con la extensión de Chrome de cada computadora' : B.galicia.sesion.estado === 'no_configurado' ? 'NO configurado' : 'listo'}`);
  console.log(`  Santander: ${SANTANDER_EXTENSION ? 'con la extensión de Chrome de cada computadora' : B.santander.sesion.estado === 'no_configurado' ? 'NO configurado (faltan SANTANDER_USUARIO y SANTANDER_CLAVE)' : 'listo (código de Google Authenticator a mano)'}`);
  console.log(`  decreditos: ${DECREDITOS_EXTENSION ? 'con la extensión de Chrome de cada computadora' : DECREDITOS_REMOTO ? 'a través de la PC de la oficina (ayudante)' : B.decreditos.sesion.estado === 'no_configurado' ? 'NO configurado' : 'listo (entra solo)'}`);
  const estadoHistorial = dbLista ? 'PostgreSQL (no se borra)'
    : !DATABASE_URL ? 'archivo local (se borra en cada deploy): la variable DATABASE_URL no llegó a la app'
    : !db ? 'archivo local: falta la librería "pg" (subí el package.json nuevo a GitHub)'
    : 'archivo local: DATABASE_URL está, pero no se pudo conectar (ver el error [DB] más arriba)';
  console.log(`  Historial: ${estadoHistorial}`);
  console.log(`  Robot (Kommo): ${ROBOT_CLAVE ? 'listo (webhook: /api/robot/consultar?clave=…)' : 'apagado (falta ROBOT_CLAVE)'}${KOMMO.token ? ' · notas en Kommo activas' : ''}`);
  console.log(`  Código por mail: ${MAIL_ACTIVO && ImapFlow ? 'automático (' + MAIL.usuario + ')' : 'manual (falta MAIL_USUARIO / MAIL_CLAVE_APP)'}`);
  console.log(`  En esta PC:        http://localhost:${PORT}`);
  for (const ip of ipsLocales()) console.log(`  Misma red / WiFi:  http://${ip}:${PORT}`);
  console.log('');
}));
