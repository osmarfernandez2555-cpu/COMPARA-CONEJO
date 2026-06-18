const express = require('express')
const cors = require('cors')
const fetch = require('node-fetch')
const path = require('path')

const app = express()
app.use(cors())
app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))

// Log al arrancar
console.log('=== SERVIDOR INICIANDO ===')
console.log('ANTHROPIC_API_KEY presente:', !!process.env.ANTHROPIC_API_KEY)
console.log('NODE_ENV:', process.env.NODE_ENV)

app.get('/api/ping', (req, res) => {
  const key = process.env.ANTHROPIC_API_KEY
  console.log('PING - key presente:', !!key)
  res.json({
    ok: true,
    key_cargada: !!key,
    key_inicio: key ? key.substring(0, 12) + '...' : 'VACIA',
    node_version: process.version,
    env: process.env.NODE_ENV || 'no definido'
  })
})

app.post('/api/buscar', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY
  console.log('POST /api/buscar - key presente:', !!apiKey)

  if (!apiKey) {
    return res.status(500).json({ error: 'API key no configurada en el servidor' })
  }

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
    const data = await response.json()
    console.log('Respuesta Anthropic status:', response.status)
    res.json(data)
  } catch (e) {
    console.error('Error fetch:', e.message)
    res.status(500).json({ error: e.message })
  }
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`)
  console.log('Key al escuchar:', !!process.env.ANTHROPIC_API_KEY)
})
