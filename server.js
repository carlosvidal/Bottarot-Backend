import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import { OpenAI } from "openai";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import paypalClient from "./paypal-config.js";
import pkg from '@paypal/paypal-server-sdk';
const { OrdersController } = pkg;
dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseAnonKey);

const app = express();
app.use(cors());
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const TAROT_SYSTEM_PROMPT = `
---
**Rol y Contexto:**
Eres una experta en tarot con décadas de experiencia, especializada en interpretaciones intuitivas, empáticas y basadas en la tradición del **Tarot de Rider-Waite** y el **Tarot de Marsella**. Tu estilo combina **profundidad simbólica** con **consejos prácticos**, adaptándote siempre al contexto del consultante.

---
**Reglas de Interpretación:**

1. **Tipos de Carta (Mayores vs. Menores):**
  - **Arcanos Mayores (22 cartas):** Representan arquetipos universales, lecciones kármicas o eventos trascendentales. Si predominan en una tirada, el mensaje es **profundo, espiritual o vital**. Usa frases como:
    *"Esta carta marca un **momento crucial** en tu vida..."*
    *"El universo te está mostrando que [tema] es parte de un **proceso de crecimiento inevitable**..."*
  - **Arcanos Menores (56 cartas):** Hablan de situaciones cotidianas, emociones, acciones o personas. Si predominan, enfócate en **consejos prácticos y accionables**. Usa frases como:
    *"En tu día a día, esta carta sugiere que..."*
    *"Una acción concreta que podrías tomar es..."*
  - **Combinación de Mayores y Menores:** Explica cómo el **tema profundo (Mayor)** se manifiesta en la **vida práctica (Menores)**. Ejemplo:
    *"[Mayor] te habla de [tema espiritual], y esto se está desarrollando a través de [Menor] en [área concreta]."*

2. **Orientación de las Cartas (Derecha/Invertida):**
  - **Derecha:** Energía fluida, manifestada o consciente.
  - **Invertida:** Energía bloqueada, reprimida, en exceso o que requiere atención interna. Usa frases como:
    *"Esta carta invertida sugiere que [significado] está **reprimido o desequilibrado**..."*
    *"Podrías estar evitando [tema], y esto se refleja en..."*

3. **Posiciones en la Tirada (si aplica):**
  - Si la tirada tiene posiciones fijas (ej: pasado/presente/futuro), relacionalas con la pregunta. Ejemplo:
    *"En el **pasado**, [carta 1] muestra que [evento]. Actualmente, [carta 2] revela [situación], y en el **futuro**, [carta 3] sugiere que [resultado]."*

4. **Interacción entre Cartas:**
  - Analiza cómo se influyen mutuamente. Ejemplo:
    *"La combinación de [Carta A] y [Carta B] indica que [significado conjunto], mientras que [Carta C] añade un matiz de [detalle]."*

5. **Pregunta del Usuario:**
  - **Siempre** relaciona la interpretación con la pregunta específica. Evita respuestas genéricas. Ejemplo:
    *"Tu pregunta sobre [tema] resuena con [carta clave], que sugiere que..."*

6. **Tono y Estilo:**
  - **Empático y poético**, pero claro. Usa metáforas y ejemplos concretos.
  - **Evita:**
    - Lenguaje catastrófico (ej: "desastre", "fracaso").
    - Afirmaciones absolutas (usa "podría indicar", "sugiere", "refleja").
    - Interpretaciones médicas, legales o financieras.
  - **Incluye:**
    - Preguntas reflexivas para el usuario: *"¿Qué necesitas soltar para avanzar?"*
    - Consejos accionables: *"Esta semana, prueba [acción concreta]."*

7. **Cartas Especiales:**
  - **Arcanos Menores "fuertes"** (ej: 10 de Espadas, 3 de Espadas, La Torre): Trátalos con énfasis emocional.
    *"El 10 de Espadas no es una carta ligera. Sugiere que [tema] ha llegado a un punto crítico, pero recuerda: es el final de un ciclo, no de tu historia."*
  - **Cartas de la Corte** (Sotas, Caballeros, Reinas, Reyes): Describe **personalidades o roles**. Ejemplo:
    *"El Rey de Copas podría representarte a ti (si eres hombre) o a alguien en tu entorno con estas características: [descripción]. Esta persona es clave en [tema]."*

8. **Estructura de la Respuesta:**
  - **Introducción:** Conecta con la pregunta del usuario.
    *"Tu pregunta sobre [tema] resuena con las cartas de hoy, que revelan..."*
  - **Significado individual:** 1-2 líneas por carta (nombre, orientación y significado).
  - **Relación entre cartas:** Cómo interactúan y qué mensaje conjunto transmiten.
  - **Mensaje final:** Síntesis con consejo o reflexión accionable (máx. 3 líneas).
`;

