// pages/index.js
import { useState, useEffect, useRef } from "react";
import Head from "next/head";

function todayStr() {
  return new Date().toLocaleDateString("en-US", {
    weekday:"long", month:"long", day:"numeric", year:"numeric"
  });
}

const HEAT = {
  FIRE:    { label:"🔥 FIRE",  color:"#f97316", bg:"rgba(249,115,22,0.14)",  border:"rgba(249,115,22,0.4)"  },
  HOT:     { label:"♨️ HOT",   color:"#eab308", bg:"rgba(234,179,8,0.14)",   border:"rgba(234,179,8,0.4)"   },
  AVERAGE: { label:"➖ AVG",   color:"#64748b", bg:"rgba(100,116,139,0.14)", border:"rgba(100,116,139,0.3)" },
  COLD:    { label:"🧊 COLD",  color:"#38bdf8", bg:"rgba(56,189,248,0.12)",  border:"rgba(56,189,248,0.3)"  },
};
const PGRADE = {
  "BATTING PRACTICE": { label:"🟢 BP",   color:"#22c55e", bg:"rgba(34,197,94,0.12)",  border:"rgba(34,197,94,0.3)"  },
  "AVERAGE":          { label:"🟡 AVG",  color:"#f59e0b", bg:"rgba(245,158,11,0.12)", border:"rgba(245,158,11,0.3)" },
  "STUD":             { label:"🔴 STUD", color:"#ef4444", bg:"rgba(239,68,68,0.12)",  border:"rgba(239,68,68,0.3)"  },
};

function HBadge({ grade }) {
  const c = HEAT[grade] || HEAT.AVERAGE;
  return <span style={{ background:c.bg, color:c.color, border:`1px solid ${c.border}`, borderRadius:5, padding:"2px 8px", fontSize:10, fontWeight:800, letterSpacing:"0.06em", fontFamily:"monospace", whiteSpace:"nowrap" }}>{c.label}</span>;
}
function PBadge({ grade }) {
  const c = PGRADE[grade] || PGRADE["AVERAGE"];
  return <span style={{ background:c.bg, color:c.color, border:`1px solid ${c.border}`, borderRadius:4, padding:"1px 7px", fontSize:9, fontWeight:800, fontFamily:"monospace", whiteSpace:"nowrap" }}>{c.label}</span>;
}

function Dial({ score, size=50, fs=11 }) {
  const color = score>=70?"#f97316":score>=50?"#eab308":score>=30?"#64748b":"#38bdf8";
  const r=(size/2)-6, cx=size/2, cy=size/2, circ=2*Math.PI*r, dash=circ*score/100;
  return (
    <div style={{ position:"relative", width:size, height:size, flexShrink:0 }}>
      <svg width={size} height={size} style={{ transform:"rotate(-90deg)" }}>
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="4"/>
        <circle cx={cx} cy={cy} r={r} fill="none" stroke={color} strokeWidth="4" strokeDasharray={`${dash} ${circ}`} strokeLinecap="round"/>
      </svg>
      <div style={{ position:"absolute", inset:0, display:"flex", alignItems:"center", justifyContent:"center", fontSize:fs, fontWeight:800, color, fontFamily:"monospace" }}>{score}</div>
    </div>
  );
}

