import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import { OpenAI } from "openai";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import paypalClient from "./paypal-config.js";
import pkg from '@paypal/paypal-server-sdk';
import { tarotDeck } from "./data/tarotDeck.js";

const { OrdersController } = pkg;
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
    *   Ejemplos: "¿Qué me depara el futuro en el amor?", "Necesito una guía sobre mi carrera", "Háblame de mi energía esta semana".

2.  **is_follow_up**: La pregunta es un seguimiento, aclaración o profundización sobre la última interpretación de tarot que diste.
    *   **Importante**: Solo es posible a partir de la segunda pregunta del usuario. La primera pregunta NUNCA puede ser \
`is_follow_up\
`.
    *   Ejemplos: "¿Qué significa la carta del medio?", "¿Puedes darme un consejo más práctico sobre eso?", "¿A qué te refieres con 'energía bloqueada'?".

3.  **is_inadequate**: La pregunta no es adecuada para una lectura de tarot.
    *   **Sub-categorías de \
`is_inadequate\
`**:
        *   **Soporte/Técnica**: Preguntas sobre la app, suscripciones, pagos, etc. (Ej: "¿Cómo cancelo mi suscripción?").
        *   **Fuera de Contexto**: Saludos, preguntas sin relación, bromas, pruebas. (Ej: "Hola", "¿Cuánto es 2+2?", "jajaja", "prueba").
        *   **Petición de Clarificación**: La pregunta es demasiado vaga o le falta contexto para hacer una tirada útil. (Ej: "ayuda", "?", "no se").

### Formato de Respuesta:

Debes responder **únicamente** con un objeto JSON. No añadas explicaciones ni texto adicional.

**Para \
`requires_new_draw\
`:**
{
  "type": "requires_new_draw"
}

**Para \
`is_follow_up\
`:**
{
  "type": "is_follow_up"
}

