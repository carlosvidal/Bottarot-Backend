# 📊 Análisis del Backend de Free Tarot Fun

**Fecha:** 9 de Noviembre, 2025
**Versión Backend:** 2.0-dummy-fix
**Rama:** claude/bottarot-backend-analysis-011CUy4BZmXfohYZ3QGtg41P
**Nota:** Este análisis se realizó cuando el proyecto se llamaba "Bottarot"

---

## 📁 Estructura del Proyecto

```
Bottarot-Backend/
├── server.js              # Servidor Express principal (460 líneas)
├── package.json           # Dependencias y configuración
├── paypal-config.js       # Configuración de PayPal
├── .gitignore            # Archivos ignorados
└── data/
    └── tarotDeck.js       # Base de datos de 78 cartas del Tarot
```

---

## 🔧 Tecnologías y Dependencias

### Stack Actual

| Tecnología | Versión | Propósito |
|-----------|---------|-----------|
| Node.js | - | Runtime (módulos ES) |
| Express | 5.1.0 | Framework web |
| OpenAI SDK | 5.21.0 | GPT-4o-mini para interpretaciones |
| Supabase JS | 2.57.4 | Base de datos y autenticación |
| PayPal Server SDK | 1.1.0 | Procesamiento de pagos |
| CORS | 2.8.5 | Cross-Origin Resource Sharing |
| dotenv | 17.2.2 | Variables de entorno |
| node-fetch | 3.3.2 | HTTP requests |

---

## 🎯 Endpoints Implementados

### 1. Lecturas de Tarot

#### `POST /api/chat/message`
**Ubicación:** `server.js:101-258`

**Sistema de Agentes IA:**

##### Agente Decisor (GPT-4o-mini)
Clasifica preguntas en 3 categorías:

1. **`requires_new_draw`**: Nueva tirada de cartas necesaria
   - Ejemplos: "¿Qué me depara el futuro en el amor?", "Necesito una guía sobre mi carrera"

2. **`is_follow_up`**: Pregunta de seguimiento sobre interpretación anterior
   - Solo desde la segunda pregunta
   - Ejemplos: "¿Qué significa la carta del medio?", "¿Puedes darme más detalles?"

3. **`is_inadequate`**: Pregunta no válida para tarot
   - Sub-categorías:
     - Soporte/Técnica: "¿Cómo cancelo mi suscripción?"
     - Fuera de Contexto: "Hola", "¿Cuánto es 2+2?"
     - Petición de Clarificación: "ayuda", "?"

**Configuración del Decisor:**
- Modelo: `gpt-4o-mini`
- Temperature: 0 (determinista)
- Response format: JSON object
- Prompt: `DECIDER_SYSTEM_PROMPT` (líneas 22-56)

##### Agente Intérprete (GPT-4o-mini)
Genera interpretaciones místicas y personalizadas.

**Características:**
- Estilo: Místico, poético pero claro y accionable
- Relaciona cartas directamente con la pregunta
- Usa contexto personal del usuario (nombre, edad, etc.)
- Mantiene continuidad con historial de chat
- Tono empático, evita afirmaciones catastróficas

**Estructura de interpretación:**
1. Saludo y conexión (si hay contexto personal)
2. Análisis de cartas por posición
3. Síntesis unificada del mensaje
4. Consejo final práctico

**Configuración del Intérprete:**
- Modelo: `gpt-4o-mini`
- Prompt: `INTERPRETER_SYSTEM_PROMPT` (líneas 57-69)
- Temperature: default (0.7)

**Funcionalidades adicionales:**
- Generación automática de títulos para chats nuevos
- Título: 3-5 palabras, estilo SEO
- Guardado en Supabase (función RPC comentada actualmente)

**Request Body:**
```json
{
  "question": "string (requerido)",
  "history": [{"role": "user|assistant", "content": "string"}],
  "personalContext": "string (opcional)",
  "userId": "string",
  "chatId": "string"
}
```

**Response Types:**

