import{f as h,a as g,b as u,e as o,c as f}from"./main-DLsBYPvM.js";import"./modulepreload-polyfill-B5Qt9EMX.js";const x={init(t){t.innerHTML=`
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
    `,r(t),l=setInterval(()=>r(t),15e3)},destroy(){l&&(clearInterval(l),l=null)}};let l=null;async function r(t){const[e,a,s]=await Promise.all([h(),g(),u()]);y(t,e),m(t,a),S(t,s),b(t,e,a)}function y(t,e){if(!e)return;const a=t.querySelector("#dash-live"),s=t.querySelector("#dash-devices"),i=t.querySelector("#dash-guidance"),n=t.querySelector("#dash-recordings"),c=e.activeSessions??e.active_sessions??0,d=e.totalDevices??e.total_devices??0,v=e.guidanceEvents??e.guidance_events??0,p=e.totalSessions??e.total_sessions??0;a&&(a.textContent=String(c)),s&&(s.textContent=String(d)),i&&(i.textContent=String(v)),n&&(n.textContent=String(p)),a&&c>0&&a.classList.add("stat-live")}function m(t,e){const a=t.querySelector("#dash-activity");if(a){if(e.length===0){a.innerHTML='<p class="empty-state">No recent activity</p>';return}a.innerHTML=e.slice(0,15).map(s=>{var i;return`
    <div class="activity-item">
      <span class="activity-dot ${s.live?"live":"recorded"}"></span>
      <span class="activity-text">${o(((i=s.device)==null?void 0:i.deviceName)||s.sessionId)}</span>
      <span class="activity-time">${s.live?"LIVE":f(s.startedAt)}</span>
    </div>
  `}).join("")}}function S(t,e){const a=t.querySelector("#dash-agents");if(a){if(e.length===0){a.innerHTML='<p class="empty-state">No AI apps configured</p>';return}a.innerHTML=e.map(s=>{var n;const i=s.active;return`
      <div class="agent-card">
        <div class="agent-info">
          <span class="agent-name">${o(s.name||s.id)}</span>
          ${(n=s.config)!=null&&n.model?`<span class="agent-model">${o(s.config.model)}</span>`:""}
        </div>
        <span class="agent-status ${i?"active":"standby"}">${i?"Active":"Standby"}</span>
      </div>
    `}).join("")}}function b(t,e,a){const s=t.querySelector("#dash-health");if(!s)return;const i=a.filter(d=>d.live).length,n=s.querySelector(".health-dot"),c=s.querySelector(".health-text");i>0?(n&&(n.className="health-dot health-good"),c&&(c.textContent=`${i} live stream${i!==1?"s":""}`),s.classList.add("healthy")):e&&(n&&(n.className="health-dot health-idle"),c&&(c.textContent="Idle — no active streams"),s.classList.remove("healthy"))}export{x as default,x as page};
