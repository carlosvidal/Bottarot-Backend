import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import crypto from "crypto";
import fetch from "node-fetch";
import { OpenAI } from "openai";
import { createClient } from "@supabase/supabase-js";
import { nanoid } from "nanoid";
import { tarotDeck } from "./data/tarotDeck.js";
import { parseInterpretationSections, filterSectionsForPaywall } from "./utils/sectionParser.js";
import { generateSharePreview, uploadToStorage } from "./utils/imageGenerator.js";
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
  requestLogger,
  errorHandler,
  notFoundHandler
} from './security.js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

// In-memory cache for anonymous user interpretations (full unfiltered content)
// Key: chatId, Value: { messages: [...], timestamp }
// Entries expire after 30 minutes
const anonymousInterpretationCache = new Map();
const ANON_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

function cacheAnonymousMessage(chatId, messageData) {
    let entry = anonymousInterpretationCache.get(chatId);
    if (!entry) {
        entry = { messages: [], timestamp: Date.now() };
        anonymousInterpretationCache.set(chatId, entry);
    }
    entry.messages.push(messageData);
    entry.timestamp = Date.now();

    // Cleanup old entries
    for (const [key, val] of anonymousInterpretationCache) {
        if (Date.now() - val.timestamp > ANON_CACHE_TTL) {
            anonymousInterpretationCache.delete(key);
        }
    }
}

const app = express();

// Trust proxy (important for rate limiting behind reverse proxy)
app.set('trust proxy', 1);

// Apply security middleware
app.use(helmetConfig);
app.use(cors(corsConfig()));
app.use(express.json({ limit: '10mb' })); // Limit payload size

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
2.  **Contexto Personal**: Si se te proporciona información del consultante (nombre, edad, etc.), **úsala** para personalizar el saludo y el tono.
3.  **Historial de Chat**: Si hay un historial, úsalo para dar continuidad a la conversación. Evita repetir lo que ya dijiste.
4.  **Tono**: Místico, poético, pero claro y accionable. Usa un lenguaje empático y evita afirmaciones absolutas o catastróficas.