*Tipo 1: Mensaje simple (inadequate/follow-up)*
```json
{
  "type": "message",
  "text": "string",
  "role": "assistant"
}
```

*Tipo 2: Lectura de tarot (Server-Sent Events - SSE)*

**⚡ NUEVO: Streaming con SSE**

Las lecturas de tarot ahora se envían mediante Server-Sent Events (SSE) para mejorar la experiencia del usuario. Las cartas se envían inmediatamente y la interpretación llega después.

**Headers de respuesta:**
```
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
```

**Secuencia de eventos:**

1. **Evento: `title`** (solo si es el primer mensaje del chat)
```
event: title
data: {"title": "Amor y Relaciones"}
```

2. **Evento: `cards`** (se envía inmediatamente después de la tirada)
```
event: cards
data: {"cards": [
  {
    "name": "El Loco",
    "description": "Nuevos comienzos...",
    "image": "/img/Trumps-00.webp",
    "upright": true,
    "orientation": "Derecha",
    "posicion": "Pasado"
  },
  {...},
  {...}
]}
```

3. **Evento: `interpretation`** (se envía después de generar con IA)
```
event: interpretation
data: {"text": "Buenas tardes, Carlos. Las cartas revelan..."}
```

4. **Evento: `done`** (indica fin de la transmisión)
```
event: done
data: {"complete": true}
```

**Ejemplo de manejo en el cliente (JavaScript con fetch):**

⚠️ **Nota:** `EventSource` solo soporta GET. Para POST, usar `fetch()` con lectura de stream.

```javascript
// Función para procesar lecturas de tarot con SSE
async function requestTarotReading(question, userId, chatId, history = []) {
  const response = await fetch('/api/chat/message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, userId, chatId, history })
  });

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n\n');
    buffer = lines.pop(); // Guardar línea incompleta

    for (const line of lines) {
      if (!line.trim()) continue;

      const [eventLine, dataLine] = line.split('\n');
      const eventType = eventLine.replace('event: ', '');
      const data = JSON.parse(dataLine.replace('data: ', ''));

      switch (eventType) {
        case 'title':
          console.log('📝 Título:', data.title);
          // Actualizar UI con título
          break;

        case 'cards':
          console.log('🃏 Cartas recibidas:', data.cards);
          // Mostrar cartas con animación inmediatamente
          displayCards(data.cards);
          break;

        case 'interpretation':
          console.log('🔮 Interpretación:', data.text);
          // Mostrar interpretación
          displayInterpretation(data.text);
          break;

        case 'done':
          console.log('✅ Lectura completa');
          break;
      }
    }
  }
}
```

**Ejemplo con Vue.js 3 (Composition API):**
```javascript
import { ref } from 'vue';

const cards = ref([]);
const interpretation = ref('');
const chatTitle = ref('');
const isLoading = ref(false);

async function askTarot(question) {
  isLoading.value = true;
  cards.value = [];
  interpretation.value = '';

  try {
    const response = await fetch('/api/chat/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question,
        userId: user.value.id,
        chatId: currentChat.value.id,
        history: chatHistory.value
      })
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split('\n\n');
      buffer = events.pop();

      for (const event of events) {
        if (!event.trim()) continue;

        const lines = event.split('\n');
        const eventType = lines[0].replace('event: ', '');
        const data = JSON.parse(lines[1].replace('data: ', ''));

        if (eventType === 'title') chatTitle.value = data.title;
        if (eventType === 'cards') cards.value = data.cards;
        if (eventType === 'interpretation') interpretation.value = data.text;
        if (eventType === 'done') isLoading.value = false;
      }
    }
  } catch (error) {
    console.error('Error en lectura:', error);
    isLoading.value = false;
  }
}
```

**Ventajas del streaming:**
- ⚡ Las cartas aparecen instantáneamente (0.1-0.2s vs 3-5s)
- 🎨 Permite animaciones mientras se genera la interpretación
- 📊 Mejor percepción de velocidad por parte del usuario
- 🔄 Respuesta progresiva en lugar de espera bloqueante

