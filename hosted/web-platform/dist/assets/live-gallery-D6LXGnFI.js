import{a as c,e as l,c as v}from"./api-client-CRb40JQZ.js";import{w as p}from"./main-D3tKFf6t.js";import"./modulepreload-polyfill-B5Qt9EMX.js";const w={init(e){e.innerHTML=`
      <div class="page live-gallery-page">
        <div class="page-header">
          <h1 class="page-title">Live Streams</h1>
          <span class="page-subtitle" id="live-subtitle">Active sessions</span>
        </div>
        <div class="pulse-strip" id="live-stats"></div>
        <div id="live-sessions-grid" class="live-sessions-grid">
          <p class="empty-state">Loading live sessions...</p>
        </div>
      </div>
    `,o(e),r=setInterval(()=>o(e),1e4)},destroy(){r&&(clearInterval(r),r=null)}};let r=null;async function o(e){const s=(await c()).filter(a=>a.live);h(e,s),m(e,s)}function h(e,t){const s=e.querySelector("#live-stats");s&&(s.innerHTML=`
    <div class="stat-card"><span class="stat-value stat-live">${t.length}</span><span class="stat-label">Live Now</span></div>
    <div class="stat-card"><span class="stat-value">${new Set(t.map(a=>{var i;return(i=a.device)==null?void 0:i.deviceName}).filter(Boolean)).size}</span><span class="stat-label">Active Devices</span></div>
  `)}function m(e,t){const s=e.querySelector("#live-sessions-grid"),a=e.querySelector("#live-subtitle");if(a&&(a.textContent=`${t.length} active session${t.length!==1?"s":""}`),t.length===0){s.innerHTML=`
      <div class="empty-state-large">
        <div class="empty-icon">
          <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" style="color:rgba(255,255,255,0.1)">
            <polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
          </svg>
        </div>
        <p>No active live streams</p>
        <span class="empty-hint">Streams will appear here when devices go live</span>
      </div>
    `;return}s.innerHTML=t.map(i=>{var n,d;return`
    <div class="live-session-card" data-session-id="${l(i.sessionId)}">
      <div class="live-card-thumb">
        <img src="/session/${l(i.sessionId)}/thumbnail" alt="" loading="lazy" onerror="this.style.display='none'" />
        <span class="live-badge">LIVE</span>
        <span class="live-card-duration">${i.startedAt?u(i.startedAt):""}</span>
      </div>
      <div class="live-card-info">
        <div class="live-card-left">
          <span class="live-card-device">${l(((n=i.device)==null?void 0:n.deviceName)||"Unknown")}</span>
          <span class="live-card-meta">${l(((d=i.device)==null?void 0:d.deviceModel)||"")} &middot; ${v(i.startedAt)}</span>
        </div>
        <span class="live-card-view-btn">Watch</span>
      </div>
    </div>
  `}).join(""),s.querySelectorAll(".live-session-card").forEach(i=>{i.addEventListener("click",()=>{const n=i.dataset.sessionId;n&&p(n)})})}function u(e){try{const t=Date.now()-new Date(e).getTime(),s=Math.floor(t/6e4);return s<1?"< 1m":s<60?`${s}m`:`${Math.floor(s/60)}h ${s%60}m`}catch{return""}}export{w as default,w as page};
