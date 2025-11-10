# Plan de Monetización: Lecturas Freemium con Unlock Premium

**Fecha**: 2025-11-10
**Versión Actual**: 3.1-instant-cards
**Modelo Propuesto**: Freemium con pago por unlock ($1 USD por lectura completa)

---

## 📊 RESUMEN EJECUTIVO

### Modelo de Negocio Propuesto

**GRATIS (Teaser):**
- ✅ Las 3 cartas visuales (Pasado, Presente, Futuro)
- ✅ Interpretación completa del Pasado
- ✅ Interpretación completa del Presente
- ✅ Interpretación del Futuro **TRUNCADA** (en preposición/conjunción/artículo/conector)

**PREMIUM ($1 USD por lectura):**
- 🔓 Revelación completa de la interpretación del Futuro
- 🔓 Síntesis unificada de las 3 cartas
- 🔓 Consejo final personalizado

### Justificación del Modelo

- **Precio bajo**: $1 USD reduce fricción y maximiza conversión
- **Valor claro**: El usuario ya vio la calidad en Pasado/Presente
- **Cliffhanger efectivo**: Truncar en medio de oración genera curiosidad
- **Ganancia neta**: ~$0.51 por unlock (después de fees PayPal)

---

## 🎯 DESAFÍO PRINCIPAL

Actualmente el **AGENTE INTÉRPRETE** genera la interpretación como un **bloque único de texto narrativo**. No hay separación clara entre las secciones Pasado/Presente/Futuro/Síntesis/Consejo.

**Necesitamos:**
1. ✅ Estructurar la interpretación en secciones identificables
2. ✅ Decidir qué contenido es gratis vs. premium
3. ✅ Implementar lógica de truncado inteligente
4. ✅ Sistema de "unlock" con pago de $1
5. ✅ Persistencia de unlocks en base de datos

---

## 🔀 OPCIONES DE IMPLEMENTACIÓN

### **OPCIÓN 1: Respuesta Estructurada JSON** ⭐ (RECOMENDADA)

Modificar el prompt del AGENTE INTÉRPRETE para que retorne JSON estructurado:

```json
{
  "saludo": "Buenas tardes, Carlos...",
  "pasado": "El Loco en tu pasado indica...",
  "presente": "La carta del Presente revela...",
  "futuro": "Hacia el futuro, las cartas muestran...",
  "sintesis": "En conjunto, estas tres cartas...",
  "consejo": "Te aconsejo que..."
}
```

**Ventajas:**
- ✅ Control preciso del contenido gratuito vs premium
- ✅ Fácil de implementar el truncado
- ✅ Estructura clara para el frontend
- ✅ No requiere IA adicional para parsear
- ✅ Robusto y predecible

**Desventajas:**
- ⚠️ Cambio en el prompt (puede afectar el tono narrativo)
- ⚠️ Requiere testing para mantener calidad

---

### **OPCIÓN 2: Marcadores en el Texto**

Mantener texto narrativo pero con marcadores claros:

```markdown
Buenas tardes, Carlos...

## Pasado
El Loco en tu pasado indica...

## Presente
La carta del Presente revela...

## Futuro
Hacia el futuro, las cartas muestran...

## Síntesis
En conjunto, estas tres cartas...

## Consejo
Te aconsejo que...
```

Backend parsea con regex para separar secciones.

**Ventajas:**
- ✅ Mantiene narrativa fluida
- ✅ Fácil de parsear con regex
- ✅ Legible para debugging

**Desventajas:**
- ⚠️ Parsing puede fallar si IA no sigue formato exacto
- ⚠️ Menos robusto que JSON
- ⚠️ Requiere fallback logic para errores de parsing

---

### **OPCIÓN 3: Dos Llamadas IA Separadas**

1. Generar interpretación completa como ahora
2. Llamar a GPT-4 mini para extraer y estructurar secciones

**Ventajas:**
- ✅ No afecta interpretación actual

**Desventajas:**
- ❌ Costo adicional de API (~2x)
- ❌ Mayor latencia (~6-8s en vez de 3-4s)
- ❌ Más complejo de mantener
- ❌ No recomendado

---

## 🎨 EXPERIENCIA DE USUARIO PROPUESTA

### Vista Inicial (Gratis)

```
┌─────────────────────────────────────────┐
│ 🃏 Cartas (3)                           │
│ [Carta Pasado] [Carta Presente] [Futuro]│ ✅ SIEMPRE VISIBLE
└─────────────────────────────────────────┘

┌─────────────────────────────────────────┐
│ 📖 Interpretación                       │
│                                         │
│ Buenas tardes, Carlos...                │ ✅ GRATIS
│                                         │
│ **Pasado**                              │ ✅ GRATIS
│ El Loco en tu pasado indica...         │
│                                         │
│ **Presente**                            │ ✅ GRATIS
│ La carta del Presente revela...        │
│                                         │
│ **Futuro**                              │ 💰 PARCIAL
│ Hacia el futuro, las cartas...         │
│ muestran que tu camino hacia...        │
│ el amor verdadero estará lleno de...   │ ◀── TRUNCADO AQUÍ
│                                         │
│ ┌─────────────────────────────────────┐ │
│ │ 🔒 Desbloquear lectura completa     │ │
│ │    • Revelación completa del futuro │ │
│ │    • Síntesis de las 3 cartas       │ │
│ │    • Consejo personalizado          │ │
│ │                                     │ │
│ │    [💳 Pagar $1.00 USD]             │ │
│ └─────────────────────────────────────┘ │
└─────────────────────────────────────────┘
```

