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

  const fmt = (arr, oppGrade) => arr.map(p => {
    const s = gameData?.playerStats?.[p.id] || {};
    // Overall power: barrel%, exit velo, launch angle, hard-hit%.
    let power = "";
    if (s.barrel_pct) {
      power = ` Brl%${s.barrel_pct}EV${s.avg_ev||"?"}LA${s.launch_angle||"?"}HH%${s.hard_hit_pct||"?"}`;
    }
    // Handedness-split power: same metrics but only vs the hand he faces today.
    const sp = (s.split_barrel!=null)
      ? ` vs${s.split_hand}HP-pow:Brl%${s.split_barrel}EV${s.split_ev||"?"}LA${s.split_la||"?"}HR${s.split_pow_hr||"?"}`
      : "";
    const air = (s.fb_pct!=null) ? ` FB%${s.fb_pct}` : "";
    // Platoon line: this hitter's numbers vs the hand of the SP he actually faces.
    const plat = s.plat_ops ? ` vs${s.plat_hand}HP:OPS${s.plat_ops}HR${s.plat_hr}ISO${s.plat_iso}(${s.plat_ab}ab)` : "";
    // Pitch-type matchup: per family the starter throws — B.slg = this batter's
    // slug vs that family, P.rv = pitcher's run value allowed/100 (higher=hittable).
    const pm = s.pitch_matchup ? ` | PITCHMIX ${s.pitch_matchup}` : "";
    // Personalized park factor for this batter's handedness (1.00 = neutral).
    const pf = (s.park_hand_factor!=null && Math.abs(s.park_hand_factor-1) >= 0.03)
      ? ` ParkHR${s.park_hand_factor.toFixed(2)}` : "";
    // Lead with the OPPOSING PITCHER's HR-vulnerability — the dominant factor.
    return `[vsP:${oppGrade}] ${p.name}(${p.bats}) #${p.lineup_spot||"?"} HR${s.hr||0} OPS${s.ops||"?"} ISO${s.iso||"?"}${air} L14:HR${s.recent_hr??0}ISO${s.recent_iso||"?"}OPS${s.recent_ops||"?"}(${s.recent_ab||0}ab)${power}${sp}${plat}${pm}${pf}`;
  }).join("\n");

  // Opposing full-staff HR vulnerability (incl. bullpen) — away hitters face it
  // from the home staff and vice-versa. Recent HR/9 flags a pen getting hit now.
  const oppA = gameData?.oppStaff?.away || {}; // staff AWAY hitters face (home team)
  const oppH = gameData?.oppStaff?.home || {}; // staff HOME hitters face (away team)
  const staffStr = (o) => {
    if (!o || o.staff_hr9==null) return "";
    // Lead with RECENT staff form — a staff getting shelled NOW is the strongest
    // cluster-HR signal (season line lags for call-ups/recent strugglers).
    let s = "";
    if (o.staff_recent_hr9!=null) s += ` | OppStaff L14 HR/9 ${o.staff_recent_hr9}`;
    if (o.staff_recent_era!=null) s += ` L14 ERA${o.staff_recent_era}`;
    s += ` (season HR/9 ${o.staff_hr9}`;
    if (o.staff_fb_pct!=null) s += ` FB%${o.staff_fb_pct}`;
    s += ")";
    return s;
  };

  // Starter line: recent (last-21-day) form FIRST, since a starter being hit
  // hard right now predicts HRs better than his season line.
  const arsA = gameData?.pitcherArsenal?.away;
  const arsH = gameData?.pitcherArsenal?.home;
  const arsStr = (a) => {
    if (!a) return "";
    const fams = ["FB","BRK","OFF"].filter(f=>a[f]&&a[f].usage>=12)
      .map(f=>`${f}${Math.round(a[f].usage)}%${a[f].rv!=null?`(rv${a[f].rv.toFixed(1)})`:""}`);
    return fams.length ? ` arsenal:${fams.join("/")}` : "";
  };
  const spLine = (label, sp, p, ars) => {
    let s = `${label} ${sp.name}(${sp.throws}) [HR-VULN: ${p.hr_vuln||"NEUTRAL"}]`;
    if (p.recent_era!=null && p.recent_era!=="N/A")
      s += ` L21: ERA${p.recent_era} HR/9 ${p.recent_hr9||"?"} BAA${p.recent_baa||"?"} (${p.recent_hr||0}HR/${p.recent_ip||"?"}ip)`;
    s += ` | season ERA${p.era||sp.era} HR/9 ${p.hr9||"?"}`;
    if (p.fb_pct!=null) s += ` FB%${p.fb_pct}`;
    // Contact allowed — the quality-of-contact evidence behind the grade.
    if (p.barrel_allowed!=null) s += ` Brl%-allowed${p.barrel_allowed}`;
    if (p.hardhit_allowed!=null) s += ` HH%-allowed${p.hardhit_allowed}`;
    s += arsStr(ars);
    return s;
  };

  // Team offensive HEAT: this lineup's own last-7-day form. Hot lineups cluster
  // HRs across the whole order, so it boosts every hitter on that side.
  const heatA = gameData?.teamHeat?.away || {};
  const heatH = gameData?.teamHeat?.home || {};
  const heatStr = (h) => {
    if (!h || h.ops==null || h.ops==="N/A") return "";
    return ` | TeamHeat L7: OPS${h.ops} ISO${h.iso} HR/G${h.hr_per_g}`;
  };

  const envStr = (gameData?.hrEnv!=null) ? ` HR-ENV ${gameData.hrEnv}x` : "";
  return `=== ${game.away_team}@${game.home_team} @${game.venue} ${slot} elev${elevation}${envStr}${isProjected?" [PROJ]":""}
${spLine("ASP", game.away_sp, aP, arsA)}
${spLine("HSP", game.home_sp, hP, arsH)}
Wx:${weather.summary||"?"}${weather.wind_effect?` [${weather.wind_effect}]`:""}
AWAY(vs ${game.home_sp.throws}HP${staffStr(oppA)}${heatStr(heatA)}):
${fmt(awayList, hP.hr_vuln||"NEUTRAL")}
HOME(vs ${game.away_sp.throws}HP${staffStr(oppH)}${heatStr(heatH)}):
${fmt(homeList, aP.hr_vuln||"NEUTRAL")}`;
}