app.post("/chat", async (req, res) => {
  const { prompt, provider = "openai" } = req.body;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.flushHeaders();

  try {
    if (provider === "deepseek") {
      // -------- DeepSeek --------
      const response = await fetch(
        "https://api.deepseek.com/v1/chat/completions",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "deepseek-chat",
            messages: [
              { role: "system", content: "Eres un asistente útil y conciso." },
              { role: "user", content: prompt },
            ],
            stream: true,
          }),
        }
      );

      for await (const chunk of response.body) {
        res.write(chunk.toString());
      }
      res.end();
    } else {
      // -------- OpenAI --------
      const stream = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: TAROT_SYSTEM_PROMPT,
          },
          { role: "user", content: prompt },
        ],
        stream: true,
      });

      for await (const part of stream) {
        const text = part.choices[0]?.delta?.content;
        if (text) res.write(`data: ${text}\n\n`);
      }
      res.write("data: [DONE]\n\n");
      res.end();
    }
  } catch (err) {
    console.error(err);
    res.write(`data: [ERROR] ${err.message}\n\n`);
    res.end();
  }
});

app.post("/api/tarot/check", async (req, res) => {
  const { history, current_question } = req.body;

  if (!current_question) {
    return res.status(400).json({ error: "Falta el mensaje actual (current_question)." });
  }

  // Limitar el historial a las últimas 3 interacciones para eficiencia
  const recentHistory = history ? history.slice(-6) : []; // 3 pares de user/assistant

  const historyText = recentHistory.map(msg => `${msg.role}: ${msg.content}`).join('\n');

  const CLASSIFICATION_PROMPT = `Eres un asistente que decide si un mensaje de tarot necesita nuevas cartas.

Historial de la conversación (últimas 3 interacciones):
${historyText}

Mensaje actual: "${current_question}"

Responde SOLO con "follow_up" si el mensaje es para profundizar, aclarar o preguntar sobre la interpretación actual.
Responde SOLO con "new_draw" si el mensaje pide una lectura completamente nueva, cambia de tema, o es una pregunta que no tiene relación directa con la interpretación anterior.`;

  try {
    console.log(`🧐 Clasificando pregunta: "${current_question.substring(0, 50)}"...`);

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "Eres un asistente de clasificación que solo puede responder con 'follow_up' o 'new_draw'."
        },
        { role: "user", content: CLASSIFICATION_PROMPT },
      ],
      temperature: 0,
      max_tokens: 5,
    });

    let decision = completion.choices[0]?.message?.content?.trim().toLowerCase();

    // Fallback y validación
    if (decision !== 'follow_up' && decision !== 'new_draw') {
      console.warn(`⚠️ Decisión no estándar del modelo: '${decision}'. Se usará 'new_draw' como fallback.`);
      decision = 'new_draw';
    }
    
    console.log(`✅ Decisión: ${decision}`);
    res.json({ decision });

  } catch (err) {
    console.error("❌ Error al clasificar la pregunta:", err);
    res.status(500).json({ error: "No se pudo clasificar la pregunta." });
  }
});

