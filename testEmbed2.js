import { config } from "dotenv";
config();
fetch("https://generativelanguage.googleapis.com/v1beta/openai/embeddings", {
  method: "POST",
  headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.LLM_API_KEY}` },
  body: JSON.stringify({ input: "Hello test", model: "gemini-embedding-2" })
})
.then(r => r.json())
.then(data => {
  if (data.data) {
     console.log("SUCCESS! Vector length:", data.data[0].embedding.length);
  } else {
     console.log("Error:", data);
  }
})
.catch(console.error);