**Para \
`is_inadequate\
`:**
{
  "type": "is_inadequate",
  "response": "Aquí va la respuesta pre-generada para el usuario."
}
`;
const INTERPRETER_SYSTEM_PROMPT = `Eres una experta en tarot. Interpreta la tirada de cartas en relación a la pregunta del usuario, usando el contexto personal y el historial si se proveen. Sé mística, empática y clara.`;
const TITLE_GEN_SYSTEM_PROMPT = `Eres un experto en SEO. Resume la siguiente pregunta en un título corto y atractivo de 3 a 5 palabras. Responde únicamente con el título.`;

// --- HELPER FUNCTIONS ---
const drawCards = (numCards = 3) => {
    const deck = [...tarotDeck];
    const drawn = [];
    const positions = ['Pasado', 'Presente', 'Futuro'];
    for (let i = 0; i < numCards; i++) {
        if (deck.length === 0) break;
        const randomIndex = Math.floor(Math.random() * deck.length);
        const card = deck.splice(randomIndex, 1)[0];
        const upright = Math.random() < 0.5;
        drawn.push({ ...card, upright, orientation: upright ? 'Derecha' : 'Invertida', posicion: positions[i] || 
`Posición ${i + 1}` 
});
    }
    return drawn;
};

// --- API ENDPOINTS ---

// Endpoint 1: Decide, draw cards, or give a simple answer
app.post("/api/chat/decide", async (req, res) => {
    const { question, history, userId, chatId } = req.body;
    if (!question) return res.status(400).json({ error: "La pregunta es requerida." });

    try {
        console.log(`[${chatId}] 🧐 /decide: Analizando pregunta...`);
        const deciderCompletion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: DECIDER_SYSTEM_PROMPT },
                { role: "user", content: `Historial:\n${JSON.stringify(history)}\n\nPregunta: "${question}"` },
            ],
            response_format: { type: "json_object" },
            temperature: 0,
        });
        const decision = JSON.parse(deciderCompletion.choices[0].message.content);
        console.log(`[${chatId}] ✅ /decide: Decisión -> ${decision.type}`);

        if (decision.type === 'is_inadequate' || decision.type === 'is_follow_up') {
            const completion = await openai.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [
                    { role: "system", content: INTERPRETER_SYSTEM_PROMPT },
                    { role: "user", content: decision.type === 'is_inadequate' ? decision.response : `Responde a esta pregunta de seguimiento basada en el historial: "${question}"` },
                ]
            });
            return res.json({ type: 'message', text: completion.choices[0].message.content });
        }

        if (decision.type === 'requires_new_draw') {
            const drawnCards = drawCards(3);
            console.log(`[${chatId}] 🃏 /decide: Tirada de cartas realizada.`);
            
            let generatedTitle = null;
            if (!history || history.length === 0) {
                console.log(`[${chatId}] ✍️ /decide: Generando título...`);
                try {
                    const titleCompletion = await openai.chat.completions.create({ model: "gpt-4o-mini", messages: [{ role: "system", content: TITLE_GEN_SYSTEM_PROMPT }, { role: "user", content: question }] });
                    generatedTitle = titleCompletion.choices[0]?.message?.content.replace(/"/g, 
'') || question.substring(0, 40);
                    await supabase.rpc('update_chat_title', { p_chat_id: chatId, p_user_id: userId, p_new_title: generatedTitle });
                } catch (titleError) { console.error(`[${chatId}] ❌ /decide: Error generando título:`, titleError); }
            }

            return res.json({ type: 'cards_drawn', cards: drawnCards, title: generatedTitle });
        }

        throw new Error(`Decisión desconocida: ${decision.type}`);
    } catch (err) {
        console.error(`[${chatId}] ❌ /decide: Error en el flujo:`, err);
        res.status(500).json({ error: "Ocurrió un error al procesar tu pregunta." });
    }
});

// Endpoint 2: Interpret the drawn cards
app.post("/api/chat/interpret", async (req, res) => {
    const { question, history, personalContext, cards, chatId } = req.body;
    if (!question || !cards) return res.status(400).json({ error: "Faltan la pregunta o las cartas." });

    try {
        console.log(`[${chatId}] 🔮 /interpret: Interpretando cartas...`);
        const interpreterPrompt = `Contexto Personal: ${personalContext || 'No disponible'}\n\nHistorial: ${JSON.stringify(history)}\n\nPregunta: "${question}"\n\nCartas: ${JSON.stringify(cards)}`;
        
        const stream = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: INTERPRETER_SYSTEM_PROMPT },
                { role: "user", content: interpreterPrompt },
            ],
            stream: true,
        });

        res.setHeader('Content-Type', 'text/plain');
        for await (const part of stream) {
            res.write(part.choices[0]?.delta?.content || '');
        }
        console.log(`[${chatId}] ✅ /interpret: Interpretación enviada.`);
        res.end();
    } catch (err) {
        console.error(`[${chatId}] ❌ /interpret: Error en el flujo:`, err);
        res.end();
    }
});


// --- OTHER ENDPOINTS (UNCHANGED) ---
app.get("/api/version", (req, res) => res.json({ version: "2.0-dummy-fix" }));
app.get("/ping", (req, res) => res.json({ ok: true, message: "El oráculo está despierto" }));
app.get("/api/user/subscription/:userId", async (req, res) => {
  try {
    console.log(`[DEBUG] Hit dummy subscription endpoint for user: ${req.params.userId}`);
    res.json({ has_active_subscription: true, plan_name: 'Premium Plan (Debug)', questions_remaining: 100, subscription_end_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(), can_ask_question: true });
  } catch (err) {
    console.error("Error getting subscription info:", err);
    res.status(500).json({ error: "No se pudo obtener la información de suscripción." });
  }
});

// ... other endpoints like paypal, etc. remain here ...

app.listen(3000, () => {
  console.log("🚀 Servidor de Bottarot escuchando en http://localhost:3000");
});