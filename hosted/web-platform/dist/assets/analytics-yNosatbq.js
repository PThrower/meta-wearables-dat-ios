import{f as V,b as H,k as W,h as O,e as U,l as K}from"./main-R9T4tZoC.js";import"./modulepreload-polyfill-B5Qt9EMX.js";const Y={width:600,height:200,color:"#4ade80",fillOpacity:.1,strokeWidth:2,showDots:!0,showGrid:!0,gridLines:4,formatLabel:t=>t,formatValue:t=>String(t)};function Z(t,e,s={}){const l={...Y,...s},{width:o,height:r,color:a,fillOpacity:c,strokeWidth:f,showDots:m,showGrid:v,gridLines:g}=l;if(e.length===0){t.innerHTML='<p class="empty-state">No data</p>';return}const h={top:10,right:20,bottom:30,left:40},k=o-h.left-h.right,y=r-h.top-h.bottom,x=e.map(n=>n.value),$=Math.min(...x,0),A=Math.max(...x,1),L=A-$||1,d=n=>h.left+n/Math.max(e.length-1,1)*k,u=n=>h.top+y-(n-$)/L*y;let b="";if(v)for(let n=0;n<=g;n++){const i=h.top+n/g*y,p=A-n/g*L;b+=`<line x1="${h.left}" y1="${i}" x2="${o-h.right}" y2="${i}" stroke="rgba(255,255,255,0.06)" />`,b+=`<text x="${h.left-6}" y="${i+3}" text-anchor="end" fill="rgba(255,255,255,0.3)" font-size="10" font-family="SF Mono, Menlo, monospace">${l.formatValue(p)}</text>`}const E=Math.max(1,Math.floor(e.length/8));let C="";for(let n=0;n<e.length;n++)(n%E===0||n===e.length-1)&&(C+=`<text x="${d(n)}" y="${r-6}" text-anchor="middle" fill="rgba(255,255,255,0.3)" font-size="10" font-family="SF Mono, Menlo, monospace">${l.formatLabel(e[n].label)}</text>`);const N=e.map((n,i)=>`${i===0?"M":"L"}${d(i)},${u(n.value)}`).join(" "),j=N+` L${d(e.length-1)},${u($)} L${d(0)},${u($)} Z`;let q="";m&&(q=e.map((n,i)=>`<circle cx="${d(i)}" cy="${u(n.value)}" r="3" fill="${a}" stroke="#0a0a0a" stroke-width="1.5" class="chart-dot" data-value="${n.value}" data-label="${n.label}" />`).join(""));const z=`
    <svg viewBox="0 0 ${o} ${r}" width="100%" height="100%" preserveAspectRatio="xMidYMid meet" class="line-chart-svg">
      ${b}
      <path d="${j}" fill="${a}" fill-opacity="${c}" />
      <path d="${N}" fill="none" stroke="${a}" stroke-width="${f}" stroke-linejoin="round" stroke-linecap="round" />
      ${q}
      ${C}
    </svg>
  `;t.innerHTML=z;const D=t.querySelector("svg");if(D&&m){const n=D.querySelectorAll(".chart-dot");let i=null;n.forEach(p=>{p.addEventListener("mouseenter",()=>{const F=p.dataset.value,I=p.dataset.label;if(!F||!I)return;const G=Number(p.getAttribute("cx")),R=Number(p.getAttribute("cy"));i=document.createElementNS("http://www.w3.org/2000/svg","text"),i.setAttribute("x",String(G)),i.setAttribute("y",String(R-10)),i.setAttribute("text-anchor","middle"),i.setAttribute("fill","#fff"),i.setAttribute("font-size","11"),i.setAttribute("font-family","SF Mono, Menlo, monospace"),i.textContent=`${l.formatLabel(I)}: ${l.formatValue(Number(F))}`,D.appendChild(i)}),p.addEventListener("mouseleave",()=>{i&&(i.remove(),i=null)})})}}const J={width:240,height:240,radius:80,thickness:24,centerLabel:"",centerValue:""};function Q(t,e,s={}){const l={...J,...s},{width:o,height:r,radius:a,thickness:c,centerLabel:f,centerValue:m}=l;if(e.length===0){t.innerHTML='<p class="empty-state">No data</p>';return}const v=o/2,g=r/2,h=e.reduce((d,u)=>d+u.value,0)||1,k=2*Math.PI*a;let y="",x="",$=0;for(const d of e){const u=d.value/h,b=u*k,E=k-b;y+=`<circle
      cx="${v}" cy="${g}" r="${a}"
      fill="none"
      stroke="${d.color}"
      stroke-width="${c}"
      stroke-dasharray="${b} ${E}"
      stroke-dashoffset="${-$}"
      transform="rotate(-90 ${v} ${g})"
      class="donut-slice"
      data-label="${d.label}"
      data-value="${d.value}"
      data-pct="${Math.round(u*100)}"
    />`,$+=b,x+=`
      <div class="donut-legend-item">
        <span class="donut-legend-dot" style="background:${d.color}"></span>
        <span class="donut-legend-label">${d.label}</span>
        <span class="donut-legend-value">${d.value}</span>
        <span class="donut-legend-pct">${Math.round(u*100)}%</span>
      </div>
    `}const A=`
    <div class="donut-chart-wrap">
      <svg viewBox="0 0 ${o} ${r}" width="${Math.min(o,200)}" height="${Math.min(r,200)}" class="donut-chart-svg">
        <!-- Background ring -->
        <circle cx="${v}" cy="${g}" r="${a}" fill="none" stroke="rgba(255,255,255,0.04)" stroke-width="${c}" />
        ${y}
        ${m?`<text x="${v}" y="${g-6}" text-anchor="middle" fill="#fff" font-size="20" font-weight="700" font-family="SF Mono, Menlo, monospace">${m}</text>`:""}
        ${f?`<text x="${v}" y="${g+14}" text-anchor="middle" fill="rgba(255,255,255,0.4)" font-size="10" font-family="SF Mono, Menlo, monospace">${f}</text>`:""}
      </svg>
      <div class="donut-legend">${x}</div>
    </div>
  `;t.innerHTML=A;const L=t.querySelector("svg");L&&L.querySelectorAll(".donut-slice").forEach(u=>{u.addEventListener("mouseenter",()=>{u.setAttribute("stroke-width",String(c+4))}),u.addEventListener("mouseleave",()=>{u.setAttribute("stroke-width",String(c))})})}const st={init(t){t.innerHTML=`
      <div class="page analytics-page">
        <div class="page-header">
          <h1 class="page-title">Analytics</h1>
          <span class="page-subtitle">Platform metrics</span>
        </div>
        <div class="analytics-kpis" id="analytics-kpis">
          <div class="stat-card"><span class="stat-value" id="an-sessions">--</span><span class="stat-label">Total Sessions</span></div>
          <div class="stat-card"><span class="stat-value" id="an-duration">--</span><span class="stat-label">Avg Duration</span></div>
          <div class="stat-card"><span class="stat-value" id="an-recordings">--</span><span class="stat-label">Recordings</span></div>
          <div class="stat-card"><span class="stat-value" id="an-bandwidth">--</span><span class="stat-label">Bandwidth</span></div>
        </div>
        <div class="analytics-grid">
          <section class="analytics-section">
            <h2 class="section-title">Sessions Over Time</h2>
            <div id="an-chart" class="analytics-chart"></div>
          </section>
          <section class="analytics-section">
            <h2 class="section-title">Session Types</h2>
            <div id="an-donut" class="analytics-donut"></div>
          </section>
        </div>
        <section class="analytics-section" style="margin-top:16px">
          <h2 class="section-title">Session Performance</h2>
          <div id="an-table" class="analytics-table-wrap">
            <p class="empty-state">Loading...</p>
          </div>
        </section>
      </div>
    `,w="date",S="desc",X(t)},destroy(){M&&(clearInterval(M),M=null)}};let M=null,w="date",S="desc";async function X(t){const[e,s]=await Promise.all([V(),H()]);P(t,e,s),_(t,s),B(t,s),T(t,s),M||(M=setInterval(async()=>{const[l,o]=await Promise.all([V(),H()]);P(t,l,o),_(t,o),B(t,o),T(t,o)},3e4))}function P(t,e,s){const l=t.querySelector("#an-sessions"),o=t.querySelector("#an-duration"),r=t.querySelector("#an-recordings"),a=t.querySelector("#an-bandwidth");e&&(l&&(l.textContent=String(e.totalSessions??e.total_sessions??s.length)),a&&(a.textContent=W(e.totalBytesSent??e.bytes_sent??0)));const c=s.filter(f=>!f.live);if(r&&(r.textContent=String(c.length)),c.length>0&&o){const f=c.reduce((m,v)=>m+(v.durationMs||0),0)/c.length;o.textContent=O(f)}}function _(t,e){const s=t.querySelector("#an-chart");if(!s)return;const l={};for(const a of e){if(!a.startedAt)continue;const c=a.startedAt.slice(0,10);l[c]=(l[c]||0)+1}const r=Object.entries(l).sort(([a],[c])=>a.localeCompare(c)).map(([a,c])=>({label:a,value:c}));Z(s,r,{color:"#4ade80",height:200,formatLabel:a=>{try{return new Date(a+"T00:00:00").toLocaleDateString([],{month:"short",day:"numeric"})}catch{return a}},formatValue:a=>String(a)})}function B(t,e){const s=t.querySelector("#an-donut");if(!s)return;const l=e.filter(r=>r.live).length,o=e.filter(r=>!r.live).length;Q(s,[{label:"Recorded",value:o,color:"#60a5fa"},{label:"Live (active)",value:l,color:"#4ade80"}],{centerValue:String(e.length),centerLabel:"Sessions"})}function T(t,e){const s=t.querySelector("#an-table"),o=tt(e).slice(0,50);if(o.length===0){s.innerHTML='<p class="empty-state">No session data</p>';return}const r=a=>w===a?S==="asc"?" ↑":" ↓":"";s.innerHTML=`
    <div class="table-scroll">
      <table class="data-table sortable">
        <thead><tr>
          <th class="sortable-col" data-sort="device">Device${r("device")}</th>
          <th class="sortable-col" data-sort="duration">Duration${r("duration")}</th>
          <th class="sortable-col" data-sort="date">Date${r("date")}</th>
          <th class="sortable-col" data-sort="status">Status${r("status")}</th>
        </tr></thead>
        <tbody>${o.map(a=>{var c,f;return`
          <tr>
            <td>${U(((c=a.device)==null?void 0:c.deviceName)||((f=a.sessionId)==null?void 0:f.slice(0,8))||"--")}</td>
            <td>${O(a.durationMs||0)}</td>
            <td>${K(a.startedAt)}</td>
            <td><span class="status-pill ${a.live?"status-live":"status-recorded"}">${a.live?"Live":"Recorded"}</span></td>
          </tr>
        `}).join("")}</tbody>
      </table>
    </div>
  `,s.querySelectorAll(".sortable-col").forEach(a=>{a.addEventListener("click",()=>{const c=a.dataset.sort;w===c?S=S==="asc"?"desc":"asc":(w=c,S="asc"),T(t,e)})})}function tt(t){return[...t].sort((e,s)=>{var o,r;let l=0;switch(w){case"device":l=(((o=e.device)==null?void 0:o.deviceName)||"").localeCompare(((r=s.device)==null?void 0:r.deviceName)||"");break;case"duration":l=(e.durationMs||0)-(s.durationMs||0);break;case"date":l=(e.startedAt||"").localeCompare(s.startedAt||"");break;case"status":l=Number(s.live)-Number(e.live);break}return S==="asc"?l:-l})}export{st as default,st as page};