### Vista Después del Pago

```
┌─────────────────────────────────────────┐
│ 📖 Interpretación Completa ✅           │
│                                         │
│ Buenas tardes, Carlos...                │
│                                         │
│ **Pasado**                              │
│ El Loco en tu pasado indica...         │
│                                         │
│ **Presente**                            │
│ La carta del Presente revela...        │
│                                         │
│ **Futuro** (Completo)                   │ ✅ DESBLOQUEADO
│ [texto completo del futuro...]          │
│                                         │
│ **Síntesis**                            │ ✅ DESBLOQUEADO
│ En conjunto, estas tres cartas...       │
│                                         │
│ **Consejo**                             │ ✅ DESBLOQUEADO
│ Te aconsejo que...                      │
└─────────────────────────────────────────┘
```

---

## 🛠️ CAMBIOS NECESARIOS

### **BACKEND** (80% del trabajo)

#### 1. **Nuevas Tablas Supabase**

```sql
-- Tabla para almacenar lecturas completas
CREATE TABLE readings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL,
  conversation_id UUID,
  cards JSONB NOT NULL, -- Array de 3 cartas con toda su info
  interpretation_full JSONB NOT NULL, -- {saludo, pasado, presente, futuro, sintesis, consejo}
  question TEXT,
  created_at TIMESTAMP DEFAULT NOW(),

  INDEX idx_readings_user_id (user_id),
  INDEX idx_readings_conversation (conversation_id),
  INDEX idx_readings_created_at (created_at)
);

-- Tabla para registrar unlocks de lecturas
CREATE TABLE reading_unlocks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  reading_id UUID NOT NULL REFERENCES readings(id),
  unlocked_at TIMESTAMP DEFAULT NOW(),
  payment_order_id TEXT NOT NULL, -- ID de PayPal
  payment_amount NUMERIC DEFAULT 1.00,

  UNIQUE(user_id, reading_id),
  INDEX idx_unlocks_user_id (user_id),
  INDEX idx_unlocks_reading_id (reading_id)
);
```

#### 2. **Modificar Prompt del AGENTE INTÉRPRETE**

**Archivo**: `server.js:223-250`

**Cambio**: Agregar instrucción para retornar JSON estructurado en vez de texto plano.

**Ejemplo de nuevo prompt** (agregar al final):

```javascript
IMPORTANTE: Debes retornar tu respuesta en el siguiente formato JSON exacto:

{
  "saludo": "Tu saludo personalizado inicial",
  "pasado": "Interpretación completa de la carta del Pasado (3-4 oraciones)",
  "presente": "Interpretación completa de la carta del Presente (3-4 oraciones)",
  "futuro": "Interpretación completa de la carta del Futuro (4-5 oraciones)",
  "sintesis": "Síntesis unificada de las tres cartas (3-4 oraciones)",
  "consejo": "Consejo final accionable (2-3 oraciones)"
}

Cada campo debe ser un string de texto continuo (sin saltos de línea internos).
Mantén tu estilo místico, empático y poético en cada sección.
```

#### 3. **Nueva Lógica de Truncado Inteligente**

**Archivo**: Nuevo módulo `utils/truncate.js`

```javascript
/**
 * Trunca texto en preposición, conjunción, artículo o conector
 * para generar efecto cliffhanger
 */
export const truncateAtConnector = (text, options = {}) => {
  const {
    minLength = 100,  // Mínimo de caracteres a mostrar
    maxLength = 150,  // Máximo de caracteres a mostrar
    addEllipsis = true // Agregar "..." al final
  } = options;

  // Conectores en español (ordenados por prioridad de truncado)
  const connectors = [
    // Preposiciones comunes
    ' de ', ' a ', ' en ', ' para ', ' por ', ' con ', ' sin ', ' sobre ',
    ' hacia ', ' desde ', ' entre ', ' hasta ', ' mediante ',

    // Conjunciones
    ' y ', ' e ', ' o ', ' u ', ' pero ', ' aunque ', ' sino ', ' porque ',
    ' que ', ' cuando ', ' mientras ', ' si ',

    // Artículos + inicio de palabra
    ' el ', ' la ', ' los ', ' las ', ' un ', ' una ', ' unos ', ' unas ',

    // Pronombres relativos
    ' donde ', ' quien ', ' cual ', ' cuyo '
  ];

  // Si el texto es menor al mínimo, retornar completo
  if (text.length <= minLength) {
    return text;
  }

  // Buscar en el rango [minLength, maxLength]
  let bestPosition = -1;
  let bestConnector = '';

  for (const connector of connectors) {
    // Buscar todas las ocurrencias del conector
    let pos = text.indexOf(connector, minLength);

    while (pos !== -1 && pos <= maxLength) {
      // Preferir posiciones más cercanas a maxLength
      if (pos > bestPosition) {
        bestPosition = pos;
        bestConnector = connector;
      }
      pos = text.indexOf(connector, pos + 1);
    }
  }

  // Si encontramos un conector en el rango ideal
  if (bestPosition !== -1) {
    const truncated = text.substring(0, bestPosition);
    return addEllipsis ? truncated + '...' : truncated;
  }

  // Fallback: truncar en maxLength en el último espacio
  const fallbackPos = text.lastIndexOf(' ', maxLength);
  if (fallbackPos > minLength) {
    const truncated = text.substring(0, fallbackPos);
    return addEllipsis ? truncated + '...' : truncated;
  }

  // Último recurso: truncar en maxLength directamente
  const truncated = text.substring(0, maxLength);
  return addEllipsis ? truncated + '...' : truncated;
};

/**
 * Ejemplo de uso:
 *
 * const futuro = "Hacia el futuro, las cartas muestran que tu camino hacia el amor verdadero estará lleno de sorpresas inesperadas y encuentros significativos que transformarán tu vida.";
 *
 * truncateAtConnector(futuro);
 * // => "Hacia el futuro, las cartas muestran que tu camino hacia el amor verdadero estará lleno de..."
 */
```

