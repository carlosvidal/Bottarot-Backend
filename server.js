import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import { OpenAI } from "openai";
import { createClient } from "@supabase/supabase-js";
import { tarotDeck } from "./data/tarotDeck.js";
import paypalClient from "./paypal-config.js";
import pkg from "@paypal/paypal-server-sdk";
const { OrdersController } = pkg;

// Security middleware
import {
  helmetConfig,
  corsConfig,
  generalLimiter,
  chatLimiter,
  paymentLimiter,
  sanitizeInput,
  requestLogger,
  errorHandler,
  notFoundHandler
} from './security.js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

const app = express();

// Trust proxy (important for rate limiting behind reverse proxy)
app.set('trust proxy', 1);

// Apply security middleware
app.use(helmetConfig);
app.use(cors(corsConfig()));
app.use(express.json({ limit: '10mb' })); // Limit payload size
app.use(sanitizeInput); // Sanitize against NoSQL injection

// Apply general rate limiting to all API routes
app.use('/api/', generalLimiter);

// Request logging (skip in test environment)
if (process.env.NODE_ENV !== 'test') {
  app.use(requestLogger);
}

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

// Apply chat-specific rate limiting
app.post("/api/chat/message", chatLimiter, async (req, res) => {
    const { question, history, personalContext, userId, chatId } = req.body;

    if (!question) {
        return res.status(400).json({ error: "La pregunta (question) es requerida." });
    }

    // Determine if user is anonymous
    const isAnonymous = !userId || userId === 'anonymous';
    let userPermissions = null;
    let futureHidden = isAnonymous; // Anonymous users always have future hidden
    let ctaMessage = null;

    // Get user permissions if authenticated
    if (!isAnonymous) {
        try {
            const { data: permissions, error } = await supabase.rpc(
                'get_user_reading_permissions',
                { p_user_id: userId }
            );
            if (!error && permissions) {
                userPermissions = permissions;
                futureHidden = !permissions.can_see_future && !permissions.is_premium;
            }
        } catch (permErr) {
            console.error(`[${chatId}] ⚠️ Error getting permissions:`, permErr);
        }
    }

    // Set appropriate CTA message
    if (isAnonymous) {
        ctaMessage = "Para revelar tu futuro, reclama tu identidad espiritual";
    } else if (futureHidden) {
        ctaMessage = "Desbloquea tu futuro completo con un plan premium";
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

            // PASO 2: Enviar cartas al cliente SIN DEMORA (con info de futuro oculto)
            console.log(`[${chatId}] 📤 Enviando cartas al cliente INMEDIATAMENTE... (futureHidden: ${futureHidden})`);
            res.write(`event: cards\n`);
            res.write(`data: ${JSON.stringify({
                cards: drawnCards,
                futureHidden: futureHidden,
                ctaMessage: ctaMessage,
                isAnonymous: isAnonymous
            })}\n\n`);
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
      .order('display_order', { ascending: true });

    if (error) throw error;

    res.json({ plans });
  } catch (err) {
    console.error("Error fetching subscription plans:", err);
    res.status(500).json({ error: "No se pudieron obtener los planes." });
  }
});