---

### 2. Text-to-Speech (ElevenLabs)

#### `POST /api/tts`
**Ubicación:** `server.js:287-358`
**Estado:** ✅ **COMPLETAMENTE IMPLEMENTADO**

**Características:**
- Integración completa con ElevenLabs API v1
- Caché en memoria con Map (límite: 50 entradas)
- Estrategia FIFO para límite de caché
- Headers personalizados: `X-Cache: HIT|MISS`

**Configuración ElevenLabs:**
```javascript
{
  model_id: "eleven_multilingual_v2",
  voice_id: "21m00Tcm4TlvDq8ikWAM", // Rachel (default)
  voice_settings: {
    stability: 0.5,
    similarity_boost: 0.75
  }
}
```

**Request:**
```json
{
  "text": "string (requerido)"
}
```

**Response:**
- Content-Type: `audio/mpeg`
- Headers: `X-Cache: HIT` o `X-Cache: MISS`
- Body: Buffer de audio MP3

**Caché:**
- Tipo: In-memory Map
- Key: Primeros 100 caracteres del texto
- Tamaño máximo: 50 entradas
- Eviction: FIFO (First In, First Out)

**⚠️ Limitación:** El caché se pierde al reiniciar el servidor.
**💡 Sugerencia:** Migrar a Redis para producción.

---

### 3. Sistema de Suscripciones

#### `GET /api/subscription-plans`
**Ubicación:** `server.js:361-376`

Obtiene planes de suscripción activos desde Supabase.

**Query Supabase:**
```javascript
supabase
  .from('subscription_plans')
  .select('*')
  .eq('is_active', true)
  .order('price', { ascending: true })
```

**Response:**
```json
{
  "plans": [
    {
      "id": "uuid",
      "name": "string",
      "description": "string",
      "price": "number",
      "is_active": "boolean"
    }
  ]
}
```

---

#### `POST /api/payments/create-order`
**Ubicación:** `server.js:379-433`

Crea orden de pago con PayPal.

**Request:**
```json
{
  "planId": "uuid",
  "userId": "uuid"
}
```

**Flujo:**
1. Valida planId y userId
2. Obtiene plan desde Supabase
3. Crea orden PayPal (o Mock si no hay credenciales)
4. Guarda transacción en tabla `payment_transactions`
5. Retorna URL de aprobación

**Response:**
```json
{
  "orderId": "string",
  "approvalUrl": "string",
  "note": "Mock PayPal response" // solo en modo dev
}
```

**Mock Mode:**
Si `PAYPAL_CLIENT_ID === 'YOUR_PAYPAL_CLIENT_ID_SANDBOX'`, genera respuesta simulada.

---

#### `POST /api/payments/capture-order`
**Ubicación:** `server.js:436-438`
**Estado:** ⚠️ **INCOMPLETO**

```javascript
app.post("/api/payments/capture-order", async (req, res) => {
    // ... (logic for capturing paypal order remains the same)
});
```

**🚨 ACCIÓN REQUERIDA:** Implementar lógica de captura.

---

#### `GET /api/user/subscription/:userId`
**Ubicación:** `server.js:441-456`
**Estado:** ⚠️ **MODO DEBUG** (datos dummy)

**Response actual (hardcoded):**
```json
{
  "has_active_subscription": true,
  "plan_name": "Premium Plan (Debug)",
  "questions_remaining": 100,
  "subscription_end_date": "ISO 8601 (+30 días)",
  "can_ask_question": true
}
```

**🚨 ACCIÓN REQUERIDA:** Conectar a Supabase real en producción.

---

### 4. Utilidades

#### `GET /api/version`
**Ubicación:** `server.js:266-268`

```json
{
  "version": "2.0-dummy-fix"
}
```

#### `GET /ping`
**Ubicación:** `server.js:271-280`

Endpoint de warmup para Render.com free tier.

