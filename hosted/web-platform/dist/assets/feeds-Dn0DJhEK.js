import{b as k,o as A,w as T,h as u,e as i,i as I,j as E}from"./main-Cc8g3gSL.js";import"./modulepreload-polyfill-B5Qt9EMX.js";const V={init(e){e.innerHTML=`
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
    `,H(e),N(e),B(e)},destroy(){h&&(clearInterval(h),h=null)}};let h=null,g=[],$="all",b=null;async function H(e){const t=await k();g=t,S(e,t),D(e,t),h||(h=setInterval(async()=>{g=await k(),S(e,g),D(e,g)},3e4))}function S(e,t){const a=e.querySelector("#feeds-stats");if(!a)return;const s=t.filter(l=>!l.live),n=s.reduce((l,c)=>l+(c.videoDurationMs||c.durationMs||0),0);s.reduce((l,c)=>l+(c.durationMs||0),0);const o=t.filter(l=>l.live).length,v=s.reduce((l,c)=>l+(c.segments||0),0);a.innerHTML=`
    <div class="stat-card"><span class="stat-value">${s.length}</span><span class="stat-label">Recordings</span></div>
    <div class="stat-card"><span class="stat-value">${u(n)}</span><span class="stat-label">Content</span></div>
    <div class="stat-card"><span class="stat-value stat-live">${o}</span><span class="stat-label">Live Now</span></div>
    <div class="stat-card"><span class="stat-value">${v}</span><span class="stat-label">Segments</span></div>
  `}function D(e,t){const a=e.querySelector("#feeds-list"),s=t.filter(d=>d.live);let n=t.filter(d=>!d.live);const o=new Date,v=new Date(o.getFullYear(),o.getMonth(),o.getDate()),l=new Date(v);l.setDate(l.getDate()-l.getDay());const c=new Date(o.getFullYear(),o.getMonth(),1);$==="today"?n=n.filter(d=>d.startedAt&&new Date(d.startedAt)>=v):$==="week"?n=n.filter(d=>d.startedAt&&new Date(d.startedAt)>=l):$==="month"&&(n=n.filter(d=>d.startedAt&&new Date(d.startedAt)>=c)),n.sort((d,r)=>{const w=d.startedAt?new Date(d.startedAt).getTime():0;return(r.startedAt?new Date(r.startedAt).getTime():0)-w});const f=s.length+n.length,m=e.querySelector("#feeds-subtitle");if(m&&(m.textContent=`${f} session${f!==1?"s":""}`),f===0){a.innerHTML=`<div class="empty-state-large">
      <p>No sessions found</p>
      <span class="empty-hint">Sessions will appear here after streaming</span>
    </div>`;return}let p="";s.length>0&&(p+=`
      <div class="feed-bucket feed-bucket-live">
        <div class="feed-bucket-header">
          <span class="feed-bucket-date">
            <span class="status-pill status-live" style="margin-right:6px">LIVE</span>
            Active Streams
          </span>
          <span class="feed-bucket-count">${s.length} live</span>
        </div>
        <div class="feed-bucket-rows">
          ${s.map(d=>q(d)).join("")}
        </div>
      </div>
    `);const y=U(n);p+=Object.entries(y).sort(([d],[r])=>r.localeCompare(d)).map(([d,r])=>`
      <div class="feed-bucket">
        <div class="feed-bucket-header">
          <span class="feed-bucket-date">${F(d)}</span>
          <span class="feed-bucket-count">${r.length} session${r.length!==1?"s":""}</span>
        </div>
        <div class="feed-bucket-rows">
          ${r.map(w=>C(w)).join("")}
        </div>
      </div>
    `).join(""),a.innerHTML=p,a.querySelectorAll(".feed-row").forEach(d=>{d.addEventListener("click",r=>{if(r.target.closest(".feed-expanded")||r.target.closest("[data-action]"))return;const w=d.dataset.sessionId;w&&R(e,w)})})}function q(e){var t;return`
    <div class="feed-row feed-row-live" data-session-id="${i(e.sessionId)}">
      <div class="feed-row-expand-icon feed-row-live-dot">
        <span class="status-pill status-live">LIVE</span>
      </div>
      <div class="feed-row-thumb">
        <div class="feed-row-placeholder feed-row-placeholder-live"></div>
      </div>
      <div class="feed-row-info">
        <span class="feed-row-device">${i(((t=e.device)==null?void 0:t.deviceName)||"Unknown")}</span>
        <span class="feed-row-meta">Live &middot; ${u(e.durationMs||0)}</span>
      </div>
      <div class="feed-row-actions">
        <button class="action-btn primary" data-action="watch-live" data-session-id="${i(e.sessionId)}">Watch Live</button>
        <button class="action-btn" data-action="share" data-session-id="${i(e.sessionId)}">Share</button>
      </div>
    </div>
  `}function C(e){var o;const t=b===e.sessionId,a=e.videoDurationMs||e.durationMs||0,s=Math.abs(e.driftMs||0),n=s>2e3?` ±${u(s)}`:"";return`
    <div class="feed-row${t?" expanded":""}" data-session-id="${i(e.sessionId)}">
      <div class="feed-row-expand-icon">
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </div>
      <div class="feed-row-thumb">
        ${e.hasThumbnail?`<img src="/session/${i(e.sessionId)}/thumbnail" alt="" loading="lazy" onerror="this.style.display='none'" />`:'<div class="feed-row-placeholder"></div>'}
      </div>
      <div class="feed-row-info">
        <span class="feed-row-device">${i(((o=e.device)==null?void 0:o.deviceName)||"Unknown")}</span>
        <span class="feed-row-meta">${u(a)}${n} &middot; ${e.segments||0} segs</span>
      </div>
      <span class="feed-row-time">${x(e.startedAt)}</span>
    </div>
    <div class="feed-expanded${t?" open":""}" data-expanded-id="${i(e.sessionId)}">
      ${t?L(e):""}
    </div>
  `}function L(e){var m;const t=(e.segments||0)>0,a=e.videoDurationMs||e.durationMs||0,s=e.driftMs||0,n=Math.abs(s),o=n>2e3;let v="";if(o){const p=s>0?"audio longer":"video longer";v=`<div class="feed-detail-row"><span class="feed-detail-label">A/V Drift</span><span class="feed-detail-value" style="color:#ffb86c">${u(n)} (${p})</span></div>`}let l="";const c=e.framesRelayed,f=e.framesRecorded;if(c!=null&&f!=null){const p=Math.abs(c-f);if(p>0){const y=c>f?"more streamed":"more recorded";l=`<div class="feed-detail-row"><span class="feed-detail-label">Stream Drift</span><span class="feed-detail-value" style="color:#bd93f9">${p} frames (${y}) &middot; ${c} relayed / ${f} recorded</span></div>`}else l=`<div class="feed-detail-row"><span class="feed-detail-label">Stream Drift</span><span class="feed-detail-value" style="color:#50fa7b">0 (perfect match: ${f} frames)</span></div>`}return`<div class="feed-expanded-inner" id="feed-expanded-${i(e.sessionId)}">
    ${t?`<div class="feed-video-wrap">
      <video class="feed-inline-video" controls preload="metadata">
        <source src="/session/${i(e.sessionId)}/video.mp4" type="video/mp4" />
      </video>
    </div>`:""}
    <div class="feed-expanded-details" id="feed-details-${i(e.sessionId)}">
      <div class="feed-detail-rows">
        <div class="feed-detail-row"><span class="feed-detail-label">Session</span><span class="feed-detail-value">${i(e.sessionId.slice(0,12))}</span></div>
        <div class="feed-detail-row"><span class="feed-detail-label">Duration</span><span class="feed-detail-value">${u(a)}${a!==(e.durationMs||0)?` <span style="color:#6272a4">(wall ${u(e.durationMs||0)})</span>`:""}</span></div>
        ${e.audioDurationMs?`<div class="feed-detail-row"><span class="feed-detail-label">Audio</span><span class="feed-detail-value">${u(e.audioDurationMs)}</span></div>`:""}
        ${v}
        ${l}
        <div class="feed-detail-row"><span class="feed-detail-label">Segments</span><span class="feed-detail-value">${e.segments||0}</span></div>
        <div class="feed-detail-row"><span class="feed-detail-label">Device</span><span class="feed-detail-value">${i(((m=e.device)==null?void 0:m.deviceName)||"Unknown")}</span></div>
        <div class="feed-detail-row"><span class="feed-detail-label">Started</span><span class="feed-detail-value">${x(e.startedAt)}</span></div>
        <div class="feed-detail-row"><span class="feed-detail-label">Access</span><span class="feed-detail-value">${i(e.access||"private")}</span></div>
      </div>
      <div class="feed-expanded-actions">
        ${t?`<a class="action-btn" href="${I("/session/"+e.sessionId+"/video.mp4")}" target="_blank" rel="noopener">Download MP4</a>
        <button class="action-btn" data-action="play-overlay" data-session-id="${i(e.sessionId)}">Open in Player</button>`:""}
        <button class="action-btn" data-action="share" data-session-id="${i(e.sessionId)}">Share</button>
      </div>
      <div class="feed-guidance-section">
        <h4 class="section-title">Guidance Events</h4>
        <div class="feed-guidance-log" id="feed-guidance-${i(e.sessionId)}">
          <p class="empty-state">Loading...</p>
        </div>
      </div>
    </div>
  </div>`}async function R(e,t){if(b&&b!==t&&M(b),b===t){M(t),b=null;return}b=t;const a=e.querySelector(`[data-expanded-id="${t}"]`),s=e.querySelector(`.feed-row[data-session-id="${t}"]`);if(s&&s.classList.add("expanded"),a){a.classList.add("open");const n=g.find(o=>o.sessionId===t);n&&(a.innerHTML=L(n)),j(t)}}function M(e){const t=document.querySelector(`[data-expanded-id="${e}"]`),a=document.querySelector(`.feed-row[data-session-id="${e}"]`);if(a&&a.classList.remove("expanded"),t){t.classList.remove("open");const s=t.querySelector("video");s&&s.pause(),t.innerHTML=""}}async function j(e){const t=document.getElementById(`feed-guidance-${e}`);if(!t)return;const a=await E(e);if(!a||a.length===0){t.innerHTML='<p class="empty-state">No guidance events for this session</p>';return}t.innerHTML=a.slice(0,30).map(s=>`
    <div class="feed-guidance-item">
      <span class="feed-guidance-type" data-type="${i(s.type)}">${i(s.type.replace("guidance.","").toUpperCase())}</span>
      <span class="feed-guidance-text">${i(s.content)}</span>
      <span class="feed-guidance-conf">${Math.round(s.confidence*100)}%</span>
    </div>
  `).join("")}function B(e){e.addEventListener("click",t=>{const a=t.target.closest("[data-action]");if(!a)return;t.stopPropagation();const s=a.dataset.action,n=a.dataset.sessionId;if(!(!s||!n))switch(s){case"watch-live":T(n);break;case"play-overlay":A(n);break;case"share":{const o=window.openShareDialog;o&&o(n);break}}})}function N(e){const t=e.querySelector("#feeds-bucket-filters");t&&t.addEventListener("click",a=>{const s=a.target.closest(".filter-pill");s&&(t.querySelectorAll(".filter-pill").forEach(n=>n.classList.remove("active")),s.classList.add("active"),$=s.dataset.bucket||"all",D(e,g))})}function U(e){const t={};for(const a of e){const s=a.startedAt?a.startedAt.slice(0,10):"unknown";t[s]||(t[s]=[]),t[s].push(a)}return t}function F(e){if(e==="unknown")return"Unknown date";try{const t=new Date(e+"T00:00:00"),a=new Date;if(t.toDateString()===a.toDateString())return"Today";const s=new Date(a);return s.setDate(s.getDate()-1),t.toDateString()===s.toDateString()?"Yesterday":t.toLocaleDateString([],{weekday:"long",month:"short",day:"numeric"})}catch{return e}}function x(e){if(!e)return"--";try{return new Date(e).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}catch{return"--"}}export{V as default,V as page};