// Get available subscription plans for a user (filters promotional plans by eligibility)
app.get("/api/subscription-plans/available/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    console.log(`[Plans] Fetching available plans for user: ${userId}`);

    // Get all active plans
    const { data: plans, error: plansError } = await supabase
      .from('subscription_plans')
      .select('*')
      .eq('is_active', true)
      .order('display_order', { ascending: true });

    if (plansError) throw plansError;

    // If no userId provided, return all plans except trial (for anonymous users)
    if (!userId || userId === 'anonymous') {
      const filteredPlans = plans.filter(p => p.plan_type !== 'trial');
      return res.json({ plans: filteredPlans });
    }

    // Check promotional offer eligibility for each plan
    const plansWithEligibility = await Promise.all(plans.map(async (plan) => {
      if (plan.is_promotional && plan.plan_type === 'trial') {
        // Check if user is eligible for this promotional offer
        const { data: eligibility, error: eligError } = await supabase.rpc(
          'check_promo_eligibility',
          { p_user_id: userId, p_offer_type: 'ritual_de_iniciacion' }
        );

        if (eligError) {
          console.error(`[Plans] Error checking promo eligibility:`, eligError);
          return { ...plan, is_eligible: true }; // Default to eligible on error
        }

        return {
          ...plan,
          is_eligible: eligibility?.is_eligible ?? true,
          cooldown_ends_at: eligibility?.cooldown_ends_at
        };
      }
      return { ...plan, is_eligible: true };
    }));

    // Filter out ineligible promotional plans
    const availablePlans = plansWithEligibility.filter(plan => {
      // Always show free plan and non-promotional plans
      if (plan.plan_type === 'free' || !plan.is_promotional) return true;
      // For promotional plans, only show if eligible
      return plan.is_eligible;
    });

    res.json({ plans: availablePlans });
  } catch (err) {
    console.error("Error fetching available subscription plans:", err);
    res.status(500).json({ error: "No se pudieron obtener los planes disponibles." });
  }
});

// Get user reading permissions
app.get("/api/user/reading-permissions/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    console.log(`[Permissions] Fetching reading permissions for user: ${userId}`);

    // For anonymous users, return restricted permissions
    if (!userId || userId === 'anonymous') {
      return res.json({
        is_premium: false,
        can_read_today: true,
        can_see_future: false,
        readings_today: 0,
        days_since_registration: 0,
        free_futures_remaining: 0,
        free_futures_used: 0,
        total_readings: 0,
        history_limit: 0,
        plan_name: 'Anónimo',
        is_anonymous: true
      });
    }

    const { data: permissions, error } = await supabase.rpc(
      'get_user_reading_permissions',
      { p_user_id: userId }
    );

    if (error) {
      console.error(`[Permissions] Supabase RPC error:`, error);
      throw error;
    }

    console.log(`[Permissions] Response:`, permissions);
    res.json(permissions || {
      is_premium: false,
      can_read_today: true,
      can_see_future: false,
      readings_today: 0,
      free_futures_remaining: 0,
      history_limit: 3,
      plan_name: 'Gratuito'
    });
  } catch (err) {
    console.error("Error getting reading permissions:", err);
    res.status(500).json({ error: "No se pudieron obtener los permisos de lectura." });
  }
});

// Record a reading for a user
app.post("/api/user/record-reading", async (req, res) => {
  try {
    const { userId, revealedFuture } = req.body;
    console.log(`[Reading] Recording reading for user: ${userId}, revealedFuture: ${revealedFuture}`);

    if (!userId) {
      return res.status(400).json({ error: "userId es requerido" });
    }

    const { data, error } = await supabase.rpc(
      'record_user_reading',
      {
        p_user_id: userId,
        p_revealed_future: revealedFuture || false
      }
    );

    if (error) {
      console.error(`[Reading] Supabase RPC error:`, error);
      throw error;
    }

    console.log(`[Reading] Recording result:`, data);
    res.json(data);
  } catch (err) {
    console.error("Error recording reading:", err);
    res.status(500).json({ error: "No se pudo registrar la lectura." });
  }
});

