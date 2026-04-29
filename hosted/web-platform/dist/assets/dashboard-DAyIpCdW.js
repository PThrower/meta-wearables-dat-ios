import{f as u,a as m,b as y,c as S,e as p,d as b}from"./main-DWB6BCMx.js";import"./modulepreload-polyfill-B5Qt9EMX.js";const q={init(t){t.innerHTML=`
      <div class="page dashboard-page">
        <div class="page-header">
          <div class="page-header-row">
            <div>
              <h1 class="page-title">Command Center</h1>
              <span class="page-subtitle">Platform overview</span>
            </div>
            <span class="fleet-health-badge" id="dash-health">
              <span class="health-dot"></span>
              <span class="health-text">Checking...</span>
            </span>
          </div>
        </div>
        <div class="pulse-strip">
          <div class="stat-card">
            <span class="stat-value" id="dash-live">--</span>
            <span class="stat-label">Live Streams</span>
          </div>
          <div class="stat-card">
            <span class="stat-value" id="dash-devices">--</span>
            <span class="stat-label">Devices</span>
          </div>
          <div class="stat-card">
            <span class="stat-value" id="dash-guidance">--</span>
            <span class="stat-label">Guidance Events</span>
          </div>
          <div class="stat-card">
            <span class="stat-value" id="dash-recordings">--</span>
            <span class="stat-label">Total Sessions</span>
          </div>
        </div>
        <div class="dashboard-grid">
          <section class="dashboard-section activity-section">
            <h2 class="section-title">Activity Feed</h2>
            <div id="dash-activity" class="activity-feed">
              <p class="empty-state">Loading activity...</p>
            </div>
          </section>
          <section class="dashboard-section agents-section">
            <h2 class="section-title">AI Agents</h2>
            <div id="dash-agents" class="agent-cards">
              <p class="empty-state">Loading agents...</p>
            </div>
          </section>
        </div>
      </div>
    `,g(t),r=setInterval(()=>g(t),15e3)},destroy(){r&&(clearInterval(r),r=null)}};let r=null;async function g(t){const[s,i,e,n]=await Promise.all([u(),m(),y(),S()]);C(t,s,e),I(t,i,e),L(t,n),x(t,s,i)}function C(t,s,i){const e=t.querySelector("#dash-live"),n=t.querySelector("#dash-devices"),l=t.querySelector("#dash-guidance"),c=t.querySelector("#dash-recordings"),d=(s==null?void 0:s.activeSessions)??i.filter(v=>v.live).length,a=(s==null?void 0:s.totalDevices)??new Set(i.map(v=>{var h;return(h=v.device)==null?void 0:h.deviceName}).filter(Boolean)).size,o=(s==null?void 0:s.guidanceEvents)??0,f=i.length;e&&(e.textContent=String(d)),n&&(n.textContent=String(a)),l&&(l.textContent=String(o)),c&&(c.textContent=String(f)),e&&d>0&&e.classList.add("stat-live")}function I(t,s,i){const e=t.querySelector("#dash-activity");if(!e)return;const n=new Set(s.filter(a=>a.live).map(a=>a.sessionId)),l=s.filter(a=>a.live),c=i.filter(a=>!n.has(a.sessionId)).slice(0,12),d=[...l,...c];if(d.length===0){e.innerHTML='<p class="empty-state">No recent activity</p>';return}e.innerHTML=d.slice(0,15).map(a=>{var o;return`
    <div class="activity-item">
      <span class="activity-dot ${a.live?"live":"recorded"}"></span>
      <span class="activity-text">${p(((o=a.device)==null?void 0:o.deviceName)||a.sessionId.slice(0,8))}</span>
      <span class="activity-time">${a.live?"LIVE":b(a.startedAt)}</span>
    </div>
  `}).join("")}function L(t,s){const i=t.querySelector("#dash-agents");if(i){if(s.length===0){i.innerHTML='<p class="empty-state">No AI apps configured</p>';return}i.innerHTML=s.map(e=>{var l;const n=e.active;return`
      <div class="agent-card">
        <div class="agent-info">
          <span class="agent-name">${p(e.name||e.id)}</span>
          ${(l=e.config)!=null&&l.model?`<span class="agent-model">${p(e.config.model)}</span>`:""}
        </div>
        <span class="agent-status ${n?"active":"standby"}">${n?"Active":"Standby"}</span>
      </div>
    `}).join("")}}function x(t,s,i){const e=t.querySelector("#dash-health");if(!e)return;const n=i.filter(d=>d.live).length,l=e.querySelector(".health-dot"),c=e.querySelector(".health-text");n>0?(l&&(l.className="health-dot health-good"),c&&(c.textContent=`${n} live stream${n!==1?"s":""}`),e.classList.add("healthy")):s&&(l&&(l.className="health-dot health-idle"),c&&(c.textContent="Idle — no active streams"),e.classList.remove("healthy"))}export{q as default,q as page};