const INSTRUCTIONS_HEAD = `You are an elite MLB home-run prediction model. Below are MLB games with lineups and stats. Identify the TOP HOME RUN CANDIDATES.

Return the 1-2 STRONGEST home-run candidates FROM EACH GAME — every game should be represented by its best hitter (and a clear second if one stands out). Rank the whole list by hr_score. Skip a game's weaker hitters, but do NOT skip whole games. Games tagged [PROJ] have projected (not confirmed) lineups — still consider them.

SCORING PRIORITY — THE OPPOSING PITCHER IS THE #1 FACTOR, ABOVE BATTER POWER:

(1) OPPOSING PITCHER HR-VULNERABILITY is the single most important input. Every batter line begins with [vsP:GRADE] — the HR-vulnerability of the pitcher THAT hitter faces — and each starter shows [HR-VULN: GRADE]. The grade already folds in HR/9 AND the quality of contact the pitcher allows (Brl%-allowed / HH%-allowed shown on the SP line) — high barrel-allowed means HRs are coming even if HR/9 hasn't caught up yet, so trust the grade over raw HR/9. The grades mean:
   • MEATBALL / VULNERABLE → pitcher gives up HRs easily. These lineups are where HRs happen. Rank their hitters HIGH.
   • NEUTRAL → average.
   • TOUGH / ELITE → very hard to homer off (e.g. Skenes, Yoshinobu, Cristopher Sánchez on form). DRAMATICALLY DOWNGRADE every hitter facing them, even elite sluggers.
   HARD RULE: an AVERAGE power hitter facing a MEATBALL/VULNERABLE pitcher MUST outrank a GREAT power hitter facing an ELITE/TOUGH pitcher. Do not rank star sluggers highly just because of their season HR total if they face an ELITE/TOUGH arm — bump them down hard. The highest scores each day should belong to hitters in the games with the most hittable pitching.

(2) RECENT PITCHING COLLAPSE & weak bullpen — a starter with high RECENT (L21) ERA/HR-9/BAA, or an opposing staff with high L14 HR/9, means HRs cluster across the WHOLE lineup; boost even non-stars there. Weight RECENT pitching far above season numbers. TEAM HEAT works the same way from the offense side: each lineup header shows its own last-7-day form (TeamHeat L7 OPS/ISO/HR-per-game). A scorching lineup (OPS .800+, HR/G 1.5+) clusters HRs up and down the order — give every hitter in it a modest boost; an ice-cold lineup (OPS under .650) gets a drag. A hot lineup facing a collapsing staff is the single best cluster setup on a slate.

(3) PITCH-TYPE MATCHUP (PITCHMIX) — a hitter who SLUGS HIGH (.550+) vs a pitch family the starter throws a lot AND gets hit on (P.rv positive) is a prime pick even with modest season HRs.

(4) PLATOON split (vsLHP/vsRHP). (5) RECENT 14-day batter form (recent ~60% vs season ~40%) — only AFTER the pitcher matchup is accounted for. (6) power metrics — barrel%, exit velo (EV), launch angle (LA, ideal HR range ~25-35°), hard-hit%. Prefer the handedness-split version (vsRHP-pow / vsLHP-pow) since it reflects power vs the exact hand the hitter faces today. These are a TIEBREAKER among hitters facing similar-quality pitching, NOT a reason to rank a star vs an ace over an average bat vs a meatball. A hitter with high barrel% AND launch angle in the 25-35° band is a strong HR-shape profile. (7) batted-ball shape — high batter FB% + high pitcher FB% is a prime setup; ground-ball hitters rarely homer. (8) HR-ENV multiplier (1.00=avg): >1.08 boosts all hitters in that game, <0.93 suppresses. (9) ParkHR personalized factor: >1.10 boost, <0.92 drag. (10) lineup spot 1-5 > 6-9.

Reward (hittable pitcher MEATBALL/VULNERABLE + hot bat + good pitch matchup + favorable park/env) 85+. Push even strong sluggers facing ELITE/TOUGH pitching into the 30s-40s. Actively diversify away from the same season-HR leaders — the daily board should be driven by WHICH PITCHERS ARE HITTABLE, not which hitters are famous.

IMPORTANT EXPECTATION: HRs are rare, high-variance events — even the single best play on a slate is only ~8-13% to homer. Do NOT inflate scores; a realistic top play is ~70-85, not 99. Spread scores honestly so the ranking reflects true separation.`;

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

