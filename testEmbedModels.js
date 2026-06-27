import { config } from "dotenv";
config();
const apiKey = process.env.LLM_API_KEY;
fetch("https://generativelanguage.googleapis.com/v1beta/openai/models", {
  headers: { "Authorization": `Bearer ${apiKey}` }
})
.then(r => r.json())
.then(data => {
  const models = data.data || [];
  const emb = models.filter(m => m.id.includes("embed"));
  console.log("Embedding models:", emb.map(m => m.id));
})
.catch(console.error);