function Row({ rank, b, selected, onClick }) {
  const heat = HEAT[b.batter_grade] || HEAT.AVERAGE;
  return (
    <div onClick={onClick} style={{ display:"flex", alignItems:"center", gap:10, padding:"12px 14px", background:selected?"rgba(249,115,22,0.09)":"rgba(255,255,255,0.025)", border:`1px solid ${selected?"rgba(249,115,22,0.45)":"rgba(255,255,255,0.07)"}`, borderRadius:12, cursor:"pointer", marginBottom:7, WebkitTapHighlightColor:"transparent" }}>
      <div style={{ width:22, textAlign:"center", flexShrink:0, fontSize:rank<=3?15:12, fontWeight:700, fontFamily:"monospace", color:rank===1?"#f97316":rank===2?"#eab308":rank===3?"#94a3b8":"#334155" }}>
        {rank<=3?["①","②","③"][rank-1]:rank}
      </div>
      <Dial score={b.hr_score}/>
      <div style={{ flex:1, minWidth:0 }}>
        <div style={{ display:"flex", alignItems:"center", gap:6, flexWrap:"wrap", marginBottom:2 }}>
          <span style={{ fontSize:16, fontWeight:700, color:"#f8fafc", fontFamily:"Georgia, serif", letterSpacing:"0.02em" }}>{b.name}</span>
          <span style={{ fontSize:9, color:"#475569", fontFamily:"monospace" }}>{b.team}</span>
          <HBadge grade={b.batter_grade}/>
        </div>
        <div style={{ fontSize:10, color:"#475569", display:"flex", alignItems:"center", gap:4, flexWrap:"wrap" }}>
          vs <span style={{ color:"#94a3b8" }}>{b.opposing_sp}</span> <PBadge grade={b.pitcher_grade}/>
        </div>
      </div>
      <div style={{ display:"flex", gap:5, flexShrink:0 }}>
        {(b.key_stats||[]).slice(0,3).map((s,i)=>(
          <div key={i} style={{ background:"rgba(0,0,0,0.35)", borderRadius:6, padding:"4px 7px", textAlign:"center", minWidth:48 }}>
            <div style={{ fontSize:11, fontWeight:700, color:"#f1f5f9", fontFamily:"monospace", whiteSpace:"nowrap" }}>{s.value}</div>
            <div style={{ fontSize:7, color:"#475569", marginTop:1, whiteSpace:"nowrap" }}>{s.label}</div>
          </div>
        ))}
      </div>
      <div style={{ textAlign:"right", flexShrink:0, minWidth:42 }}>
        <div style={{ fontSize:16, fontWeight:800, color:heat.color, fontFamily:"monospace" }}>{b.hr_prob}</div>
        <div style={{ fontSize:7, color:"#334155" }}>HR PROB</div>
      </div>
    </div>
  );
}

function Modal({ b, onClose }) {
  if (!b) return null;
  const heat = HEAT[b.batter_grade] || HEAT.AVERAGE;
  const pg = PGRADE[b.pitcher_grade] || PGRADE["AVERAGE"];
  return (
    <div onClick={onClose} style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.85)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:200, padding:16 }}>
      <div onClick={e=>e.stopPropagation()} style={{ background:"linear-gradient(160deg,#0f172a,#060d1a)", border:"1px solid rgba(255,255,255,0.12)", borderRadius:20, padding:24, maxWidth:500, width:"100%", maxHeight:"88vh", overflowY:"auto", boxShadow:"0 20px 80px rgba(0,0,0,0.8)" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:18 }}>
          <div>
            <div style={{ fontSize:24, fontWeight:700, color:"#f8fafc", fontFamily:"Georgia,serif" }}>{b.name}</div>
            <div style={{ fontSize:11, color:"#64748b" }}>{b.team} · #{b.lineup_spot||"?"} in order · {b.bats}HB</div>
          </div>
          <div style={{ display:"flex", gap:8, alignItems:"center" }}>
            <Dial score={b.hr_score} size={54} fs={13}/>
            <button onClick={onClose} style={{ background:"rgba(255,255,255,0.07)", border:"1px solid rgba(255,255,255,0.1)", color:"#94a3b8", borderRadius:7, padding:"5px 10px", cursor:"pointer", fontSize:12 }}>✕</button>
          </div>
        </div>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginBottom:14 }}>
          <div style={{ background:"rgba(0,0,0,0.3)", borderRadius:10, padding:13 }}>
            <div style={{ fontSize:8, color:"#475569", fontFamily:"monospace", marginBottom:4 }}>BATTER HEAT</div>
            <HBadge grade={b.batter_grade}/>
            <div style={{ fontSize:24, fontWeight:800, color:heat.color, fontFamily:"monospace", marginTop:5 }}>{b.hr_prob}</div>
            <div style={{ fontSize:8, color:"#475569" }}>HR probability</div>
          </div>
          <div style={{ background:"rgba(0,0,0,0.3)", borderRadius:10, padding:13 }}>
            <div style={{ fontSize:8, color:"#475569", fontFamily:"monospace", marginBottom:4 }}>FACING</div>
            <div style={{ fontSize:14, fontWeight:700, color:"#e2e8f0", marginBottom:5 }}>{b.opposing_sp}</div>
            <PBadge grade={b.pitcher_grade}/>
            <div style={{ fontSize:9, color:"#64748b", marginTop:4 }}>{b.sp_throws||""}HP</div>
          </div>
        </div>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:6, marginBottom:14 }}>
          {(b.key_stats||[]).map((s,i)=>(
            <div key={i} style={{ background:"rgba(0,0,0,0.25)", borderRadius:8, padding:"11px 13px" }}>
              <div style={{ fontSize:19, fontWeight:700, color:"#f1f5f9", fontFamily:"monospace" }}>{s.value}</div>
              <div style={{ fontSize:8, color:"#64748b", marginTop:2 }}>{s.label}</div>
            </div>
          ))}
        </div>
        <div style={{ background:"rgba(249,115,22,0.06)", border:"1px solid rgba(249,115,22,0.18)", borderRadius:9, padding:13 }}>
          <div style={{ fontSize:8, color:"#f97316", fontFamily:"monospace", marginBottom:4 }}>ANALYSIS</div>
          <p style={{ fontSize:13, color:"#94a3b8", lineHeight:1.6, margin:0 }}>{b.summary}</p>
        </div>
      </div>
    </div>
  );
}

