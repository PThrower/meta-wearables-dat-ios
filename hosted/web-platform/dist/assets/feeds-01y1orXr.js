import{g as b,e as i,h as S}from"./api-client-DnmY5-31.js";import{f as g}from"./main-DQ1BgOMO.js";import"./modulepreload-polyfill-B5Qt9EMX.js";const C={init(e){e.innerHTML=`
      <div class="page feeds-page">
        <div class="page-header">
          <h1 class="page-title">Feeds</h1>
          <span class="page-subtitle" id="feeds-subtitle">Recorded sessions</span>
        </div>
        <div class="feeds-stats" id="feeds-stats"></div>
        <div class="feeds-toolbar">
          <div class="filter-pills" id="feeds-bucket-filters">
            <button class="filter-pill active" data-bucket="all">All</button>
            <button class="filter-pill" data-bucket="today">Today</button>
            <button class="filter-pill" data-bucket="week">This Week</button>
            <button class="filter-pill" data-bucket="month">This Month</button>
          </div>
        </div>
        <div id="feeds-list" class="feeds-list">
          <p class="empty-state">Loading recordings...</p>
        </div>
      </div>
    `,L(e),M(e)},destroy(){v&&(clearInterval(v),v=null)}};let v=null,f=[],u="all",r=null;async function L(e){const s=await b();f=s,$(e,s),m(e,s),v||(v=setInterval(async()=>{f=await b(),$(e,f),m(e,f)},3e4))}function $(e,s){const a=e.querySelector("#feeds-stats");if(!a)return;const t=s.filter(l=>!l.live),n=t.reduce((l,w)=>l+(w.durationMs||0),0),c=s.filter(l=>l.live).length;a.innerHTML=`
    <div class="stat-card"><span class="stat-value">${t.length}</span><span class="stat-label">Recordings</span></div>
    <div class="stat-card"><span class="stat-value">${g(n)}</span><span class="stat-label">Total Runtime</span></div>
    <div class="stat-card"><span class="stat-value stat-live">${c}</span><span class="stat-label">Live Now</span></div>
  `}function m(e,s){const a=e.querySelector("#feeds-list");let t=s.filter(d=>!d.live);const n=new Date,c=new Date(n.getFullYear(),n.getMonth(),n.getDate()),l=new Date(c);l.setDate(l.getDate()-l.getDay());const w=new Date(n.getFullYear(),n.getMonth(),1);u==="today"?t=t.filter(d=>d.startedAt&&new Date(d.startedAt)>=c):u==="week"?t=t.filter(d=>d.startedAt&&new Date(d.startedAt)>=l):u==="month"&&(t=t.filter(d=>d.startedAt&&new Date(d.startedAt)>=w)),t.sort((d,o)=>{const p=d.startedAt?new Date(d.startedAt).getTime():0;return(o.startedAt?new Date(o.startedAt).getTime():0)-p});const h=e.querySelector("#feeds-subtitle");if(h&&(h.textContent=`${t.length} recording${t.length!==1?"s":""}`),t.length===0){a.innerHTML=`<div class="empty-state-large">
      <p>No recordings found</p>
      <span class="empty-hint">Recorded sessions will appear here</span>
    </div>`;return}const D=q(t);a.innerHTML=Object.entries(D).sort(([d],[o])=>o.localeCompare(d)).map(([d,o])=>`
      <div class="feed-bucket">
        <div class="feed-bucket-header">
          <span class="feed-bucket-date">${E(d)}</span>
          <span class="feed-bucket-count">${o.length} session${o.length!==1?"s":""}</span>
        </div>
        <div class="feed-bucket-rows">
          ${o.map(p=>x(p)).join("")}
        </div>
      </div>
    `).join(""),a.querySelectorAll(".feed-row").forEach(d=>{d.addEventListener("click",o=>{if(o.target.closest(".feed-expanded"))return;const p=d.dataset.sessionId;p&&A(e,p)})})}function x(e){var a,t;const s=r===e.sessionId;return`
    <div class="feed-row${s?" expanded":""}" data-session-id="${i(e.sessionId)}">
      <div class="feed-row-expand-icon">
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </div>
      <div class="feed-row-thumb">
        ${e.hasThumbnail?`<img src="/session/${i(e.sessionId)}/thumbnail" alt="" loading="lazy" onerror="this.style.display='none'" />`:'<div class="feed-row-placeholder"></div>'}
      </div>
      <div class="feed-row-info">
        <span class="feed-row-device">${i(((a=e.device)==null?void 0:a.deviceName)||"Unknown")}</span>
        <span class="feed-row-meta">${g(e.durationMs||0)} &middot; ${e.segments||0} segments</span>
      </div>
      <span class="feed-row-time">${y(e.startedAt)}</span>
    </div>
    <div class="feed-expanded${s?" open":""}" data-expanded-id="${i(e.sessionId)}">
      ${s?`<div class="feed-expanded-inner" id="feed-expanded-${i(e.sessionId)}">
        <div class="feed-video-wrap">
          <video class="feed-inline-video" controls preload="metadata">
            <source src="/session/${i(e.sessionId)}/video.mp4" type="video/mp4" />
          </video>
        </div>
        <div class="feed-expanded-details" id="feed-details-${i(e.sessionId)}">
          <div class="feed-detail-rows">
            <div class="feed-detail-row"><span class="feed-detail-label">Session</span><span class="feed-detail-value">${i(e.sessionId.slice(0,12))}</span></div>
            <div class="feed-detail-row"><span class="feed-detail-label">Duration</span><span class="feed-detail-value">${g(e.durationMs||0)}</span></div>
            <div class="feed-detail-row"><span class="feed-detail-label">Device</span><span class="feed-detail-value">${i(((t=e.device)==null?void 0:t.deviceName)||"Unknown")}</span></div>
            <div class="feed-detail-row"><span class="feed-detail-label">Started</span><span class="feed-detail-value">${y(e.startedAt)}</span></div>
            <div class="feed-detail-row"><span class="feed-detail-label">Access</span><span class="feed-detail-value">${i(e.access||"private")}</span></div>
          </div>
          <div class="feed-guidance-section">
            <h4 class="section-title">Guidance Events</h4>
            <div class="feed-guidance-log" id="feed-guidance-${i(e.sessionId)}">
              <p class="empty-state">Loading...</p>
            </div>
          </div>
        </div>
      </div>`:""}
    </div>
  `}async function A(e,s){var n;if(r&&r!==s&&k(r),r===s){k(s),r=null;return}r=s;const a=e.querySelector(`[data-expanded-id="${s}"]`),t=e.querySelector(`.feed-row[data-session-id="${s}"]`);if(t&&t.classList.add("expanded"),a){a.classList.add("open");const c=f.find(l=>l.sessionId===s);a.innerHTML=`<div class="feed-expanded-inner">
      <div class="feed-video-wrap">
        <video class="feed-inline-video" controls preload="metadata">
          <source src="/session/${s}/video.mp4" type="video/mp4" />
        </video>
      </div>
      <div class="feed-expanded-details">
        <div class="feed-detail-rows">
          ${c?`
            <div class="feed-detail-row"><span class="feed-detail-label">Session</span><span class="feed-detail-value">${i(c.sessionId.slice(0,12))}</span></div>
            <div class="feed-detail-row"><span class="feed-detail-label">Duration</span><span class="feed-detail-value">${g(c.durationMs||0)}</span></div>
            <div class="feed-detail-row"><span class="feed-detail-label">Device</span><span class="feed-detail-value">${i(((n=c.device)==null?void 0:n.deviceName)||"Unknown")}</span></div>
            <div class="feed-detail-row"><span class="feed-detail-label">Started</span><span class="feed-detail-value">${y(c.startedAt)}</span></div>
            <div class="feed-detail-row"><span class="feed-detail-label">Access</span><span class="feed-detail-value">${i(c.access||"private")}</span></div>
          `:""}
        </div>
        <div class="feed-guidance-section">
          <h4 class="section-title">Guidance Events</h4>
          <div class="feed-guidance-log" id="feed-guidance-${s}">
            <p class="empty-state">Loading...</p>
          </div>
        </div>
      </div>
    </div>`,T(s)}}function k(e){const s=document.querySelector(`[data-expanded-id="${e}"]`),a=document.querySelector(`.feed-row[data-session-id="${e}"]`);if(a&&a.classList.remove("expanded"),s){s.classList.remove("open");const t=s.querySelector("video");t&&t.pause(),s.innerHTML=""}}async function T(e){const s=document.getElementById(`feed-guidance-${e}`);if(!s)return;const a=await S(e);if(!a||a.length===0){s.innerHTML='<p class="empty-state">No guidance events for this session</p>';return}s.innerHTML=a.slice(0,30).map(t=>`
    <div class="feed-guidance-item">
      <span class="feed-guidance-type" data-type="${i(t.type)}">${i(t.type.replace("guidance.","").toUpperCase())}</span>
      <span class="feed-guidance-text">${i(t.content)}</span>
      <span class="feed-guidance-conf">${Math.round(t.confidence*100)}%</span>
    </div>
  `).join("")}function M(e){const s=e.querySelector("#feeds-bucket-filters");s&&s.addEventListener("click",a=>{const t=a.target.closest(".filter-pill");t&&(s.querySelectorAll(".filter-pill").forEach(n=>n.classList.remove("active")),t.classList.add("active"),u=t.dataset.bucket||"all",m(e,f))})}function q(e){const s={};for(const a of e){const t=a.startedAt?a.startedAt.slice(0,10):"unknown";s[t]||(s[t]=[]),s[t].push(a)}return s}function E(e){if(e==="unknown")return"Unknown date";try{const s=new Date(e+"T00:00:00"),a=new Date;if(s.toDateString()===a.toDateString())return"Today";const t=new Date(a);return t.setDate(t.getDate()-1),s.toDateString()===t.toDateString()?"Yesterday":s.toLocaleDateString([],{weekday:"long",month:"short",day:"numeric"})}catch{return e}}function y(e){if(!e)return"--";try{return new Date(e).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}catch{return"--"}}export{C as default,C as page};
