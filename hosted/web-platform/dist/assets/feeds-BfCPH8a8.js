import{g as k,o as A,w as T,h as f,e as d,i as I,j as E}from"./main-UnnJVdi9.js";import"./modulepreload-polyfill-B5Qt9EMX.js";const V={init(e){e.innerHTML=`
      <div class="page feeds-page">
        <div class="page-header">
          <h1 class="page-title">Feeds</h1>
          <span class="page-subtitle" id="feeds-subtitle">Sessions</span>
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
          <p class="empty-state">Loading sessions...</p>
        </div>
      </div>
    `,q(e),N(e),B(e)},destroy(){w&&(clearInterval(w),w=null)}};let w=null,g=[],b="all",u=null;async function q(e){const t=await k();g=t,D(e,t),$(e,t),w||(w=setInterval(async()=>{g=await k(),D(e,g),$(e,g)},3e4))}function D(e,t){const a=e.querySelector("#feeds-stats");if(!a)return;const s=t.filter(o=>!o.live),n=s.reduce((o,r)=>o+(r.videoDurationMs||r.durationMs||0),0);s.reduce((o,r)=>o+(r.durationMs||0),0);const l=t.filter(o=>o.live).length,p=s.reduce((o,r)=>o+(r.segments||0),0);a.innerHTML=`
    <div class="stat-card"><span class="stat-value">${s.length}</span><span class="stat-label">Recordings</span></div>
    <div class="stat-card"><span class="stat-value">${f(n)}</span><span class="stat-label">Content</span></div>
    <div class="stat-card"><span class="stat-value stat-live">${l}</span><span class="stat-label">Live Now</span></div>
    <div class="stat-card"><span class="stat-value">${p}</span><span class="stat-label">Segments</span></div>
  `}function $(e,t){const a=e.querySelector("#feeds-list"),s=t.filter(i=>i.live);let n=t.filter(i=>!i.live);const l=new Date,p=new Date(l.getFullYear(),l.getMonth(),l.getDate()),o=new Date(p);o.setDate(o.getDate()-o.getDay());const r=new Date(l.getFullYear(),l.getMonth(),1);b==="today"?n=n.filter(i=>i.startedAt&&new Date(i.startedAt)>=p):b==="week"?n=n.filter(i=>i.startedAt&&new Date(i.startedAt)>=o):b==="month"&&(n=n.filter(i=>i.startedAt&&new Date(i.startedAt)>=r)),n.sort((i,c)=>{const v=i.startedAt?new Date(i.startedAt).getTime():0;return(c.startedAt?new Date(c.startedAt).getTime():0)-v});const h=s.length+n.length,y=e.querySelector("#feeds-subtitle");if(y&&(y.textContent=`${h} session${h!==1?"s":""}`),h===0){a.innerHTML=`<div class="empty-state-large">
      <p>No sessions found</p>
      <span class="empty-hint">Sessions will appear here after streaming</span>
    </div>`;return}let m="";s.length>0&&(m+=`
      <div class="feed-bucket feed-bucket-live">
        <div class="feed-bucket-header">
          <span class="feed-bucket-date">
            <span class="status-pill status-live" style="margin-right:6px">LIVE</span>
            Active Streams
          </span>
          <span class="feed-bucket-count">${s.length} live</span>
        </div>
        <div class="feed-bucket-rows">
          ${s.map(i=>H(i)).join("")}
        </div>
      </div>
    `);const x=U(n);m+=Object.entries(x).sort(([i],[c])=>c.localeCompare(i)).map(([i,c])=>`
      <div class="feed-bucket">
        <div class="feed-bucket-header">
          <span class="feed-bucket-date">${F(i)}</span>
          <span class="feed-bucket-count">${c.length} session${c.length!==1?"s":""}</span>
        </div>
        <div class="feed-bucket-rows">
          ${c.map(v=>C(v)).join("")}
        </div>
      </div>
    `).join(""),a.innerHTML=m,a.querySelectorAll(".feed-row").forEach(i=>{i.addEventListener("click",c=>{if(c.target.closest(".feed-expanded")||c.target.closest("[data-action]"))return;const v=i.dataset.sessionId;v&&R(e,v)})})}function H(e){var t;return`
    <div class="feed-row feed-row-live" data-session-id="${d(e.sessionId)}">
      <div class="feed-row-expand-icon feed-row-live-dot">
        <span class="status-pill status-live">LIVE</span>
      </div>
      <div class="feed-row-thumb">
        <div class="feed-row-placeholder feed-row-placeholder-live"></div>
      </div>
      <div class="feed-row-info">
        <span class="feed-row-device">${d(((t=e.device)==null?void 0:t.deviceName)||"Unknown")}</span>
        <span class="feed-row-meta">Live &middot; ${f(e.durationMs||0)}</span>
      </div>
      <div class="feed-row-actions">
        <button class="action-btn primary" data-action="watch-live" data-session-id="${d(e.sessionId)}">Watch Live</button>
        <button class="action-btn" data-action="share" data-session-id="${d(e.sessionId)}">Share</button>
      </div>
    </div>
  `}function C(e){var l;const t=u===e.sessionId,a=e.videoDurationMs||e.durationMs||0,s=Math.abs(e.driftMs||0),n=s>2e3?` ±${f(s)}`:"";return`
    <div class="feed-row${t?" expanded":""}" data-session-id="${d(e.sessionId)}">
      <div class="feed-row-expand-icon">
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </div>
      <div class="feed-row-thumb">
        ${e.hasThumbnail?`<img src="/session/${d(e.sessionId)}/thumbnail" alt="" loading="lazy" onerror="this.style.display='none'" />`:'<div class="feed-row-placeholder"></div>'}
      </div>
      <div class="feed-row-info">
        <span class="feed-row-device">${d(((l=e.device)==null?void 0:l.deviceName)||"Unknown")}</span>
        <span class="feed-row-meta">${f(a)}${n} &middot; ${e.segments||0} segs</span>
      </div>
      <span class="feed-row-time">${L(e.startedAt)}</span>
    </div>
    <div class="feed-expanded${t?" open":""}" data-expanded-id="${d(e.sessionId)}">
      ${t?M(e):""}
    </div>
  `}function M(e){var o;const t=(e.segments||0)>0,a=e.videoDurationMs||e.durationMs||0,s=e.driftMs||0,n=Math.abs(s),l=n>2e3;let p="";if(l){const r=s>0?"audio longer":"video longer";p=`<div class="feed-detail-row"><span class="feed-detail-label">A/V Drift</span><span class="feed-detail-value" style="color:#ffb86c">${f(n)} (${r})</span></div>`}return`<div class="feed-expanded-inner" id="feed-expanded-${d(e.sessionId)}">
    ${t?`<div class="feed-video-wrap">
      <video class="feed-inline-video" controls preload="metadata">
        <source src="/session/${d(e.sessionId)}/video.mp4" type="video/mp4" />
      </video>
    </div>`:""}
    <div class="feed-expanded-details" id="feed-details-${d(e.sessionId)}">
      <div class="feed-detail-rows">
        <div class="feed-detail-row"><span class="feed-detail-label">Session</span><span class="feed-detail-value">${d(e.sessionId.slice(0,12))}</span></div>
        <div class="feed-detail-row"><span class="feed-detail-label">Duration</span><span class="feed-detail-value">${f(a)}${a!==(e.durationMs||0)?` <span style="color:#6272a4">(wall ${f(e.durationMs||0)})</span>`:""}</span></div>
        ${e.audioDurationMs?`<div class="feed-detail-row"><span class="feed-detail-label">Audio</span><span class="feed-detail-value">${f(e.audioDurationMs)}</span></div>`:""}
        ${p}
        <div class="feed-detail-row"><span class="feed-detail-label">Segments</span><span class="feed-detail-value">${e.segments||0}</span></div>
        <div class="feed-detail-row"><span class="feed-detail-label">Device</span><span class="feed-detail-value">${d(((o=e.device)==null?void 0:o.deviceName)||"Unknown")}</span></div>
        <div class="feed-detail-row"><span class="feed-detail-label">Started</span><span class="feed-detail-value">${L(e.startedAt)}</span></div>
        <div class="feed-detail-row"><span class="feed-detail-label">Access</span><span class="feed-detail-value">${d(e.access||"private")}</span></div>
      </div>
      <div class="feed-expanded-actions">
        ${t?`<a class="action-btn" href="${I("/session/"+e.sessionId+"/video.mp4")}" target="_blank" rel="noopener">Download MP4</a>
        <button class="action-btn" data-action="play-overlay" data-session-id="${d(e.sessionId)}">Open in Player</button>`:""}
        <button class="action-btn" data-action="share" data-session-id="${d(e.sessionId)}">Share</button>
      </div>
      <div class="feed-guidance-section">
        <h4 class="section-title">Guidance Events</h4>
        <div class="feed-guidance-log" id="feed-guidance-${d(e.sessionId)}">
          <p class="empty-state">Loading...</p>
        </div>
      </div>
    </div>
  </div>`}async function R(e,t){if(u&&u!==t&&S(u),u===t){S(t),u=null;return}u=t;const a=e.querySelector(`[data-expanded-id="${t}"]`),s=e.querySelector(`.feed-row[data-session-id="${t}"]`);if(s&&s.classList.add("expanded"),a){a.classList.add("open");const n=g.find(l=>l.sessionId===t);n&&(a.innerHTML=M(n)),j(t)}}function S(e){const t=document.querySelector(`[data-expanded-id="${e}"]`),a=document.querySelector(`.feed-row[data-session-id="${e}"]`);if(a&&a.classList.remove("expanded"),t){t.classList.remove("open");const s=t.querySelector("video");s&&s.pause(),t.innerHTML=""}}async function j(e){const t=document.getElementById(`feed-guidance-${e}`);if(!t)return;const a=await E(e);if(!a||a.length===0){t.innerHTML='<p class="empty-state">No guidance events for this session</p>';return}t.innerHTML=a.slice(0,30).map(s=>`
    <div class="feed-guidance-item">
      <span class="feed-guidance-type" data-type="${d(s.type)}">${d(s.type.replace("guidance.","").toUpperCase())}</span>
      <span class="feed-guidance-text">${d(s.content)}</span>
      <span class="feed-guidance-conf">${Math.round(s.confidence*100)}%</span>
    </div>
  `).join("")}function B(e){e.addEventListener("click",t=>{const a=t.target.closest("[data-action]");if(!a)return;t.stopPropagation();const s=a.dataset.action,n=a.dataset.sessionId;if(!(!s||!n))switch(s){case"watch-live":T(n);break;case"play-overlay":A(n);break;case"share":{const l=window.openShareDialog;l&&l(n);break}}})}function N(e){const t=e.querySelector("#feeds-bucket-filters");t&&t.addEventListener("click",a=>{const s=a.target.closest(".filter-pill");s&&(t.querySelectorAll(".filter-pill").forEach(n=>n.classList.remove("active")),s.classList.add("active"),b=s.dataset.bucket||"all",$(e,g))})}function U(e){const t={};for(const a of e){const s=a.startedAt?a.startedAt.slice(0,10):"unknown";t[s]||(t[s]=[]),t[s].push(a)}return t}function F(e){if(e==="unknown")return"Unknown date";try{const t=new Date(e+"T00:00:00"),a=new Date;if(t.toDateString()===a.toDateString())return"Today";const s=new Date(a);return s.setDate(s.getDate()-1),t.toDateString()===s.toDateString()?"Yesterday":t.toLocaleDateString([],{weekday:"long",month:"short",day:"numeric"})}catch{return e}}function L(e){if(!e)return"--";try{return new Date(e).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}catch{return"--"}}export{V as default,V as page};
