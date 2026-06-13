// pages/api/analyze.js
// v12: ONE pass over the slate, provider fallback chain.
//   1) Cerebras gpt-oss-120b  (proven winner on this account)
//   2) Gemini 2.5-flash-lite  (fallback)
//   3) Gemini 2.5-flash       (last resort)
// Cerebras has an 8,192-token context cap, so if the slate is large we split
// it into chunks that each fit, run them, and merge. One request per chunk —
// still far under any per-minute limit.

export const config = { maxDuration: 60 };

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

async function fetchWithTimeout(url, opts, ms) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(id); }
}

// ── Prompt building ────────────────────────────────────────────────────────
function gameBlock(game, gameData) {
  const awayList = (gameData?.lineups?.away || []).slice(0, 9);
  const homeList = (gameData?.lineups?.home || []).slice(0, 9);
  const isProjected = !!gameData?.projected;
  const aP = gameData?.pitcherStats?.away || {};
  const hP = gameData?.pitcherStats?.home || {};
  const weather = gameData?.weather || {};
  const elevation = gameData?.elevation || 20;
  const slot = gameData?.isNightGame ? "N" : "D";

  const fmt = (arr) => arr.map(p => {
    const s = gameData?.playerStats?.[p.id] || {};
    const power = s.barrel_pct ? ` Brl%${s.barrel_pct}EV${s.avg_ev||"?"}` : "";
    const air = (s.fb_pct!=null) ? ` FB%${s.fb_pct}` : "";
    // Platoon line: this hitter's numbers vs the hand of the SP he actually faces.
    const plat = s.plat_ops ? ` vs${s.plat_hand}HP:OPS${s.plat_ops}HR${s.plat_hr}ISO${s.plat_iso}(${s.plat_ab}ab)` : "";
    return `#${p.lineup_spot||"?"} ${p.name}(${p.bats}) HR${s.hr||0} OPS${s.ops||"?"} ISO${s.iso||"?"}${air} L14:HR${s.recent_hr??0}ISO${s.recent_iso||"?"}OPS${s.recent_ops||"?"}(${s.recent_ab||0}ab)${power}${plat}`;
  }).join("\n");

  const aFb = aP.fb_pct!=null ? ` FB%${aP.fb_pct}` : "";
  const hFb = hP.fb_pct!=null ? ` FB%${hP.fb_pct}` : "";

  return `=== ${game.away_team}@${game.home_team} @${game.venue} ${slot} elev${elevation}${isProjected?" [PROJ]":""}
ASP ${game.away_sp.name}(${game.away_sp.throws}) ERA${aP.era||game.away_sp.era} HR/9 ${aP.hr9||"?"}${aFb}
HSP ${game.home_sp.name}(${game.home_sp.throws}) ERA${hP.era||game.home_sp.era} HR/9 ${hP.hr9||"?"}${hFb}
Wx:${weather.summary||"?"}${weather.wind_effect?` [${weather.wind_effect}]`:""}
AWAY(vs ${game.home_sp.throws}HP):
${fmt(awayList)}
HOME(vs ${game.away_sp.throws}HP):
${fmt(homeList)}`;
}

const INSTRUCTIONS_HEAD = `You are an elite MLB home-run prediction model. Below are MLB games with lineups and stats. Identify the TOP HOME RUN CANDIDATES.

Return the strongest 2-3 hitters from each game. Games tagged [PROJ] have projected (not confirmed) lineups — still analyze them.

SCORING PRIORITY: (1) RECENT 14-day form DOMINATES — weight recent ~60%, season ~40%; a hot bat beats a cold star. (2) PLATOON split — use the hitter's "vsLHP/vsRHP" line (OPS/ISO/HR) against the starter he actually faces; a strong platoon edge is a major boost. (3) power metrics (barrel%, EV). (4) batted-ball shape — high batter FB% (fly-ball hitter) + high pitcher FB% (fly-ball pitcher) together is a prime HR setup; a ground-ball hitter rarely homers regardless of power. (5) pitcher HR/9 and FB%. (6) WIND: "OUT to CF" strongly boosts HR, "IN from CF" strongly suppresses it, indoor/roof is neutral. (7) park/elevation (high elev boosts HR). (8) lineup spot — hitters batting 1-5 get more PAs and better pitches to hit than 6-9; weight top-of-order bats up slightly. (9) temperature — warm air (>78°F) adds carry. Reward hot+powerful+favorable-platoon+wind-out 85+, push cold or wind-in or ground-ball bats into 30s-40s. Use decimal hr_score to break ties.`;

