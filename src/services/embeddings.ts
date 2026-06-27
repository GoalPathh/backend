import { config } from "../config.js";
import { AppError } from "../errors.js";

// Uses the configured LLM API (if OpenAI compatible) to generate embeddings
export async function generateEmbedding(text: string): Promise<number[]> {
  if (!config.llmApiKey || !config.llmProviderUrl) {
    console.warn("[Embeddings] Missing LLM config, returning empty vector");
    return new Array(1536).fill(0);
  }

  // Assuming OpenAI compatible embeddings endpoint
  const url = `${config.llmProviderUrl.replace(/\/chat\/completions$/, "")}/embeddings`;
  
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${config.llmApiKey}`
      },
      body: JSON.stringify({
        input: text,
        model: "gemini-embedding-2", // Gemini OpenAI-compatible embedding model
      })
    });

    if (!res.ok) {
      console.warn(`[Embeddings] API failed: ${res.status}`);
      return new Array(1536).fill(0);
    }

    const data = await res.json() as any;
    if (data.data && data.data[0] && data.data[0].embedding) {
      const rawVector = data.data[0].embedding;
      // Gemini's embedding-2 returns 3072 dimensions.
      // Our pgvector column is vector(1536).
      // We truncate (slice) it down to 1536 dimensions so Postgres accepts it.
      return rawVector.slice(0, 1536);
    }
    
    return new Array(1536).fill(0);
  } catch (error) {
    console.warn(`[Embeddings] Error generating vector: ${error}`);
    return new Array(1536).fill(0);
  }
}
