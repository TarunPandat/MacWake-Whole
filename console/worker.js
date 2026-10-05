// MacWake admin console. Cloudflare Worker + KV. One shared bearer token for phone and Mac.
// KV keys, each with a single writer so eventually-consistent KV never loses an update:
//   cmd      {seq, action:'wake'|'idle', at}            written by console
//   device   {lastSeen, ac, battery, host, holding, ackSeq} written by the Mac
//   settings {interval, hold}                           written by console

const DEFAULTS = { interval: 5, hold: 30 }; // minutes

// Pairing (trust on first use), same as console-next/lib/logic.js: the Mac app registers a random token once.
const hex = async s => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map(b => b.toString(16).padStart(2, "0")).join("");
async function same(a, b) {   // constant-time: compares fixed-length digests
  const [x, y] = await Promise.all([hex(a), hex(b)]);
  let d = 0; for (let i = 0; i < 64; i++) d |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return d === 0;
}
const bearer = request => { const h = request.headers.get("Authorization") || ""; return h.startsWith("Bearer ") ? h.slice(7).trim() : ""; };

async function authed(request, env) {
  const given = bearer(request);
  if (!given) return false;
  if (env.ADMIN_TOKEN && await same(given, env.ADMIN_TOKEN)) return true;
  const owner = await env.STATE.get("owner");
  return !!owner && await same(await hex(given), owner);
}

async function register(request, env) {
  const given = bearer(request);
  if (given.length < 32) return json({ error: "token must be at least 32 characters" }, 400);
  const owner = await env.STATE.get("owner"), mine = await hex(given);
  if (!owner) { await env.STATE.put("owner", mine); return json({ paired: true }, 201); }
  return await same(mine, owner) ? json({ paired: true }) : json({ error: "console already paired with another Mac" }, 409);
}

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });
const get = async (kv, k, d) => (await kv.get(k, "json")) || d;

async function state(kv) {
  const [cmd, device, settings] = await Promise.all([get(kv, "cmd", { seq: 0, action: "idle" }), get(kv, "device", {}), get(kv, "settings", DEFAULTS)]);
  // idle -> requested (button) -> awake (Mac acked, holding) -> done (hold expired, Mac asleep again)
  const phase = cmd.action !== "wake" ? "idle" : (device.ackSeq || 0) < cmd.seq ? "requested" : device.holding ? "awake" : "done";
  return { phase, cmd, device, settings, now: Date.now() };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/") return new Response(PAGE, { headers: { "Content-Type": "text/html;charset=utf-8" } });
    if (!url.pathname.startsWith("/api/")) return new Response("not found", { status: 404 });
    if (url.pathname === "/api/register" && request.method === "POST") return register(request, env);
    if (!(await authed(request, env))) return json({ error: "unauthorized" }, 401);
    const kv = env.STATE, now = Date.now();
    const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};

    switch (url.pathname) {
      case "/api/state":
        return json(await state(kv));

      case "/api/wake":
      case "/api/cancel": {
        const cmd = await get(kv, "cmd", { seq: 0 });
        await kv.put("cmd", JSON.stringify({ seq: cmd.seq + 1, action: url.pathname === "/api/wake" ? "wake" : "idle", at: now }));
        return json(await state(kv));
      }

      case "/api/settings": {
        const cur = await get(kv, "settings", DEFAULTS);
        const clamp = (v, lo, hi, d) => Number.isFinite(+v) ? Math.min(hi, Math.max(lo, Math.round(+v))) : d;
        const next = { interval: clamp(body.interval, 1, 240, cur.interval), hold: clamp(body.hold, 1, 1440, cur.hold) };
        await kv.put("settings", JSON.stringify(next));
        return json(await state(kv));
      }

      case "/api/heartbeat": {
        // Mac calls this on every wake and every ~60s while awake.
        const [cmd, device, settings] = await Promise.all([
          kv.get("cmd", { type: "json", cacheTtl: 30 }).then(v => v || { seq: 0, action: "idle" }),   // shortest allowed cache: wake requests propagate faster
          get(kv, "device", {}), get(kv, "settings", DEFAULTS)]);
        // Deliver once per request; re-deliver if the Mac dropped the hold (e.g. rebooted) while the hold window is still open.
        const acked = (device.ackSeq || 0) >= cmd.seq;
        const wake = cmd.action === "wake" && (!acked || (!body.holding && now - (device.ackAt || 0) < settings.hold * 60e3));
        // The Mac reports `holding` as of before this reply; if we tell it to wake now, it will be holding.
        const next = { lastSeen: now, ac: !!body.ac, battery: body.battery ?? null, host: body.host || "", lid: !!body.lid, holding: wake || !!body.holding, ackSeq: wake ? cmd.seq : device.ackSeq || 0, ackAt: wake ? now : device.ackAt || 0 };
        // ponytail: KV free tier allows 1000 writes/day, so only persist when something changed or 5 min passed.
        const changed = ["ac", "lid", "holding", "ackSeq", "host"].some(k => next[k] !== device[k]) || now - (device.lastSeen || 0) > 5 * 60e3;
        if (changed) await kv.put("device", JSON.stringify(next));
        return json({ wake, hold: cmd.action === "wake", interval: settings.interval, holdMinutes: settings.hold });
      }
    }
    return json({ error: "not found" }, 404);
  },
};