### ESTRUCTURA OBLIGATORIA:
Tu respuesta DEBE seguir EXACTAMENTE esta estructura con estos encabezados de nivel 2 (##). No omitas ninguno. No cambies los nombres de los encabezados. No agregues encabezados adicionales.

## Saludo
Saluda al consultante (si hay contexto personal) y conecta emocionalmente con su pregunta. Breve, 1-2 frases.

## Pasado
Interpreta la carta en posición Pasado. Relaciona con la pregunta del consultante. Describe cómo las energías pasadas influyen en su situación actual.

## Presente
Interpreta la carta en posición Presente. Relaciona con la pregunta del consultante. Describe la energía actual y lo que está sucediendo ahora.

## Futuro
Interpreta la carta en posición Futuro. Relaciona con la pregunta del consultante. Describe las tendencias y posibilidades que se vislumbran.

## Síntesis
Unifica el mensaje de las tres cartas en una narrativa coherente. Conecta pasado, presente y futuro en un mensaje integrado sobre la pregunta del consultante.

## Consejo
Ofrece una reflexión práctica y accionable basada en la tirada. Da un consejo concreto que el consultante pueda aplicar.
`;

// =======================================
// FOLLOW-UP CONVERSATION AGENT
// =======================================

const FOLLOWUP_SYSTEM_PROMPT = `Eres una experta en tarot que acaba de realizar una lectura para el consultante.
Ahora estás conversando sobre esa lectura de manera natural.

### Reglas:
1. **NO repitas la estructura** de Pasado/Presente/Futuro/Síntesis/Consejo. Ya diste esa lectura completa.
2. **Responde de forma natural y conversacional**, como una consejera sabia y cercana.
3. **Basa tus respuestas** estrictamente en la lectura anterior que está en el historial.
4. **Sé concisa** - 2-4 párrafos máximo.
5. Si el usuario agradece, despídete cálidamente y deséale buena fortuna.
6. Si pide más detalles sobre algo específico, profundiza en lo que ya dijiste sin repetir toda la estructura.
7. Si hace una pregunta completamente nueva que requeriría tirar cartas nuevas, indícale amablemente que para eso necesita iniciar una nueva lectura.

Tono: Empático, cercano, poético pero claro. Tutea al consultante. Sin encabezados ni formato estructurado.`;

// =======================================
// CONTEXT EVALUATOR AGENT
// =======================================

const CONTEXT_EVALUATOR_SYSTEM_PROMPT = `Eres el oráculo interior de un sistema de tarot. Tu función es evaluar si la pregunta del consultante tiene suficiente contexto emocional e intencional para realizar una lectura significativa.

### Dimensiones a Evaluar:
1. **Marco temporal (timeframe)**: ¿La pregunta tiene un horizonte temporal implícito o explícito? (reciente, arrastrado, futuro cercano, largo plazo)
2. **Foco (focus)**: ¿Se identifica un área de vida o relación específica? (amor, trabajo, salud, finanzas, familia, crecimiento personal)
3. **Agencia (agency)**: ¿El consultante se posiciona como protagonista que puede decidir, o como observador pasivo esperando señales?
4. **Intención (intent)**: ¿Qué busca realmente? (claridad, confirmación, exploración, consuelo, advertencia)

### Reglas Críticas:
- Respuestas cortas de acción como "dale", "procede", "sí", "hazlo", "tira las cartas", "adelante", "ok", "va" SIEMPRE significan que el consultante quiere proceder. Responde con proceed: true.
- Si al menos 3 de las 4 dimensiones están presentes (aunque sea de forma implícita), el contexto es SUFICIENTE.
- Si la pregunta es concreta y específica (ej: "¿Cómo va a ir mi entrevista de trabajo del viernes?"), el contexto es SUFICIENTE incluso si falta alguna dimensión.
- Solo pide contexto adicional si la pregunta es genuinamente vaga o abstracta (ej: "quiero una lectura", "hola", "ayuda").
- NUNCA hagas más de UNA pregunta. Elige la dimensión MÁS importante que falta.
- Tu pregunta debe ser oracular, poética y breve (1-2 frases). No uses formato de formulario.
- Si hay historial de conversación que ya proporciona contexto, considéralo como parte de la evaluación.
- Ante la duda, prefiere proceder (proceed: true) en lugar de preguntar.

### Formato de Respuesta (JSON):

**Si el contexto es suficiente:**
{"proceed": true, "context_summary": "Breve resumen del contexto emocional detectado en 1-2 frases"}

**Si necesita más contexto:**
{"proceed": false, "oracle_question": "Tu pregunta oracular aquí", "missing_dimension": "timeframe|focus|agency|intent"}

### Ejemplos de preguntas oraculares (cuando SÍ falta contexto):
- Falta foco: "Siento una energía intensa en tu consulta... ¿es el corazón quien habla, o son las preocupaciones del mundo material?"
- Falta timeframe: "Las estrellas ven muchos caminos ante ti... ¿es algo que está ocurriendo ahora, o algo que temes que se acerque?"
- Falta agencia: "Percibo que algo te mueve... ¿vienes buscando claridad para tomar una decisión, o necesitas entender lo que ya está en marcha?"
- Falta intención: "Tu pregunta resuena con fuerza... ¿buscas confirmación de lo que ya intuyes, o quieres que las cartas te muestren lo que aún no puedes ver?"

### Alternativa — frases espejo (puedes usarlas en lugar de preguntar directamente):
"Siento que esta pregunta nace de algo que aún no termina de cerrarse…"
(El consultante confirma o corrige, y eso también es contexto válido)`;

// =======================================
// MEMORY EXTRACTOR AGENT
// =======================================

const MEMORY_EXTRACTOR_SYSTEM_PROMPT = `Eres un agente de extracción de memoria silencioso. Tu función es analizar un intercambio entre un consultante y un oráculo de tarot, y extraer SOLO información explícitamente declarada por el consultante.

### Reglas Estrictas:
1. SOLO extrae hechos EXPLÍCITAMENTE declarados por el consultante en sus mensajes. NUNCA inferencias.
2. NO extraigas estados emocionales momentáneos (ej: "hoy estoy cansado", "me siento mal").
3. NO extraigas información sensible innecesaria (datos médicos específicos, números de cuenta, contraseñas, etc.).
4. NO extraigas nada que el oráculo/intérprete haya dicho — solo lo que el CONSULTANTE declaró.
5. Si no hay nada nuevo relevante que extraer, devuelve un array vacío.
6. Cada entrada debe tener una categoría, una clave única descriptiva (snake_case), y el valor como frase descriptiva.
7. Sé conservador: es mejor extraer menos que extraer información dudosa.

### Categorías Válidas:
- **recurring_theme**: Temas que aparecen en la consulta (ej: "inseguridad laboral", "búsqueda de pareja", "conflicto familiar")
- **life_event**: Eventos de vida mencionados (ej: "se divorció recientemente", "cambió de trabajo", "se mudó")
- **relationship**: Personas mencionadas por nombre o rol (ej: "pareja se llama Carlos", "tiene una hija", "problemas con su jefe")
- **preference**: Preferencias sobre las lecturas o estilo de comunicación (ej: "prefiere consejos directos", "le interesa el amor", "quiere lecturas reflexivas")
- **identity**: Datos identitarios explícitos (ej: "es artista", "vive en Barcelona", "tiene 35 años")

### Capas de Memoria:
- **identity**: Datos permanentes que rara vez cambian (nombre de pareja, profesión, ciudad, estado civil). ttl_days: null (permanente).
- **emotional**: Situaciones y temas actuales que pueden evolucionar o resolverse. ttl_days: 30.

### Formato de Respuesta (JSON):

{"entries": [
    {
        "category": "relationship",
        "key": "pareja_nombre",
        "value": "Su pareja se llama María",
        "confidence": 0.95,
        "layer": "identity",
        "ttl_days": null
    },
    {
        "category": "recurring_theme",
        "key": "ansiedad_laboral",
        "value": "Está experimentando ansiedad por una posible reestructuración en su trabajo",
        "confidence": 0.9,
        "layer": "emotional",
        "ttl_days": 30
    }
]}

Si no hay nada relevante que extraer:
{"entries": []}`;

// =======================================
// HELPER FUNCTIONS
// =======================================

/**
 * Extract memory from a conversation exchange and save to database (fire-and-forget).
 * Only runs for authenticated users. Does not block the response.
 */
const extractAndSaveMemory = async (userId, chatId, question, interpretation) => {
    if (!userId || userId === 'anonymous') return;

    try {
        console.log(`[${chatId}] 🧠 Extrayendo memoria en background...`);

        const extractionPrompt = `Mensaje del consultante: "${question}"\n\nRespuesta del oráculo (resumen): "${interpretation.substring(0, 500)}"`;

        const extractionCompletion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: MEMORY_EXTRACTOR_SYSTEM_PROMPT },
                { role: "user", content: extractionPrompt },
            ],
            response_format: { type: "json_object" },
            temperature: 0,
        });

        const extraction = JSON.parse(extractionCompletion.choices[0].message.content);

        if (extraction.entries && extraction.entries.length > 0) {
            console.log(`[${chatId}] 💾 Guardando ${extraction.entries.length} entradas de memoria...`);

            for (const entry of extraction.entries) {
                await supabase.rpc('save_memory_entry', {
                    p_user_id: userId,
                    p_category: entry.category,
                    p_key: entry.key,
                    p_value: entry.value,
                    p_confidence: entry.confidence || 1.0,
                    p_layer: entry.layer || 'emotional',
                    p_source_chat_id: chatId,
                    p_ttl_days: entry.ttl_days ?? (entry.layer === 'emotional' ? 30 : null)
                });
            }

            console.log(`[${chatId}] ✅ Memoria guardada exitosamente.`);
        } else {
            console.log(`[${chatId}] 📝 No se encontraron nuevas entradas de memoria.`);
        }
    } catch (err) {
        // Non-blocking: log but don't fail the request
        console.error(`[${chatId}] ⚠️ Error extrayendo memoria (non-blocking):`, err.message);
    }
};

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
        // --- 0. PRE-CHECKS ---
        const historyForDecider = history ? history.map(msg => `${msg.role}: ${msg.content}`).join('\n') : '';

        // Check if user is responding to a context question — skip Decisor
        const isContextResponse = history && history.length > 0 &&
            history[history.length - 1]?.role === 'assistant' &&
            history[history.length - 1]?._isContextQuestion === true;

        let decision;

        if (isContextResponse) {
            console.log(`[${chatId}] ↩️ Usuario respondió a pregunta contextual, saltando Decisor → requires_new_draw`);
            decision = { type: 'requires_new_draw' };
        } else {
            // --- 1. AGENT DECISOR ---
            console.log(`[${chatId}] 🧐 Agente Decisor analizando: "${question.substring(0, 50)}"...`);

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

            decision = JSON.parse(deciderCompletion.choices[0].message.content);
            console.log(`[${chatId}] ✅ Decisión: ${decision.type}`);
        }

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

**Mensaje del Consultante:** "${question}"
`;

            const followUpCompletion = await openai.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [
                    { role: "system", content: FOLLOWUP_SYSTEM_PROMPT },
                    { role: "user", content: followUpPrompt },
                ],
            });
            const interpretation = followUpCompletion.choices[0].message.content;
            console.log(`[${chatId}] ✅ Respuesta de seguimiento generada.`);

            // Background: Extract memory from follow-ups too
            extractAndSaveMemory(userId, chatId, question, interpretation);

            return res.json({
                type: 'message',
                text: interpretation,
                role: 'assistant'
            });
        }

        // CASE 3: La pregunta requiere una nueva tirada
        if (decision.type === 'requires_new_draw') {

            // --- CONTEXT EVALUATION PHASE ---
            let contextSummary = null;

            if (!isContextResponse) {
                console.log(`[${chatId}] 🔍 Evaluando contexto emocional...`);

                const contextEvalPrompt = `${personalContext || ''}\n\nHistorial de conversación:\n${historyForDecider}\n\nPregunta del consultante: "${question}"`;

                const contextEvalCompletion = await openai.chat.completions.create({
                    model: "gpt-4o-mini",
                    messages: [
                        { role: "system", content: CONTEXT_EVALUATOR_SYSTEM_PROMPT },
                        { role: "user", content: contextEvalPrompt },
                    ],
                    response_format: { type: "json_object" },
                    temperature: 0.3,
                });

                const contextEval = JSON.parse(contextEvalCompletion.choices[0].message.content);
                console.log(`[${chatId}] 📊 Evaluación de contexto:`, contextEval);

                if (!contextEval.proceed) {
                    // Need more context — return oracle question as JSON (not SSE)
                    console.log(`[${chatId}] 🔮 Necesita más contexto, enviando pregunta oracular...`);
                    return res.json({
                        type: 'context_question',
                        text: contextEval.oracle_question,
                        missing_dimension: contextEval.missing_dimension,
                        role: 'assistant',
                        _isContextQuestion: true
                    });
                }

                // Context is sufficient
                contextSummary = contextEval.context_summary;
                console.log(`[${chatId}] ✅ Contexto suficiente: ${contextSummary}`);
            } else {
                console.log(`[${chatId}] ↩️ Usuario respondió a pregunta contextual, procediendo directo a tirada.`);
            }

            // --- MEMORY RETRIEVAL ---
            let memoryContext = null;
            if (!isAnonymous) {
                try {
                    const { data: memData, error: memError } = await supabase.rpc(
                        'get_user_memory_context',
                        { p_user_id: userId }
                    );
                    if (!memError && memData) {
                        memoryContext = memData;
                        console.log(`[${chatId}] 🧠 Contexto de memoria cargado.`);
                    }
                } catch (memErr) {
                    console.error(`[${chatId}] ⚠️ Error cargando memoria (non-blocking):`, memErr.message);
                }
            }

            // Context sufficient + memory loaded → ready for client-side card draw
            console.log(`[${chatId}] ✅ Listo para lectura. El frontend tirará las cartas.`);
            return res.json({
                type: 'ready_for_reading',
                contextSummary: contextSummary || null,
                memoryContext: memoryContext || null,
                futureHidden,
                ctaMessage,
                isAnonymous
            });
        }

        // Fallback por si la decisión no es ninguna de las esperadas
        throw new Error(`Decisión desconocida del Agente Decisor: ${decision.type}`);

    } catch (err) {
        console.error(`[${chatId}] ❌ Error en el flujo del chat:`, err);
        res.status(500).json({ error: "Ocurrió un error al procesar tu pregunta." });
    }
});