// Last-resort salvage for truncated output (MAX_TOKENS): walk the text tracking
// brace depth and string state, and capture EVERY balanced {...} object that
// contains a "name" field — at any nesting depth, since the candidate objects
// live inside an outer {"candidates":[ ... ]} wrapper that never closes when the
// response is cut off. Each complete candidate before the cut is recovered.
function salvageCandidates(rawText) {
  if (!rawText) return null;
  const out = [];
  const stack = [];           // start-index of each open brace
  let inStr = false, esc = false;
  for (let i = 0; i < rawText.length; i++) {
    const ch = rawText[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === "{") stack.push(i);
    else if (ch === "}") {
      const start = stack.pop();
      if (start === undefined) continue;
      const chunk = rawText.slice(start, i + 1);
      // A candidate object has a name but is NOT the outer wrapper (no "candidates").
      if (/"name"\s*:/.test(chunk) && !/"candidates"\s*:/.test(chunk)) {
        try { const o = JSON.parse(chunk); if (o && o.name) out.push(o); } catch {}
      }
    }
  }
  // De-dupe (a key_stats object won't have name, so only real candidates remain).
  const seen = new Set();
  const uniq = out.filter(o => { const k=(o.name||"")+"|"+(o.team||""); if(seen.has(k))return false; seen.add(k); return true; });
  return uniq.length ? uniq : null;
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
        max_completion_tokens: 6000,
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
  const msg = data?.choices?.[0]?.message || {};
  const text = msg.content || msg.reasoning || "";
  const finish = data?.choices?.[0]?.finish_reason || "";
  if (!text) return { ok:false, kind:"empty", msg:"Cerebras empty" };
  let cands = extractCandidates(text);
  // If output was cut off, recover the complete candidate objects we did get
  // before declaring it too big (matches the Gemini/OpenRouter behavior).
  if (!cands) cands = salvageCandidates(text);
  if (!cands) {
    // Truly nothing usable → signal "toobig" so the caller splits the slate smaller.
    if (finish === "length") return { ok:false, kind:"toobig", msg:"Cerebras truncated (length)" };
    return { ok:false, kind:"unparseable", msg:"Cerebras unparseable" };
  }
  return { ok:true, candidates: cands };
}