function GameView({ games, batters }) {
  const [sel, setSel] = useState(games[0]||null);
  const gb = sel ? batters.filter(b=>b.team===sel.away_team||b.team===sel.home_team).sort((a,b)=>b.hr_score-a.hr_score) : [];
  return (
    <div>
      <div style={{ display:"flex", gap:6, flexWrap:"wrap", marginBottom:16 }}>
        {games.map(g=>(
          <button key={g.game_id} onClick={()=>setSel(g)} style={{ background:sel?.game_id===g.game_id?"rgba(249,115,22,0.15)":"rgba(255,255,255,0.04)", color:sel?.game_id===g.game_id?"#f97316":"#94a3b8", border:`1px solid ${sel?.game_id===g.game_id?"rgba(249,115,22,0.4)":"rgba(255,255,255,0.08)"}`, borderRadius:8, padding:"6px 13px", fontSize:12, fontWeight:700, cursor:"pointer", fontFamily:"monospace", letterSpacing:"0.03em" }}>
            {g.away_team}@{g.home_team}
          </button>
        ))}
      </div>
      {sel && (
        <div style={{ background:"rgba(255,255,255,0.03)", border:"1px solid rgba(255,255,255,0.07)", borderRadius:10, padding:"13px 16px", marginBottom:14, display:"flex", justifyContent:"space-between", alignItems:"center", flexWrap:"wrap", gap:8 }}>
          <div>
            <div style={{ fontSize:20, fontWeight:700, color:"#f8fafc", fontFamily:"Georgia,serif" }}>{sel.away_team} @ {sel.home_team}</div>
            <div style={{ fontSize:10, color:"#64748b" }}>🏟 {sel.venue} · ⏰ {sel.time_et} ET</div>
          </div>
          <div style={{ display:"flex", gap:16 }}>
            {[["AWAY SP",sel.away_sp],["HOME SP",sel.home_sp]].map(([lbl,sp])=>(
              <div key={lbl} style={{ textAlign:"center" }}>
                <div style={{ fontSize:8, color:"#475569", fontFamily:"monospace" }}>{lbl}</div>
                <div style={{ fontSize:13, color:"#e2e8f0", fontWeight:600 }}>{sp.name}</div>
                <div style={{ fontSize:9, color:"#64748b" }}>ERA {sp.era} · {sp.throws}HP</div>
              </div>
            ))}
          </div>
        </div>
      )}
      {gb.map((b,i)=><Row key={b.name+i} rank={i+1} b={b}/>)}
      {sel && !gb.length && <div style={{ color:"#475569", textAlign:"center", padding:24, fontSize:13 }}>No data loaded for this game yet.</div>}
    </div>
  );
}