app.post("/api/tarot", async (req, res) => {
  const { pregunta, cartas, contextoPersonal, history } = req.body;

  if (!pregunta || !cartas || !Array.isArray(cartas) || cartas.length === 0) {
    return res.status(400).json({ error: "Faltan la pregunta o las cartas." });
  }

  // Construir el historial para el prompt
  const historyText = history && history.length > 0
    ? `---\n**Historial de la Conversación Anterior:**\n${history.map(msg => `${msg.role === 'user' ? 'Consultante' : 'Oráculo'}: ${msg.content}`).join('\n\n')}\n---`
    : '';

  // Construir el prompt para el LLM
  const userPrompt = `
${historyText}

${contextoPersonal ? `${contextoPersonal}\n` : ''}
**Pregunta Actual del Consultante:** "${pregunta}"

**Cartas para esta pregunta:**
${cartas
  .map(
    (carta, index) =>
      `${index + 1}. ${carta.nombre} - ${carta.orientacion} (Posición: ${`
        carta.posicion
      })`}
  )
  .join("\n")}

---
Por favor, genera una interpretación de tarot. ${historyText ? 'Usa el historial de la conversación para dar una respuesta contextual y que continúe el diálogo de forma natural.' : 'Sigue las reglas y el estilo definidos.'}${contextoPersonal ? ' Además, IMPORTANTE: Utiliza la información personal proporcionada para hacer una interpretación más relevante y personalizada.' : ''}
`;

  try {
    // Log para debugging
    console.log(`🔮 Generando interpretación para: "${pregunta.substring(0, 50)}"...`);
    if (history && history.length > 0) console.log('🧠 Interpretación con historial de conversación.');
    if (contextoPersonal) console.log('📋 Interpretación con contexto personalizado.');

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: TAROT_SYSTEM_PROMPT,
        },
        { role: "user", content: userPrompt },
      ],
    });

    const interpretation = completion.choices[0]?.message?.content;

    console.log('✅ Interpretación generada exitosamente');
    res.json({ interpretation });
  } catch (err) {
    console.error("❌ Error al contactar con OpenAI:", err);
    res.status(500).json({ error: "No se pudo obtener la interpretación." });
  }
});


// ========================================
// PAYPAL PAYMENT ENDPOINTS
// ========================================

// Test endpoint
app.get("/api/test", (req, res) => {
  res.json({ message: "Test endpoint working!" });
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

    // Get plan details
    const { data: plan, error: planError } = await supabase
      .from('subscription_plans')
      .select('*')
      .eq('id', planId)
      .single();

    if (planError || !plan) {
      return res.status(404).json({ error: "Plan no encontrado" });
    }

    // Check if PayPal credentials are configured
    if (!process.env.PAYPAL_CLIENT_ID || process.env.PAYPAL_CLIENT_ID === 'YOUR_PAYPAL_CLIENT_ID_SANDBOX') {
      // Use mock response if credentials not configured
      const mockResponse = {
        result: {
          id: "MOCK_ORDER_" + Date.now(),
          links: [{ rel: 'approve', href: 'https://sandbox.paypal.com/checkoutnow?token=MOCK_TOKEN' }]
        }
      };

      // Store mock order in database
      const { error: dbError } = await supabase
        .from('payment_transactions')
        .insert({
          user_id: userId,
          paypal_order_id: mockResponse.result.id,
          amount: plan.price,
          status: 'pending',
          transaction_data: mockResponse.result
        });

      if (dbError) {
        console.error("Error storing transaction:", dbError);
      }

      return res.json({
        orderId: mockResponse.result.id,
        approvalUrl: mockResponse.result.links.find(link => link.rel === 'approve')?.href,
        note: "Mock PayPal response - configure real credentials in .env"
      });
    }

    // Create PayPal order
    const ordersController = new OrdersController(paypalClient);

    const orderRequest = {
      intent: 'CAPTURE',
      purchaseUnits: [{
        amount: {
          currencyCode: 'USD',
          value: plan.price.toFixed(2)
        },
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

    const response = await ordersController.createOrder({
      body: orderRequest,
      prefer: 'return=representation'
    });

    if (response.statusCode !== 201) {
      throw new Error(`PayPal API error: ${response.statusCode}`);
    }

    // Store order in database
    const { error: dbError } = await supabase
      .from('payment_transactions')
      .insert({
        user_id: userId,
        paypal_order_id: response.result.id,
        amount: plan.price,
        status: 'pending',
        transaction_data: response.result
      });

    if (dbError) {
      console.error("Error storing transaction:", dbError);
    }

    res.json({
      orderId: response.result.id,
      approvalUrl: response.result.links.find(link => link.rel === 'approve')?.href
    });

  } catch (err) {
    console.error("Error creating PayPal order:", err);
    res.status(500).json({ error: "No se pudo crear la orden de pago." });
  }
});

// Capture PayPal order
app.post("/api/payments/capture-order", async (req, res) => {
  try {
    const { orderId, userId } = req.body;

    if (!orderId || !userId) {
      return res.status(400).json({ error: "orderId y userId son requeridos" });
    }

    // Check if PayPal credentials are configured
    if (!process.env.PAYPAL_CLIENT_ID || process.env.PAYPAL_CLIENT_ID === 'YOUR_PAYPAL_CLIENT_ID_SANDBOX') {
      // Use mock response if credentials not configured
      const captureData = {
        status: 'COMPLETED',
        purchase_units: [{
          custom_id: `${userId}_1`,
          payments: {
            captures: [{
              id: "MOCK_CAPTURE_" + Date.now(),
              custom_id: `${userId}_1`
            }]
          }
        }]
      };

      // Continue with mock processing...
      if (captureData.status === 'COMPLETED') {
        // Extract plan info from custom_id
        const customId = captureData.purchase_units[0].payments.captures[0].custom_id || captureData.purchase_units[0].custom_id;
        const [captureUserId, planId] = customId.split('_');

        // Get plan details
        const { data: plan } = await supabase
          .from('subscription_plans')
          .select('*')
          .eq('id', planId)
          .single();

        if (plan) {
          // Calculate subscription dates
          const startDate = new Date();
          const endDate = new Date();
          endDate.setDate(startDate.getDate() + plan.duration_days);

          // Create or update subscription
          const { error: subError } = await supabase
            .from('user_subscriptions')
            .upsert({
              user_id: userId,
              plan_id: planId,
              paypal_order_id: orderId,
              status: 'active',
              start_date: startDate.toISOString(),
              end_date: endDate.toISOString(),
              auto_renew: true
            });

          if (subError) {
            console.error("Error creating subscription:", subError);
          }
        }

        // Update transaction record
        const { error: updateError } = await supabase
          .from('payment_transactions')
          .update({
            status: 'completed',
            paypal_payment_id: captureData.purchaseUnits[0].payments.captures[0].id,
            transaction_data: captureData
          })
          .eq('paypal_order_id', orderId);

        if (updateError) {
          console.error("Error updating transaction:", updateError);
        }

        return res.json({
          success: true,
          transactionId: captureData.purchaseUnits[0].payments.captures[0].id,
          subscriptionActive: true,
          note: "Mock PayPal capture - configure real credentials in .env"
        });
      } else {
        return res.status(400).json({ error: "Mock pago no completado" });
      }
    }

    // Capture the order
    const ordersController = new OrdersController(paypalClient);
    const response = await ordersController.captureOrder({
      id: orderId,
      prefer: 'return=representation'
    });

    if (response.statusCode !== 201) {
      throw new Error(`PayPal capture error: ${response.statusCode}`);
    }

    const captureData = response.result;

    // Debug logging to inspect actual PayPal response structure
    console.log('💰 PayPal capture response structure:');
    console.log('Full captureData:', JSON.stringify(captureData, null, 2));
    console.log('captureData.status:', captureData.status);
    console.log('captureData.purchaseUnits exists:', !!captureData.purchaseUnits);
    console.log('captureData.purchaseUnits length:', captureData.purchaseUnits?.length);
    if (captureData.purchaseUnits && captureData.purchaseUnits[0]) {
      console.log('First purchaseUnit:', JSON.stringify(captureData.purchaseUnits[0], null, 2));
    }

    if (captureData.status === 'COMPLETED') {
      // Safely extract plan info from customId with proper error handling
      let customId = null;

      try {
        // Try different possible locations for customId - PayPal uses camelCase, not snake_case
        if (captureData.purchaseUnits &&
            captureData.purchaseUnits[0] &&
            captureData.purchaseUnits[0].payments &&
            captureData.purchaseUnits[0].payments.captures &&
            captureData.purchaseUnits[0].payments.captures[0] &&
            captureData.purchaseUnits[0].payments.captures[0].customId) {
          customId = captureData.purchaseUnits[0].payments.captures[0].customId;
        } else if (captureData.purchaseUnits &&
                   captureData.purchaseUnits[0] &&
                   captureData.purchaseUnits[0].customId) {
          customId = captureData.purchaseUnits[0].customId;
        } else if (captureData.customId) {
          customId = captureData.customId;
        }

        console.log('💰 Extracted customId:', customId);

        if (!customId) {
          throw new Error('Could not find customId in PayPal response');
        }
      } catch (err) {
        console.error('💰 Error extracting customId:', err);
        throw new Error('Invalid PayPal response structure');
      }
      const [captureUserId, planId] = customId.split('_');

      // Get plan details
      const { data: plan } = await supabase
        .from('subscription_plans')
        .select('*')
        .eq('id', planId)
        .single();

      if (plan) {
        // Calculate subscription dates
        const startDate = new Date();
        const endDate = new Date();
        endDate.setDate(startDate.getDate() + plan.duration_days);

        // Create or update subscription
        const { error: subError } = await supabase
          .from('user_subscriptions')
          .upsert({
            user_id: userId,
            plan_id: planId,
            paypal_order_id: orderId,
            status: 'active',
            start_date: startDate.toISOString(),
            end_date: endDate.toISOString(),
            auto_renew: true
          });

        if (subError) {
          console.error("Error creating subscription:", subError);
        }
      }

      // Update transaction record
      const { error: updateError } = await supabase
        .from('payment_transactions')
        .update({
          status: 'completed',
          paypal_payment_id: captureData.purchaseUnits[0].payments.captures[0].id,
          transaction_data: captureData
        })
        .eq('paypal_order_id', orderId);

      if (updateError) {
        console.error("Error updating transaction:", updateError);
      }

      res.json({
        success: true,
        transactionId: captureData.purchaseUnits[0].payments.captures[0].id,
        subscriptionActive: true
      });

    } else {
      res.status(400).json({ error: "Pago no completado" });
    }

  } catch (err) {
    console.error("Error capturing PayPal order:", err);
    res.status(500).json({ error: "No se pudo procesar el pago." });
  }
});

// Get user subscription status
app.get("/api/user/subscription/:userId", async (req, res) => {
  try {
    const { userId } = req.params;

    const { data, error } = await supabase
      .rpc('get_user_subscription_info', { user_uuid: userId });

    if (error) throw error;

    res.json(data[0] || {
      has_active_subscription: false,
      plan_name: 'Gratuito',
      questions_remaining: 1,
      subscription_end_date: null,
      can_ask_question: true
    });

  } catch (err) {
    console.error("Error getting subscription info:", err);
    res.status(500).json({ error: "No se pudo obtener la información de suscripción." });
  }
});

// Check if user can ask question
app.get("/api/user/can-ask/:userId", async (req, res) => {
  try {
    const { userId } = req.params;

    const { data, error } = await supabase
      .rpc('can_user_ask_question', { user_uuid: userId });

    if (error) throw error;

    res.json({ canAsk: data });

  } catch (err) {
    console.error("Error checking question permission:", err);
    res.status(500).json({ error: "No se pudo verificar los permisos." });
  }
});

// Record user question
app.post("/api/user/question", async (req, res) => {
  try {
    const { userId, question, response, cards, isPremium = false } = req.body;

    const { error } = await supabase
      .from('user_questions')
      .insert({
        user_id: userId,
        question,
        response,
        cards_used: cards || [],
        is_premium: isPremium
      });

    if (error) throw error;

    res.json({ success: true });

  } catch (err) {
    console.error("Error recording question:", err);
    res.status(500).json({ error: "No se pudo registrar la pregunta." });
  }
});

// ========================================
// CHAT PERSISTENCE ENDPOINTS
// ========================================

app.get("/api/chats/:chatId", async (req, res) => {
  const { chatId } = req.params;
  // TODO: Add user authentication check to ensure user can access this chat

  try {
    console.log(`📚 Cargando historial para el chat: ${chatId}`);
    const { data, error } = await supabase
      .from('messages')
      .select('*')
      .eq('chat_id', chatId)
      .order('created_at', { ascending: true });

    if (error) throw error;

    console.log(`✅ Historial cargado: ${data.length} mensajes encontrados.`);
    res.json(data);
  } catch (err) {
    console.error(`❌ Error fetching chat history for ${chatId}:`, err);
    res.status(500).json({ error: "No se pudo cargar el historial del chat." });
  }
});

app.post("/api/chats", async (req, res) => {
  const { chatId, userId, title } = req.body;

  if (!chatId || !userId) {
    return res.status(400).json({ error: "Faltan chatId o userId." });
  }

  try {
    console.log(`⏳ Creando nuevo chat en DB: ${chatId}`);
    const { data, error } = await supabase
      .from('chats')
      .insert([{ id: chatId, user_id: userId, title: title }])
      .select();

    if (error) {
        // If the chat already exists (duplicate key), don't treat it as a fatal error.
        if (error.code === '23505') { // 23505 is the PostgreSQL error code for unique_violation
            console.log(`👍 El chat ${chatId} ya existía, continuando.`);
            return res.status(200).json({ message: 'Chat already exists' });
        }
        throw error;
    }

    console.log(`✅ Chat creado exitosamente: ${data[0].id}`);
    res.status(201).json(data[0]);
  } catch (err) {
    console.error(`❌ Error creating chat ${chatId}:`, err);
    res.status(500).json({ error: "No se pudo crear el chat." });
  }
});

app.post("/api/messages", async (req, res) => {
  const { chatId, userId, role, content, cards } = req.body;

  if (!chatId || !role || !content) {
    return res.status(400).json({ error: "Faltan chatId, role o content." });
  }

  try {
    const { data, error } = await supabase
      .from('messages')
      .insert([{ 
        chat_id: chatId, 
        user_id: userId, 
        role, 
        content, 
        cards 
      }])
      .select();

    if (error) throw error;

    console.log(`💾 Mensaje guardado para el chat ${chatId} (Rol: ${role})`);
    res.status(201).json(data[0]);
  } catch (err) {
    console.error(`❌ Error saving message for chat ${chatId}:`, err);
    res.status(500).json({ error: "No se pudo guardar el mensaje." });
  }
});

app.listen(3000, () => {
  console.log("🚀 LLM proxy escuchando en http://localhost:3000");
});
