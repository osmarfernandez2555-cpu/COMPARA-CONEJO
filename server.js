const express = require('express')
const cors = require('cors')
const fetch = require('node-fetch')
const path = require('path')

const app = express()
app.use(cors())
app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))

app.post('/api/buscar', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return res.status(500).json({ error: 'API key no configurada en el servidor' })

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
    res.json(data)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`))