// ── Gemini ─────────────────────────────────────────────────────────────────
async function callGemini(model, prompt, key, timeoutMs) {
  const cleanKey = encodeURIComponent((key || "").trim());
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${cleanKey}`;
  let r;
  try {
    r = await fetchWithTimeout(url, {
      method:"POST", headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 8000, responseMimeType: "application/json" }
      })
    }, timeoutMs || 30000);
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
        max_tokens: 8000,
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
  const BUDGET = 1900;
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

  // Build allow-list + blocks. Track projected status PER PLAYER (keyed by their
  // own game), NOT slate-wide — otherwise one game lacking a posted lineup would
  // mark EVERY candidate (even in-progress games) as projected.
  const validLower = new Set();
  const blocks = [];
  const projByPlayer = {}; // normalizedName|team -> true if that player's game is projected
  for (const { game, gameData } of games) {
    const a = (gameData?.lineups?.away || []).slice(0, 9);
    const h = (gameData?.lineups?.home || []).slice(0, 9);
    if (a.length < 3 || h.length < 3) continue;
    const gameProjected = !!gameData?.projected;
    [...a].forEach(p => { validLower.add((p.name||"").toLowerCase()); projByPlayer[`${(p.name||"").toLowerCase()}|${game.away_team}`] = gameProjected; });
    [...h].forEach(p => { validLower.add((p.name||"").toLowerCase()); projByPlayer[`${(p.name||"").toLowerCase()}|${game.home_team}`] = gameProjected; });
    blocks.push(gameBlock(game, gameData));
  }
  if (!blocks.length)
    return res.status(200).json({ candidates: [], reason: "no usable lineups in any game" });

  // Normalize a name for matching: lowercase, strip a leading "#3 " lineup
  // prefix, drop punctuation/accents, collapse spaces.
  const normName = (s) => String(s||"")
    .toLowerCase()
    .replace(/^#?\d+\s+/, "")           // strip any leading lineup number
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // strip accents
    .replace(/[.\-']/g, "")
    .replace(/\s+/g, " ")
    .trim();

  // Build a normalized allow-set plus a last-name index for fuzzy fallback.
  const validNorm = new Set([...validLower].map(normName));
  const validLast = new Set([...validNorm].map(n => n.split(" ").pop()));

  const finalize = (cands, source) => {
    const seen = new Set();
    const clean = (cands || [])
      .filter(c => c && c.name)
      .map(c => ({ ...c, name: String(c.name).replace(/^#?\d+\s+/, "").trim() }));

    // Tier 1: exact normalized match against the lineup allow-list.
    let kept = clean.filter(c => validNorm.has(normName(c.name)));
    // Tier 2: if exact matching removed (almost) everything, fall back to a
    // last-name match so a small formatting difference can't zero out the board.
    if (kept.length < 3) {
      const byLast = clean.filter(c => validLast.has(normName(c.name).split(" ").pop()));
      if (byLast.length > kept.length) kept = byLast;
    }
    // Tier 3: if matching stripped MOST of what the AI returned (not just all of
    // it — e.g. 30 came back and 1 survived), the allow-list is the thing that's
    // wrong, not the AI. Trust the AI's list rather than show a 1-player board.
    let filteredNote = "";
    if (clean.length >= 6 && kept.length < Math.max(3, Math.floor(clean.length / 3))) {
      filteredNote = ` (name-match kept ${kept.length}/${clean.length}; showing all)`;
      kept = clean;
    } else if (!kept.length && clean.length) {
      kept = clean;
    }

    // Resolve each candidate's projected status from ITS OWN game. Try exact
    // name|team, then any key matching the player's name (handles team-abbrev
    // mismatches). Default false = treat as confirmed rather than falsely PROJ.
    const projFor = (c) => {
      const nm = (c.name||"").toLowerCase();
      const exact = projByPlayer[`${nm}|${c.team||""}`];
      if (exact !== undefined) return exact;
      const lastNm = normName(c.name).split(" ").pop();
      for (const [k, v] of Object.entries(projByPlayer)) {
        const keyName = k.split("|")[0];
        if (keyName === nm || normName(keyName).split(" ").pop() === lastNm) return v;
      }
      return false;
    };

    const out = kept
      .filter(c => { const k=normName(c.name)+"|"+(c.team||""); if(seen.has(k))return false; seen.add(k); return true; })
      .map(c => ({ ...c, hr_score: Math.round((parseFloat(c.hr_score)||0)*10)/10, projected: projFor(c) }))
      .sort((a,b) => b.hr_score - a.hr_score)
      .slice(0, 32);   // room for 1-2 per game across a full ~15-game slate.

    // Diagnostic: if we end up empty, say WHY so the UI shows something useful
    // instead of a bare "no candidates". rawN = objects AI returned; namedN =
    // how many had a usable name field after cleaning.
    if (!out.length) {
      const rawN = Array.isArray(cands) ? cands.length : 0;
      const namedN = clean.length;
      const reason = rawN === 0
        ? `${source} returned an empty list`
        : `${source} returned ${rawN} items but ${namedN} had names and 0 matched lineups`;
      return res.status(200).json({ candidates: [], source, reason });
    }
    return res.status(200).json({ candidates: out, source: source + filteredNote });
  };

  let lastMsg = "";

  // Global deadline: Vercel kills the function at 60s. Track a budget so we
  // always reserve time to fall through to a fast provider and return something.
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;
  const timeLeft = () => 58000 - elapsed();

  // ── Provider 1: OpenRouter (fresh quota tonight, large context = one call) ──
  // ── Provider 1: Gemini flash-lite FIRST — most reliable, 1M context so the
  // whole slate goes in ONE call, and fast. This is the best shot at covering
  // every game, so we try it before the slower free providers.
  if (GEMINI_KEY && timeLeft() > 15000) {
    const prompt = buildPrompt(blocks);
    for (const model of ["gemini-2.5-flash-lite", "gemini-2.5-flash"]) {
      if (timeLeft() < 12000) break;
      const r = await callGemini(model, prompt, GEMINI_KEY, Math.max(10000, timeLeft() - 6000));
      if (r.ok) return finalize(r.candidates, model);
      lastMsg = r.msg;
    }
  }

  // ── Provider 2: OpenRouter (one fast free model, full slate in one call). ──
  if (OPENROUTER_KEY && timeLeft() > 22000) {
    const prompt = buildPrompt(blocks);
    const r = await callOpenRouter("meta-llama/llama-3.3-70b-instruct:free", prompt, OPENROUTER_KEY, Math.min(20000, timeLeft() - 16000));
    if (r.ok) return finalize(r.candidates, "openrouter:llama-3.3-70b");
    lastMsg = r.msg;
  }

  // ── Provider 3: Cerebras (last resort). Tiny 8k context forces chunking, so
  // it can only cover part of a big slate — used only if the others all failed.
  // Only attempt if we have real time left — its chunked calls are the slowest.
  if (CEREBRAS_KEY && timeLeft() > 18000) {
    const allChunks = chunkForCerebras(blocks);
    // Cap chunks by BOTH a hard limit and remaining time so we never overrun
    // Vercel's function limit. The per-chunk time check below is the real guard;
    // this cap is just a backstop.
    const MAX_CHUNKS = 9;
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
        // If a multi-game chunk is too big, split it and reprocess.
        if (r.kind === "toobig" && chunks[i].length > 1) {
          const mid = Math.ceil(chunks[i].length/2);
          chunks.splice(i, 1, chunks[i].slice(0,mid), chunks[i].slice(mid));
          i--; chunkDone = true; break; // reprocess from the new smaller chunk
        }
        // A SINGLE-game chunk that still truncates can't be split further — skip
        // it and keep going so the rest of the slate still produces a board.
        if (r.kind === "toobig" && chunks[i].length === 1) { chunkDone = true; break; }
        // Rate-limited: back off and retry this same chunk (don't abandon).
        if (r.kind === "rate" && attempt < 3 && timeLeft() > 14000) {
          await sleep(2500 * attempt); continue;
        }
        if (["busy","empty","unparseable","network"].includes(r.kind) && attempt < 3 && timeLeft() > 14000) {
          await sleep(2500); continue;
        }
        break;
      }
      // Never hard-abort the whole Cerebras pass on one bad chunk — continue so
      // partial results from other chunks still surface.
      if (!chunkDone) continue;
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
