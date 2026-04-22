import{g as k,o as T,w as M,h as b,e as d,i as I,j as E}from"./main-DLsBYPvM.js";import"./modulepreload-polyfill-B5Qt9EMX.js";const V={init(e){e.innerHTML=`
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
    `,q(e),N(e),B(e)},destroy(){v&&(clearInterval(v),v=null)}};let v=null,f=[],w="all",r=null;async function q(e){const t=await k();f=t,S(e,t),y(e,t),v||(v=setInterval(async()=>{f=await k(),S(e,f),y(e,f)},3e4))}function S(e,t){const s=e.querySelector("#feeds-stats");if(!s)return;const a=t.filter(o=>!o.live),i=a.reduce((o,u)=>o+(u.durationMs||0),0),l=t.filter(o=>o.live).length,g=a.reduce((o,u)=>o+(u.segments||0),0);s.innerHTML=`
    <div class="stat-card"><span class="stat-value">${a.length}</span><span class="stat-label">Recordings</span></div>
    <div class="stat-card"><span class="stat-value">${b(i)}</span><span class="stat-label">Total Runtime</span></div>
    <div class="stat-card"><span class="stat-value stat-live">${l}</span><span class="stat-label">Live Now</span></div>
    <div class="stat-card"><span class="stat-value">${g}</span><span class="stat-label">Segments</span></div>
  `}function y(e,t){const s=e.querySelector("#feeds-list"),a=t.filter(n=>n.live);let i=t.filter(n=>!n.live);const l=new Date,g=new Date(l.getFullYear(),l.getMonth(),l.getDate()),o=new Date(g);o.setDate(o.getDate()-o.getDay());const u=new Date(l.getFullYear(),l.getMonth(),1);w==="today"?i=i.filter(n=>n.startedAt&&new Date(n.startedAt)>=g):w==="week"?i=i.filter(n=>n.startedAt&&new Date(n.startedAt)>=o):w==="month"&&(i=i.filter(n=>n.startedAt&&new Date(n.startedAt)>=u)),i.sort((n,c)=>{const p=n.startedAt?new Date(n.startedAt).getTime():0;return(c.startedAt?new Date(c.startedAt).getTime():0)-p});const h=a.length+i.length,$=e.querySelector("#feeds-subtitle");if($&&($.textContent=`${h} session${h!==1?"s":""}`),h===0){s.innerHTML=`<div class="empty-state-large">
      <p>No sessions found</p>
      <span class="empty-hint">Sessions will appear here after streaming</span>
    </div>`;return}let m="";a.length>0&&(m+=`
      <div class="feed-bucket feed-bucket-live">
        <div class="feed-bucket-header">
          <span class="feed-bucket-date">
            <span class="status-pill status-live" style="margin-right:6px">LIVE</span>
            Active Streams
          </span>
          <span class="feed-bucket-count">${a.length} live</span>
        </div>
        <div class="feed-bucket-rows">
          ${a.map(n=>H(n)).join("")}
        </div>
      </div>
    `);const A=U(i);m+=Object.entries(A).sort(([n],[c])=>c.localeCompare(n)).map(([n,c])=>`
      <div class="feed-bucket">
        <div class="feed-bucket-header">
          <span class="feed-bucket-date">${F(n)}</span>
          <span class="feed-bucket-count">${c.length} session${c.length!==1?"s":""}</span>
        </div>
        <div class="feed-bucket-rows">
          ${c.map(p=>R(p)).join("")}
        </div>
      </div>
    `).join(""),s.innerHTML=m,s.querySelectorAll(".feed-row").forEach(n=>{n.addEventListener("click",c=>{if(c.target.closest(".feed-expanded")||c.target.closest("[data-action]"))return;const p=n.dataset.sessionId;p&&C(e,p)})})}function H(e){var t;return`
    <div class="feed-row feed-row-live" data-session-id="${d(e.sessionId)}">
      <div class="feed-row-expand-icon feed-row-live-dot">
        <span class="status-pill status-live">LIVE</span>
      </div>
      <div class="feed-row-thumb">
        <div class="feed-row-placeholder feed-row-placeholder-live"></div>
      </div>
      <div class="feed-row-info">
        <span class="feed-row-device">${d(((t=e.device)==null?void 0:t.deviceName)||"Unknown")}</span>
        <span class="feed-row-meta">Live &middot; ${b(e.durationMs||0)}</span>
      </div>
      <div class="feed-row-actions">
        <button class="action-btn primary" data-action="watch-live" data-session-id="${d(e.sessionId)}">Watch Live</button>
        <button class="action-btn" data-action="share" data-session-id="${d(e.sessionId)}">Share</button>
      </div>
    </div>
  `}function R(e){var s;const t=r===e.sessionId;return(e.segments||0)>0,`
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
        <span class="feed-row-device">${d(((s=e.device)==null?void 0:s.deviceName)||"Unknown")}</span>
        <span class="feed-row-meta">${b(e.durationMs||0)} &middot; ${e.segments||0} segments</span>
      </div>
      <span class="feed-row-time">${x(e.startedAt)}</span>
    </div>
    <div class="feed-expanded${t?" open":""}" data-expanded-id="${d(e.sessionId)}">
      ${t?L(e):""}
    </div>
  `}function L(e){var s;const t=(e.segments||0)>0;return`<div class="feed-expanded-inner" id="feed-expanded-${d(e.sessionId)}">
    ${t?`<div class="feed-video-wrap">
      <video class="feed-inline-video" controls preload="metadata">
        <source src="/session/${d(e.sessionId)}/video.mp4" type="video/mp4" />
      </video>
    </div>`:""}
    <div class="feed-expanded-details" id="feed-details-${d(e.sessionId)}">
      <div class="feed-detail-rows">
        <div class="feed-detail-row"><span class="feed-detail-label">Session</span><span class="feed-detail-value">${d(e.sessionId.slice(0,12))}</span></div>
        <div class="feed-detail-row"><span class="feed-detail-label">Duration</span><span class="feed-detail-value">${b(e.durationMs||0)}</span></div>
        <div class="feed-detail-row"><span class="feed-detail-label">Segments</span><span class="feed-detail-value">${e.segments||0}</span></div>
        <div class="feed-detail-row"><span class="feed-detail-label">Device</span><span class="feed-detail-value">${d(((s=e.device)==null?void 0:s.deviceName)||"Unknown")}</span></div>
        <div class="feed-detail-row"><span class="feed-detail-label">Started</span><span class="feed-detail-value">${x(e.startedAt)}</span></div>
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
  </div>`}async function C(e,t){if(r&&r!==t&&D(r),r===t){D(t),r=null;return}r=t;const s=e.querySelector(`[data-expanded-id="${t}"]`),a=e.querySelector(`.feed-row[data-session-id="${t}"]`);if(a&&a.classList.add("expanded"),s){s.classList.add("open");const i=f.find(l=>l.sessionId===t);i&&(s.innerHTML=L(i)),j(t)}}function D(e){const t=document.querySelector(`[data-expanded-id="${e}"]`),s=document.querySelector(`.feed-row[data-session-id="${e}"]`);if(s&&s.classList.remove("expanded"),t){t.classList.remove("open");const a=t.querySelector("video");a&&a.pause(),t.innerHTML=""}}async function j(e){const t=document.getElementById(`feed-guidance-${e}`);if(!t)return;const s=await E(e);if(!s||s.length===0){t.innerHTML='<p class="empty-state">No guidance events for this session</p>';return}t.innerHTML=s.slice(0,30).map(a=>`
    <div class="feed-guidance-item">
      <span class="feed-guidance-type" data-type="${d(a.type)}">${d(a.type.replace("guidance.","").toUpperCase())}</span>
      <span class="feed-guidance-text">${d(a.content)}</span>
      <span class="feed-guidance-conf">${Math.round(a.confidence*100)}%</span>
    </div>
  `).join("")}function B(e){e.addEventListener("click",t=>{const s=t.target.closest("[data-action]");if(!s)return;t.stopPropagation();const a=s.dataset.action,i=s.dataset.sessionId;if(!(!a||!i))switch(a){case"watch-live":M(i);break;case"play-overlay":T(i);break;case"share":{const l=window.openShareDialog;l&&l(i);break}}})}function N(e){const t=e.querySelector("#feeds-bucket-filters");t&&t.addEventListener("click",s=>{const a=s.target.closest(".filter-pill");a&&(t.querySelectorAll(".filter-pill").forEach(i=>i.classList.remove("active")),a.classList.add("active"),w=a.dataset.bucket||"all",y(e,f))})}function U(e){const t={};for(const s of e){const a=s.startedAt?s.startedAt.slice(0,10):"unknown";t[a]||(t[a]=[]),t[a].push(s)}return t}function F(e){if(e==="unknown")return"Unknown date";try{const t=new Date(e+"T00:00:00"),s=new Date;if(t.toDateString()===s.toDateString())return"Today";const a=new Date(s);return a.setDate(a.getDate()-1),t.toDateString()===a.toDateString()?"Yesterday":t.toLocaleDateString([],{weekday:"long",month:"short",day:"numeric"})}catch{return e}}function x(e){if(!e)return"--";try{return new Date(e).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}catch{return"--"}}export{V as default,V as page};