**Response:**
```json
{
  "ok": true,
  "time": 1699564800000,
  "message": "El oráculo está despierto",
  "timestamp": "2025-11-09T21:00:00.000Z"
}
```

**Logs:** Imprime timestamp en consola para debugging.

---

## 🎴 Sistema de Cartas

### Baraja Completa (`tarotDeck.js`)

**Total: 78 cartas**

#### Arcanos Mayores (22 cartas)
0. El Loco
1. El Mago
2. La Sacerdotisa
3. La Emperatriz
4. El Emperador
5. El Hierofante
6. Los Enamorados
7. El Carro
8. La Fuerza
9. El Ermitaño
10. La Rueda de la Fortuna
11. La Justicia
12. El Colgado
13. La Muerte
14. La Templanza
15. El Diablo
16. La Torre
17. La Estrella
18. La Luna
19. El Sol
20. El Juicio
21. El Mundo

#### Arcanos Menores (56 cartas)

**Copas (14 cartas)** - Emociones, relaciones, intuición
- As, 2-10, Sota, Caballero, Reina, Rey

**Espadas (14 cartas)** - Pensamientos, conflictos, decisiones
- As, 2-10, Sota, Caballero, Reina, Rey

**Bastos (14 cartas)** - Energía, acción, creatividad
- As, 2-10, Sota, Caballero, Reina, Rey

**Pentáculos (14 cartas)** - Recursos materiales, trabajo, finanzas
- As, 2-10, Sota, Caballero, Reina, Rey

### Función de Tirada

**Ubicación:** `server.js:75-95`

```javascript
const drawCards = (numCards = 3) => {
  // Selección aleatoria sin reemplazo
  // Orientación aleatoria (50% upright/invertida)
  // Posiciones: Pasado, Presente, Futuro
}
```

**Características:**
- Default: 3 cartas
- Sin reemplazo (no hay duplicados en una tirada)
- Orientación aleatoria por carta
- Posiciones predefinidas según índice

**Estructura de carta retornada:**
```javascript
{
  name: "string",
  description: "string",
  image: "/img/path.webp",
  upright: boolean,
  orientation: "Derecha|Invertida",
  posicion: "Pasado|Presente|Futuro"
}
```

---

## 🗄️ Integración con Supabase

### Cliente Configurado

**Ubicación:** `server.js:11-13`

```javascript
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseServiceKey);
```

**Nota:** Usa `SUPABASE_SERVICE_KEY` (admin) en lugar de anon key.

### Tablas Esperadas

#### `subscription_plans`
```sql
CREATE TABLE subscription_plans (
  id UUID PRIMARY KEY,
  name TEXT,
  description TEXT,
  price NUMERIC,
  is_active BOOLEAN,
  -- otros campos...
);
```

#### `payment_transactions`
```sql
CREATE TABLE payment_transactions (
  id UUID PRIMARY KEY,
  user_id UUID,
  paypal_order_id TEXT,
  amount NUMERIC,
  status TEXT,
  transaction_data JSONB,
  created_at TIMESTAMP
);
```

#### RPC Functions (comentadas)

**`update_chat_title`** - Línea 198-202 (deshabilitada)

```sql
-- Función esperada en Supabase
CREATE OR REPLACE FUNCTION update_chat_title(
  p_chat_id UUID,
  p_user_id UUID,
  p_new_title TEXT
) RETURNS VOID AS $$
-- Implementación pendiente
$$ LANGUAGE plpgsql;
```

**🚨 ACCIÓN REQUERIDA:** Crear esta función si se desea habilitar.

---

## 🔌 Integraciones con Servicios de IA

### OpenAI GPT-4o-mini

**Ubicación:** `server.js:19`

```javascript
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
```

**Uso:**
1. **Agente Decisor**
   - Modelo: `gpt-4o-mini`
   - Temperature: 0
   - Response format: JSON object

2. **Agente Intérprete**
   - Modelo: `gpt-4o-mini`
   - Temperature: default (0.7)
   - Response format: text