#### 4. **Modificar Endpoint `/api/chat/message`**

**Archivo**: `server.js:251-350` (zona de procesamiento de respuesta)

**Cambios principales:**

```javascript
// ANTES (actual)
const content = completion.choices[0]?.message?.content || "";
res.write(`data: ${JSON.stringify({ interpretation: content })}\n\n`);

// DESPUÉS (propuesto)
const content = completion.choices[0]?.message?.content || "";

try {
  // Parsear JSON de la interpretación
  const interpretation = JSON.parse(content);

  // Truncar la sección de futuro
  const futuroTruncado = truncateAtConnector(interpretation.futuro, {
    minLength: 100,
    maxLength: 150
  });

  // Guardar lectura completa en BD
  const { data: reading, error: readingError } = await supabase
    .from('readings')
    .insert({
      user_id: userId,
      conversation_id: conversationId,
      cards: drawnCards, // las 3 cartas ya generadas
      interpretation_full: interpretation,
      question: userMessage
    })
    .select()
    .single();

  if (readingError) {
    console.error('Error saving reading:', readingError);
    throw readingError;
  }

  // Enviar versión preview al frontend
  const preview = {
    saludo: interpretation.saludo,
    pasado: interpretation.pasado,
    presente: interpretation.presente,
    futuroTruncado: futuroTruncado,
    // NO enviar sintesis ni consejo
  };

  res.write(`data: ${JSON.stringify({
    interpretationPreview: preview,
    readingId: reading.id,
    isUnlocked: false,
    unlockPrice: 1.00
  })}\n\n`);

} catch (parseError) {
  // Fallback si el JSON parsing falla
  console.error('Error parsing interpretation JSON:', parseError);
  res.write(`data: ${JSON.stringify({
    interpretation: content,
    error: 'formato_invalido'
  })}\n\n`);
}
```

#### 5. **Nuevos Endpoints de Unlock**

##### **POST `/api/readings/unlock/:readingId`**

Crea orden de pago PayPal para unlock.

```javascript
app.post("/api/readings/unlock/:readingId", async (req, res) => {
  try {
    const { readingId } = req.params;
    const { userId } = req.body;

    // Verificar que la lectura existe
    const { data: reading, error: readingError } = await supabase
      .from('readings')
      .select('id, user_id')
      .eq('id', readingId)
      .single();

    if (readingError || !reading) {
      return res.status(404).json({ error: 'Lectura no encontrada' });
    }

    // Verificar que pertenece al usuario
    if (reading.user_id !== userId) {
      return res.status(403).json({ error: 'No autorizado' });
    }

    // Verificar si ya está unlocked
    const { data: existingUnlock } = await supabase
      .from('reading_unlocks')
      .select('id')
      .eq('user_id', userId)
      .eq('reading_id', readingId)
      .single();

    if (existingUnlock) {
      return res.status(400).json({
        error: 'Lectura ya desbloqueada',
        alreadyUnlocked: true
      });
    }

    // Crear orden PayPal de $1.00
    const order = await paypalsdk.orders.create({
      body: {
        intent: "CAPTURE",
        purchase_units: [
          {
            amount: {
              currency_code: "USD",
              value: "1.00"
            },
            description: `Unlock de lectura de tarot - ID: ${readingId.substring(0, 8)}`
          }
        ],
        application_context: {
          brand_name: "Bottarot",
          landing_page: "NO_PREFERENCE",
          user_action: "PAY_NOW",
          return_url: `${process.env.FRONTEND_URL}/reading/${readingId}/success`,
          cancel_url: `${process.env.FRONTEND_URL}/reading/${readingId}/cancel`
        }
      }
    });

    // Guardar orden en payment_transactions
    await supabase.from('payment_transactions').insert({
      user_id: userId,
      paypal_order_id: order.result.id,
      amount: 1.00,
      status: 'created',
      transaction_data: {
        reading_id: readingId,
        type: 'reading_unlock'
      }
    });

    res.json({
      orderId: order.result.id,
      approvalUrl: order.result.links.find(link => link.rel === 'approve')?.href
    });

  } catch (error) {
    console.error('Error creating unlock order:', error);
    res.status(500).json({ error: 'Error al crear orden de pago' });
  }
});
```

##### **POST `/api/readings/confirm-unlock/:readingId`**