// Create PayPal order (with payment rate limiting)
app.post("/api/payments/create-order", paymentLimiter, async (req, res) => {
  try {
    const { planId, userId } = req.body;
    console.log(`[Payment] Creating order for plan ${planId}, user ${userId}`);

    if (!planId || !userId) {
      return res.status(400).json({ error: "planId y userId son requeridos" });
    }

    const { data: plan, error: planError } = await supabase
      .from('subscription_plans')
      .select('*')
      .eq('id', planId)
      .single();

    if (planError || !plan) {
      console.error(`[Payment] Plan not found:`, planError);
      return res.status(404).json({ error: "Plan no encontrado" });
    }

    console.log(`[Payment] Found plan: ${plan.name}, price: ${plan.price}`);

    if (!process.env.PAYPAL_CLIENT_ID || process.env.PAYPAL_CLIENT_ID === 'YOUR_PAYPAL_CLIENT_ID_SANDBOX') {
      const mockResponse = {
        result: {
          id: "MOCK_ORDER_" + Date.now(),
          links: [{ rel: 'approve', href: 'https://sandbox.paypal.com/checkoutnow?token=MOCK_TOKEN' }]
        }
      };
      const { error: insertError } = await supabase.from('payment_transactions').insert({ user_id: userId, paypal_order_id: mockResponse.result.id, amount: plan.price, status: 'pending', plan_id: planId, transaction_data: mockResponse.result });
      if (insertError) console.error(`[Payment] Insert error:`, insertError);
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
        brandName: 'Free Tarot Fun',
        userAction: 'PAY_NOW'
      }
    };

    console.log(`[Payment] Calling PayPal API...`);
    const response = await ordersController.createOrder({ body: orderRequest, prefer: 'return=representation' });
    console.log(`[Payment] PayPal order created: ${response.result.id}`);

    const { error: insertError } = await supabase.from('payment_transactions').insert({
      user_id: userId,
      paypal_order_id: response.result.id,
      amount: plan.price,
      status: 'pending',
      plan_id: planId,
      transaction_data: response.result
    });

    if (insertError) {
      console.error(`[Payment] ❌ Insert error:`, insertError);
      // Still return success since PayPal order was created
    } else {
      console.log(`[Payment] ✅ Transaction saved to database`);
    }

    res.json({ orderId: response.result.id, approvalUrl: response.result.links.find(link => link.rel === 'approve')?.href });

  } catch (err) {
    console.error("Error creating PayPal order:", err);
    res.status(500).json({ error: "No se pudo crear la orden de pago." });
  }
});