3. **Generador de Títulos**
   - Modelo: `gpt-4o-mini`
   - Temperature: 0.7
   - Max tokens: 20

**Prompts Especializados:**
- `DECIDER_SYSTEM_PROMPT` (líneas 22-56)
- `INTERPRETER_SYSTEM_PROMPT` (líneas 57-69)

### ElevenLabs TTS

**API Endpoint:**
```
POST https://api.elevenlabs.io/v1/text-to-speech/{VOICE_ID}
```

**Headers:**
```javascript
{
  'Accept': 'audio/mpeg',
  'Content-Type': 'application/json',
  'xi-api-key': ELEVENLABS_API_KEY
}
```

**Body:**
```json
{
  "text": "string",
  "model_id": "eleven_multilingual_v2",
  "voice_settings": {
    "stability": 0.5,
    "similarity_boost": 0.75
  }
}
```

**Voces disponibles:**
- Default: `21m00Tcm4TlvDq8ikWAM` (Rachel)
- Configurable via `ELEVENLABS_VOICE_ID`

---

## 🔐 Variables de Entorno Requeridas

### Template `.env`

```env
# ============================================
# SUPABASE
# ============================================
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your-service-role-key-here

# ============================================
# OPENAI
# ============================================
OPENAI_API_KEY=sk-proj-...

# ============================================
# ELEVENLABS (Text-to-Speech)
# ============================================
ELEVENLABS_API_KEY=your-elevenlabs-key
ELEVENLABS_VOICE_ID=21m00Tcm4TlvDq8ikWAM  # Opcional (Rachel por defecto)

# ============================================
# PAYPAL
# ============================================
PAYPAL_CLIENT_ID=your-paypal-client-id
PAYPAL_CLIENT_SECRET=your-paypal-secret
PAYPAL_ENVIRONMENT=sandbox  # o 'production'

# ============================================
# FRONTEND
# ============================================
FRONTEND_URL=http://localhost:5173  # Para desarrollo
# FRONTEND_URL=https://yourdomain.com  # Para producción
```

### Obtención de Claves

#### Supabase
1. Ir a https://supabase.com/dashboard
2. Seleccionar proyecto
3. Settings > API
4. Copiar `URL` y `service_role key`

#### OpenAI
1. Ir a https://platform.openai.com/api-keys
2. Create new secret key
3. Copiar API key

#### ElevenLabs
1. Ir a https://elevenlabs.io/
2. Profile Settings > API Keys
3. Copiar API key
4. (Opcional) Voices > Copiar Voice ID deseado

#### PayPal
1. Ir a https://developer.paypal.com/
2. Dashboard > Apps & Credentials
3. Crear aplicación o usar existente
4. Copiar Client ID y Secret
5. Usar Sandbox para desarrollo

---

## ✅ Compatibilidad Frontend-Backend

| Funcionalidad Frontend | Estado Backend | Ubicación | Notas |
|------------------------|---------------|-----------|-------|
| Lecturas de Tarot | ✅ Completo | `server.js:101-258` | Sistema de agentes robusto |
| TTS con ElevenLabs | ✅ Completo | `server.js:287-358` | Caché implementado |
| Conexión Supabase | ✅ Configurado | `server.js:11-13` | Cliente inicializado |
| Sistema de pagos | ⚠️ Parcial | `server.js:379-438` | Endpoint capture incompleto |
| Gestión de suscripciones | ⚠️ Debug | `server.js:441-456` | Retorna datos dummy |
| State management (Pinia) | N/A | - | Solo frontend |
| Vue Router | N/A | - | Solo frontend |
| Animación de cartas | N/A | - | Solo frontend |

---

## 🚨 Issues y Pendientes

### 1. Endpoint de Captura PayPal Incompleto

**Ubicación:** `server.js:436-438`

**Problema:**
```javascript
app.post("/api/payments/capture-order", async (req, res) => {
    // ... (logic for capturing paypal order remains the same)
});
```