const PAGE = `<!doctype html><html><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>MacWake</title><link rel=icon href="data:,">
<style>
:root{--bg:#f4f4f6;--fg:#111;--mut:#666;--card:#fff;--acc:#0a84ff;--ok:#30d158;--warn:#ff9f0a}
@media(prefers-color-scheme:dark){:root{--bg:#000;--fg:#eee;--mut:#999;--card:#1c1c1e}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:17px -apple-system,system-ui,sans-serif;padding:16px;max-width:460px;margin:auto}
h1{font-size:22px;margin:16px 0}.card{background:var(--card);border-radius:14px;padding:16px;margin:12px 0}
.row{display:flex;justify-content:space-between;padding:6px 0;color:var(--mut)}.row b{color:var(--fg)}
button{width:100%;border:0;border-radius:14px;padding:18px;font-size:19px;font-weight:600;color:#fff;background:var(--acc);margin:8px 0}
button.sec{background:#8e8e93}button:disabled{opacity:.5}
input{width:100%;font-size:17px;padding:10px;border-radius:10px;border:1px solid #8884;background:transparent;color:var(--fg);margin:4px 0 10px}
.dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px;background:var(--mut)}
.on{background:var(--ok)}.req{background:var(--warn);animation:b 1s infinite}@keyframes b{50%{opacity:.3}}
small{color:var(--mut)}#err{color:#ff453a}
</style></head><body>
<h1>MacWake</h1>
<div class=card id=login><label>Admin token<input id=tok type=password autocomplete=current-password></label><button onclick="saveTok()">Sign in</button></div>
<div id=app hidden>
<div class=card>
 <div style="font-size:20px;margin-bottom:8px"><span class=dot id=dot></span><b id=phase>…</b></div>
 <div class=row><span>Last seen</span><b id=seen>–</b></div>
 <div class=row><span>Power</span><b id=power>–</b></div>
 <div class=row><span>Mac</span><b id=host>–</b></div>
 <small id=hint></small>
</div>
<button id=wake onclick="post('/api/wake')">Wake up Mac</button>
<button id=cancel class=sec onclick="post('/api/cancel')">Cancel / let it sleep</button>
<div class=card><b>Settings</b>
 <label>Check-in interval (minutes) <small>= max wake delay</small><input id=interval type=number min=1 max=240></label>
 <label>Stay awake after wake (minutes)<input id=hold type=number min=1 max=1440></label>
 <button class=sec onclick="post('/api/settings',{interval:+interval.value,hold:+hold.value})">Save settings</button>
</div>
<p id=err></p><button class=sec onclick="localStorage.removeItem('tok');location.reload()">Sign out</button>
</div>
<script>
const $=id=>document.getElementById(id);let tok=localStorage.getItem('tok');
function saveTok(){tok=$('tok').value.trim();localStorage.setItem('tok',tok);boot()}
async function api(p,b){const r=await fetch(p,{method:b?'POST':'GET',headers:{Authorization:'Bearer '+tok,'Content-Type':'application/json'},body:b?JSON.stringify(b):undefined});
 if(r.status===401){localStorage.removeItem('tok');location.reload()}if(!r.ok)throw new Error('HTTP '+r.status);return r.json()}
async function post(p,b){try{render(await api(p,b))}catch(e){$('err').textContent=e.message}}
const ago=t=>!t?'never':(d=>d<60?d+'s ago':d<3600?Math.round(d/60)+' min ago':Math.round(d/3600)+' h ago')(Math.round((Date.now()-t)/1e3));
function render(s){const d=s.device,ph=s.phase,stale=(Date.now()-(d.lastSeen||0))>Math.max(s.settings.interval*1.5,5.5)*60e3;
 $('phase').textContent={idle:stale?'Probably asleep':'Awake (idle)',requested:'Wake requested… waiting for Mac to check in',awake:'Awake, holding',done:'Hold ended, probably asleep again'}[ph];
 $('dot').className='dot '+(ph==='awake'||(ph==='idle'&&!stale)?'on':ph==='requested'?'req':'');
 $('seen').textContent=ago(d.lastSeen);$('power').textContent=d.lastSeen?(d.ac?'Charger':'Battery')+(d.battery!=null?' '+d.battery+'%':''):'–';$('host').textContent=d.host||'–';
 $('hint').textContent=ph==='requested'?'Mac checks in every '+s.settings.interval+' min on charger (30 min on battery); it will wake within that window.':ph==='awake'?'Holding awake for '+s.settings.hold+' min. SSH / Screen Sharing should work now.':d.lastSeen&&!d.ac?'Mac is on battery: checks only every 30 min and needs the lid open. Plug it in.':'';
 $('wake').disabled=ph==='requested'||ph==='awake';$('cancel').disabled=ph==='idle';
 if(document.activeElement.id!=='interval')$('interval').value=s.settings.interval;if(document.activeElement.id!=='hold')$('hold').value=s.settings.hold;}
async function boot(){if(!tok)return;$('login').hidden=true;$('app').hidden=false;post('/api/state');clearInterval(window.t);window.t=setInterval(()=>post('/api/state'),10e3)}
boot();
</script></body></html>`;
