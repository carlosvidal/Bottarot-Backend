import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import { OpenAI } from "openai";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { tarotDeck } from "./data/tarotDeck.js";

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

const app = express();
app.use(cors());
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- AGENT SYSTEM PROMPTS ---
const DECIDER_SYSTEM_PROMPT = `Eres el "Agente Decisor" de un oráculo de tarot. Tu única función es analizar la pregunta de un usuario y clasificarla en una de las siguientes categorías, devolviendo únicamente un objeto JSON.

### Categorías de Decisión:

1.  **requires_new_draw**: La pregunta es una consulta de tarot válida y requiere una nueva tirada de cartas.
    *   Ejemplos:
        - "¿Qué me depara el futuro en el amor?"
        - "Necesito una guía sobre mi carrera"
        - "Háblame de mi energía esta semana"
        - "¿Qué dicen las cartas para mí el día de hoy?"
        - "¿Qué me deparan las cartas?"
        - "¿Cómo estará mi día/semana/mes?"
    *   **IMPORTANTE**: Cualquier pregunta que mencione "cartas", "tirada", "lectura", o pida orientación sobre un tema SIEMPRE es requires_new_draw.

2.  **is_follow_up**: La pregunta es un seguimiento, aclaración o profundización sobre la última interpretación de tarot que diste.
    *   **Importante**: Solo es posible a partir de la segunda pregunta del usuario. La primera pregunta NUNCA puede ser is_follow_up.
    *   Ejemplos: "¿Qué significa la carta del medio?", "¿Puedes darme un consejo más práctico sobre eso?", "¿A qué te refieres con 'energía bloqueada'?".
    *   **Clave**: Debe hacer referencia a una interpretación ANTERIOR que ya existe en el historial.
    *   **REGLA CRÍTICA**: Si la pregunta pide UNA NUEVA LECTURA (menciona "cartas", "nueva tirada", "qué dicen las cartas", "hazme una lectura"), NO es follow-up, es requires_new_draw, incluso si hay historial previo.

3.  **is_inadequate**: La pregunta no es adecuada para una lectura de tarot.
    *   **Sub-categorías de is_inadequate**:
        *   **Soporte/Técnica**: Preguntas sobre la app, suscripciones, pagos, etc. (Ej: "¿Cómo cancelo mi suscripción?").
        *   **Fuera de Contexto**: Saludos SOLOS sin pregunta de tarot, preguntas sin relación, bromas, pruebas. (Ej: SOLO "Hola", SOLO "¿Cuánto es 2+2?", "jajaja", "prueba").
        *   **Petición de Clarificación**: La pregunta es demasiado vaga o le falta contexto para hacer una tirada útil. (Ej: SOLO "ayuda", SOLO "?", SOLO "no se").
    *   **NOTA CRÍTICA**: Si la pregunta incluye saludos PERO también pide una lectura de cartas, clasifícala como requires_new_draw.

### Formato de Respuesta:

Debes responder **únicamente** con un objeto JSON. No añadas explicaciones ni texto adicional.

**Para requires_new_draw:**
{"type": "requires_new_draw"}

**Para is_follow_up:**
{"type": "is_follow_up"}

**Para is_inadequate:**
{"type": "is_inadequate", "response": "Aquí va la respuesta pre-generada para el usuario."}

### Ejemplos de Respuestas is_inadequate:
*   Si preguntan por soporte: {"type": "is_inadequate", "response": "Soy un oráculo de tarot y no puedo ayudarte con asuntos técnicos o de suscripción. Por favor, contacta a soporte para obtener ayuda."}
*   Si la pregunta es vaga: {"type": "is_inadequate", "response": "Para que las cartas te ofrezcan una guía clara, necesito que me des un poco más de contexto. ¿Sobre qué área de tu vida te gustaría preguntar?"}
*   Si es SOLO un saludo sin pregunta: {"type": "is_inadequate", "response": "El oráculo está listo. Formula tu pregunta cuando quieras."}
`;
const INTERPRETER_SYSTEM_PROMPT = `Eres una experta en tarot con décadas de experiencia, especializada en interpretaciones intuitivas y empáticas. Tu estilo combina profundidad simbólica con consejos prácticos.

### Reglas Clave:
1.  **Relaciona Siempre**: Conecta cada carta y la interpretación general directamente con la **pregunta del usuario**.
2.  **Contexto Personal**: Si se te proporciona información del consultante (nombre, edad, etc.), **úsala** para personalizar el saludo y el tono. (Ej: "Buenas noches, Carlos. Veo que tu cumpleaños se acerca, una época potente para la reflexión. Analicemos tu pregunta sobre tu carrera...").
3.  **Historial de Chat**: Si hay un historial, úsalo para dar continuidad a la conversación. Evita repetir lo que ya dijiste.
4.  **Tono**: Místico, poético, pero claro y accionable. Usa un lenguaje empático y evita afirmaciones absolutas o catastróficas.
5.  **Estructura**:
    *   **Saludo y Conexión**: Saluda (si hay contexto personal) y conecta con la pregunta.
    *   **Análisis de Cartas**: Describe brevemente cada carta en su posición.
    *   **Síntesis**: Unifica el mensaje de las cartas en una narrativa coherente.
    *   **Consejo Final**: Ofrece una reflexión o un consejo práctico basado en la tirada.
`;

