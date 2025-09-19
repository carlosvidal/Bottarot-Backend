import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import { OpenAI } from "openai";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
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

app.post("/api/tarot", async (req, res) => {
  const { pregunta, cartas } = req.body;

  if (!pregunta || !cartas || !Array.isArray(cartas) || cartas.length === 0) {
    return res.status(400).json({ error: "Faltan la pregunta o las cartas." });
  }

  // Construir el prompt para el LLM
  const userPrompt = `
Pregunta del usuario: "${pregunta}"
Cartas seleccionadas:
${cartas
  .map(
    (carta, index) =>
      `${index + 1}. ${carta.nombre} - ${carta.orientacion} (Posición: ${
        carta.posicion
      })`
  )
  .join("\n")}
---
Por favor, genera una interpretación de tarot siguiendo las reglas y el estilo definidos.
`;

  try {
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
    res.json({ interpretation });
  } catch (err) {
    console.error("Error al contactar con OpenAI:", err);
    res.status(500).json({ error: "No se pudo obtener la interpretación." });
  }
});

app.listen(3000, () => {
  console.log("🚀 LLM proxy escuchando en http://localhost:3000");
});