**Acción requerida:**
Implementar la lógica completa para:
1. Recibir `orderId` del frontend
2. Llamar a PayPal Capture API
3. Actualizar estado en `payment_transactions`
4. Activar suscripción del usuario
5. Retornar confirmación

**Prioridad:** 🔴 Alta (bloquea pagos reales)

---

### 2. Sistema de Suscripciones en Modo Debug

**Ubicación:** `server.js:441-456`

**Problema:**
El endpoint siempre retorna datos hardcoded:
```javascript
res.json({
  has_active_subscription: true,
  plan_name: 'Premium Plan (Debug)',
  questions_remaining: 100,
  subscription_end_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  can_ask_question: true
});
```

**Acción requerida:**
1. Crear tabla `user_subscriptions` en Supabase
2. Implementar lógica real de consulta
3. Validar permisos por plan
4. Manejar límites de preguntas
5. Verificar fechas de expiración

**Prioridad:** 🟡 Media (funciona para desarrollo)

---

### 3. Actualización de Títulos de Chat Deshabilitada

**Ubicación:** `server.js:198-202`

**Problema:**
```javascript
// The user would need to re-create this RPC function if they want this feature
// await supabase.rpc('update_chat_title', {
//     p_chat_id: chatId,
//     p_user_id: userId,
//     p_new_title: generatedTitle
// });
```

**Acción requerida:**
1. Crear función RPC en Supabase
2. Descomentar líneas 198-202
3. Manejar errores de actualización

**Prioridad:** 🟢 Baja (opcional, no bloquea funcionalidad core)

---

### 4. Caché de TTS en Memoria

**Problema:**
- El caché se pierde al reiniciar servidor
- Límite de 50 entradas arbitrario
- No escalable para múltiples instancias

**Acción requerida:**
1. **Opción 1 (recomendada):** Migrar a Redis
   ```javascript
   import { createClient } from 'redis';
   const redis = createClient({ url: process.env.REDIS_URL });
   ```

2. **Opción 2:** Almacenar audios frecuentes en S3/Cloudinary
   - Pre-generar audios para interpretaciones comunes
   - Servir desde CDN

**Prioridad:** 🟡 Media (mejora rendimiento y costos)

---

### 5. Sin Tests

**Problema:**
```json
"scripts": {
  "test": "echo \"Error: no test specified\" && exit 1"
}
```

**Acción requerida:**
1. Instalar Jest + Supertest
2. Crear tests para endpoints críticos:
   - `/api/chat/message`
   - `/api/tts`
   - `/api/payments/*`
3. Mock de servicios externos (OpenAI, ElevenLabs, PayPal)

**Prioridad:** 🟡 Media (mejora confiabilidad)

---

## 💡 Sugerencias de Mejoras

### 1. Seguridad

#### Validación de Inputs
```bash
npm install zod
```

```javascript
import { z } from 'zod';

const chatMessageSchema = z.object({
  question: z.string().min(1).max(500),
  userId: z.string().uuid(),
  chatId: z.string().uuid(),
  history: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string()
  })).optional(),
  personalContext: z.string().max(1000).optional()
});

app.post("/api/chat/message", async (req, res) => {
  const validation = chatMessageSchema.safeParse(req.body);
  if (!validation.success) {
    return res.status(400).json({ error: validation.error });
  }
  // ...
});
```

#### Rate Limiting
```bash
npm install express-rate-limit
```

```javascript
import rateLimit from 'express-rate-limit';

const ttsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 50, // 50 requests por IP
  message: 'Demasiadas solicitudes de TTS, intenta más tarde'
});

app.post("/api/tts", ttsLimiter, async (req, res) => {
  // ...
});
```

#### Helmet.js
```bash
npm install helmet
```

```javascript
import helmet from 'helmet';
app.use(helmet());
```

---

### 2. Monitoreo y Logging

#### Winston para Logs Estructurados
```bash
npm install winston
```

