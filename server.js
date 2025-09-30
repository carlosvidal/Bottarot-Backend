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

const DECIDER_SYSTEM_PROMPT = `Eres el "Agente Decisor" de un oráculo de tarot. Tu única función es analizar la pregunta de un usuario y clasificarla en una de las siguientes categorías, devolviendo únicamente un objeto JSON.

### Categorías de Decisión:

1.  **requires_new_draw**: La pregunta es una consulta de tarot válida y requiere una nueva tirada de cartas.
    *   Ejemplos: "¿Qué me depara el futuro en el amor?", "Necesito una guía sobre mi carrera", "Háblame de mi energía esta semana".

2.  **is_follow_up**: La pregunta es un seguimiento, aclaración o profundización sobre la última interpretación de tarot que diste.
    *   **Importante**: Solo es posible a partir de la segunda pregunta del usuario. La primera pregunta NUNCA puede ser `is_follow_up`.
    *   Ejemplos: "¿Qué significa la carta del medio?", "¿Puedes darme un consejo más práctico sobre eso?", "¿A qué te refieres con 'energía bloqueada'?".

3.  **is_inadequate**: La pregunta no es adecuada para una lectura de tarot.
    *   **Sub-categorías de `is_inadequate`**:
        *   **Soporte/Técnica**: Preguntas sobre la app, suscripciones, pagos, etc. (Ej: "¿Cómo cancelo mi suscripción?").
        *   **Fuera de Contexto**: Saludos, preguntas sin relación, bromas, pruebas. (Ej: "Hola", "¿Cuánto es 2+2?", "jajaja", "prueba").
        *   **Petición de Clarificación**: La pregunta es demasiado vaga o le falta contexto para hacer una tirada útil. (Ej: "ayuda", "?", "no se").

### Formato de Respuesta:

Debes responder **únicamente** con un objeto JSON. No añadas explicaciones ni texto adicional.

**Para `requires_new_draw`:**
{
  "type": "requires_new_draw"
}

**Para `is_follow_up`:**
{
  "type": "is_follow_up"
}

**Para `is_inadequate`:**
{
  "type": "is_inadequate",
  "response": "Aquí va la respuesta pre-generada para el usuario."
}
`;
const INTERPRETER_SYSTEM_PROMPT = `Eres una experta en tarot. Interpreta la tirada de cartas en relación a la pregunta del usuario, usando el contexto personal y el historial si se proveen. Sé mística, empática y clara.`;
const TITLE_GEN_SYSTEM_PROMPT = `Eres un experto en SEO. Resume la siguiente pregunta en un título corto y atractivo de 3 a 5 palabras. Responde únicamente con el título.`;

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

app.post("/api/chat/decide", async (req, res) => {
    const { question, history, userId, chatId } = req.body;
    if (!question) return res.status(400).json({ error: "La pregunta es requerida." });

    try {
        console.log(`[${chatId}] 🧐 /decide: Analizando pregunta...`);
        const deciderCompletion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: DECIDER_SYSTEM_PROMPT },
                { role: "user", content: `Historial:\n${JSON.stringify(history)}

Pregunta: "${question}"