// =======================================
// INTERPRETATION ENDPOINT (Phase 2: after client-side card draw)
// =======================================

app.post("/api/chat/interpret", chatLimiter, async (req, res) => {
    const { question, history, personalContext, drawnCards, userId, chatId, contextSummary, memoryContext } = req.body;

    if (!question || !drawnCards || !chatId) {
        return res.status(400).json({ error: "question, drawnCards y chatId son requeridos." });
    }

    const isAnonymous = !userId || userId === 'anonymous';

    // Get user permissions for paywall filtering
    let futureHidden = isAnonymous;
    if (!isAnonymous) {
        try {
            const { data: permissions, error } = await supabase.rpc(
                'get_user_reading_permissions',
                { p_user_id: userId }
            );
            if (!error && permissions) {
                futureHidden = !permissions.can_see_future && !permissions.is_premium;
            }
        } catch (permErr) {
            console.error(`[${chatId}] ⚠️ Error getting permissions:`, permErr);
        }
    }

    try {
        // Configure SSE headers
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();

        // PASO 1: Generar título en paralelo (no bloqueante) si es primer mensaje
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

        // PASO 2: Construir prompt del intérprete
        const historyForInterpreter = history ? history.map(msg => `${msg.role === 'user' ? 'Consultante' : 'Oráculo'}: ${msg.content}`).join('\n\n') : '';
        const interpreterPrompt = `
            ${personalContext || ''}

            ${contextSummary ? `**Contexto emocional detectado:** ${contextSummary}` : ''}

            ${memoryContext ? `**Contexto conocido del consultante (de sesiones anteriores):**\n${memoryContext}` : ''}

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

        // PASO 3: Generar interpretación
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

        // PASO 4: Parsear secciones y filtrar según permisos
        const sections = parseInterpretationSections(interpretation);
        const clientSections = filterSectionsForPaywall(sections, futureHidden);

        // Cache full unfiltered content for anonymous users (used during transfer)
        if (isAnonymous && sections._sectioned) {
            const fullContent = JSON.stringify({
                _version: 2,
                sections: Object.fromEntries(
                    ['saludo', 'pasado', 'presente', 'futuro', 'sintesis', 'consejo']
                        .filter(k => sections[k])
                        .map(k => [k, sections[k]])
                ),
                rawText: interpretation
            });
            cacheAnonymousMessage(chatId, {
                role: 'user',
                content: question,
                cards: null
            });
            cacheAnonymousMessage(chatId, {
                role: 'assistant',
                content: fullContent,
                cards: drawnCards
            });
            console.log(`[${chatId}] 💾 Cached full interpretation for anonymous user`);
        }

        // PASO 5: Enviar secciones al cliente
        console.log(`[${chatId}] 📤 Enviando secciones al cliente (futureHidden=${futureHidden}, sectioned=${sections._sectioned})...`);

        if (sections._sectioned) {
            const sectionOrder = ['saludo', 'pasado', 'presente', 'futuro', 'sintesis', 'consejo'];
            let isFirstSection = true;
            for (const sectionKey of sectionOrder) {
                if (clientSections[sectionKey]) {
                    // Stagger sections for dramatic reveal (skip delay on first)
                    if (!isFirstSection) {
                        await new Promise(r => setTimeout(r, 800));
                    }
                    isFirstSection = false;
                    res.write(`event: section\n`);
                    res.write(`data: ${JSON.stringify({
                        section: sectionKey,
                        text: clientSections[sectionKey],
                        isTeaser: sectionKey === 'futuro' && futureHidden
                    })}\n\n`);
                    if (res.flush) res.flush();
                }
            }
        }

        // Legacy: also send full visible text as interpretation event (backward compat)
        const visibleText = sections._sectioned
            ? ['saludo', 'pasado', 'presente', 'futuro', 'sintesis', 'consejo']
                .filter(k => clientSections[k])
                .map(k => clientSections[k])
                .join('\n\n')
            : interpretation;
        res.write(`event: interpretation\n`);
        res.write(`data: ${JSON.stringify({ text: visibleText })}\n\n`);

        // PASO 6: Enviar título si está disponible
        if (titlePromise) {
            try {
                const titleCompletion = await titlePromise;
                if (titleCompletion) {
                    const generatedTitle = titleCompletion.choices[0]?.message?.content.replace(/"/g, '') || question.substring(0, 40);
                    console.log(`[${chatId}] 📝 Título generado: "${generatedTitle}"`);

                    res.write(`event: title\n`);
                    res.write(`data: ${JSON.stringify({ title: generatedTitle })}\n\n`);
                }
            } catch (titleError) {
                console.error(`[${chatId}] ❌ Error esperando título:`, titleError);
            }
        }

        // PASO 7: Evento DONE para cerrar el stream
        res.write(`event: done\n`);
        res.write(`data: ${JSON.stringify({ complete: true })}\n\n`);

        // Background: Extract and save memory (fire-and-forget)
        extractAndSaveMemory(userId, chatId, question, interpretation);

        return res.end();

    } catch (err) {
        console.error(`[${chatId}] ❌ Error en interpretación:`, err);
        // If headers already sent (SSE started), send error event
        if (res.headersSent) {
            res.write(`event: error\n`);
            res.write(`data: ${JSON.stringify({ error: "Error al generar la interpretación." })}\n\n`);
            return res.end();
        }
        res.status(500).json({ error: "Error al generar la interpretación." });
    }
});


// =======================================
// CHAT TRANSFER & SECTION REVEAL ENDPOINTS
// =======================================

// Transfer anonymous chat to authenticated user (with in-memory messages)
app.post("/api/chat/transfer", async (req, res) => {
    const { chatId, newUserId, messages } = req.body;

    if (!chatId || !newUserId) {
        return res.status(400).json({ error: "chatId y newUserId son requeridos" });
    }

    try {
        // Prefer server-side cached messages (full unfiltered) over client-provided (filtered)
        const cachedEntry = anonymousInterpretationCache.get(chatId);
        const messagesToSave = (cachedEntry && cachedEntry.messages.length > 0)
            ? cachedEntry.messages
            : messages;

        console.log(`[Transfer] Transferring chat ${chatId} to user ${newUserId}, messages: ${messagesToSave?.length || 0} (source: ${cachedEntry ? 'server-cache' : 'client'})`);

        // Clean up cache entry after use
        if (cachedEntry) {
            anonymousInterpretationCache.delete(chatId);
        }

        // Check if chat already exists in DB
        const { data: existingChat } = await supabase
            .from('chats')
            .select('id')
            .eq('id', chatId)
            .maybeSingle();

        if (existingChat) {
            // Chat exists — update ownership
            const { error: chatUpdateErr } = await supabase
                .from('chats')
                .update({ user_id: newUserId })
                .eq('id', chatId);

            if (chatUpdateErr) {
                console.error(`[Transfer] Error updating chat ownership:`, chatUpdateErr);
            }

            const { error: msgUpdateErr } = await supabase
                .from('messages')
                .update({ user_id: newUserId })
                .eq('chat_id', chatId);

            if (msgUpdateErr) {
                console.error(`[Transfer] Error updating message ownership:`, msgUpdateErr);
            }

            console.log(`[Transfer] Updated existing chat ownership to ${newUserId}`);
        } else if (messagesToSave && messagesToSave.length > 0) {
            // Chat doesn't exist — create it with provided messages
            const title = messagesToSave.find(m => m.role === 'user')?.content?.substring(0, 50) || 'Chat transferido';

            const { error: chatInsertError } = await supabase
                .from('chats')
                .insert({ id: chatId, user_id: newUserId, title });

            if (chatInsertError) {
                console.error(`[Transfer] Error creating chat:`, chatInsertError);
                return res.status(500).json({ error: "Error al crear el chat", details: chatInsertError.message });
            }

            // Insert messages in order using direct table insert (service key bypasses RLS)
            // Note: save_message RPC uses auth.uid() which is null with service key
            let savedCount = 0;
            for (const msg of messagesToSave) {
                const { error: insertError } = await supabase
                    .from('messages')
                    .insert({
                        chat_id: chatId,
                        user_id: newUserId,
                        role: msg.role,
                        content: msg.content,
                        cards: msg.cards || null
                    });

                if (insertError) {
                    console.error(`[Transfer] Error inserting message:`, insertError);
                } else {
                    savedCount++;
                }
            }

            console.log(`[Transfer] Created new chat with ${savedCount}/${messagesToSave.length} messages for user ${newUserId}`);
        } else {
            return res.status(404).json({ error: "Chat no encontrado y no se proporcionaron mensajes" });
        }

        res.json({ success: true, chatId });
    } catch (err) {
        console.error("[Transfer] Error:", err);
        res.status(500).json({ error: "Error al transferir el chat" });
    }
});

// Get full unfiltered sections for a message (after payment/auth)
app.get("/api/chat/message/:chatId/:messageId/full-sections", async (req, res) => {
    const { chatId, messageId } = req.params;
    const { userId } = req.query;

    if (!userId) {
        return res.status(400).json({ error: "userId es requerido" });
    }

    try {
        console.log(`[FullSections] Fetching for chat=${chatId}, message=${messageId}, user=${userId}`);

        // Verify user can see future
        const { data: permissions, error: permError } = await supabase.rpc(
            'get_user_reading_permissions',
            { p_user_id: userId }
        );

        if (permError) {
            console.error(`[FullSections] Permission check error:`, permError);
            return res.status(500).json({ error: "Error verificando permisos" });
        }

        const canSeeFuture = permissions?.can_see_future || permissions?.is_premium;
        if (!canSeeFuture) {
            return res.status(403).json({ error: "No tienes permiso para ver el futuro completo" });
        }

        // Fetch the message
        const { data: message, error: msgError } = await supabase
            .from('messages')
            .select('content, user_id')
            .eq('id', messageId)
            .eq('chat_id', chatId)
            .maybeSingle();

        if (msgError || !message) {
            console.error(`[FullSections] Message not found:`, msgError);
            return res.status(404).json({ error: "Mensaje no encontrado" });
        }

        // Verify ownership
        if (message.user_id !== userId) {
            return res.status(403).json({ error: "No tienes acceso a este mensaje" });
        }

        // Parse v2 content
        let sections = null;
        try {
            const parsed = JSON.parse(message.content);
            if (parsed._version === 2 && parsed.sections) {
                sections = {};
                const sectionOrder = ['saludo', 'pasado', 'presente', 'futuro', 'sintesis', 'consejo'];
                for (const key of sectionOrder) {
                    if (parsed.sections[key]) {
                        sections[key] = { text: parsed.sections[key], isTeaser: false };
                    }
                }
            }
        } catch (e) {
            // v1 plain text — no sections to reveal
            return res.json({ sections: null, rawText: message.content });
        }

        res.json({ sections });
    } catch (err) {
        console.error("[FullSections] Error:", err);
        res.status(500).json({ error: "Error al obtener secciones completas" });
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

    // Check if this is the user's first reading and complete referral if pending
    if (data?.total_readings === 1) {
      console.log(`[Referral] First reading for user ${userId}, checking for pending referral...`);
      try {
        const { data: referralResult } = await supabase.rpc('complete_referral_reward', {
          p_referred_id: userId
        });
        if (referralResult?.success) {
          console.log(`[Referral] Reward granted to referrer: ${referralResult.reward_type} = ${referralResult.reward_amount}`);
        }
      } catch (refError) {
        // Don't block the reading response if referral fails
        console.error('[Referral] Auto-complete failed (non-blocking):', refError.message);
      }
    }

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

// Get all users list
app.get("/api/admin/users", adminAuth, async (req, res) => {
  try {
    // Get all users from Supabase Auth
    const { data: authData, error: authError } = await supabase.auth.admin.listUsers();

    if (authError) {
      console.error("Error listing users:", authError);
      return res.status(500).json({ error: "Error fetching auth users" });
    }

    console.log("[Admin] listUsers result:", JSON.stringify(authData, null, 2));
    const authUsers = authData?.users || [];

    // Get user profiles from database
    const { data: profiles } = await supabase
      .from('user_profiles')
      .select('user_id, display_name, gender, date_of_birth, language, timezone');

    const profileMap = {};
    profiles?.forEach(p => {
      profileMap[p.user_id] = p;
    });

    // Get active subscriptions
    const { data: subscriptions } = await supabase
      .from('user_subscriptions')
      .select('user_id, plan_id, status, subscription_end_date')
      .eq('status', 'active')
      .gt('subscription_end_date', new Date().toISOString());

    const subMap = {};
    subscriptions?.forEach(s => {
      subMap[s.user_id] = s;
    });

    // Get chat counts per user
    const { data: chatCounts } = await supabase
      .from('chats')
      .select('user_id');

    const chatCountMap = {};
    chatCounts?.forEach(c => {
      chatCountMap[c.user_id] = (chatCountMap[c.user_id] || 0) + 1;
    });

    // Combine all data
    const users = authUsers.map(u => ({
      id: u.id,
      email: u.email,
      name: profileMap[u.id]?.display_name || '-',
      language: profileMap[u.id]?.language || '-',
      created_at: u.created_at,
      last_sign_in: u.last_sign_in_at,
      is_premium: !!subMap[u.id],
      subscription_end: subMap[u.id]?.subscription_end_date || null,
      chat_count: chatCountMap[u.id] || 0,
      provider: u.app_metadata?.provider || 'email'
    }));

    // Sort by created_at descending (newest first)
    users.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    console.log(`[Admin] Returning ${users.length} users`);
    res.json({ users });
  } catch (err) {
    console.error("Admin error:", err);
    res.status(500).json({ error: "Error fetching users" });
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
// SHARE ENDPOINTS
// =======================================

// Create a share link for a chat
app.post("/api/chat/:chatId/share", async (req, res) => {
  const { chatId } = req.params;
  const { userId } = req.body;

  if (!chatId || !userId) {
    return res.status(400).json({ error: "chatId y userId son requeridos" });
  }

  try {
    console.log(`[Share] Creating share for chat ${chatId} by user ${userId}`);

    // 1. Verify ownership of the chat
    const { data: chat, error: chatError } = await supabase
      .from('chats')
      .select('id, title, user_id')
      .eq('id', chatId)
      .eq('user_id', userId)
      .single();

    if (chatError || !chat) {
      console.error(`[Share] Chat not found or unauthorized:`, chatError);
      return res.status(404).json({ error: 'Chat no encontrado o no autorizado' });
    }

    // 2. Check if share already exists for this chat
    const { data: existingShare } = await supabase.rpc('get_existing_share', {
      p_chat_id: chatId
    });

    if (existingShare && existingShare.length > 0) {
      const share = existingShare[0];
      console.log(`[Share] Found existing share: ${share.share_id}`);
      return res.json({
        shareId: share.share_id,
        shareUrl: `${process.env.SHARE_URL || 'https://share.freetarot.fun'}/${share.share_id}`,
        previewImageUrl: share.preview_image_url,
        alreadyShared: true
      });
    }

    // 3. Get chat history
    const { data: messages, error: msgError } = await supabase.rpc('get_chat_history', {
      p_chat_id: chatId
    });

    if (msgError) {
      console.error(`[Share] Error fetching chat history:`, msgError);
      return res.status(500).json({ error: 'Error obteniendo historial del chat' });
    }

    // 4. Find the reading message with cards
    const readingMsg = messages?.find(m => m.cards && m.cards.length > 0);
    if (!readingMsg) {
      return res.status(400).json({ error: 'No se encontró una lectura de tarot en este chat' });
    }

    // 5. Extract synthesis for OG description
    let interpretationSummary = '';
    try {
      const content = JSON.parse(readingMsg.content);
      if (content._version === 2 && content.sections?.sintesis) {
        interpretationSummary = content.sections.sintesis.substring(0, 200);
      } else if (content.sections?.sintesis?.text) {
        interpretationSummary = content.sections.sintesis.text.substring(0, 200);
      }
    } catch (e) {
      // Plain text content - extract first 200 chars
      interpretationSummary = readingMsg.content?.substring(0, 200) || '';
    }

    // 6. Get user's original question
    const userQuestion = messages?.find(m => m.role === 'user')?.content || '';

    // 7. Generate unique share_id
    const shareId = nanoid(10);

    // 8. Create share record FIRST (fast response to user)
    const { data: shareResult, error: insertError } = await supabase.rpc('create_share', {
      p_share_id: shareId,
      p_chat_id: chatId,
      p_user_id: userId,
      p_title: chat.title || 'Lectura de Tarot',
      p_question: userQuestion,
      p_cards: readingMsg.cards,
      p_interpretation_summary: interpretationSummary,
      p_preview_image_url: null // Will be updated in background
    });

    if (insertError) {
      console.error(`[Share] Error creating share:`, insertError);
      return res.status(500).json({ error: 'Error al crear el enlace compartido' });
    }

    const shareUrl = `${process.env.SHARE_URL || 'https://share.freetarot.fun'}/${shareId}`;
    console.log(`[Share] Created share: ${shareId} for chat ${chatId}`);

    // 9. Auto-close the chat when shared
    try {
      await supabase.rpc('close_chat', {
        p_chat_id: chatId,
        p_user_id: userId
      });
      console.log(`[Share] Chat ${chatId} auto-closed after sharing`);
    } catch (closeErr) {
      console.error(`[Share] Warning: Failed to auto-close chat:`, closeErr);
      // Don't fail the share operation if close fails
    }

    // 10. Send response immediately (don't wait for image)
    res.json({
      shareId,
      shareUrl,
      previewImageUrl: null, // Image generating in background
      chatClosed: true // Inform frontend that chat is now closed
    });

    // 10. Generate preview image in BACKGROUND (after response sent)
    const frontendUrl = process.env.FRONTEND_URL || 'https://freetarot.fun';
    generateSharePreview(readingMsg.cards, frontendUrl)
      .then(imageBuffer => uploadToStorage(supabase, imageBuffer, shareId))
      .then(previewImageUrl => {
        // Update share record with image URL
        return supabase
          .from('shared_chats')
          .update({ preview_image_url: previewImageUrl })
          .eq('share_id', shareId);
      })
      .then(() => {
        console.log(`[Share] Background image generated for: ${shareId}`);
      })
      .catch(imgError => {
        console.error(`[Share] Background image generation failed for ${shareId}:`, imgError.message);
      });

  } catch (error) {
    console.error('[Share] Error:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Close/finalize a chat (prevent further messages)
app.post("/api/chat/:chatId/close", async (req, res) => {
  const { chatId } = req.params;
  const { userId } = req.body;

  if (!chatId || !userId) {
    return res.status(400).json({ error: "chatId y userId son requeridos" });
  }

  try {
    console.log(`[Close] Closing chat ${chatId} for user ${userId}`);

    const { data, error } = await supabase.rpc('close_chat', {
      p_chat_id: chatId,
      p_user_id: userId
    });

    if (error) {
      console.error(`[Close] Error closing chat:`, error);
      return res.status(500).json({ error: 'Error al cerrar el chat' });
    }

    if (!data) {
      return res.status(404).json({ error: 'Chat no encontrado o no autorizado' });
    }

    console.log(`[Close] Chat ${chatId} closed successfully`);
    res.json({ success: true, closed: true });

  } catch (error) {
    console.error('[Close] Error:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Get shared reading data (public endpoint)
app.get("/api/shared/:shareId", async (req, res) => {
  const { shareId } = req.params;

  if (!shareId) {
    return res.status(400).json({ error: "shareId es requerido" });
  }

  try {
    console.log(`[Share] Fetching shared reading: ${shareId}`);

    const { data, error } = await supabase.rpc('get_shared_reading', {
      p_share_id: shareId
    });

    if (error) {
      console.error(`[Share] Error fetching share:`, error);
      return res.status(500).json({ error: 'Error obteniendo lectura compartida' });
    }

    if (!data) {
      return res.status(404).json({ error: 'Lectura compartida no encontrada o expirada' });
    }

    console.log(`[Share] Found share: ${shareId}, views: ${data.share?.view_count || 0}`);

    // Transform messages to include parsed sections for display
    const readings = [];
    if (data.messages) {
      for (const msg of data.messages) {
        if (msg.role === 'assistant' && msg.cards) {
          // This is a reading message
          let sections = null;
          try {
            const parsed = JSON.parse(msg.content);
            if (parsed._version === 2 && parsed.sections) {
              sections = parsed.sections;
            }
          } catch (e) {
            // Plain text - use raw content
          }

          readings.push({
            id: msg.id,
            cards: msg.cards,
            sections: sections,
            rawContent: sections ? null : msg.content,
            createdAt: msg.created_at
          });
        }
      }
    }

    res.json({
      share: data.share,
      readings,
      question: data.share?.question
    });

  } catch (error) {
    console.error('[Share] Error:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Check if a chat has a public share (for redirecting SPA URLs)
app.get("/api/chat/:chatId/public-share", async (req, res) => {
  const { chatId } = req.params;

  if (!chatId) {
    return res.status(400).json({ error: "chatId es requerido" });
  }

  try {
    // Check if there's a share for this chat
    const { data: existingShare } = await supabase.rpc('get_existing_share', {
      p_chat_id: chatId
    });

    if (existingShare && existingShare.length > 0) {
      const share = existingShare[0];
      return res.json({
        hasShare: true,
        shareUrl: `${process.env.SHARE_URL || 'https://share.freetarot.fun'}/${share.share_id}`
      });
    }

    res.json({ hasShare: false });

  } catch (error) {
    console.error('[Share] Error checking public share:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// =======================================
// REFERRAL ENDPOINTS
// =======================================

// GET /api/referral/code - Get or create user's referral code
app.get("/api/referral/code", async (req, res) => {
  const userId = req.headers['x-user-id'];
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    // Try to get existing code
    let { data: existing } = await supabase
      .from('referral_codes')
      .select('code')
      .eq('user_id', userId)
      .single();

    if (existing) {
      return res.json({ code: existing.code });
    }

    // Create new code using nanoid
    const code = nanoid(10).toUpperCase();
    const { data, error } = await supabase
      .from('referral_codes')
      .insert({ user_id: userId, code })
      .select('code')
      .single();

    if (error) {
      console.error('[Referral] Insert error:', error);
      // If there was a conflict, try to fetch the existing one
      const { data: existingAfterConflict } = await supabase
        .from('referral_codes')
        .select('code')
        .eq('user_id', userId)
        .single();

      if (existingAfterConflict) {
        return res.json({ code: existingAfterConflict.code });
      }
      throw error;
    }

    console.log(`[Referral] Created code ${data.code} for user ${userId}`);
    res.json({ code: data.code });

  } catch (error) {
    console.error('[Referral] Get code error:', error);
    res.status(500).json({ error: 'Failed to get referral code' });
  }
});

// GET /api/referral/stats - Get user's referral statistics
app.get("/api/referral/stats", async (req, res) => {
  const userId = req.headers['x-user-id'];
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const { data, error } = await supabase.rpc('get_referral_stats', {
      p_user_id: userId
    });

    if (error) throw error;
    res.json(data);

  } catch (error) {
    console.error('[Referral] Stats error:', error);
    res.status(500).json({ error: 'Failed to get referral stats' });
  }
});

// POST /api/referral/register - Register a referral (called on signup)
app.post("/api/referral/register", async (req, res) => {
  const { userId, referralCode } = req.body;

  if (!userId || !referralCode) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const { data, error } = await supabase.rpc('register_referral', {
      p_referred_id: userId,
      p_referral_code: referralCode
    });

    if (error) throw error;

    console.log(`[Referral] Registered referral: user ${userId} with code ${referralCode}, success: ${data}`);
    res.json({ success: data });

  } catch (error) {
    console.error('[Referral] Register error:', error);
    res.status(500).json({ error: 'Failed to register referral' });
  }
});

// POST /api/referral/complete - Complete referral and grant reward
app.post("/api/referral/complete", async (req, res) => {
  const { userId } = req.body;

  if (!userId) {
    return res.status(400).json({ error: 'Missing userId' });
  }

  try {
    const { data, error } = await supabase.rpc('complete_referral_reward', {
      p_referred_id: userId
    });

    if (error) throw error;

    console.log('[Referral] Completed:', data);
    res.json(data);

  } catch (error) {
    console.error('[Referral] Complete error:', error);
    res.status(500).json({ error: 'Failed to complete referral' });
  }
});

// GET /api/referral/list - Get list of user's referrals
app.get("/api/referral/list", async (req, res) => {
  const userId = req.headers['x-user-id'];
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const { data, error } = await supabase
      .from('referrals')
      .select('id, status, reward_type, reward_amount, created_at, completed_at')
      .eq('referrer_id', userId)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) throw error;
    res.json({ referrals: data });

  } catch (error) {
    console.error('[Referral] List error:', error);
    res.status(500).json({ error: 'Failed to get referrals' });
  }
});

// =======================================
// FACEBOOK DATA DELETION CALLBACK
// =======================================

function parseSignedRequest(signedRequest, secret) {
  const [encodedSig, payload] = signedRequest.split('.');
  if (!encodedSig || !payload) return null;

  const sig = Buffer.from(encodedSig.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const expectedSig = crypto.createHmac('sha256', secret).update(payload).digest();

  if (!crypto.timingSafeEqual(sig, expectedSig)) return null;

  return JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
}

app.post('/api/facebook/data-deletion', async (req, res) => {
  try {
    const { signed_request } = req.body;
    const appSecret = process.env.FACEBOOK_APP_SECRET;

    if (!appSecret) {
      console.error('[Facebook Data Deletion] FACEBOOK_APP_SECRET not configured');
      return res.status(500).json({ error: 'Server configuration error' });
    }

    if (!signed_request) {
      return res.status(400).json({ error: 'signed_request is required' });
    }

    const data = parseSignedRequest(signed_request, appSecret);
    if (!data) {
      return res.status(403).json({ error: 'Invalid signed_request' });
    }

    const facebookUserId = String(data.user_id);
    const confirmationCode = crypto.randomBytes(16).toString('hex');

    console.log(`[Facebook Data Deletion] Request for Facebook user: ${facebookUserId}`);

    // Find the Supabase user linked to this Facebook account
    const { data: identity, error: identityError } = await supabase
      .from('auth.identities')
      .select('user_id')
      .eq('provider', 'facebook')
      .eq('provider_id', facebookUserId)
      .single();

    if (identityError || !identity) {
      // User not found — may have already been deleted. Return success per Facebook's spec.
      console.log(`[Facebook Data Deletion] No user found for Facebook ID ${facebookUserId}, returning success`);
    } else {
      const { error: deleteError } = await supabase.auth.admin.deleteUser(identity.user_id);
      if (deleteError) {
        console.error(`[Facebook Data Deletion] Error deleting user ${identity.user_id}:`, deleteError);
        return res.status(500).json({ error: 'Failed to delete user data' });
      }
      console.log(`[Facebook Data Deletion] Successfully deleted user ${identity.user_id}`);
    }

    const statusUrl = `${process.env.FRONTEND_URL || 'https://freetarot.fun'}/deletion-status?code=${confirmationCode}`;

    res.json({
      url: statusUrl,
      confirmation_code: confirmationCode
    });

  } catch (err) {
    console.error('[Facebook Data Deletion] Error:', err);
    res.status(500).json({ error: 'Error processing data deletion request' });
  }
});

app.get('/api/facebook/deletion-status', (req, res) => {
  res.json({
    status: 'complete',
    message: 'Your data has been deleted from FreeTarot.Fun. This action is irreversible.'
  });
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