const INSTRUCTIONS_TAIL = `Respond with ONLY JSON (no markdown):
{"candidates":[{"name":"","team":"","bats":"L","lineup_spot":3,"opposing_sp":"","sp_throws":"R","pitcher_grade":"AVERAGE","batter_grade":"HOT","hr_score":72.4,"hr_prob":"14%","key_stats":[{"label":"L14 HR","value":"4"},{"label":"L14 ISO","value":".310"},{"label":"vsRHP OPS","value":".940"},{"label":"Brl%","value":"15"}],"summary":"brief — mention platoon edge, wind, or FB-shape when relevant"}]}
Only use players listed above. team = the 2-3 letter abbreviation. pitcher_grade: BATTING PRACTICE|AVERAGE|STUD. batter_grade: FIRE|HOT|AVERAGE|COLD.`;

function buildPrompt(blocks) {
  return `${INSTRUCTIONS_HEAD}\n\n${blocks.join("\n\n")}\n\n${INSTRUCTIONS_TAIL}`;
}

// Rough token estimate: ~4 chars/token. Used to size Cerebras chunks.
function estTokens(str){ return Math.ceil(str.length / 4); }

// ── JSON extraction ────────────────────────────────────────────────────────
function extractCandidates(rawText) {
  if (!rawText) return null;
  let parsed;
  try { parsed = JSON.parse(rawText); }
  catch {
    const o1=rawText.indexOf("{"), o2=rawText.lastIndexOf("}");
    if (o1!==-1 && o2>o1) { try { parsed=JSON.parse(rawText.slice(o1,o2+1)); } catch {} }
    if (!parsed) { const a1=rawText.indexOf("["),a2=rawText.lastIndexOf("]"); if(a1!==-1&&a2>a1){try{parsed=JSON.parse(rawText.slice(a1,a2+1));}catch{}} }
  }
  if (!parsed) return null;
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed.candidates)) return parsed.candidates;
  const arr = Object.values(parsed).find(v=>Array.isArray(v));
  return arr || null;
}

// Last-resort salvage for truncated output (MAX_TOKENS): pull every COMPLETE
// {...} object out of a cut-off array and parse them individually. A response
// that got chopped mid-array still yields all the candidates before the cut.
function salvageCandidates(rawText) {
  if (!rawText) return null;
  const out = [];
  // Match balanced-ish object literals that contain a "name" field.
  const re = /\{[^{}]*"name"[^{}]*\}/g;
  let m;
  while ((m = re.exec(rawText)) !== null) {
    try { out.push(JSON.parse(m[0])); } catch {}
  }
  return out.length ? out : null;
}