// Capture PayPal order (with payment rate limiting)
app.post("/api/payments/capture-order", paymentLimiter, async (req, res) => {
  try {
    const { orderId, userId } = req.body;

    if (!orderId || !userId) {
      return res.status(400).json({ error: "orderId y userId son requeridos" });
    }

    console.log(`[Payment] Capturing order ${orderId} for user ${userId}`);

    // 1. Find the pending transaction
    const { data: transaction, error: txError } = await supabase
      .from('payment_transactions')
      .select('*')
      .eq('paypal_order_id', orderId)
      .eq('user_id', userId)
      .eq('status', 'pending')
      .single();

    if (txError || !transaction) {
      console.error(`[Payment] Transaction not found:`, txError);
      return res.status(404).json({ error: "Transacción no encontrada o ya procesada" });
    }

    console.log(`[Payment] Found transaction:`, transaction.id);

    // 1b. Get the plan details
    const { data: plan, error: planError } = await supabase
      .from('subscription_plans')
      .select('*')
      .eq('id', transaction.plan_id)
      .single();

    if (planError) {
      console.error(`[Payment] Plan not found:`, planError);
    }

    let captureId = null;
    let captureData = null;

    // 2. Capture the payment (mock or real)
    const isMockOrder = orderId.startsWith('MOCK_ORDER_');

    if (isMockOrder) {
      // Mock capture for development
      console.log(`[Payment] Using mock capture for order ${orderId}`);
      captureId = `MOCK_CAPTURE_${Date.now()}`;
      captureData = {
        id: captureId,
        status: 'COMPLETED',
        mock: true,
        captured_at: new Date().toISOString()
      };
    } else {
      // Real PayPal capture
      console.log(`[Payment] Capturing real PayPal order ${orderId}`);
      const ordersController = new OrdersController(paypalClient);

      try {
        const captureResponse = await ordersController.captureOrder({
          id: orderId,
          prefer: 'return=representation'
        });

        captureId = captureResponse.result?.purchaseUnits?.[0]?.payments?.captures?.[0]?.id;
        captureData = captureResponse.result;
        console.log(`[Payment] PayPal capture successful: ${captureId}`);
      } catch (paypalError) {
        console.error(`[Payment] PayPal capture failed:`, paypalError);
        return res.status(400).json({ error: "No se pudo capturar el pago en PayPal" });
      }
    }

    // 3. Update transaction to completed
    const { error: updateTxError } = await supabase
      .from('payment_transactions')
      .update({
        status: 'completed',
        paypal_capture_id: captureId,
        completed_at: new Date().toISOString(),
        transaction_data: captureData
      })
      .eq('id', transaction.id);

    if (updateTxError) {
      console.error(`[Payment] Error updating transaction:`, updateTxError);
      // Don't fail - payment was captured, just log the error
    }

    // 4. Calculate subscription dates
    const durationDays = plan?.duration_days || 30;
    const subscriptionStart = new Date();
    const subscriptionEnd = new Date();
    subscriptionEnd.setDate(subscriptionEnd.getDate() + durationDays);

    console.log(`[Payment] Creating subscription: ${durationDays} days, ends ${subscriptionEnd.toISOString()}`);

    // 4b. If this is a promotional/trial plan, record the purchase with cooldown
    if (plan?.is_promotional && plan?.plan_type === 'trial') {
      console.log(`[Payment] Recording promotional purchase with ${plan.cooldown_days || 14} day cooldown`);
      try {
        const { data: promoResult, error: promoError } = await supabase.rpc(
          'record_promo_purchase',
          {
            p_user_id: userId,
            p_offer_type: 'ritual_de_iniciacion',
            p_cooldown_days: plan.cooldown_days || 14
          }
        );
        if (promoError) {
          console.error(`[Payment] Error recording promo purchase:`, promoError);
        } else {
          console.log(`[Payment] Promo purchase recorded, cooldown ends:`, promoResult?.cooldown_ends_at);
        }
      } catch (promoErr) {
        console.error(`[Payment] Exception recording promo purchase:`, promoErr);
      }
    }

    // 5. Create or update user subscription (upsert)
    const { data: subscription, error: subError } = await supabase
      .from('user_subscriptions')
      .upsert({
        user_id: userId,
        plan_id: transaction.plan_id,
        status: 'active',
        subscription_start_date: subscriptionStart.toISOString(),
        subscription_end_date: subscriptionEnd.toISOString(),
        payment_transaction_id: transaction.id
      }, {
        onConflict: 'user_id'
      })
      .select()
      .single();

    if (subError) {
      console.error(`[Payment] Error creating subscription:`, subError);
      // Try alternative: check if user_subscriptions uses different conflict handling
      const { error: insertError } = await supabase
        .from('user_subscriptions')
        .insert({
          user_id: userId,
          plan_id: transaction.plan_id,
          status: 'active',
          subscription_start_date: subscriptionStart.toISOString(),
          subscription_end_date: subscriptionEnd.toISOString(),
          payment_transaction_id: transaction.id
        });

      if (insertError && !insertError.message?.includes('duplicate')) {
        console.error(`[Payment] Error inserting subscription:`, insertError);
        return res.status(500).json({ error: "Error al activar la suscripción" });
      }
    }

    console.log(`[Payment] ✅ Payment captured and subscription activated for user ${userId}`);

    // 6. Return success response
    res.json({
      success: true,
      message: "Pago capturado y suscripción activada",
      subscription: {
        plan_name: plan?.name || 'Premium',
        start_date: subscriptionStart.toISOString(),
        end_date: subscriptionEnd.toISOString(),
        duration_days: durationDays
      },
      transaction: {
        id: transaction.id,
        capture_id: captureId,
        amount: transaction.amount
      }
    });

  } catch (err) {
    console.error("[Payment] Error capturing order:", err);
    res.status(500).json({ error: "No se pudo completar el pago." });
  }
});

