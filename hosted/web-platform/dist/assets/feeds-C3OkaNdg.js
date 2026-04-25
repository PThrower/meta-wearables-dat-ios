import{b as k,o as A,w as T,j as p,e as n,k as I,l as E}from"./main-Dlh06tj_.js";import"./modulepreload-polyfill-B5Qt9EMX.js";const V={init(e){e.innerHTML=`
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
    `,H(e),N(e),B(e)},destroy(){$&&(clearInterval($),$=null)}};let $=null,g=[],y="all",v=null;async function H(e){const a=await k();g=a,S(e,a),D(e,a),$||($=setInterval(async()=>{g=await k(),S(e,g),D(e,g)},3e4))}function S(e,a){const s=e.querySelector("#feeds-stats");if(!s)return;const t=a.filter(l=>!l.live),i=t.reduce((l,c)=>l+(c.videoDurationMs||c.durationMs||0),0);t.reduce((l,c)=>l+(c.durationMs||0),0);const o=a.filter(l=>l.live).length,u=t.reduce((l,c)=>l+(c.segments||0),0);s.innerHTML=`
    <div class="stat-card"><span class="stat-value">${t.length}</span><span class="stat-label">Recordings</span></div>
    <div class="stat-card"><span class="stat-value">${p(i)}</span><span class="stat-label">Content</span></div>
    <div class="stat-card"><span class="stat-value stat-live">${o}</span><span class="stat-label">Live Now</span></div>
    <div class="stat-card"><span class="stat-value">${u}</span><span class="stat-label">Segments</span></div>
  `}function D(e,a){const s=e.querySelector("#feeds-list"),t=a.filter(d=>d.live);let i=a.filter(d=>!d.live);const o=new Date,u=new Date(o.getFullYear(),o.getMonth(),o.getDate()),l=new Date(u);l.setDate(l.getDate()-l.getDay());const c=new Date(o.getFullYear(),o.getMonth(),1);y==="today"?i=i.filter(d=>d.startedAt&&new Date(d.startedAt)>=u):y==="week"?i=i.filter(d=>d.startedAt&&new Date(d.startedAt)>=l):y==="month"&&(i=i.filter(d=>d.startedAt&&new Date(d.startedAt)>=c)),i.sort((d,r)=>{const w=d.startedAt?new Date(d.startedAt).getTime():0;return(r.startedAt?new Date(r.startedAt).getTime():0)-w});const f=t.length+i.length,m=e.querySelector("#feeds-subtitle");if(m&&(m.textContent=`${f} session${f!==1?"s":""}`),f===0){s.innerHTML=`<div class="empty-state-large">
      <p>No sessions found</p>
      <span class="empty-hint">Sessions will appear here after streaming</span>
    </div>`;return}let b="";t.length>0&&(b+=`
      <div class="feed-bucket feed-bucket-live">
        <div class="feed-bucket-header">
          <span class="feed-bucket-date">
            <span class="status-pill status-live" style="margin-right:6px">LIVE</span>
            Active Streams
          </span>
          <span class="feed-bucket-count">${t.length} live</span>
        </div>
        <div class="feed-bucket-rows">
          ${t.map(d=>q(d)).join("")}
        </div>
      </div>
    `);const h=U(i);b+=Object.entries(h).sort(([d],[r])=>r.localeCompare(d)).map(([d,r])=>`
      <div class="feed-bucket">
        <div class="feed-bucket-header">
          <span class="feed-bucket-date">${F(d)}</span>
          <span class="feed-bucket-count">${r.length} session${r.length!==1?"s":""}</span>
        </div>
        <div class="feed-bucket-rows">
          ${r.map(w=>C(w)).join("")}
        </div>
      </div>
    `).join(""),s.innerHTML=b,s.querySelectorAll(".feed-row").forEach(d=>{d.addEventListener("click",r=>{if(r.target.closest(".feed-expanded")||r.target.closest("[data-action]"))return;const w=d.dataset.sessionId;w&&R(e,w)})})}function q(e){var a,s;return`
    <div class="feed-row feed-row-live" data-session-id="${n(e.sessionId)}">
      <div class="feed-row-expand-icon feed-row-live-dot">
        <span class="status-pill status-live">LIVE</span>
      </div>
      <div class="feed-row-thumb">
        <div class="feed-row-placeholder feed-row-placeholder-live"></div>
      </div>
      <div class="feed-row-info">
        <span class="feed-row-device">${n(((a=e.device)==null?void 0:a.deviceName)||"Unknown")}${(s=e.wearable)!=null&&s.wearableType?` + ${n(e.wearable.wearableType)}`:""}</span>
        <span class="feed-row-meta">Live &middot; ${p(e.durationMs||0)}</span>
      </div>
      <div class="feed-row-actions">
        <button class="action-btn primary" data-action="watch-live" data-session-id="${n(e.sessionId)}">Watch Live</button>
        <button class="action-btn" data-action="share" data-session-id="${n(e.sessionId)}">Share</button>
      </div>
    </div>
  `}function C(e){var o;const a=v===e.sessionId,s=e.videoDurationMs||e.durationMs||0,t=Math.abs(e.driftMs||0),i=t>2e3?` ±${p(t)}`:"";return`
    <div class="feed-row${a?" expanded":""}" data-session-id="${n(e.sessionId)}">
      <div class="feed-row-expand-icon">
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </div>
      <div class="feed-row-thumb">
        ${e.hasThumbnail?`<img src="/session/${n(e.sessionId)}/thumbnail" alt="" loading="lazy" onerror="this.style.display='none'" />`:'<div class="feed-row-placeholder"></div>'}
      </div>
      <div class="feed-row-info">
        <span class="feed-row-device">${n(((o=e.device)==null?void 0:o.deviceName)||"Unknown")}</span>
        <span class="feed-row-meta">${p(s)}${i} &middot; ${e.segments||0} segs</span>
      </div>
      <span class="feed-row-time">${x(e.startedAt)}</span>
    </div>
    <div class="feed-expanded${a?" open":""}" data-expanded-id="${n(e.sessionId)}">
      ${a?L(e):""}
    </div>
  `}function L(e){var m,b,h;const a=(e.segments||0)>0,s=e.videoDurationMs||e.durationMs||0,t=e.driftMs||0,i=Math.abs(t),o=i>2e3;let u="";if(o){const d=t>0?"audio longer":"video longer";u=`<div class="feed-detail-row"><span class="feed-detail-label">A/V Drift</span><span class="feed-detail-value" style="color:#ffb86c">${p(i)} (${d})</span></div>`}let l="";const c=e.framesRelayed,f=e.framesRecorded;if(c!=null&&f!=null){const d=Math.abs(c-f);if(d>0){const r=c>f?"more streamed":"more recorded";l=`<div class="feed-detail-row"><span class="feed-detail-label">Stream Drift</span><span class="feed-detail-value" style="color:#bd93f9">${d} frames (${r}) &middot; ${c} relayed / ${f} recorded</span></div>`}else l=`<div class="feed-detail-row"><span class="feed-detail-label">Stream Drift</span><span class="feed-detail-value" style="color:#50fa7b">0 (perfect match: ${f} frames)</span></div>`}return`<div class="feed-expanded-inner" id="feed-expanded-${n(e.sessionId)}">
    ${a?`<div class="feed-video-wrap">
      <video class="feed-inline-video" controls preload="metadata">
        <source src="/session/${n(e.sessionId)}/video.mp4?audio" type="video/mp4" />
      </video>
    </div>`:""}
    <div class="feed-expanded-details" id="feed-details-${n(e.sessionId)}">
      <div class="feed-detail-rows">
        <div class="feed-detail-row"><span class="feed-detail-label">Session</span><span class="feed-detail-value">${n(e.sessionId.slice(0,12))}</span></div>
        <div class="feed-detail-row"><span class="feed-detail-label">Duration</span><span class="feed-detail-value">${p(s)}${s!==(e.durationMs||0)?` <span style="color:#6272a4">(wall ${p(e.durationMs||0)})</span>`:""}</span></div>
        ${e.audioDurationMs?`<div class="feed-detail-row"><span class="feed-detail-label">Audio</span><span class="feed-detail-value">${p(e.audioDurationMs)}</span></div>`:""}
        ${u}
        ${l}
        <div class="feed-detail-row"><span class="feed-detail-label">Segments</span><span class="feed-detail-value">${e.segments||0}</span></div>
        <div class="feed-detail-row"><span class="feed-detail-label">Device</span><span class="feed-detail-value">${n(((m=e.device)==null?void 0:m.deviceName)||"Unknown")}${(b=e.device)!=null&&b.deviceModel?` (${n(e.device.deviceModel)})`:""}</span></div>
        ${(h=e.wearable)!=null&&h.wearableType?`<div class="feed-detail-row"><span class="feed-detail-label">Camera</span><span class="feed-detail-value">${n(e.wearable.wearableType)}${e.wearable.wearableId?` &middot; ${n(e.wearable.wearableId.slice(0,8))}`:""}</span></div>`:""}
        <div class="feed-detail-row"><span class="feed-detail-label">Started</span><span class="feed-detail-value">${x(e.startedAt)}</span></div>
        <div class="feed-detail-row"><span class="feed-detail-label">Access</span><span class="feed-detail-value">${n(e.access||"private")}</span></div>
      </div>
      <div class="feed-expanded-actions">
        ${a?`<a class="action-btn" href="${I("/session/"+e.sessionId+"/video.mp4?audio")}" target="_blank" rel="noopener">Download MP4</a>
        <button class="action-btn" data-action="play-overlay" data-session-id="${n(e.sessionId)}">Open in Player</button>`:""}
        <button class="action-btn" data-action="share" data-session-id="${n(e.sessionId)}">Share</button>
      </div>
      <div class="feed-guidance-section">
        <h4 class="section-title">Guidance Events</h4>
        <div class="feed-guidance-log" id="feed-guidance-${n(e.sessionId)}">
          <p class="empty-state">Loading...</p>
        </div>
      </div>
    </div>
  </div>`}async function R(e,a){if(v&&v!==a&&M(v),v===a){M(a),v=null;return}v=a;const s=e.querySelector(`[data-expanded-id="${a}"]`),t=e.querySelector(`.feed-row[data-session-id="${a}"]`);if(t&&t.classList.add("expanded"),s){s.classList.add("open");const i=g.find(o=>o.sessionId===a);i&&(s.innerHTML=L(i)),j(a)}}function M(e){const a=document.querySelector(`[data-expanded-id="${e}"]`),s=document.querySelector(`.feed-row[data-session-id="${e}"]`);if(s&&s.classList.remove("expanded"),a){a.classList.remove("open");const t=a.querySelector("video");t&&t.pause(),a.innerHTML=""}}async function j(e){const a=document.getElementById(`feed-guidance-${e}`);if(!a)return;const s=await E(e);if(!s||s.length===0){a.innerHTML='<p class="empty-state">No guidance events for this session</p>';return}a.innerHTML=s.slice(0,30).map(t=>`
    <div class="feed-guidance-item">
      <span class="feed-guidance-type" data-type="${n(t.type)}">${n(t.type.replace("guidance.","").toUpperCase())}</span>
      <span class="feed-guidance-text">${n(t.content)}</span>
      <span class="feed-guidance-conf">${Math.round(t.confidence*100)}%</span>
    </div>
  `).join("")}function B(e){e.addEventListener("click",a=>{const s=a.target.closest("[data-action]");if(!s)return;a.stopPropagation();const t=s.dataset.action,i=s.dataset.sessionId;if(!(!t||!i))switch(t){case"watch-live":T(i);break;case"play-overlay":A(i);break;case"share":{const o=window.openShareDialog;o&&o(i);break}}})}function N(e){const a=e.querySelector("#feeds-bucket-filters");a&&a.addEventListener("click",s=>{const t=s.target.closest(".filter-pill");t&&(a.querySelectorAll(".filter-pill").forEach(i=>i.classList.remove("active")),t.classList.add("active"),y=t.dataset.bucket||"all",D(e,g))})}function U(e){const a={};for(const s of e){const t=s.startedAt?s.startedAt.slice(0,10):"unknown";a[t]||(a[t]=[]),a[t].push(s)}return a}function F(e){if(e==="unknown")return"Unknown date";try{const a=new Date(e+"T00:00:00"),s=new Date;if(a.toDateString()===s.toDateString())return"Today";const t=new Date(s);return t.setDate(t.getDate()-1),a.toDateString()===t.toDateString()?"Yesterday":a.toLocaleDateString([],{weekday:"long",month:"short",day:"numeric"})}catch{return e}}function x(e){if(!e)return"--";try{return new Date(e).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}catch{return"--"}}export{V as default,V as page};
