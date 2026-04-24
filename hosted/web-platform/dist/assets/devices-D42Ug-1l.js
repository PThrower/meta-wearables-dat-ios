import{g,a as y,e as v,d as u}from"./main-GsIQMRzw.js";import"./modulepreload-polyfill-B5Qt9EMX.js";const q={init(a){a.innerHTML=`
      <div class="page devices-page">
        <div class="page-header">
          <h1 class="page-title">Fleet</h1>
          <span class="page-subtitle">Registered devices</span>
        </div>
        <div class="pulse-strip" id="devices-stats"></div>
        <div class="devices-toolbar">
          <input type="search" id="device-search" class="search-input" placeholder="Search devices..." />
          <div class="filter-pills" id="device-filters">
            <button class="filter-pill active" data-filter="all">All</button>
            <button class="filter-pill" data-filter="online">Online</button>
            <button class="filter-pill" data-filter="offline">Offline</button>
          </div>
        </div>
        <div id="devices-grid" class="devices-grid">
          <p class="empty-state">Loading devices...</p>
        </div>
      </div>
      <div id="device-modal" class="modal-overlay hidden">
        <div class="modal-content">
          <div class="modal-header">
            <h3 class="modal-title" id="modal-device-name">Device</h3>
            <button class="modal-close" id="modal-close">&times;</button>
          </div>
          <div class="modal-body" id="modal-body"></div>
        </div>
      </div>
    `,S(a),L(a),w(a),M(a)},destroy(){c&&(clearInterval(c),c=null)}};let c=null,r=[],p=[],f="all",b="";async function S(a){const[l,e]=await Promise.all([g(),y()]);r=l,p=e,$(a,l),m(a,l,e),c||(c=setInterval(async()=>{if(!a.isConnected){clearInterval(c),c=null;return}const[i,d]=await Promise.all([g(),y()]);a.isConnected&&(r=i,p=d,$(a,i),m(a,i,d))},2e4))}function $(a,l){const e=a.querySelector("#devices-stats");if(!e)return;const i=l.filter(t=>t.online).length,d=l.length-i,s=l.length>0?Math.round(l.filter(t=>t.battery!=null).reduce((t,n)=>t+(n.battery??0),0)/Math.max(1,l.filter(t=>t.battery!=null).length)):0;e.innerHTML=`
    <div class="stat-card"><span class="stat-value">${l.length}</span><span class="stat-label">Total Devices</span></div>
    <div class="stat-card"><span class="stat-value stat-live">${i}</span><span class="stat-label">Online</span></div>
    <div class="stat-card"><span class="stat-value">${d}</span><span class="stat-label">Offline</span></div>
    <div class="stat-card"><span class="stat-value">${s>0?s+"%":"--"}</span><span class="stat-label">Avg Battery</span></div>
  `}function m(a,l,e){const i=a.querySelector("#devices-grid");if(!i)return;let d=l;if(f==="online"?d=d.filter(s=>s.online):f==="offline"&&(d=d.filter(s=>!s.online)),b){const s=b.toLowerCase();d=d.filter(t=>(t.deviceName||t.device_id||"").toLowerCase().includes(s)||(t.deviceModel||t.device_model||"").toLowerCase().includes(s))}if(d.length===0){i.innerHTML=`<p class="empty-state">${l.length===0?"No devices registered":"No devices match filter"}</p>`;return}i.innerHTML=d.map(s=>{const n=e.filter(o=>{var h;return((h=o.device)==null?void 0:h.deviceName)===s.deviceName}).filter(o=>o.live).length;return`
      <div class="device-card" data-device-id="${v(s.device_id)}">
        <div class="device-card-header">
          <span class="device-name">${v(s.deviceName||s.device_id||"Unknown")}</span>
          <div class="device-card-badges">
            ${n>0?`<span class="device-live-badge">${n} LIVE</span>`:""}
            <span class="device-status-dot ${s.online?"online":"offline"}"></span>
          </div>
        </div>
        <div class="device-card-body">
          <div class="device-meta">
            <span class="device-meta-label">Model</span>
            <span class="device-meta-value">${v(s.deviceModel||s.device_model||"--")}</span>
          </div>
          ${s.battery!=null?`
            <div class="device-meta">
              <span class="device-meta-label">Battery</span>
              <span class="device-meta-value ${s.battery<20?"value-warning":""}">${s.battery}%</span>
            </div>
          `:""}
          ${s.signalStrength!=null?`
            <div class="device-meta">
              <span class="device-meta-label">Signal</span>
              <span class="device-meta-value">${s.signalStrength}%</span>
            </div>
          `:""}
          <div class="device-meta">
            <span class="device-meta-label">APNs</span>
            <span class="device-meta-value">${s.apnsToken?"Registered":"None"}</span>
          </div>
          <div class="device-meta">
            <span class="device-meta-label">Last Seen</span>
            <span class="device-meta-value">${s.lastSeen?u(s.lastSeen):"--"}</span>
          </div>
        </div>
      </div>
    `}).join(""),i.querySelectorAll(".device-card").forEach(s=>{s.addEventListener("click",()=>{const t=s.dataset.deviceId;t&&N(a,t)})})}function L(a){const l=a.querySelector("#device-filters");l&&l.addEventListener("click",e=>{const i=e.target.closest(".filter-pill");i&&(l.querySelectorAll(".filter-pill").forEach(d=>d.classList.remove("active")),i.classList.add("active"),f=i.dataset.filter||"all",m(a,r,p))})}function w(a){const l=a.querySelector("#device-search");if(!l)return;let e;l.addEventListener("input",()=>{clearTimeout(e),e=setTimeout(()=>{b=l.value.trim(),m(a,r,p)},200)})}function M(a){const l=a.querySelector("#modal-close"),e=a.querySelector("#device-modal");l==null||l.addEventListener("click",()=>e==null?void 0:e.classList.add("hidden")),e==null||e.addEventListener("click",i=>{i.target===e&&e.classList.add("hidden")})}function N(a,l){const e=r.find(n=>n.device_id===l);if(!e)return;const i=a.querySelector("#modal-device-name"),d=a.querySelector("#modal-body"),s=a.querySelector("#device-modal");i&&(i.textContent=e.deviceName||e.device_id),s&&s.classList.remove("hidden");const t=p.filter(n=>{var o;return((o=n.device)==null?void 0:o.deviceName)===e.deviceName});d&&(d.innerHTML=`
      <div class="modal-rows">
        <div class="modal-row"><span class="modal-label">Device ID</span><span class="modal-value">${v(e.device_id)}</span></div>
        <div class="modal-row"><span class="modal-label">Model</span><span class="modal-value">${v(e.deviceModel||e.device_model||"--")}</span></div>
        <div class="modal-row"><span class="modal-label">Status</span><span class="modal-value"><span class="device-status-dot ${e.online?"online":"offline"}"></span> ${e.online?"Online":"Offline"}</span></div>
        <div class="modal-row"><span class="modal-label">APNs Token</span><span class="modal-value">${e.apnsToken?"Registered":"None"}</span></div>
        <div class="modal-row"><span class="modal-label">Last Seen</span><span class="modal-value">${e.lastSeen?u(e.lastSeen):"--"}</span></div>
        ${e.battery!=null?`<div class="modal-row"><span class="modal-label">Battery</span><span class="modal-value">${e.battery}%</span></div>`:""}
      </div>
      <div class="modal-section">
        <h4 class="section-title">Session History</h4>
        ${t.length>0?`<div class="modal-sessions">${t.slice(0,10).map(n=>`
              <div class="modal-session-row">
                <span class="activity-dot ${n.live?"live":"recorded"}"></span>
                <span class="modal-session-id">${v(n.sessionId.slice(0,8))}</span>
                <span class="modal-session-time">${u(n.startedAt)}</span>
                <span class="modal-session-status ${n.live?"text-live":"text-muted"}">${n.live?"LIVE":"Recorded"}</span>
              </div>
            `).join("")}</div>`:'<p class="empty-state">No sessions for this device</p>'}
      </div>
    `)}export{q as default,q as page};