// Get user subscription status
app.get("/api/user/subscription/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    console.log(`[Subscription] Fetching subscription info for user: ${userId}`);

    const { data, error } = await supabase.rpc('get_user_subscription_info', {
      p_user_uuid: userId
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

// =======================================
// ADMIN ENDPOINTS
// =======================================

// Admin auth middleware
const adminAuth = (req, res, next) => {
  const adminPassword = req.headers['x-admin-password'];
  const validPassword = process.env.ADMIN_PASSWORD;

  if (!validPassword) {
    return res.status(500).json({ error: "Admin password not configured" });
  }

  if (adminPassword !== validPassword) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
};

// Get all subscriptions
app.get("/api/admin/subscriptions", adminAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('user_subscriptions')
      .select(`
        *,
        subscription_plans (name, price, duration_days)
      `)
      .order('created_at', { ascending: false });

    if (error) throw error;

    // Get user emails from auth.users
    const userIds = data.map(s => s.user_id);
    const { data: users } = await supabase.auth.admin.listUsers();

    const userMap = {};
    users?.users?.forEach(u => {
      userMap[u.id] = u.email;
    });

    const subscriptions = data.map(s => ({
      ...s,
      user_email: userMap[s.user_id] || 'Unknown',
      plan_name: s.subscription_plans?.name,
      is_active: s.status === 'active' && new Date(s.subscription_end_date) > new Date()
    }));

    res.json({ subscriptions });
  } catch (err) {
    console.error("Admin error:", err);
    res.status(500).json({ error: "Error fetching subscriptions" });
  }
});

// Get all payments
app.get("/api/admin/payments", adminAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('payment_transactions')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) throw error;

    // Get user emails
    const userIds = [...new Set(data.map(p => p.user_id))];
    const { data: users } = await supabase.auth.admin.listUsers();

    const userMap = {};
    users?.users?.forEach(u => {
      userMap[u.id] = u.email;
    });

    const payments = data.map(p => ({
      ...p,
      user_email: userMap[p.user_id] || 'Unknown',
      plan_name: p.plan_id ? `Plan #${p.plan_id}` : 'N/A'
    }));

    res.json({ payments });
  } catch (err) {
    console.error("Admin error:", err);
    res.status(500).json({ error: "Error fetching payments" });
  }
});

// Get stats summary
app.get("/api/admin/stats", adminAuth, async (req, res) => {
  try {
    // Total users
    const { data: users } = await supabase.auth.admin.listUsers();
    const totalUsers = users?.users?.length || 0;

    // Active subscriptions
    const { count: activeSubscriptions } = await supabase
      .from('user_subscriptions')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'active')
      .gt('subscription_end_date', new Date().toISOString());

    // Total revenue
    const { data: payments } = await supabase
      .from('payment_transactions')
      .select('amount')
      .eq('status', 'completed');

    const totalRevenue = payments?.reduce((sum, p) => sum + (p.amount || 0), 0) || 0;

    // Total chats
    const { count: totalChats } = await supabase
      .from('chats')
      .select('*', { count: 'exact', head: true });

    // Total messages
    const { count: totalMessages } = await supabase
      .from('messages')
      .select('*', { count: 'exact', head: true });

    res.json({
      totalUsers,
      activeSubscriptions: activeSubscriptions || 0,
      totalRevenue,
      totalChats: totalChats || 0,
      totalMessages: totalMessages || 0
    });
  } catch (err) {
    console.error("Admin error:", err);
    res.status(500).json({ error: "Error fetching stats" });
  }
});

// Clean up pending transactions (admin)
app.delete("/api/admin/pending-transactions", adminAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('payment_transactions')
      .delete()
      .eq('status', 'pending')
      .select();

    if (error) throw error;

    console.log(`[Admin] Deleted ${data?.length || 0} pending transactions`);
    res.json({
      success: true,
      deleted: data?.length || 0,
      message: `Se eliminaron ${data?.length || 0} transacciones pendientes`
    });
  } catch (err) {
    console.error("Admin error:", err);
    res.status(500).json({ error: "Error deleting pending transactions" });
  }
});

// =======================================
// HEALTH CHECK & ERROR HANDLING
// =======================================

// Health check endpoint (no rate limit)
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// 404 handler (must be after all routes)
app.use(notFoundHandler);

// Global error handler (must be last)
app.use(errorHandler);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor de Free Tarot Fun escuchando en http://localhost:${PORT}`);
  console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔒 Security middleware enabled`);
});