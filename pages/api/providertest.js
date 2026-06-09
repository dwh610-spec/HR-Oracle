// pages/api/providertest.js
// Diagnostic: checks each provider independently with a trivial prompt and
// reports back in plain English. Visit /api/providertest in the browser.
// Does NOT touch MLB data — isolates the LLM layer only.

export const config = { maxDuration: 30 };

async function fetchWithTimeout(url, opts, ms) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(id); }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const out = { time: new Date().toISOString(), cerebras: {}, gemini: {} };

  const cKeyRaw = process.env.CEREBRAS_API_KEY || "";
  const gKeyRaw = process.env.GEMINI_API_KEY || "";
  const cKey = cKeyRaw.trim();
  const gKey = gKeyRaw.trim();

  // Report key presence + whether the stored value had stray whitespace.
  out.cerebras.keyPresent = !!cKey;
  out.cerebras.keyLength = cKey.length;
  out.cerebras.keyPrefix = cKey ? cKey.slice(0, 7) : "(none)";
  out.cerebras.hadWhitespace = cKeyRaw !== cKey;
  out.gemini.keyPresent = !!gKey;
  out.gemini.keyLength = gKey.length;
  out.gemini.hadWhitespace = gKeyRaw !== gKey;

  const tinyPrompt = 'Reply with this exact JSON and nothing else: {"ok":true}';

  // ── Test Cerebras ─────────────────────────────────────────────────────
  if (cKey) {
    try {
      const r = await fetchWithTimeout("https://api.cerebras.ai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${cKey}` },
        body: JSON.stringify({
          model: "gpt-oss-120b",
          max_completion_tokens: 50,
          response_format: { type: "json_object" },
          messages: [{ role: "user", content: tinyPrompt }]
        })
      }, 25000);
      out.cerebras.httpStatus = r.status;
      let data; try { data = await r.json(); } catch { data = null; }
      if (data?.error) {
        out.cerebras.result = "ERROR";
        out.cerebras.detail = (data.error.message || JSON.stringify(data.error)).slice(0, 200);
      } else if (data?.choices?.[0]?.message?.content) {
        out.cerebras.result = "SUCCESS ✅";
        out.cerebras.sample = data.choices[0].message.content.slice(0, 60);
      } else {
        out.cerebras.result = "UNEXPECTED";
        out.cerebras.detail = JSON.stringify(data).slice(0, 200);
      }
    } catch (e) {
      out.cerebras.result = "THREW";
      out.cerebras.detail = e.name === "AbortError" ? "timed out (25s)" : e.message.slice(0, 200);
    }
  } else {
    out.cerebras.result = "NO KEY — not set in Vercel env vars";
  }

  // ── Test Gemini ───────────────────────────────────────────────────────
  if (gKey) {
    for (const model of ["gemini-2.5-flash-lite", "gemini-2.5-flash"]) {
      const entry = {};
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(gKey)}`;
        const r = await fetchWithTimeout(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: tinyPrompt }] }],
            generationConfig: { maxOutputTokens: 50, responseMimeType: "application/json" }
          })
        }, 25000);
        entry.httpStatus = r.status;
        let data; try { data = await r.json(); } catch { data = null; }
        if (data?.error) {
          entry.result = data.error.code === 429 ? "RATE-LIMITED (429) — likely daily quota used up" : "ERROR";
          entry.detail = (data.error.message || "").slice(0, 200);
        } else if (data?.candidates?.[0]?.content?.parts?.[0]?.text) {
          entry.result = "SUCCESS ✅";
          entry.sample = data.candidates[0].content.parts[0].text.slice(0, 60);
        } else {
          entry.result = "UNEXPECTED";
          entry.detail = JSON.stringify(data).slice(0, 200);
        }
      } catch (e) {
        entry.result = "THREW";
        entry.detail = e.name === "AbortError" ? "timed out (25s)" : e.message.slice(0, 200);
      }
      out.gemini[model] = entry;
    }
  } else {
    out.gemini.result = "NO KEY — not set in Vercel env vars";
  }

  // ── Verdict ───────────────────────────────────────────────────────────
  const cOk = out.cerebras.result === "SUCCESS ✅";
  const gLiteOk = out.gemini["gemini-2.5-flash-lite"]?.result === "SUCCESS ✅";
  const gFlashOk = out.gemini["gemini-2.5-flash"]?.result === "SUCCESS ✅";
  if (cOk) out.VERDICT = "Cerebras works — the main app should now succeed via Cerebras.";
  else if (gLiteOk || gFlashOk) out.VERDICT = "Cerebras is down but Gemini works — app should succeed via Gemini.";
  else out.VERDICT = "Both providers failing. See detail fields above for the exact reason per provider.";

  return res.status(200).json(out);
}