// =======================================
// HELPER FUNCTIONS
// =======================================

const drawCards = (numCards = 3) => {
    const deck = [...tarotDeck];
    const drawn = [];
    const positions = ['Pasado', 'Presente', 'Futuro'];

    for (let i = 0; i < numCards; i++) {
        if (deck.length === 0) break;

        const randomIndex = Math.floor(Math.random() * deck.length);
        const card = deck.splice(randomIndex, 1)[0];
        const upright = Math.random() < 0.5;

        drawn.push({
            ...card,
            upright: upright,
            orientation: upright ? 'Derecha' : 'Invertida',
            posicion: positions[i] || `Posición ${i + 1}`,
        });
    }
    return drawn;
};

// =======================================
// NEW MAIN CHAT ENDPOINT
// =======================================

app.post("/api/chat/message", async (req, res) => {
    const { question, history, personalContext, userId, chatId } = req.body;

    if (!question) {
        return res.status(400).json({ error: "La pregunta (question) es requerida." });
    }

    try {
        // --- 1. AGENT DECISOR ---
        console.log(`[${chatId}] 🧐 Agente Decisor analizando: "${question.substring(0, 50)}"...`);

        const historyForDecider = history ? history.map(msg => `${msg.role}: ${msg.content}`).join('\n') : '';
        const deciderPrompt = `
        Historial de la conversación:
        ${historyForDecider}

        Pregunta actual del usuario: "${question}"
        `;

        const deciderCompletion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: DECIDER_SYSTEM_PROMPT },
                { role: "user", content: deciderPrompt },
            ],
            response_format: { type: "json_object" },
            temperature: 0,
        });

        const decision = JSON.parse(deciderCompletion.choices[0].message.content);
        console.log(`[${chatId}] ✅ Decisión: ${decision.type}`);

        // --- 2. LOGIC BASED ON DECISION ---

        // CASE 1: La pregunta no es adecuada
        if (decision.type === 'is_inadequate') {
            console.log(`[${chatId}] 💬 Respondiendo con mensaje de clarificación/inadecuado.`);
            return res.json({
                type: 'message',
                text: decision.response,
                role: 'assistant'
            });
        }

        // CASE 2: La pregunta es un seguimiento
        if (decision.type === 'is_follow_up') {
            console.log(`[${chatId}] 🧠 Gestionando pregunta de seguimiento.`);
            const followUpPrompt = `
            ${personalContext || ''}

            **Historial de la Conversación:**
            ${history.map(msg => `${msg.role === 'user' ? 'Consultante' : 'Oráculo'}: ${msg.content}`).join('\n\n')}

            **Pregunta de Seguimiento del Consultante:** "${question}"

            ---
            Eres una experta en tarot. Responde a la pregunta de seguimiento del consultante basándote **estrictamente** en la información de la tirada anterior que se encuentra en el historial. No inventes nuevas cartas ni conceptos. Sé concisa y directa.
            `;

            const followUpCompletion = await openai.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [
                    { role: "system", content: INTERPRETER_SYSTEM_PROMPT },
                    { role: "user", content: followUpPrompt },
                ],
            });
            const interpretation = followUpCompletion.choices[0].message.content;
            console.log(`[${chatId}] ✅ Respuesta de seguimiento generada.`);
            return res.json({
                type: 'message',
                text: interpretation,
                role: 'assistant'
            });
        }

        // CASE 3: La pregunta requiere una nueva tirada
        if (decision.type === 'requires_new_draw') {
            // Configure SSE headers
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.flushHeaders(); // Enviar headers inmediatamente

            // PASO 1: Tirar cartas INMEDIATAMENTE (sin esperar nada)
            console.log(`[${chatId}] 🃏 Realizando nueva tirada de cartas.`);
            const drawnCards = drawCards(3);

            // PASO 2: Enviar cartas al cliente SIN DEMORA
            console.log(`[${chatId}] 📤 Enviando cartas al cliente INMEDIATAMENTE...`);
            res.write(`event: cards\n`);
            res.write(`data: ${JSON.stringify({ cards: drawnCards })}\n\n`);
            // Forzar flush del buffer para que el cliente reciba las cartas YA
            if (res.flush) res.flush();

            // PASO 3: Generar título en paralelo (no bloqueante) si es primer mensaje
            let titlePromise = null;
            if (!history || history.length === 0) {
                console.log(`[${chatId}] ✍️ Generando título en background...`);
                titlePromise = openai.chat.completions.create({
                    model: "gpt-4o-mini",
                    messages: [
                        { role: "system", content: "Eres un experto en SEO. Resume la siguiente pregunta en un título corto y atractivo de 3 a 5 palabras para un historial de chat. Responde únicamente con el título." },
                        { role: "user", content: question },
                    ],
                    temperature: 0.7,
                    max_tokens: 20,
                }).catch(err => {
                    console.error(`[${chatId}] ❌ Error generating title:`, err);
                    return null;
                });
            }

            const historyForInterpreter = history ? history.map(msg => `${msg.role === 'user' ? 'Consultante' : 'Oráculo'}: ${msg.content}`).join('\n\n') : '';
            const interpreterPrompt = `
            ${personalContext || ''}

            ${historyForInterpreter ? `---
**Historial de la Conversación Anterior:**
${historyForInterpreter}
---` : ''}

            **Pregunta Actual del Consultante:** "${question}"

            **Cartas para esta pregunta:**
            ${drawnCards.map((carta, index) => `${index + 1}. ${carta.name} - ${carta.orientation} (Posición: ${carta.posicion})`).join("\n")}

            ---
            Por favor, genera una interpretación de tarot.
            `;

            // PASO 4: Generar interpretación (la parte que toma tiempo)
            console.log(`[${chatId}] 🔮 Agente Intérprete generando...`);
            const interpreterCompletion = await openai.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [
                    { role: "system", content: INTERPRETER_SYSTEM_PROMPT },
                    { role: "user", content: interpreterPrompt },
                ],
            });
            const interpretation = interpreterCompletion.choices[0].message.content;
            console.log(`[${chatId}] ✅ Interpretación generada.`);

            // PASO 5: Enviar interpretación al cliente
            console.log(`[${chatId}] 📤 Enviando interpretación al cliente...`);
            res.write(`event: interpretation\n`);
            res.write(`data: ${JSON.stringify({ text: interpretation })}\n\n`);

            // PASO 6: Enviar título si está disponible (fue generado en paralelo)
            if (titlePromise) {
                try {
                    const titleCompletion = await titlePromise;
                    if (titleCompletion) {
                        const generatedTitle = titleCompletion.choices[0]?.message?.content.replace(/"/g, '') || question.substring(0, 40);
                        console.log(`[${chatId}] 📝 Título generado: "${generatedTitle}"`);

                        res.write(`event: title\n`);
                        res.write(`data: ${JSON.stringify({ title: generatedTitle })}\n\n`);

                        // Opcional: Guardar en Supabase
                        // await supabase.rpc('update_chat_title', {
                        //     p_chat_id: chatId,
                        //     p_user_id: userId,
                        //     p_new_title: generatedTitle
                        // });
                    }
                } catch (titleError) {
                    console.error(`[${chatId}] ❌ Error esperando título:`, titleError);
                }
            }

            // PASO 7: Evento DONE para cerrar el stream
            res.write(`event: done\n`);
            res.write(`data: ${JSON.stringify({ complete: true })}\n\n`);

            return res.end();
        }

        // Fallback por si la decisión no es ninguna de las esperadas
        throw new Error(`Decisión desconocida del Agente Decisor: ${decision.type}`);

    } catch (err) {
        console.error(`[${chatId}] ❌ Error en el flujo del chat:`, err);
        res.status(500).json({ error: "Ocurrió un error al procesar tu pregunta." });
    }
});