Captura pago y desbloquea contenido.

```javascript
app.post("/api/readings/confirm-unlock/:readingId", async (req, res) => {
  try {
    const { readingId } = req.params;
    const { userId, orderId } = req.body;

    // Capturar pago en PayPal
    const capture = await paypalsdk.orders.capture({
      id: orderId
    });

    if (capture.result.status !== 'COMPLETED') {
      return res.status(400).json({
        error: 'Pago no completado',
        status: capture.result.status
      });
    }

    // Registrar unlock en BD
    const { data: unlock, error: unlockError } = await supabase
      .from('reading_unlocks')
      .insert({
        user_id: userId,
        reading_id: readingId,
        payment_order_id: orderId,
        payment_amount: 1.00
      })
      .select()
      .single();

    if (unlockError) {
      console.error('Error saving unlock:', unlockError);
      return res.status(500).json({ error: 'Error al registrar unlock' });
    }

    // Actualizar transacción
    await supabase
      .from('payment_transactions')
      .update({
        status: 'completed',
        transaction_data: {
          reading_id: readingId,
          type: 'reading_unlock',
          captured_at: new Date().toISOString()
        }
      })
      .eq('paypal_order_id', orderId);

    // Obtener interpretación completa
    const { data: reading } = await supabase
      .from('readings')
      .select('interpretation_full')
      .eq('id', readingId)
      .single();

    res.json({
      success: true,
      unlocked: true,
      interpretation: reading.interpretation_full
    });

  } catch (error) {
    console.error('Error confirming unlock:', error);
    res.status(500).json({ error: 'Error al confirmar pago' });
  }
});
```

##### **GET `/api/readings/:readingId/status`**

Verifica si lectura está unlocked.

```javascript
app.get("/api/readings/:readingId/status", async (req, res) => {
  try {
    const { readingId } = req.params;
    const { userId } = req.query;

    // Verificar unlock
    const { data: unlock } = await supabase
      .from('reading_unlocks')
      .select('id, unlocked_at')
      .eq('user_id', userId)
      .eq('reading_id', readingId)
      .single();

    if (unlock) {
      // Ya está unlocked, retornar interpretación completa
      const { data: reading } = await supabase
        .from('readings')
        .select('interpretation_full, cards, question, created_at')
        .eq('id', readingId)
        .single();

      return res.json({
        isUnlocked: true,
        interpretation: reading.interpretation_full,
        cards: reading.cards,
        question: reading.question,
        createdAt: reading.created_at,
        unlockedAt: unlock.unlocked_at
      });
    }

    // No está unlocked, retornar preview
    const { data: reading } = await supabase
      .from('readings')
      .select('interpretation_full, cards, question, created_at')
      .eq('id', readingId)
      .single();

    const interpretation = reading.interpretation_full;
    const futuroTruncado = truncateAtConnector(interpretation.futuro, {
      minLength: 100,
      maxLength: 150
    });

    res.json({
      isUnlocked: false,
      interpretationPreview: {
        saludo: interpretation.saludo,
        pasado: interpretation.pasado,
        presente: interpretation.presente,
        futuroTruncado: futuroTruncado
      },
      cards: reading.cards,
      question: reading.question,
      createdAt: reading.created_at,
      unlockPrice: 1.00
    });

  } catch (error) {
    console.error('Error checking reading status:', error);
    res.status(500).json({ error: 'Error al verificar estado de lectura' });
  }
});
```

---

### **FRONTEND** (20% del trabajo)

#### 1. **State Management (Pinia)**

**Archivo**: `stores/reading.js` (crear si no existe)