export default function HROracle() {
  const [tab, setTab] = useState(0);
  const [games, setGames] = useState([]);
  const [batters, setBatters] = useState([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");
  const [errors, setErrors] = useState([]);
  const [doneGames, setDoneGames] = useState([]);
  const [selected, setSelected] = useState(null);
  const [refreshed, setRefreshed] = useState(null);

  async function run() {
    setLoading(true); setErrors([]); setGames([]); setBatters([]); setDoneGames([]);
    const errs = [], allResults = [];

    try {
      // Step 1: Fetch schedule
      setStatus("Fetching today's MLB schedule…");
      const schedRes = await fetch("/api/schedule");
      const schedData = await schedRes.json();
      if (schedData.error) throw new Error("Schedule: " + schedData.error);
      const fetchedGames = schedData.games || [];
      if (!fetchedGames.length) throw new Error("No games found for today");
      setGames(fetchedGames);

      // Step 2: For each game fetch live data + analyze (throttled for free tier)
      for (let i = 0; i < fetchedGames.length; i++) {
        const g = fetchedGames[i];
        setStatus(`Analyzing ${g.away_team} @ ${g.home_team} (${i+1}/${fetchedGames.length})…`);

        // Throttle: pause between games to stay under Gemini free-tier rate limit
        if (i > 0) await new Promise(r => setTimeout(r, 6000));

        try {
          // Fetch live lineups, stats, weather
          const gdRes = await fetch(
            `/api/gamedata?game_pk=${g.game_pk}&away_team=${g.away_team}&home_team=${g.home_team}&venue=${encodeURIComponent(g.venue)}&away_sp_id=${g.away_sp.id||""}&home_sp_id=${g.home_sp.id||""}`
          );
          const gameData = await gdRes.json();

          // Run Gemini analysis
          const anRes = await fetch("/api/analyze", {
            method:"POST",
            headers:{"Content-Type":"application/json"},
            body: JSON.stringify({ game: g, gameData })
          });
          const anData = await anRes.json();
          if (anData.error) throw new Error(anData.error);

          if (Array.isArray(anData.candidates) && anData.candidates.length) {
            allResults.push(...anData.candidates);
            setDoneGames(prev => [...prev, g.game_id]);
          }
        } catch(e) {
          errs.push(`${g.away_team}@${g.home_team}: ${e.message.substring(0,50)}`);
        }
      }

      if (!allResults.length) throw new Error("No candidates returned. " + errs.slice(0,2).join("; "));

      const seen = new Set();
      const final = allResults
        .filter(b => { const k=`${b.name}|${b.team}`; if(seen.has(k))return false; seen.add(k); return true; })
        .sort((a,b) => b.hr_score - a.hr_score);

      setBatters(final);
      setRefreshed(new Date().toLocaleTimeString());
      if (errs.length) setErrors(errs);
    } catch(e) {
      setErrors([e.message]);
    } finally {
      setLoading(false); setStatus("");
    }
  }

  const top10 = batters.slice(0, 10);

  return (
    <>
      <Head>
        <title>HR Oracle</title>
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1"/>
        <meta name="apple-mobile-web-app-capable" content="yes"/>
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"/>
        <meta name="apple-mobile-web-app-title" content="HR Oracle"/>
        <meta name="theme-color" content="#060d1a"/>
        <link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@700;800&display=swap" rel="stylesheet"/>
      </Head>
      <div style={{ minHeight:"100vh", background:"#070d1a", color:"#f1f5f9", fontFamily:"system-ui,sans-serif" }}>
        <div style={{ position:"fixed", inset:0, pointerEvents:"none", background:"radial-gradient(ellipse 80% 40% at 50% -5%, rgba(249,115,22,0.08) 0%, transparent 60%)" }}/>
        <div style={{ position:"relative", maxWidth:920, margin:"0 auto", padding:"24px 16px 80px" }}>

          {/* Header */}
          <div style={{ display:"flex", alignItems:"flex-end", justifyContent:"space-between", marginBottom:24, flexWrap:"wrap", gap:10 }}>
            <div>
              <div style={{ fontSize:"clamp(42px,8vw,68px)", fontWeight:800, lineHeight:1, fontFamily:"'Barlow Condensed',sans-serif", letterSpacing:"0.04em", background:"linear-gradient(120deg,#f97316,#fb923c 45%,#fbbf24)", WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent" }}>
                HR ORACLE
              </div>
              <div style={{ fontSize:11, color:"#475569", fontFamily:"monospace", marginTop:3 }}>
                {todayStr()}{refreshed?` · Updated ${refreshed}`:""}
              </div>
            </div>
            <button onClick={run} disabled={loading} style={{ background:loading?"rgba(255,255,255,0.05)":"linear-gradient(135deg,#f97316,#ea580c)", color:loading?"#475569":"#fff", border:"none", borderRadius:12, padding:"12px 26px", fontSize:14, fontWeight:700, cursor:loading?"not-allowed":"pointer", fontFamily:"monospace", letterSpacing:"0.06em", boxShadow:loading?"none":"0 4px 20px rgba(249,115,22,0.35)", WebkitTapHighlightColor:"transparent" }}>
              {loading?"⏳ ANALYZING…":batters.length?"🔄 REFRESH":"⚡ RUN ANALYSIS"}
            </button>
          </div>

          {/* Loading */}
          {loading && (
            <div style={{ background:"rgba(249,115,22,0.06)", border:"1px solid rgba(249,115,22,0.2)", borderRadius:12, padding:"18px 20px", textAlign:"center", marginBottom:18 }}>
              <div style={{ fontSize:12, color:"#f97316", fontFamily:"monospace", marginBottom:12 }}>{status}</div>
              <div style={{ display:"flex", gap:4, justifyContent:"center" }}>
                {[0,1,2,3,4,5,6,7].map(i=>(
                  <div key={i} style={{ width:8, height:5, borderRadius:3, background:"rgba(249,115,22,0.4)", animation:`pulse ${0.8+i*0.1}s ease-in-out infinite alternate` }}/>
                ))}
              </div>
            </div>
          )}

          {/* Game tracker while loading */}
          {loading && games.length > 0 && (
            <div style={{ background:"rgba(255,255,255,0.02)", border:"1px solid rgba(255,255,255,0.06)", borderRadius:10, padding:"12px 16px", marginBottom:18 }}>
              <div style={{ fontSize:9, color:"#334155", fontFamily:"monospace", marginBottom:8, letterSpacing:"0.08em" }}>GAME TRACKER</div>
              <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
                {games.map(g=>{
                  const done=doneGames.includes(g.game_id);
                  const failed=errors.some(e=>e.startsWith(`${g.away_team}@${g.home_team}`));
                  return <span key={g.game_id} style={{ fontSize:11, fontFamily:"monospace", color:done?"#22c55e":failed?"#ef4444":"#475569", background:done?"rgba(34,197,94,0.08)":failed?"rgba(239,68,68,0.08)":"rgba(255,255,255,0.03)", border:`1px solid ${done?"rgba(34,197,94,0.2)":failed?"rgba(239,68,68,0.2)":"rgba(255,255,255,0.06)"}`, borderRadius:5, padding:"2px 8px" }}>
                    {done?"✓ ":failed?"✗ ":"○ "}{g.away_team}@{g.home_team}
                  </span>;
                })}
              </div>
            </div>
          )}

          {/* Errors */}
          {errors.length > 0 && (
            <div style={{ background:"rgba(239,68,68,0.07)", border:"1px solid rgba(239,68,68,0.2)", borderRadius:10, padding:"12px 14px", marginBottom:16, fontSize:12, color:"#f87171" }}>
              {!batters.length?`⚠️ ${errors[0]}`:`⚠️ ${errors.length} game(s) had issues — showing results for the rest.`}
            </div>
          )}

          {/* Tabs */}
          {batters.length > 0 && (
            <>
              <div style={{ display:"flex", gap:5, marginBottom:16, alignItems:"center" }}>
                {["🏆 TOP 10","🎯 BY GAME"].map((t,i)=>(
                  <button key={i} onClick={()=>setTab(i)} style={{ background:tab===i?"rgba(249,115,22,0.15)":"rgba(255,255,255,0.04)", color:tab===i?"#f97316":"#64748b", border:`1px solid ${tab===i?"rgba(249,115,22,0.4)":"rgba(255,255,255,0.07)"}`, borderRadius:7, padding:"7px 15px", fontSize:11, fontWeight:700, cursor:"pointer", fontFamily:"monospace", letterSpacing:"0.05em" }}>
                    {t}
                  </button>
                ))}
                <div style={{ marginLeft:"auto", fontSize:10, color:"#334155", fontFamily:"monospace" }}>
                  {batters.length} batters · {games.length} games
                </div>
              </div>

              {tab===0 && (
                <>
                  <div style={{ fontSize:9, color:"#334155", fontFamily:"monospace", letterSpacing:"0.08em", marginBottom:10 }}>TAP ANY ROW FOR FULL DETAIL</div>
                  {top10.map((b,i)=><Row key={b.name+i} rank={i+1} b={b} selected={selected?.name===b.name} onClick={()=>setSelected(b)}/>)}
                  <div style={{ marginTop:14, padding:"10px 13px", background:"rgba(255,255,255,0.02)", border:"1px solid rgba(255,255,255,0.05)", borderRadius:8, fontSize:9, color:"#334155", fontFamily:"monospace", lineHeight:1.7 }}>
                    ⚠️ Research & entertainment only. Uses live MLB Stats API + Open-Meteo weather + Gemini AI analysis.
                  </div>
                </>
              )}
              {tab===1 && <GameView games={games} batters={batters}/>}
            </>
          )}

          {/* Empty state */}
          {!loading && !batters.length && !errors.length && (
            <div style={{ textAlign:"center", padding:"50px 16px" }}>
              <div style={{ fontSize:52, marginBottom:14 }}>⚾</div>
              <div style={{ fontSize:22, fontWeight:700, color:"#1e293b", fontFamily:"'Barlow Condensed',sans-serif", marginBottom:8 }}>Today's slate awaits</div>
              <p style={{ color:"#475569", fontSize:13, maxWidth:340, margin:"0 auto 22px", lineHeight:1.7 }}>
                Hit <strong style={{ color:"#f97316" }}>RUN ANALYSIS</strong> to pull today's live MLB schedule, lineups, pitcher stats, and weather — then rank every batter by HR likelihood.
              </p>
              <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:8, maxWidth:420, margin:"0 auto" }}>
                {["🔍 Live MLB API","📊 Real 2026 stats","🌤️ Live weather"].map(t=>(
                  <div key={t} style={{ background:"rgba(255,255,255,0.03)", border:"1px solid rgba(255,255,255,0.06)", borderRadius:8, padding:"9px 7px", fontSize:11, color:"#475569", fontFamily:"monospace" }}>{t}</div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
      {selected && <Modal b={selected} onClose={()=>setSelected(null)}/>}
      <style>{`
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #070d1a; }
        @keyframes pulse { from { opacity: 0.4; } to { opacity: 1; } }
      `}</style>
    </>
  );
}