// ── Cerebras ───────────────────────────────────────────────────────────────
// Free tier: 8,192-token context. Param is max_completion_tokens. JSON mode
// via response_format. Only gpt-oss-120b / zai-glm-4.7 available on this key.
async function callCerebras(prompt, key) {
  // Strip any stray whitespace/newlines from the env var — a trailing space or
  // line break makes the Authorization header an invalid string and fetch throws
  // "The string did not match the expected pattern" before the request is sent.
  const cleanKey = (key || "").trim();
  let r;
  try {
    r = await fetchWithTimeout("https://api.cerebras.ai/v1/chat/completions", {
      method:"POST",
      headers:{ "Content-Type":"application/json", "Authorization":`Bearer ${cleanKey}` },
      body: JSON.stringify({
        model: "gpt-oss-120b",
        max_completion_tokens: 5000,
        temperature: 0.3,
        response_format: { type: "json_object" },
        messages: [{ role:"user", content: prompt }]
      })
    }, 40000);
  } catch(e) {
    if (e.name === "AbortError") return { ok:false, kind:"timeout", msg:"Cerebras timed out" };
    return { ok:false, kind:"network", msg:"Cerebras: "+e.message };
  }

  let data;
  try { data = await r.json(); }
  catch { return { ok:false, kind:"parse", msg:`Cerebras non-JSON HTTP ${r.status}` }; }

  if (r.status === 429) return { ok:false, kind:"rate", msg:"Cerebras rate-limited" };
  if (r.status === 503 || r.status === 500) return { ok:false, kind:"busy", msg:`Cerebras busy (${r.status})` };
  // Context-overflow shows up as a 400 mentioning tokens/context/length.
  if (r.status === 400) {
    const m = (data?.error?.message||data?.message||"").toLowerCase();
    if (m.includes("token") || m.includes("context") || m.includes("length") || m.includes("maximum"))
      return { ok:false, kind:"toobig", msg:"Cerebras context exceeded" };
    return { ok:false, kind:"api", msg:"Cerebras 400: "+(data?.error?.message||"").substring(0,80) };
  }
  if (data?.error) return { ok:false, kind:"api", msg:"Cerebras: "+(data.error.message||"").substring(0,80) };

  // gpt-oss-120b is a reasoning model: the JSON answer is in message.content,
  // but if it runs low on tokens the parseable JSON can end up in `reasoning`.
  // Check content first, then reasoning as a fallback.
  const msg = data?.choices?.[0]?.message || {};
  const text = msg.content || msg.reasoning || "";
  const finish = data?.choices?.[0]?.finish_reason || "";
  if (!text) return { ok:false, kind:"empty", msg:"Cerebras empty" };
  const cands = extractCandidates(text);
  if (!cands) {
    // Ran out of room before producing valid JSON → split the slate smaller.
    if (finish === "length") return { ok:false, kind:"toobig", msg:"Cerebras truncated (length)" };
    return { ok:false, kind:"unparseable", msg:"Cerebras unparseable" };
  }
  return { ok:true, candidates: cands };
}

