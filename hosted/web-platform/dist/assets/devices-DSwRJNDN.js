import{g as w,a as E,h as D,e as r,d as h,i as _}from"./main-CZ7VDJrt.js";import"./modulepreload-polyfill-B5Qt9EMX.js";const z={init(e){e.innerHTML=`
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
          <button class="btn btn-sm btn-toggle" id="device-select-toggle">Select</button>
          <button class="btn btn-sm btn-danger hidden" id="device-delete-btn">Delete (0)</button>
          <div class="confirm-bar hidden" id="device-confirm-bar">
            <span class="confirm-text">Remove <strong id="confirm-count">0</strong> devices? They can re-register on reconnect.</span>
            <button class="btn btn-sm btn-danger" id="confirm-yes">Delete</button>
            <button class="btn btn-sm" id="confirm-no">Cancel</button>
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
    `,M(e),C(e),T(e),A(e),H(e)},destroy(){f&&(clearInterval(f),f=null),g&&(document.removeEventListener("keydown",g),g=null)}};let f=null,g=null,p=[],m=[],$="all",L="",u=!1,c=new Set,y=null;async function M(e){y=e;const[l,s]=await Promise.all([w(),E()]);p=l,m=s,k(e,l),b(e,l,s),f||(f=setInterval(async()=>{if(!e.isConnected){clearInterval(f),f=null;return}const[n,d]=await Promise.all([w(),E()]);e.isConnected&&(p=n,m=d,k(e,n),b(e,n,d))},2e4))}function k(e,l){const s=e.querySelector("#devices-stats");if(!s)return;const n=l.filter(a=>a.online).length,d=l.length-n,t=l.length>0?Math.round(l.filter(a=>a.battery!=null).reduce((a,i)=>a+(i.battery??0),0)/Math.max(1,l.filter(a=>a.battery!=null).length)):0;s.innerHTML=`
    <div class="stat-card"><span class="stat-value">${l.length}</span><span class="stat-label">Total Devices</span></div>
    <div class="stat-card"><span class="stat-value stat-live">${n}</span><span class="stat-label">Online</span></div>
    <div class="stat-card"><span class="stat-value">${d}</span><span class="stat-label">Offline</span></div>
    <div class="stat-card"><span class="stat-value">${t>0?t+"%":"--"}</span><span class="stat-label">Avg Battery</span></div>
  `}function b(e,l,s){const n=e.querySelector("#devices-grid");if(!n)return;let d=l;if($==="online"?d=d.filter(t=>t.online):$==="offline"&&(d=d.filter(t=>!t.online)),L){const t=L.toLowerCase();d=d.filter(a=>(a.deviceName||a.device_id||"").toLowerCase().includes(t)||(a.deviceModel||a.device_model||"").toLowerCase().includes(t))}if(d.length===0){n.innerHTML=`<p class="empty-state">${l.length===0?"No devices registered":"No devices match filter"}</p>`;return}n.innerHTML=d.map(t=>{const i=s.filter(v=>{var q;return((q=v.device)==null?void 0:q.deviceName)===t.deviceName}).filter(v=>v.live).length,o=c.has(t.device_id);return`
      <div class="device-card${u?" select-mode":""}${o?" selected":""}" data-device-id="${r(t.device_id)}">
        ${u?`<input type="checkbox" class="device-card-checkbox" ${o?"checked":""} />`:""}
        <div class="device-card-header">
          <span class="device-name">${r(t.deviceName||t.device_id||"Unknown")}</span>
          <div class="device-card-badges">
            ${i>0?`<span class="device-live-badge">${i} LIVE</span>`:""}
            <span class="device-status-dot ${t.online?"online":"offline"}"></span>
          </div>
        </div>
        <div class="device-card-body">
          <div class="device-meta">
            <span class="device-meta-label">Model</span>
            <span class="device-meta-value">${r(t.deviceModel||t.device_model||"--")}</span>
          </div>
          ${t.battery!=null?`
            <div class="device-meta">
              <span class="device-meta-label">Battery</span>
              <span class="device-meta-value ${t.battery<20?"value-warning":""}">${t.battery}%</span>
            </div>
          `:""}
          ${t.signalStrength!=null?`
            <div class="device-meta">
              <span class="device-meta-label">Signal</span>
              <span class="device-meta-value">${t.signalStrength}%</span>
            </div>
          `:""}
          <div class="device-meta">
            <span class="device-meta-label">APNs</span>
            <span class="device-meta-value">${t.apnsToken?"Registered":"None"}</span>
          </div>
          ${t.appVersion||t.buildNumber?`
          <div class="device-meta">
            <span class="device-meta-label">Build</span>
            <span class="device-meta-value">${r(t.appVersion||"--")}${t.buildNumber?` (${t.buildNumber})`:""}</span>
          </div>
          `:""}
          <div class="device-meta">
            <span class="device-meta-label">Last Seen</span>
            <span class="device-meta-value">${t.lastSeen?h(t.lastSeen):"--"}</span>
          </div>
        </div>
      </div>
    `}).join(""),n.querySelectorAll(".device-card").forEach(t=>{t.addEventListener("click",a=>{const i=t.dataset.deviceId;if(i)if(u){if(a.target.classList.contains("device-card-checkbox"))return;x(i)}else I(e,i)})}),n.querySelectorAll(".device-card-checkbox").forEach(t=>{t.addEventListener("change",a=>{const i=t.closest(".device-card"),o=i==null?void 0:i.dataset.deviceId;o&&(a.stopPropagation(),x(o))})})}function C(e){const l=e.querySelector("#device-filters");l&&l.addEventListener("click",s=>{const n=s.target.closest(".filter-pill");n&&(l.querySelectorAll(".filter-pill").forEach(d=>d.classList.remove("active")),n.classList.add("active"),$=n.dataset.filter||"all",b(e,p,m))})}function T(e){const l=e.querySelector("#device-search");if(!l)return;let s;l.addEventListener("input",()=>{clearTimeout(s),s=setTimeout(()=>{L=l.value.trim(),b(e,p,m)},200)})}function A(e){const l=e.querySelector("#modal-close"),s=e.querySelector("#device-modal");l==null||l.addEventListener("click",()=>s==null?void 0:s.classList.add("hidden")),s==null||s.addEventListener("click",n=>{n.target===s&&s.classList.add("hidden")})}function x(e){c.has(e)?c.delete(e):c.add(e),N(),y&&b(y,p,m)}function N(){const e=y;if(!e)return;const l=e.querySelector("#device-delete-btn"),s=e.querySelector("#device-confirm-bar"),n=e.querySelector("#confirm-count");l&&(l.textContent=`Delete (${c.size})`,l.classList.toggle("hidden",!u||c.size===0)),s&&s.classList.add("hidden"),n&&(n.textContent=String(c.size))}function B(e){u=!0,c.clear();const l=e.querySelector("#device-select-toggle");l&&(l.textContent="Cancel",l.classList.add("active")),N(),b(e,p,m)}function S(e){u=!1,c.clear();const l=e.querySelector("#device-select-toggle");l&&(l.textContent="Select",l.classList.remove("active"));const s=e.querySelector("#device-delete-btn"),n=e.querySelector("#device-confirm-bar");s&&s.classList.add("hidden"),n&&n.classList.add("hidden"),b(e,p,m)}function H(e){const l=e.querySelector("#device-select-toggle"),s=e.querySelector("#device-delete-btn");e.querySelector("#device-confirm-bar");const n=e.querySelector("#confirm-yes"),d=e.querySelector("#confirm-no");l==null||l.addEventListener("click",()=>{u?S(e):B(e)}),s==null||s.addEventListener("click",()=>{if(c.size===0)return;const t=e.querySelector("#device-confirm-bar"),a=e.querySelector("#confirm-count"),i=e.querySelector("#device-delete-btn");a&&(a.textContent=String(c.size)),i&&i.classList.add("hidden"),t&&t.classList.remove("hidden")}),n==null||n.addEventListener("click",async()=>{const t=Array.from(c);if(t.length===0)return;const a=e.querySelector("#confirm-yes");a&&(a.textContent="Deleting...",a.setAttribute("disabled","true"));try{const i=await D(t);i!=null&&i.ok?(S(e),await M(e)):(console.error("[fleet] Delete failed:",i),a&&(a.textContent="Delete",a.removeAttribute("disabled")))}catch(i){console.error("[fleet] Delete error:",i),a&&(a.textContent="Delete",a.removeAttribute("disabled"))}}),d==null||d.addEventListener("click",()=>{const t=e.querySelector("#device-confirm-bar"),a=e.querySelector("#device-delete-btn");t&&t.classList.add("hidden"),a&&a.classList.toggle("hidden",c.size===0)}),g=t=>{t.key==="Escape"&&u&&y&&S(y)},document.addEventListener("keydown",g)}function I(e,l){const s=p.find(i=>i.device_id===l);if(!s)return;const n=e.querySelector("#modal-device-name"),d=e.querySelector("#modal-body"),t=e.querySelector("#device-modal");n&&(n.textContent=s.deviceName||s.device_id),t&&t.classList.remove("hidden");const a=m.filter(i=>{var o;return((o=i.device)==null?void 0:o.deviceName)===s.deviceName});d&&(d.innerHTML=`
      <div class="modal-rows">
        <div class="modal-row"><span class="modal-label">Device ID</span><span class="modal-value">${r(s.device_id)}</span></div>
        <div class="modal-row"><span class="modal-label">Model</span><span class="modal-value">${r(s.deviceModel||s.device_model||"--")}</span></div>
        ${s.systemVersion?`<div class="modal-row"><span class="modal-label">iOS</span><span class="modal-value">${r(s.systemVersion)}</span></div>`:""}
        <div class="modal-row"><span class="modal-label">Status</span><span class="modal-value"><span class="device-status-dot ${s.online?"online":"offline"}"></span> ${s.online?"Online":"Offline"}</span></div>
        <div class="modal-row"><span class="modal-label">Build</span><span class="modal-value">${r(s.appVersion||"--")}${s.buildNumber?` (${s.buildNumber})`:""}</span></div>
        <div class="modal-row"><span class="modal-label">APNs Token</span><span class="modal-value">${s.apnsToken?"Registered":"None"}</span></div>
        <div class="modal-row"><span class="modal-label">Last Seen</span><span class="modal-value">${s.lastSeen?h(s.lastSeen):"--"}</span></div>
        ${s.battery!=null?`<div class="modal-row"><span class="modal-label">Battery</span><span class="modal-value">${s.battery}%</span></div>`:""}
      </div>
      <div class="modal-section">
        <h4 class="section-title">Build History</h4>
        <div id="modal-build-history"><p class="empty-state">Loading...</p></div>
      </div>
      <div class="modal-section">
        <h4 class="section-title">Session History</h4>
        ${a.length>0?`<div class="modal-sessions">${a.slice(0,10).map(i=>`
              <div class="modal-session-row">
                <span class="activity-dot ${i.live?"live":"recorded"}"></span>
                <span class="modal-session-id">${r(i.sessionId.slice(0,8))}</span>
                <span class="modal-session-time">${h(i.startedAt)}</span>
                <span class="modal-session-status ${i.live?"text-live":"text-muted"}">${i.live?"LIVE":"Recorded"}</span>
              </div>
            `).join("")}</div>`:'<p class="empty-state">No sessions for this device</p>'}
      </div>
    `,_(l).then(i=>{const o=d.querySelector("#modal-build-history");if(o){if(i.length===0){o.innerHTML='<p class="empty-state">No build history</p>';return}o.innerHTML=`<div class="modal-sessions">${i.map(v=>`
        <div class="modal-session-row">
          <span class="modal-session-id">${r(v.appVersion)} (${r(v.buildNumber)})</span>
          <span class="modal-session-time">First: ${h(v.firstSeenAt)}</span>
          <span class="modal-session-status text-muted">Last: ${h(v.lastSeenAt)}</span>
        </div>
      `).join("")}</div>`}}))}export{z as default,z as page};