```javascript
import winston from 'winston';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' })
  ]
});

// Uso
logger.info(`[${chatId}] Agente Decisor analizando`, { question, userId });
```

#### Métricas de APIs
```javascript
// Tracking de costos OpenAI/ElevenLabs
let apiMetrics = {
  openai: { requests: 0, tokens: 0 },
  elevenlabs: { requests: 0, characters: 0 }
};

// En cada llamada
apiMetrics.openai.requests++;
apiMetrics.openai.tokens += completion.usage.total_tokens;
```

---

### 3. Resiliencia

#### Reintentos para APIs Externas
```bash
npm install axios-retry
```

```javascript
import axios from 'axios';
import axiosRetry from 'axios-retry';

axiosRetry(axios, {
  retries: 3,
  retryDelay: axiosRetry.exponentialDelay,
  retryCondition: (error) => {
    return axiosRetry.isNetworkOrIdempotentRequestError(error)
           || error.response.status === 429;
  }
});
```

#### Circuit Breaker
```bash
npm install opossum
```

```javascript
import CircuitBreaker from 'opossum';

const openaiBreaker = new CircuitBreaker(async (prompt) => {
  return await openai.chat.completions.create(prompt);
}, {
  timeout: 10000,
  errorThresholdPercentage: 50,
  resetTimeout: 30000
});
```

---

### 4. Mejoras de Arquitectura

#### Estructura Modular
```
src/
├── routes/
│   ├── chat.routes.js
│   ├── tts.routes.js
│   ├── payments.routes.js
│   └── subscriptions.routes.js
├── services/
│   ├── openai.service.js
│   ├── elevenlabs.service.js
│   ├── paypal.service.js
│   └── tarot.service.js
├── middleware/
│   ├── auth.js
│   ├── validation.js
│   └── ratelimit.js
├── utils/
│   ├── logger.js
│   └── cache.js
└── server.js
```

#### Ejemplo: Separar Servicio de Tarot
```javascript
// src/services/tarot.service.js
export class TarotService {
  constructor(deck) {
    this.deck = deck;
  }

  drawCards(numCards = 3) {
    // Lógica de tirada
  }

  async getInterpretation(cards, question, context) {
    // Lógica de interpretación
  }
}
```

---

### 5. Documentación

#### README.md Completo
Incluir:
- Descripción del proyecto
- Requisitos del sistema
- Instrucciones de instalación
- Configuración de variables de entorno
- Comandos disponibles
- Estructura del proyecto
- Endpoints de API
- Contribución

#### Swagger/OpenAPI
```bash
npm install swagger-jsdoc swagger-ui-express
```

```javascript
import swaggerJsdoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';

const swaggerOptions = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Bottarot API',
      version: '2.0.0',
      description: 'API para el oráculo de Tarot con IA'
    }
  },
  apis: ['./routes/*.js']
};

const swaggerSpec = swaggerJsdoc(swaggerOptions);
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
```

---

### 6. Optimizaciones de Rendimiento

#### Compresión de Responses
```bash
npm install compression
```

```javascript
import compression from 'compression';
app.use(compression());
```

#### Cache Control Headers
```javascript
app.get("/api/version", (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.json({ version: "2.0-dummy-fix" });
});
```

#### Streaming para TTS
```javascript
app.post("/api/tts", async (req, res) => {
  // ...
  const response = await fetch(...);

  res.setHeader('Content-Type', 'audio/mpeg');
  response.body.pipe(res); // Stream directo sin buffering
});
```

---

## 🚀 Roadmap Sugerido

### Fase 1: Fundamentos (Semana 1-2)
- [ ] Completar endpoint `/api/payments/capture-order`
- [ ] Implementar sistema real de suscripciones
- [ ] Crear tabla `user_subscriptions` en Supabase
- [ ] Agregar validación de inputs con Zod
- [ ] Implementar rate limiting