// ── Gemini ─────────────────────────────────────────────────────────────────
async function callGemini(model, prompt, key) {
  const cleanKey = encodeURIComponent((key || "").trim());
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${cleanKey}`;
  let r;
  try {
    r = await fetchWithTimeout(url, {
      method:"POST", headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 16000, responseMimeType: "application/json" }
      })
    }, 45000);
  } catch(e) {
    if (e.name === "AbortError") return { ok:false, kind:"timeout", msg:`${model} timed out` };
    return { ok:false, kind:"network", msg:`${model}: ${e.message}` };
  }
  let data;
  try { data = await r.json(); }
  catch { return { ok:false, kind:"parse", msg:`${model} non-JSON HTTP ${r.status}` }; }

  const code = data.error?.code || r.status;
  if (code === 429) return { ok:false, kind:"rate", msg:`${model} rate-limited` };
  if (code === 503 || code === 500) return { ok:false, kind:"busy", msg:`${model} overloaded (${code})` };
  if (data.error) return { ok:false, kind:"api", msg:`${model}: ${(data.error.message||"").substring(0,90)}` };

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  const finish = data.candidates?.[0]?.finishReason || "";
  if (!text) return { ok:false, kind:"empty", msg:`${model} empty (${finish||"?"})` };
  let cands = extractCandidates(text);
  // If output was cut off (MAX_TOKENS), salvage the complete objects we did get.
  if (!cands) cands = salvageCandidates(text);
  if (!cands) return { ok:false, kind:"unparseable", msg:`${model} unparseable (${finish||"?"})` };
  return { ok:true, candidates: cands };
}

// ── OpenRouter ───────────────────────────────────────────────────────────────
// OpenAI-compatible endpoint. Free models have large context windows, so the
// whole slate goes in one call. `model` is an OpenRouter model slug.
async function callOpenRouter(model, prompt, key, timeoutMs) {
  const cleanKey = (key || "").trim();
  let r;
  try {
    r = await fetchWithTimeout("https://openrouter.ai/api/v1/chat/completions", {
      method:"POST",
      headers:{
        "Content-Type":"application/json",
        "Authorization":`Bearer ${cleanKey}`,
        "HTTP-Referer":"https://hr-oracle.vercel.app",
        "X-Title":"HR Oracle"
      },
      body: JSON.stringify({
        model,
        temperature: 0.3,
        max_tokens: 16000,
        response_format: { type: "json_object" },
        messages: [{ role:"user", content: prompt }]
      })
    }, timeoutMs || 50000);
  } catch(e) {
    if (e.name === "AbortError") return { ok:false, kind:"timeout", msg:`OR ${model} timed out` };
    return { ok:false, kind:"network", msg:`OR ${model}: ${e.message}` };
  }
  let data;
  try { data = await r.json(); }
  catch { return { ok:false, kind:"parse", msg:`OR ${model} non-JSON HTTP ${r.status}` }; }

  if (r.status === 429 || data?.error?.code === 429) return { ok:false, kind:"rate", msg:`OR ${model} rate-limited` };
  if (r.status === 503 || r.status === 500 || r.status === 502) return { ok:false, kind:"busy", msg:`OR ${model} busy (${r.status})` };
  if (data?.error) return { ok:false, kind:"api", msg:`OR ${model}: ${(data.error.message||"").substring(0,90)}` };

  const msg = data?.choices?.[0]?.message || {};
  const text = msg.content || msg.reasoning || "";
  const finish = data?.choices?.[0]?.finish_reason || "";
  if (!text) return { ok:false, kind:"empty", msg:`OR ${model} empty (${finish||"?"})` };
  let cands = extractCandidates(text);
  if (!cands) cands = salvageCandidates(text);
  if (!cands) {
    if (finish === "length") return { ok:false, kind:"toobig", msg:`OR ${model} truncated` };
    return { ok:false, kind:"unparseable", msg:`OR ${model} unparseable (${finish||"?"})` };
  }
  return { ok:true, candidates: cands };
}

// Split blocks into chunks whose prompt fits Cerebras's context budget.
// gpt-oss-120b caps total context at 8,192 tokens AND reserves a big chunk for
// reasoning + answer (we allow 5,000 for completion). So keep INPUT small —
// ~2,600 tokens — which is roughly 2-3 games per chunk.
function chunkForCerebras(blocks) {
  const BUDGET = 2600;
  const overhead = estTokens(INSTRUCTIONS_HEAD) + estTokens(INSTRUCTIONS_TAIL) + 50;
  const chunks = [];
  let cur = [], curTok = overhead;
  for (const b of blocks) {
    const t = estTokens(b) + 2;
    if (cur.length && curTok + t > BUDGET) { chunks.push(cur); cur = []; curTok = overhead; }
    cur.push(b); curTok += t;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

 try {
  // req.body can arrive as an object (normal) OR an unparsed string (depending
  // on how the request is sent / Vercel's body parsing). Handle both so a bad
  // body never crashes the function into a non-JSON "An error occurred" page.
  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const games = body?.games;
  const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
  const CEREBRAS_KEY = process.env.CEREBRAS_API_KEY;
  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  if (!OPENROUTER_KEY && !CEREBRAS_KEY && !GEMINI_KEY)
    return res.status(500).json({ error: "No API key set (need OPENROUTER_API_KEY, CEREBRAS_API_KEY or GEMINI_API_KEY)" });
  if (!Array.isArray(games) || !games.length)
    return res.status(400).json({ error: "no games provided" });

  // Build allow-list + blocks.
  const validLower = new Set();
  const blocks = [];
  let projectedAny = false;
  for (const { game, gameData } of games) {
    const a = (gameData?.lineups?.away || []).slice(0, 9);
    const h = (gameData?.lineups?.home || []).slice(0, 9);
    if (a.length < 3 || h.length < 3) continue;
    [...a, ...h].forEach(p => validLower.add((p.name||"").toLowerCase()));
    if (gameData?.projected) projectedAny = true;
    blocks.push(gameBlock(game, gameData));
  }
  if (!blocks.length)
    return res.status(200).json({ candidates: [], reason: "no usable lineups in any game" });

  const finalize = (cands, source) => {
    const seen = new Set();
    const out = cands
      .filter(c => c && c.name && validLower.has((c.name||"").toLowerCase()))
      .filter(c => { const k=(c.name||"").toLowerCase()+"|"+(c.team||""); if(seen.has(k))return false; seen.add(k); return true; })
      .map(c => ({ ...c, hr_score: Math.round((parseFloat(c.hr_score)||0)*10)/10, projected: projectedAny }))
      .sort((a,b) => b.hr_score - a.hr_score);
    return res.status(200).json({ candidates: out, source });
  };

  let lastMsg = "";

  // Global deadline: Vercel kills the function at 60s. Track a budget so we
  // always reserve time to fall through to a fast provider and return something.
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;
  const timeLeft = () => 58000 - elapsed();

  // ── Provider 1: OpenRouter (fresh quota tonight, large context = one call) ──
  // Fail FAST: try just ONE fast free model with a short timeout. Slow free
  // models cause server timeouts, so we don't grind through four of them — if
  // the first doesn't answer quickly we move on to Gemini (known to be fast).
  if (OPENROUTER_KEY && timeLeft() > 30000) {
    const prompt = buildPrompt(blocks);
    // Single attempt, single model. callOpenRouter has its own 50s cap, but we
    // pass a tighter budget so it can't eat the whole window.
    const r = await callOpenRouter("meta-llama/llama-3.3-70b-instruct:free", prompt, OPENROUTER_KEY, Math.min(28000, timeLeft() - 20000));
    if (r.ok) return finalize(r.candidates, "openrouter:llama-3.3-70b");
    lastMsg = r.msg;
  }

  // ── Provider 3: Gemini flash-lite (confirmed working, one clean batch call) ──
  // flash-lite has the most generous free tier (15 RPM, 1000/day) and 1M context,
  // so the whole slate goes in one request — no splitting.
  if (GEMINI_KEY && timeLeft() > 15000) {
    const prompt = buildPrompt(blocks);
    for (const model of ["gemini-2.5-flash-lite", "gemini-2.5-flash"]) {
      if (timeLeft() < 12000) break;
      const r = await callGemini(model, prompt, GEMINI_KEY);
      if (r.ok) return finalize(r.candidates, model);
      lastMsg = r.msg;
      // No long in-model retries here — falling to the next model/provider is
      // faster and safer than sleeping inside our shrinking time budget.
    }
  }

  // ── Provider 4: Cerebras (fallback). Split into chunks that fit its context. ──
  // Only attempt if we have real time left — its chunked calls are the slowest.
  if (CEREBRAS_KEY && timeLeft() > 18000) {
    const allChunks = chunkForCerebras(blocks);
    // Cap chunks by BOTH a hard limit and remaining time so we never overrun.
    const MAX_CHUNKS = 5;
    const chunks = allChunks.slice(0, MAX_CHUNKS);
    const collected = [];
    let cerebrasOk = true;

    for (let i = 0; i < chunks.length; i++) {
      if (timeLeft() < 12000) { cerebrasOk = false; break; } // bail with partial
      // Space calls out: Cerebras free tier is ~1 request/second. Pausing
      // before every chunk after the first keeps us under that limit.
      if (i > 0) await sleep(1300);

      let chunkDone = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        const r = await callCerebras(buildPrompt(chunks[i]), CEREBRAS_KEY);
        if (r.ok) { collected.push(...r.candidates); chunkDone = true; break; }
        lastMsg = r.msg;
        // If a single chunk is still too big, split it further (rare).
        if (r.kind === "toobig" && chunks[i].length > 1) {
          const mid = Math.ceil(chunks[i].length/2);
          chunks.splice(i, 1, chunks[i].slice(0,mid), chunks[i].slice(mid));
          i--; chunkDone = true; break; // reprocess from the new smaller chunk
        }
        // Rate-limited: back off and retry this same chunk (don't abandon).
        if (r.kind === "rate" && attempt < 3 && timeLeft() > 14000) {
          await sleep(2500 * attempt); continue;
        }
        if (["busy","empty","unparseable","network"].includes(r.kind) && attempt < 3 && timeLeft() > 14000) {
          await sleep(2500); continue;
        }
        break;
      }
      if (!chunkDone) { cerebrasOk = false; break; }
    }

    // Return whatever we collected, even if some chunks failed or were capped —
    // partial HR picks are far more useful than an error screen.
    if (collected.length) return finalize(collected, cerebrasOk ? "cerebras" : "cerebras (partial)");
  }

  return res.status(200).json({ candidates: [], reason: lastMsg || "all providers failed — wait a minute and refresh" });
 } catch (e) {
   // Never let an unexpected throw become a non-JSON Vercel crash page.
   return res.status(200).json({ candidates: [], reason: "Analyzer error: " + (e?.message || "unknown").substring(0,150) });
 }
}
