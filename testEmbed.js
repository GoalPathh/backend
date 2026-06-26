import { config } from "dotenv";
config();
const apiKey = process.env.LLM_API_KEY;
const url = "https://generativelanguage.googleapis.com/v1beta/openai/embeddings";
fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
  body: JSON.stringify({ input: "Hello test", model: "text-embedding-004" })
})
.then(r => r.json())
.then(data => console.log("Response:", JSON.stringify(data, null, 2)))
.catch(console.error);