// =======================================
// PAYPAL & OTHER ENDPOINTS (UNCHANGED)
// =======================================

// Version check endpoint for debugging deployments
app.get("/api/version", (req, res) => {
  res.json({
    version: "3.1-instant-cards",
    commit: "785bb30",
    features: [
      "sse-streaming",
      "instant-cards-delivery",
      "parallel-title-generation",
      "improved-decisor",
      "tts-cache"
    ],
    performance: {
      cardsDelivery: "~50-100ms",
      interpretationDelivery: "~3-4s"
    },
    timestamp: new Date().toISOString()
  });
});

// Warmup ping endpoint for Render.com free tier
app.get("/ping", (req, res) => {
  const serverTime = Date.now();
  console.log('🔥 Warmup ping received at:', new Date().toISOString());
  res.json({
    ok: true,
    time: serverTime,
    message: "El oráculo está despierto",
    timestamp: new Date().toISOString()
  });
});

// Simple in-memory cache for TTS (consider using Redis for production)
const ttsCache = new Map();
const MAX_CACHE_SIZE = 50;

// Text-to-Speech endpoint using ElevenLabs
app.post("/api/tts", async (req, res) => {
  try {
    const { text } = req.body;

    if (!text) {
      return res.status(400).json({ error: "Text is required" });
    }

    // Check cache first
    const cacheKey = `${text.substring(0, 100)}`;
    if (ttsCache.has(cacheKey)) {
      console.log(`✅ TTS cache hit for ${text.length} characters`);
      const cachedAudio = ttsCache.get(cacheKey);
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('X-Cache', 'HIT');
      return res.send(cachedAudio);
    }

    const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
    const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM"; // Rachel voice by default

    if (!ELEVENLABS_API_KEY) {
      console.error("❌ ELEVENLABS_API_KEY not configured");
      return res.status(500).json({ error: "TTS service not configured" });
    }

    console.log(`🎙️ Generating TTS for ${text.length} characters...`);

    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`, {
      method: 'POST',
      headers: {
        'Accept': 'audio/mpeg',
        'Content-Type': 'application/json',
        'xi-api-key': ELEVENLABS_API_KEY
      },
      body: JSON.stringify({
        text: text,
        model_id: "eleven_multilingual_v2",
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75
        }
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('❌ ElevenLabs API error:', errorText);
      return res.status(response.status).json({ error: "TTS generation failed" });
    }

    // Read the audio data
    const audioBuffer = await response.arrayBuffer();
    const audioData = Buffer.from(audioBuffer);

    // Cache the audio (limit cache size)
    if (ttsCache.size >= MAX_CACHE_SIZE) {
      const firstKey = ttsCache.keys().next().value;
      ttsCache.delete(firstKey);
    }
    ttsCache.set(cacheKey, audioData);

    // Send the audio back to the client
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('X-Cache', 'MISS');
    res.send(audioData);

  } catch (error) {
    console.error("❌ Error in TTS endpoint:", error);
    res.status(500).json({ error: "Failed to generate speech" });
  }
});

// Get subscription plans
app.get("/api/subscription-plans", async (req, res) => {
  try {
    const { data: plans, error } = await supabase
      .from('subscription_plans')
      .select('*')
      .eq('is_active', true)
      .order('price', { ascending: true });

    if (error) throw error;

    res.json({ plans });
  } catch (err) {
    console.error("Error fetching subscription plans:", err);
    res.status(500).json({ error: "No se pudieron obtener los planes." });
  }
});

// Create PayPal order
app.post("/api/payments/create-order", async (req, res) => {
  try {
    const { planId, userId } = req.body;

    if (!planId || !userId) {
      return res.status(400).json({ error: "planId y userId son requeridos" });
    }

    const { data: plan, error: planError } = await supabase
      .from('subscription_plans')
      .select('*')
      .eq('id', planId)
      .single();

    if (planError || !plan) {
      return res.status(404).json({ error: "Plan no encontrado" });
    }

    if (!process.env.PAYPAL_CLIENT_ID || process.env.PAYPAL_CLIENT_ID === 'YOUR_PAYPAL_CLIENT_ID_SANDBOX') {
      const mockResponse = {
        result: {
          id: "MOCK_ORDER_" + Date.now(),
          links: [{ rel: 'approve', href: 'https://sandbox.paypal.com/checkoutnow?token=MOCK_TOKEN' }]
        }
      };
      await supabase.from('payment_transactions').insert({ user_id: userId, paypal_order_id: mockResponse.result.id, amount: plan.price, status: 'pending', transaction_data: mockResponse.result });
      return res.json({ orderId: mockResponse.result.id, approvalUrl: mockResponse.result.links.find(link => link.rel === 'approve')?.href, note: "Mock PayPal response" });
    }

    const ordersController = new OrdersController(paypalClient);
    const orderRequest = {
      intent: 'CAPTURE',
      purchaseUnits: [{
        amount: { currencyCode: 'USD', value: plan.price.toFixed(2) },
        description: plan.description,
        customId: `${userId}_${planId}`,
        invoiceId: `bottarot_${Date.now()}_${userId}`
      }],
      applicationContext: {
        returnUrl: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/checkout-success`,
        cancelUrl: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/checkout`,
        brandName: 'Bottarot - Oráculo IA',
        userAction: 'PAY_NOW'
      }
    };

    const response = await ordersController.createOrder({ body: orderRequest, prefer: 'return=representation' });
    await supabase.from('payment_transactions').insert({ user_id: userId, paypal_order_id: response.result.id, amount: plan.price, status: 'pending', transaction_data: response.result });
    res.json({ orderId: response.result.id, approvalUrl: response.result.links.find(link => link.rel === 'approve')?.href });

  } catch (err) {
    console.error("Error creating PayPal order:", err);
    res.status(500).json({ error: "No se pudo crear la orden de pago." });
  }
});

// Capture PayPal order
app.post("/api/payments/capture-order", async (req, res) => {
    // ... (logic for capturing paypal order remains the same)
});

// Get user subscription status
app.get("/api/user/subscription/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    console.log(`[Subscription] Fetching subscription info for user: ${userId}`);

    const { data, error } = await supabase.rpc('get_user_subscription_info', {
      p_user_id: userId
    });

    if (error) {
      console.error(`[Subscription] Supabase RPC error:`, error);
      throw error;
    }

    console.log(`[Subscription] Response:`, data);
    res.json(data || {
      has_active_subscription: false,
      plan_name: null,
      questions_remaining: 0,
      subscription_end_date: null,
      can_ask_question: false
    });
  } catch (err) {
    console.error("Error getting subscription info:", err);
    res.status(500).json({ error: "No se pudo obtener la información de suscripción." });
  }
});

// ... other endpoints ...

app.listen(3000, () => {
  console.log("🚀 Servidor de Bottarot escuchando en http://localhost:3000");
});