### Fase 2: Infraestructura (Semana 3-4)
- [ ] Migrar caché TTS a Redis
- [ ] Implementar logging con Winston
- [ ] Agregar manejo de errores centralizado
- [ ] Crear tests unitarios básicos
- [ ] Separar código en módulos

### Fase 3: Mejoras (Semana 5-6)
- [ ] Agregar circuit breakers
- [ ] Implementar métricas de API
- [ ] Crear documentación Swagger
- [ ] Optimizar performance con compresión
- [ ] Agregar monitoreo con Sentry/DataDog

### Fase 4: Avanzado (Semana 7-8)
- [ ] Sistema de webhooks para eventos
- [ ] Notificaciones push
- [ ] Analytics de uso de cartas
- [ ] A/B testing de prompts
- [ ] Personalización avanzada de voces TTS

---

## 📊 Métricas Actuales

### Endpoints por Funcionalidad

| Categoría | Endpoints | Completitud |
|-----------|-----------|-------------|
| Tarot/Chat | 1 | 100% ✅ |
| TTS | 1 | 100% ✅ |
| Suscripciones | 1 | 50% ⚠️ |
| Pagos | 2 | 50% ⚠️ |
| Utilidades | 2 | 100% ✅ |
| **TOTAL** | **7** | **78.6%** |

### Integraciones Externas

| Servicio | Estado | Uso |
|----------|--------|-----|
| OpenAI GPT-4o-mini | ✅ Activo | 3 casos de uso |
| ElevenLabs TTS | ✅ Activo | 1 endpoint |
| Supabase | ✅ Activo | Auth + DB |
| PayPal | ⚠️ Parcial | Solo create-order |

### Cobertura de Código
- Tests: 0%
- Validación: ~20% (solo checks básicos)
- Manejo de errores: ~60%
- Logging: ~40%

---

## 🔗 Enlaces Útiles

### Documentación Oficial
- [Express.js](https://expressjs.com/)
- [OpenAI API](https://platform.openai.com/docs)
- [ElevenLabs API](https://elevenlabs.io/docs/api-reference)
- [Supabase JS Client](https://supabase.com/docs/reference/javascript)
- [PayPal Server SDK](https://developer.paypal.com/docs/api/orders/v2/)

### Herramientas de Desarrollo
- [Postman](https://www.postman.com/) - Testing de APIs
- [ngrok](https://ngrok.com/) - Tunneling para webhooks
- [Render.com](https://render.com/) - Hosting actual
- [Redis Cloud](https://redis.com/try-free/) - Caché en la nube

### Comunidad
- [Stack Overflow - Express](https://stackoverflow.com/questions/tagged/express)
- [OpenAI Community](https://community.openai.com/)
- [Supabase Discord](https://discord.supabase.com/)

---

## 📝 Notas Finales

### Fortalezas del Backend Actual
1. ✅ Sistema de agentes IA bien diseñado y robusto
2. ✅ Integración completa de TTS con caché
3. ✅ Código limpio y organizado
4. ✅ Logs informativos para debugging
5. ✅ Prompts especializados y bien documentados

### Áreas de Mejora Prioritarias
1. 🔴 Completar sistema de pagos
2. 🔴 Implementar suscripciones reales
3. 🟡 Agregar tests automatizados
4. 🟡 Mejorar seguridad (validación, rate limiting)
5. 🟢 Documentar con README y Swagger

### Compatibilidad con Frontend Vue.js
El backend está **bien preparado** para soportar todas las funcionalidades del frontend mencionadas:
- ✅ Lecturas de tarot con animaciones
- ✅ TTS funcionando
- ✅ Gestión de estado (Pinia se comunica correctamente)
- ✅ Routing (endpoints bien definidos)
- ⚠️ Sistema de pagos requiere completarse

---

**Documento generado:** 9 de Noviembre, 2025
**Versión:** 1.0
**Autor:** Claude Code Analysis Agent
**Contacto:** Para preguntas sobre este análisis, revisar el código fuente en `/home/user/Bottarot-Backend/`