```javascript
import { defineStore } from 'pinia';
import { ref } from 'vue';

export const useReadingStore = defineStore('reading', () => {
  const currentReading = ref(null);
  const isUnlocked = ref(false);
  const readingId = ref(null);

  /**
   * Unlock de lectura con PayPal
   */
  const unlockReading = async (readingIdToUnlock, userId) => {
    try {
      // 1. Crear orden de pago
      const createResponse = await fetch(
        `/api/readings/unlock/${readingIdToUnlock}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId })
        }
      );

      const { orderId, approvalUrl } = await createResponse.json();

      // 2. Redirigir a PayPal (o abrir popup)
      window.location.href = approvalUrl;

      // Nota: El callback de PayPal redirigirá a /reading/{id}/success
      // donde se llamará a confirmUnlock()

    } catch (error) {
      console.error('Error unlocking reading:', error);
      throw error;
    }
  };

  /**
   * Confirmar unlock después del pago
   */
  const confirmUnlock = async (readingIdToConfirm, userId, orderId) => {
    try {
      const response = await fetch(
        `/api/readings/confirm-unlock/${readingIdToConfirm}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId, orderId })
        }
      );

      const data = await response.json();

      if (data.success) {
        currentReading.value = data.interpretation;
        isUnlocked.value = true;
        readingId.value = readingIdToConfirm;
      }

      return data;

    } catch (error) {
      console.error('Error confirming unlock:', error);
      throw error;
    }
  };

  /**
   * Cargar estado de una lectura existente
   */
  const loadReading = async (readingIdToLoad, userId) => {
    try {
      const response = await fetch(
        `/api/readings/${readingIdToLoad}/status?userId=${userId}`
      );

      const data = await response.json();

      readingId.value = readingIdToLoad;
      isUnlocked.value = data.isUnlocked;

      if (data.isUnlocked) {
        currentReading.value = data.interpretation;
      } else {
        currentReading.value = data.interpretationPreview;
      }

      return data;

    } catch (error) {
      console.error('Error loading reading:', error);
      throw error;
    }
  };

  return {
    currentReading,
    isUnlocked,
    readingId,
    unlockReading,
    confirmUnlock,
    loadReading
  };
});
```

#### 2. **Componente de Interpretación**

**Archivo**: `components/ReadingInterpretation.vue`

```vue
<template>
  <div class="interpretation-container">
    <!-- Saludo -->
    <p class="saludo">{{ interpretation.saludo }}</p>

    <!-- Pasado (siempre visible) -->
    <section class="section-pasado">
      <h3>Pasado</h3>
      <p>{{ interpretation.pasado }}</p>
    </section>

    <!-- Presente (siempre visible) -->
    <section class="section-presente">
      <h3>Presente</h3>
      <p>{{ interpretation.presente }}</p>
    </section>

    <!-- Futuro (truncado si no está unlocked) -->
    <section class="section-futuro">
      <h3>Futuro</h3>
      <p v-if="isUnlocked">{{ interpretation.futuro }}</p>
      <div v-else>
        <p class="truncated">{{ interpretation.futuroTruncado }}</p>

        <!-- Botón de unlock -->
        <div class="unlock-box">
          <h4>🔒 Desbloquear lectura completa</h4>
          <ul>
            <li>Revelación completa del futuro</li>
            <li>Síntesis de las 3 cartas</li>
            <li>Consejo personalizado</li>
          </ul>
          <button @click="handleUnlock" class="unlock-button">
            💳 Pagar $1.00 USD
          </button>
        </div>
      </div>
    </section>

    <!-- Síntesis (solo si está unlocked) -->
    <section v-if="isUnlocked" class="section-sintesis">
      <h3>Síntesis</h3>
      <p>{{ interpretation.sintesis }}</p>
    </section>

    <!-- Consejo (solo si está unlocked) -->
    <section v-if="isUnlocked" class="section-consejo">
      <h3>Consejo</h3>
      <p>{{ interpretation.consejo }}</p>
    </section>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { useReadingStore } from '@/stores/reading';

const props = defineProps({
  interpretation: {
    type: Object,
    required: true
  },
  readingId: {
    type: String,
    required: true
  }
});

const readingStore = useReadingStore();
const isUnlocked = computed(() => readingStore.isUnlocked);

const handleUnlock = async () => {
  try {
    const userId = 'USER_ID_AQUI'; // Obtener del auth store
    await readingStore.unlockReading(props.readingId, userId);
  } catch (error) {
    console.error('Error unlocking:', error);
    alert('Error al procesar el pago. Intenta nuevamente.');
  }
};
</script>

<style scoped>
.interpretation-container {
  padding: 20px;
  max-width: 800px;
  margin: 0 auto;
}

.saludo {
  font-style: italic;
  margin-bottom: 20px;
  color: #666;
}

section {
  margin-bottom: 30px;
}

h3 {
  font-size: 1.2em;
  margin-bottom: 10px;
  color: #4a148c;
}

.truncated {
  position: relative;
}

.unlock-box {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
  padding: 20px;
  border-radius: 10px;
  margin-top: 20px;
  text-align: center;
}

.unlock-box h4 {
  margin-bottom: 15px;
}

.unlock-box ul {
  list-style: none;
  padding: 0;
  margin: 15px 0;
}

.unlock-box li {
  margin: 8px 0;
}

.unlock-button {
  background: white;
  color: #764ba2;
  border: none;
  padding: 12px 30px;
  font-size: 1.1em;
  font-weight: bold;
  border-radius: 5px;
  cursor: pointer;
  transition: transform 0.2s;
}

.unlock-button:hover {
  transform: scale(1.05);
}
</style>
```

#### 3. **Página de Callback PayPal**

**Archivo**: `pages/reading/[id]/success.vue`

```vue
<template>
  <div class="success-page">
    <div v-if="loading">
      <h2>Procesando tu pago...</h2>
      <p>Un momento, estamos desbloqueando tu lectura completa.</p>
    </div>

    <div v-else-if="error">
      <h2>Error al procesar el pago</h2>
      <p>{{ error }}</p>
      <button @click="$router.push('/chat')">Volver al inicio</button>
    </div>

    <div v-else-if="success">
      <h2>¡Lectura desbloqueada exitosamente!</h2>
      <p>Ya puedes ver la interpretación completa.</p>
      <ReadingInterpretation
        :interpretation="interpretation"
        :reading-id="readingId"
      />
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useReadingStore } from '@/stores/reading';
import ReadingInterpretation from '@/components/ReadingInterpretation.vue';

const route = useRoute();
const router = useRouter();
const readingStore = useReadingStore();

const readingId = ref(route.params.id);
const loading = ref(true);
const error = ref(null);
const success = ref(false);
const interpretation = ref(null);

onMounted(async () => {
  try {
    // Obtener orderId de query params
    const orderId = route.query.token; // PayPal usa "token" como param
    const userId = 'USER_ID_AQUI'; // Obtener del auth store

    if (!orderId) {
      throw new Error('No se encontró el ID de orden');
    }

    // Confirmar unlock
    const result = await readingStore.confirmUnlock(
      readingId.value,
      userId,
      orderId
    );

    if (result.success) {
      success.value = true;
      interpretation.value = result.interpretation;
    } else {
      throw new Error('No se pudo confirmar el pago');
    }

  } catch (err) {
    console.error('Error in success callback:', err);
    error.value = err.message;
  } finally {
    loading.value = false;
  }
});
</script>
```

#### 4. **Modificar SSE Handler en Chat**

**Archivo**: `composables/useChat.js` (o donde se maneje el SSE)

```javascript
// ANTES
eventSource.addEventListener('interpretation', (e) => {
  const data = JSON.parse(e.data);
  currentInterpretation.value = data.text;
});

// DESPUÉS
eventSource.addEventListener('interpretation', (e) => {
  const data = JSON.parse(e.data);

  if (data.interpretationPreview) {
    // Nueva lectura con preview
    currentInterpretation.value = data.interpretationPreview;
    currentReadingId.value = data.readingId;
    isUnlocked.value = data.isUnlocked;
    unlockPrice.value = data.unlockPrice;
  } else if (data.text) {
    // Follow-up (formato antiguo)
    currentInterpretation.value = { text: data.text };
  }
});
```

---

## 💰 CONSIDERACIONES DE NEGOCIO

### **Análisis Financiero**

| Concepto | Valor |
|----------|-------|
| Precio por unlock | $1.00 USD |
| Fee PayPal (tarifa fija) | $0.30 |
| Fee PayPal (%) | 2.9% ($0.029) |
| **Fee total PayPal** | **~$0.49** |
| **Ganancia neta** | **~$0.51** |
| **Margen** | **51%** |

### **Optimizaciones Futuras**

#### **Paquetes de Créditos**
```
• 1 unlock  = $1.00  ($1.00/unlock)
• 5 unlocks = $4.00  ($0.80/unlock) - ahorro 20%
• 10 unlocks = $7.00 ($0.70/unlock) - ahorro 30%
```

Mejora el margen y reduce fees proporcionales de PayPal.

#### **Suscripción Mensual**
```
• Free: 3 lecturas completas/mes
• Premium: Lecturas ilimitadas completas por $9.99/mes
```

Ingreso recurrente predecible y mejor margen.

#### **Unlock Gratuito Diferido**
```
• Unlock automático después de 7 días
• Urgencia aumenta conversión inmediata
• Los pacientes obtienen gratis (goodwill)
```

### **Conversión Esperada**

**Factores de éxito:**
- ✅ Precio bajo ($1) = baja fricción
- ✅ Usuario ya vio valor (Pasado/Presente)
- ✅ Cliffhanger bien diseñado = alta curiosidad
- ✅ Proceso de pago rápido (PayPal)

**Estimación conservadora:**
- 15-25% de conversión en primer mes
- 25-35% después de optimizaciones

**Ejemplo con 1000 lecturas/mes:**
- Conversión 20% = 200 unlocks
- Ingreso = $200 USD
- Ganancia neta = ~$102 USD

---

## 📋 DECISIONES PENDIENTES

Antes de implementar, necesitas definir:

### **1. Formato de Interpretación**
- [ ] **Opción A**: JSON estructurado (recomendado)
- [ ] **Opción B**: Markdown con marcadores
- [ ] **Opción C**: Dos llamadas IA

**Recomendación**: Opción A (JSON)

---

### **2. Contenido Premium Exacto**

- [x] **Futuro truncado** ✅ Confirmado
- [x] **Síntesis completa es premium** ✅ Confirmado
- [x] **Consejo completo es premium** ✅ Confirmado
- [ ] **¿El saludo inicial es gratis o premium?**

**Recomendación**: Saludo gratis (mejor UX)

---

### **3. Longitud del Teaser del Futuro**

- [ ] Mostrar primeras **100 caracteres**
- [ ] Mostrar primeras **150 caracteres** (recomendado)
- [ ] Mostrar primeras **200 caracteres**

**Recomendación**: 100-150 caracteres (2-3 oraciones)

---

### **4. Estrategia de Truncado**

- [ ] **Opción A**: Truncar SIEMPRE en conector (máximo suspenso)
- [ ] **Opción B**: Permitir completar oración si está cerca

**Recomendación**: Opción A (más engaging)

**Ejemplo:**
```
✅ BUENO: "...tu camino hacia el amor verdadero estará lleno de..."
❌ MALO:  "...tu camino hacia el amor verdadero estará lleno de sorpresas."
```

---

### **5. Persistencia de Unlocks**

- [ ] **Opción A**: Unlocks permanentes (recomendado)
- [ ] **Opción B**: Unlocks expiran después de 30 días

**Recomendación**: Permanentes (mejor experiencia, genera confianza)

---

### **6. Historial de Lecturas**

- [ ] **Opción A**: Guardar TODAS las lecturas en BD (recomendado)
- [ ] **Opción B**: Solo guardar lecturas unlocked
- [ ] **Opción C**: No guardar historial

**Recomendación**: Opción A
- Permite remarketing ("¿Quieres desbloquear tu lectura del 5 de noviembre?")
- Analytics de conversión
- Mejor UX

---

### **7. Interfaz de Pago**

- [ ] **Opción A**: Redirect a PayPal (más simple)
- [ ] **Opción B**: Popup de PayPal (mejor UX, más complejo)
- [ ] **Opción C**: Modal con PayPal SDK embebido

**Recomendación**: Empezar con A, migrar a B después

---

## 🚀 PRÓXIMOS PASOS

### **Fase 1: Backend Core** (Estimado: 4-6 horas)
1. ✅ Crear tablas en Supabase (`readings`, `reading_unlocks`)
2. ✅ Modificar prompt del AGENTE INTÉRPRETE para JSON
3. ✅ Implementar función de truncado inteligente
4. ✅ Modificar endpoint `/api/chat/message` para guardar lecturas
5. ✅ Crear endpoint `/api/readings/unlock/:id`
6. ✅ Crear endpoint `/api/readings/confirm-unlock/:id`
7. ✅ Crear endpoint `/api/readings/:id/status`

### **Fase 2: Frontend** (Estimado: 3-4 horas)
1. ✅ Crear/actualizar Pinia store de readings
2. ✅ Crear componente `ReadingInterpretation.vue`
3. ✅ Crear página de callback PayPal
4. ✅ Modificar handler SSE para nuevo formato
5. ✅ Agregar estilos y animaciones

### **Fase 3: Testing** (Estimado: 2-3 horas)
1. ✅ Test de generación de interpretación JSON
2. ✅ Test de truncado en diferentes escenarios
3. ✅ Test de flujo de pago completo (sandbox PayPal)
4. ✅ Test de persistencia y recuperación de lecturas
5. ✅ Test de edge cases (pago fallido, timeout, etc.)

### **Fase 4: Optimizaciones** (Estimado: 2-3 horas)
1. ✅ Analytics de conversión
2. ✅ A/B testing de longitud de truncado
3. ✅ Remarketing de lecturas no unlocked
4. ✅ Optimización de prompt para mejor cliffhanger

---

## 🧪 PLAN DE TESTING

### **Testing de Truncado**

```javascript
// test/truncate.test.js
import { truncateAtConnector } from '../utils/truncate';

describe('Truncado inteligente', () => {
  it('debe truncar en preposición', () => {
    const text = 'Hacia el futuro, las cartas muestran que tu camino hacia el amor verdadero estará lleno de sorpresas inesperadas.';
    const result = truncateAtConnector(text, { maxLength: 100 });
    expect(result).toContain('...');
    expect(result).toMatch(/ (de|a|en|para|por|con|hacia)\.\.\.$/);
  });

  it('debe respetar longitud mínima', () => {
    const text = 'Texto corto.';
    const result = truncateAtConnector(text, { minLength: 100 });
    expect(result).toBe(text);
  });
});
```

### **Testing de Endpoints**

```bash
# Test crear orden unlock
curl -X POST http://localhost:3000/api/readings/unlock/UUID_AQUI \
  -H "Content-Type: application/json" \
  -d '{"userId":"user-123"}'

# Test verificar estado
curl http://localhost:3000/api/readings/UUID_AQUI/status?userId=user-123
```

---

## 📊 MÉTRICAS A MONITOREAR

### **Métricas de Conversión**
- [ ] Tasa de conversión global (unlocks / lecturas totales)
- [ ] Tasa de conversión por longitud de truncado
- [ ] Tiempo promedio hasta unlock (inmediato vs días después)
- [ ] Tasa de abandono en pago

### **Métricas de Negocio**
- [ ] Ingreso total por unlocks
- [ ] Ingreso neto (después de fees)
- [ ] Valor promedio por usuario
- [ ] Tasa de retención de usuarios pagadores

### **Métricas Técnicas**
- [ ] Latencia de generación de interpretación
- [ ] Tasa de error en parsing JSON
- [ ] Tasa de fallo de pagos PayPal
- [ ] Tiempo de respuesta de endpoints

---

## ⚠️ RIESGOS Y MITIGACIONES

### **Riesgo 1: IA no genera JSON válido**
**Mitigación:**
- Implementar validación con schema JSON
- Fallback a formato texto plano
- Retry con prompt ajustado

### **Riesgo 2: Truncado muy corto o muy largo**
**Mitigación:**
- A/B testing de longitudes
- Analytics de conversión por variante
- Ajuste dinámico basado en datos

### **Riesgo 3: Baja tasa de conversión**
**Mitigación:**
- Optimizar cliffhanger (A/B testing)
- Ofrecer preview de síntesis (1 oración)
- Remarketing por email/push

### **Riesgo 4: Fraude o chargebacks**
**Mitigación:**
- Validar user_id en todos los endpoints
- Registro completo de transacciones
- Política de no reembolso clara

### **Riesgo 5: Problemas con PayPal API**
**Mitigación:**
- Retry logic con exponential backoff
- Fallback a modo manual
- Monitoreo de uptime de PayPal

---

## 🎯 CRITERIOS DE ÉXITO

### **Criterios Mínimos (MVP)**
- [x] Usuario puede ver interpretación truncada
- [x] Usuario puede pagar $1 para unlock
- [x] Contenido se desbloquea tras pago exitoso
- [x] Unlock es persistente

### **Criterios de Calidad**
- [ ] Tasa de conversión > 15%
- [ ] < 2% de errores en pagos
- [ ] Latencia < 5s para generación
- [ ] 100% de unlocks se persisten correctamente

### **Criterios de Excelencia**
- [ ] Tasa de conversión > 25%
- [ ] NPS > 8/10
- [ ] < 1% de chargebacks
- [ ] Remarketing automático funcional

---

## 📚 RECURSOS Y REFERENCIAS

### **Documentación Técnica**
- [PayPal Orders API](https://developer.paypal.com/docs/api/orders/v2/)
- [Supabase JavaScript Client](https://supabase.com/docs/reference/javascript)
- [OpenAI JSON Mode](https://platform.openai.com/docs/guides/structured-outputs)

### **Archivos Relevantes**
- `/home/user/Bottarot-Backend/server.js` - Backend principal
- `/home/user/Bottarot-Backend/paypal-config.js` - Configuración PayPal
- `/home/user/Bottarot-Backend/data/tarotDeck.js` - Baraja de cartas

### **Variables de Entorno Necesarias**
```env
# Existentes
SUPABASE_URL=
SUPABASE_SERVICE_KEY=
OPENAI_API_KEY=
PAYPAL_CLIENT_ID=
PAYPAL_CLIENT_SECRET=
PAYPAL_ENVIRONMENT=sandbox # o production

# Nuevas
FRONTEND_URL=https://tu-frontend.com
UNLOCK_PRICE=1.00
```

---

## 🤝 PREGUNTAS FRECUENTES

### **¿Qué pasa si el usuario ya pagó pero pierde la conexión?**
- El unlock queda registrado en `reading_unlocks`
- Al recargar la página, `/api/readings/:id/status` retornará `isUnlocked: true`
- El usuario ve la interpretación completa sin pagar de nuevo

### **¿Se puede desbloquear una lectura antigua?**
- Sí, todas las lecturas se guardan en `readings`
- El usuario puede acceder desde historial y pagar para unlock
- Posible feature de remarketing: "Tienes 3 lecturas sin desbloquear"

### **¿Qué pasa con las lecturas follow-up?**
- Las follow-up NO generan nuevas cartas
- Por lo tanto, NO se cobran
- Usan el contexto de la lectura original (que puede estar o no unlocked)

### **¿Se puede hacer refund?**
- Técnicamente sí (via PayPal API)
- Requiere eliminar el registro en `reading_unlocks`
- Recomendación: Política de no reembolso (contenido digital inmediato)

---

## 📅 CRONOGRAMA ESTIMADO

### **Semana 1: Backend**
- **Día 1-2**: Tablas Supabase + modificación prompt + truncado
- **Día 3-4**: Endpoints de unlock + integración PayPal
- **Día 5**: Testing backend + fixes

### **Semana 2: Frontend**
- **Día 1-2**: Componentes + Pinia store
- **Día 3-4**: Integración PayPal + callbacks
- **Día 5**: Estilos + UX polish

### **Semana 3: Testing & Launch**
- **Día 1-2**: Testing end-to-end
- **Día 3**: Beta testing con usuarios reales
- **Día 4**: Fixes + optimizaciones
- **Día 5**: Launch público

---

## ✅ CHECKLIST DE IMPLEMENTACIÓN

### **Pre-implementación**
- [ ] Decidir formato de interpretación (JSON vs Markdown)
- [ ] Definir longitud de truncado (100-150 chars)
- [ ] Configurar PayPal Sandbox
- [ ] Crear tablas en Supabase

### **Backend**
- [ ] Modificar prompt AGENTE INTÉRPRETE
- [ ] Implementar función `truncateAtConnector()`
- [ ] Modificar endpoint `/api/chat/message`
- [ ] Crear endpoint `POST /api/readings/unlock/:id`
- [ ] Crear endpoint `POST /api/readings/confirm-unlock/:id`
- [ ] Crear endpoint `GET /api/readings/:id/status`
- [ ] Testing de endpoints

### **Frontend**
- [ ] Crear/actualizar Pinia store
- [ ] Crear componente `ReadingInterpretation.vue`
- [ ] Crear página callback PayPal
- [ ] Modificar handler SSE
- [ ] Estilos y UX
- [ ] Testing de flujo completo

### **Testing**
- [ ] Test de generación JSON
- [ ] Test de truncado
- [ ] Test de pago sandbox
- [ ] Test de persistencia
- [ ] Test de edge cases

### **Launch**
- [ ] Migrar a PayPal Production
- [ ] Deploy backend
- [ ] Deploy frontend
- [ ] Monitoreo de errores
- [ ] Analytics configurados

---

## 🎉 CONCLUSIÓN

Este plan de monetización es **viable, escalable y de bajo riesgo**:

✅ **Implementación moderada** (2-3 semanas)
✅ **Inversión inicial baja** (solo tiempo de desarrollo)
✅ **Precio atractivo** ($1 = alta conversión esperada)
✅ **Margen aceptable** (51% después de fees)
✅ **Escalable** (paquetes y suscripciones después)

**Siguiente paso recomendado:**
1. Resolver las 7 decisiones pendientes
2. Crear tablas en Supabase
3. Comenzar con Fase 1 (Backend Core)

---

**¿Listo para empezar la implementación?** 🚀
