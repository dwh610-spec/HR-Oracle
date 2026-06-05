// pages/api/keytest.js
// Visit /api/keytest in your browser to test the Cerebras key directly

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const KEY = process.env.CEREBRAS_API_KEY;

  // Report what the key looks like WITHOUT exposing it fully
  const keyInfo = KEY
    ? `Key present. Length: ${KEY.length}. Starts: ${KEY.substring(0,7)}... Ends: ...${KEY.substring(KEY.length-4)}`
    : "NO KEY FOUND in environment";

  if (!KEY) {
    return res.status(200).json({ keyInfo, result: "Cannot test — no key set" });
  }

  // List available models with this key
  let modelsResult;
  try {
    const mRes = await fetch("https://api.cerebras.ai/v1/models", {
      headers: { "Authorization": `Bearer ${KEY}` }
    });
    const mData = await mRes.json();
    modelsResult = {
      status: mRes.status,
      data: mData
    };
  } catch (e) {
    modelsResult = { error: e.message };
  }

  // Try a tiny completion
  let chatResult;
  try {
    const cRes = await fetch("https://api.cerebras.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "llama3.1-8b",
        messages: [{ role: "user", content: "say hi" }],
        max_completion_tokens: 10
      })
    });
    const cData = await cRes.json();
    chatResult = {
      status: cRes.status,
      data: cData
    };
  } catch (e) {
    chatResult = { error: e.message };
  }

  return res.status(200).json({
    keyInfo,
    availableModels: modelsResult,
    chatTest: chatResult
  });
}
