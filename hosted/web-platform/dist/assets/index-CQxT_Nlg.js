import{s as se,p as c,q as xe,e as m,n as qe,r as ae,t as X,u as ne,v as Ee,x as Y,y as Ie,z as _e,A as Ae,B as Te,C as y,D as Ne,E as ie,F as oe,G as re,H as Me,I as Pe,J as H,K as R,L as We,M as De,N as Q,O as Oe,P as ee,Q as Ce,R as le,S as j,g as ce,a as U,T as z,U as M,V as C,W as He,X as de,Y as fe,Z as ze,_ as we,$ as Fe,a0 as Ve,a1 as Be,a2 as Ye,a3 as je,a4 as Ge,a5 as Xe,a6 as Je,a7 as ue,a8 as Re,a9 as Ue,aa as Ke,ab as pe,ac as Ze,ad as Qe,ae as et,af as tt,ag as st,ah as at}from"./main-U9TbKK4R.js";import"./modulepreload-polyfill-B5Qt9EMX.js";async function nt(){var r;const e=c();e&&(e.innerHTML=`
    <div class="page workflow-page">
      <div class="page-header">
        <div class="page-header-row">
          <div>
            <h1 class="page-title">Workflows</h1>
            <span class="page-subtitle">AI pipeline builder</span>
          </div>
          <button class="btn btn-primary" id="wf-new-btn">+ New</button>
        </div>
      </div>
      <div id="wf-list" class="wf-card-grid">
        <p class="empty-state">Loading workflows...</p>
      </div>
    </div>
  `,(r=e.querySelector("#wf-new-btn"))==null||r.addEventListener("click",()=>{location.hash="/workflows/new"}),await J(),X()&&clearInterval(X()),se(setInterval(()=>J(),15e3)))}async function J(){var n;const e=(n=c())==null?void 0:n.querySelector("#wf-list");if(!e)return;const r=await xe();if(r.length===0){e.innerHTML='<p class="empty-state">No workflows yet. Click "+ New" to create one.</p>';return}e.innerHTML=r.map(a=>{const i=a.status==="published"?"wf-status-published":a.status==="archived"?"wf-status-archived":"wf-status-draft";return`
      <div class="wf-card" data-id="${m(a.id)}">
        <div class="wf-card-header">
          <span class="wf-card-name">${m(a.name)}</span>
          <span class="wf-card-status ${i}">${m(a.status)}</span>
        </div>
        <p class="wf-card-desc">${m(a.description||"No description")}</p>
        <div class="wf-card-meta">
          <span>${a.nodeCount} nodes</span>
          <span>${qe(a.updatedAt)}</span>
        </div>
        <div class="wf-card-actions">
          <button class="btn btn-sm wf-edit-btn" data-id="${m(a.id)}">Edit</button>
          <button class="btn btn-sm btn-danger wf-delete-btn" data-id="${m(a.id)}">Delete</button>
        </div>
      </div>
    `}).join(""),e.querySelectorAll(".wf-edit-btn").forEach(a=>{a.addEventListener("click",()=>{location.hash=`/workflows/${a.dataset.id}`})}),e.querySelectorAll(".wf-delete-btn").forEach(a=>{a.addEventListener("click",async()=>{confirm("Delete this workflow?")&&(await ae(a.dataset.id),await J())})})}async function ve(e){const r=c();if(!r)return;if(H(!1),je(null),Ge(0),Xe(0),Je(1),await Ee(),e){const i=Date.now();Y({id:"",name:"Untitled Workflow",description:"",status:"draft",ownerId:null,nodes:[{id:`n_cam_${i}`,type:"camera-source",label:"Camera",config:{visionFps:1,codec:"jpeg"},positionX:50,positionY:160},{id:`n_mic_${i}`,type:"phone-mic-source",label:"Phone Mic",config:{},positionX:50,positionY:280},{id:`n_txt_${i}`,type:"text",label:"Text Content",config:{text:"You are a helpful assistant."},positionX:320,positionY:100},{id:`n_ai_${i}`,type:"s2s-live",label:"AI Assistant",config:{model:"gemini-2.5-flash-native-audio-latest"},positionX:320,positionY:260},{id:`n_ovl_${i}`,type:"overlays",label:"Overlays",config:{},positionX:600,positionY:260}],edges:[{id:`e_cam_ai_${i}`,sourceNodeId:`n_cam_${i}`,targetNodeId:`n_ai_${i}`},{id:`e_mic_ai_${i}`,sourceNodeId:`n_mic_${i}`,targetNodeId:`n_ai_${i}`},{id:`e_txt_ai_${i}`,sourceNodeId:`n_txt_${i}`,targetNodeId:`n_ai_${i}`},{id:`e_ai_ovl_${i}`,sourceNodeId:`n_ai_${i}`,targetNodeId:`n_ovl_${i}`}],canvasViewport:{x:0,y:0,zoom:1},flowConfig:null,settings:null,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()})}else{const i=Ie();if(!i){location.hash="/workflows";return}const d=await _e(i);if(!d){location.hash="/workflows";return}Y(d)}const n=y(),a=n.id?await Ae(n.id):null;r.innerHTML=`
    <div class="page workflow-editor-page">
      <div class="wf-editor-layout">
        <div class="wf-palette" id="wf-palette">
          ${it()}
        </div>
        <div class="wf-scrim" id="wf-scrim"></div>
        <div class="wf-canvas-wrap" id="wf-canvas-wrap">
          ${Te()}
          ${be()}
        </div>
        <div class="wf-config-panel" id="wf-config-panel">
          <p class="empty-state">Select a node</p>
        </div>
      </div>
      ${ye(n)}
      <div class="wf-toolbar">
        <input type="text" class="wf-toolbar-input" id="wf-name" value="${m(n.name)}" placeholder="Workflow name" />
        <input type="text" class="wf-toolbar-input wf-toolbar-desc" id="wf-desc" value="${m(n.description)}" placeholder="Description" />
        <button class="btn btn-primary" id="wf-save-btn">Save</button>
        <span id="wf-save-status" style="font-size:11px;color:var(--text-tertiary);margin-left:4px;">Saved</span>
        <button class="btn" id="wf-publish-btn">${n.status==="published"?"Unpublish":"Publish"}</button>
        <button class="btn btn-danger" id="wf-del-btn">Delete</button>
        <button class="btn" id="wf-settings-btn">Settings</button>
        <span class="wf-toolbar-sep" style="width:1px;height:20px;background:var(--border);margin:0 4px;display:inline-block;vertical-align:middle"></span>
        <button class="btn wf-toolbar-desktop" id="wf-wake-btn" title="Wake device via push notification">Wake</button>
        <button class="btn wf-toolbar-desktop" id="wf-activate-btn" title="Activate workflow against a live session">Activate</button>
        <button class="btn wf-toolbar-desktop" id="wf-stream-start-btn" title="Start camera stream">Start Stream</button>
        <button class="btn wf-toolbar-desktop" id="wf-stream-stop-btn" title="Stop camera stream" disabled>Stop Stream</button>
        <button class="btn wf-toolbar-desktop" id="wf-test-btn" title="Open fleet testing panel">Testing</button>
        <span id="wf-preview-status" style="font-size:11px;margin-left:8px;${a?"":"display:none"}">
          <span class="wf-live-dot" style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#4ade80;margin-right:3px;vertical-align:middle"></span>
          <span style="color:#4ade80;vertical-align:middle">LIVE</span>
        </span>
        <!-- Mobile toggles -->
        <button class="btn wf-mobile-toggle" id="wf-nodes-toggle" style="display:none">Nodes</button>
        <button class="btn wf-mobile-toggle" id="wf-config-toggle" style="display:none">Config</button>
      </div>
      <div class="wf-testing-panel" id="wf-testing-panel" style="display:none">
        <div class="wf-testing-header">
          <span style="font-weight:600;font-size:13px">Fleet Testing</span>
          <button class="btn" id="wf-testing-close" style="padding:2px 8px;font-size:11px">&times;</button>
        </div>
        <div class="wf-testing-body" id="wf-testing-body">
          <p class="empty-state" style="font-size:11px;color:var(--text-tertiary)">Loading devices...</p>
        </div>
      </div>
    </div>
  `,ot(),me(),rt(),ge(),ct(a,n.id),ke()}function it(){return[{role:"source",label:"Source"},{role:"reference",label:"Reference"},{role:"processor",label:"Processor"},{role:"trigger",label:"Trigger"},{role:"transform",label:"Transform"},{role:"sink",label:"Sink"}].map(({role:r,label:n})=>{const a=Ne().filter(i=>i.role===r);return a.length===0?"":`
        <h3 class="wf-palette-title">${n}</h3>
        ${a.map(i=>{const d=(i.runtime??[]).map(t=>t==="mobile"?'<span class="wf-rt-badge" style="background:#06b6d4">MOB</span>':'<span class="wf-rt-badge" style="background:#8b5cf6">SRV</span>').join("");return`
                  <button class="wf-palette-item" data-type="${i.type}">
                    <span class="wf-palette-dot" style="background:${i.color.header}"></span>
                    <span class="wf-palette-label">${m(i.label)}</span>
                    <span class="wf-palette-runtime">${d}</span>
                  </button>`}).join("")}`}).join("")}function be(){return`
    <div class="wf-fab-group" id="wf-fab-group">
      <button class="wf-fab wf-fab-sec" id="wf-fab-wake" title="Wake device" style="display:none">Wake</button>
      <button class="wf-fab wf-fab-sec" id="wf-fab-activate" title="Activate workflow" style="display:none">Activate</button>
      <button class="wf-fab wf-fab-sec" id="wf-fab-stream" title="Start/Stop stream" style="display:none">Stream</button>
      <button class="wf-fab wf-fab-primary" id="wf-fab-toggle">&#8230;</button>
    </div>`}function ge(){var n,a,i,d;const e=c(),r=e==null?void 0:e.querySelector("#wf-fab-group");r&&((n=r.querySelector("#wf-fab-toggle"))==null||n.addEventListener("click",()=>{const t=r.classList.toggle("wf-fab-open");r.querySelectorAll(".wf-fab-sec").forEach(s=>{s.style.display=t?"flex":"none"})}),(a=r.querySelector("#wf-fab-wake"))==null||a.addEventListener("click",async()=>{const t=y();if(!(t!=null&&t.id))return;const s=t.settings;s!=null&&s.targetDeviceId&&await j(s.targetDeviceId)}),(i=r.querySelector("#wf-fab-activate"))==null||i.addEventListener("click",async()=>{const t=y();if(!(t!=null&&t.id))return;const l=(await U()).filter(S=>S.live);if(l.length===0){alert("No live sessions.");return}const p=l[0].sessionId;await z(t.id,p)}),(d=r.querySelector("#wf-fab-stream"))==null||d.addEventListener("click",()=>{M()&&(pe()==="live"?C({type:"stop_stream"}):C({type:"start_stream"}))}))}function ye(e){const r=ie(e.nodes,e.edges);if(r.length<=1)return"";const n=e.flowConfig??oe(r),a=(n==null?void 0:n.mode)??"parallel",d=((n==null?void 0:n.flowOrder)??r.map(t=>t.flowId)).map(t=>{const s=r.find(l=>l.flowId===t);return s?`<div class="wf-flow-bar-item" data-flow-id="${s.flowId}">
      <span class="wf-flow-bar-dot" style="background:${s.color}"></span>
      <span class="wf-flow-bar-label">${m(s.label)}</span>
      <span class="wf-flow-bar-arrow wf-flow-up" data-flow-id="${s.flowId}">&#9650;</span>
      <span class="wf-flow-bar-arrow wf-flow-down" data-flow-id="${s.flowId}">&#9660;</span>
    </div>`:""}).join("");return`
    <div id="wf-flow-controls" class="wf-flow-controls-bar">
      <div class="wf-flow-mode-toggle">
        <button class="btn wf-flow-mode-btn ${a==="parallel"?"btn-primary":""}" id="wf-flow-parallel">Parallel</button>
        <button class="btn wf-flow-mode-btn ${a==="sequential"?"btn-primary":""}" id="wf-flow-sequential">Sequential</button>
        <button class="btn wf-flow-mode-btn ${a==="event-driven"?"btn-primary":""}" id="wf-flow-event">Event</button>
      </div>
      <div id="wf-flow-list" class="wf-flow-list ${a==="parallel"?"disabled":""}">
        ${d}
      </div>
    </div>`}function me(){var a,i,d;const e=c();if(!e)return;const r=t=>{const s=y();if(!s)return;const l=ie(s.nodes,s.edges),p=s.flowConfig??oe(l);s.flowConfig={mode:t,flowOrder:(p==null?void 0:p.flowOrder)??l.map(S=>S.flowId),...t==="event-driven"?{flowTriggers:(p==null?void 0:p.flowTriggers)??{}}:{}},H(!0),R(),Se()};(a=e.querySelector("#wf-flow-parallel"))==null||a.addEventListener("click",()=>r("parallel")),(i=e.querySelector("#wf-flow-sequential"))==null||i.addEventListener("click",()=>r("sequential")),(d=e.querySelector("#wf-flow-event"))==null||d.addEventListener("click",()=>r("event-driven"));const n=e.querySelector("#wf-flow-list");n==null||n.querySelectorAll(".wf-flow-up").forEach(t=>{t.addEventListener("click",s=>{s.stopPropagation(),te(t.dataset.flowId,-1)})}),n==null||n.querySelectorAll(".wf-flow-down").forEach(t=>{t.addEventListener("click",s=>{s.stopPropagation(),te(t.dataset.flowId,1)})})}function te(e,r){const n=y();if(!(n!=null&&n.flowConfig))return;const a=[...n.flowConfig.flowOrder],i=a.indexOf(e);if(i<0)return;const d=i+r;d<0||d>=a.length||([a[i],a[d]]=[a[d],a[i]],n.flowConfig={...n.flowConfig,flowOrder:a},H(!0),R(),Se())}function Se(){const e=c(),r=y();if(!e||!r)return;const n=e.querySelector("#wf-flow-controls");n&&(n.outerHTML=ye(r)),me()}function ot(){var e,r,n,a,i,d,t,s,l,p,S,$,I,_,A,T,N,F,V,P,K,Z;re(),(e=c())==null||e.querySelectorAll(".wf-palette-item").forEach(o=>{o.addEventListener("click",()=>{const u=y();if(!u)return;const b=o.dataset.type,g=Me(b),w=Pe(),k=u.nodes.length*30,h=g?{...g.defaultConfig}:{};u.nodes.push({id:w,type:b,label:(g==null?void 0:g.defaultLabel)??b.replace(/-/g," "),config:h,positionX:200+k,positionY:150+k}),H(!0),R(),We(),O()})}),(n=(r=c())==null?void 0:r.querySelector("#wf-save-btn"))==null||n.addEventListener("click",async()=>{await De();const o=y();if(o!=null&&o.id&&o.status!=="published"){const u=await Q(o.id,{status:"published"});u&&Y(u)}Oe()}),(i=(a=c())==null?void 0:a.querySelector("#wf-publish-btn"))==null||i.addEventListener("click",async()=>{var w,k,h,x;const o=y();if(!(o!=null&&o.id)||ee()&&!confirm("You have unsaved changes. Save before publishing?"))return;const b={status:o.status==="published"?"draft":"published"};ee()&&(o.name=((k=(w=c())==null?void 0:w.querySelector("#wf-name"))==null?void 0:k.value)??o.name,o.description=((x=(h=c())==null?void 0:h.querySelector("#wf-desc"))==null?void 0:x.value)??o.description,b.name=o.name,b.description=o.description,b.nodes=o.nodes.map(q=>({...q,config:JSON.stringify(q.config)})),b.edges=o.edges);const g=await Q(o.id,b);g&&(Y(g),H(!1)),ve(!1)}),(t=(d=c())==null?void 0:d.querySelector("#wf-del-btn"))==null||t.addEventListener("click",async()=>{const o=y();o!=null&&o.id&&confirm("Delete this workflow?")&&(await ae(o.id),location.hash="/workflows")}),(l=(s=c())==null?void 0:s.querySelector("#wf-settings-btn"))==null||l.addEventListener("click",()=>{const o=Ze();Ce(!o),le()}),(S=(p=c())==null?void 0:p.querySelector("#wf-wake-btn"))==null||S.addEventListener("click",async()=>{var h,x,q,W;const o=y();if(!(o!=null&&o.id))return;const u=o.settings;if(u!=null&&u.targetDeviceId){const f=await j(u.targetDeviceId);if(!(f!=null&&f.ok)){alert((f==null?void 0:f.error)??"Wake failed");return}alert(`Wake sent to device ${u.targetDeviceId.slice(0,8)}...`),L();return}const b=(h=c())==null?void 0:h.querySelector(".wf-wake-dropdown");if(b){b.remove();return}const g=await ce();if(g.length===0){alert("No registered devices. Open the app on a device first.");return}const w=document.createElement("div");w.className="wf-wake-dropdown",w.style.cssText="position:absolute;right:200px;bottom:60px;background:var(--bg-surface);border:1px solid var(--border);border-radius:8px;padding:8px;z-index:200;min-width:220px",w.innerHTML=`
      <div style="font-size:11px;color:var(--text-secondary);margin-bottom:4px;">Select device to wake:</div>
      <select class="wf-wake-select" style="width:100%;margin-bottom:6px;padding:4px;background:var(--bg-surface-alt);border:1px solid var(--border);border-radius:4px;color:var(--text-primary);font-size:12px">
        ${g.map(f=>`<option value="${f.device_id}">${f.deviceName??f.device_id.slice(0,8)} ${f.deviceModel??""}</option>`).join("")}
      </select>
      <button class="btn" style="width:100%">Wake Device</button>
    `,(q=(x=c())==null?void 0:x.querySelector(".workflow-editor-page"))==null||q.appendChild(w),(W=w.querySelector(".btn"))==null||W.addEventListener("click",async()=>{var D;const f=(D=w.querySelector(".wf-wake-select"))==null?void 0:D.value;if(!f)return;w.remove();const v=await j(f);if(!(v!=null&&v.ok)){alert((v==null?void 0:v.error)??"Wake failed");return}alert(`Wake sent to ${f.slice(0,8)}...`),L()});const k=f=>{w.contains(f.target)||(w.remove(),document.removeEventListener("click",k))};setTimeout(()=>document.addEventListener("click",k),0)}),(I=($=c())==null?void 0:$.querySelector("#wf-activate-btn"))==null||I.addEventListener("click",async()=>{var h,x,q,W;const o=y();if(!(o!=null&&o.id))return;const u=(h=c())==null?void 0:h.querySelector(".wf-activate-dropdown");if(u){u.remove();return}const g=(await U()).filter(f=>f.live);if(g.length===0){alert("No live sessions. Wake a device first, then activate.");return}const w=document.createElement("div");w.className="wf-activate-dropdown",w.style.cssText="position:absolute;right:140px;bottom:60px;background:var(--bg-surface);border:1px solid var(--border);border-radius:8px;padding:8px;z-index:200;min-width:260px",w.innerHTML=`
      <div style="font-size:11px;color:var(--text-secondary);margin-bottom:4px;">Select session:</div>
      <select class="wf-activate-select" style="width:100%;margin-bottom:6px;padding:4px;background:var(--bg-surface-alt);border:1px solid var(--border);border-radius:4px;color:var(--text-primary);font-size:12px">
        ${g.map(f=>{var v;return`<option value="${f.sessionId}">${((v=f.device)==null?void 0:v.deviceName)??"unknown"} (${f.sessionId.slice(0,8)})</option>`}).join("")}
      </select>
      <button class="btn" style="width:100%">Activate</button>
    `,(q=(x=c())==null?void 0:x.querySelector(".workflow-editor-page"))==null||q.appendChild(w),(W=w.querySelector(".btn"))==null||W.addEventListener("click",async()=>{var D;const f=(D=w.querySelector(".wf-activate-select"))==null?void 0:D.value;if(!f)return;w.remove();let v=await z(o.id,f);if(!v){alert("Activation failed");return}if(v.status==="conflict"&&v.conflict){const G=v.conflict,$e=G.activeAppId??"unknown",Le=G.activatedAt?new Date(G.activatedAt).toLocaleTimeString():"unknown";if(!confirm(`Session already has active AI:
  App: ${$e}
  Active since: ${Le}

Override and activate this workflow instead?`))return;if(v=await z(o.id,f,{override:!0,reason:"Manual override"}),!v){alert("Override failed");return}}v.status==="passive"?alert("Activated (passive). Sinks/transforms configured on device."):v.appId?alert(`Activated! App: ${v.appId}, Status: ${v.status}`):alert("Activation result: "+v.status),L()});const k=f=>{w.contains(f.target)||(w.remove(),document.removeEventListener("click",k))};setTimeout(()=>document.addEventListener("click",k),0)}),(A=(_=c())==null?void 0:_.querySelector("#wf-stream-start-btn"))==null||A.addEventListener("click",async()=>{var w;if(M()){C({type:"start_stream"});return}const o=y(),u=((w=o==null?void 0:o.settings)==null?void 0:w.targetDeviceId)??null,b=await He(u);if(!b){alert("No live session found. Open the app on a device first.");return}de(b);const g=()=>{M()?C({type:"start_stream"}):setTimeout(g,200)};setTimeout(g,300)}),(N=(T=c())==null?void 0:T.querySelector("#wf-stream-stop-btn"))==null||N.addEventListener("click",()=>{M()&&C({type:"stop_stream"})}),(V=(F=c())==null?void 0:F.querySelector("#wf-test-btn"))==null||V.addEventListener("click",()=>{var b;const o=(b=c())==null?void 0:b.querySelector("#wf-testing-panel");if(!o)return;const u=o.style.display!=="none";o.style.display=u?"none":"flex",u||L()}),(K=(P=c())==null?void 0:P.querySelector("#wf-testing-close"))==null||K.addEventListener("click",()=>{var u;const o=(u=c())==null?void 0:u.querySelector("#wf-testing-panel");o&&(o.style.display="none")}),document.addEventListener("keydown",fe),(Z=c())==null||Z.addEventListener("click",o=>{o.target.closest(".wf-flow-dot")&&(o.stopPropagation(),ze(!0))})}function ke(){const e=c();if(!e)return;const r=window.innerWidth<=768;e.querySelectorAll(".wf-mobile-toggle").forEach(a=>{a.style.display=r?"inline-flex":"none"}),e.querySelectorAll(".wf-toolbar-desktop").forEach(a=>{a.style.display=r?"none":"inline-flex"});const n=e.querySelector("#wf-fab-group");n&&(n.style.display=r?"flex":"none")}function rt(){var a,i,d;const e=c();if(!e)return;(a=e.querySelector("#wf-nodes-toggle"))==null||a.addEventListener("click",()=>{const t=e.querySelector("#wf-palette"),s=e.querySelector("#wf-scrim");if(!t)return;const l=t.classList.contains("mobile-open");O(),l||(t.classList.add("mobile-open"),s==null||s.classList.add("active"))}),(i=e.querySelector("#wf-config-toggle"))==null||i.addEventListener("click",()=>{const t=e.querySelector("#wf-config-panel"),s=e.querySelector("#wf-scrim");if(!t)return;const l=t.classList.contains("mobile-open");O(),l||(t.classList.add("mobile-open"),s==null||s.classList.add("active"))}),(d=e.querySelector("#wf-scrim"))==null||d.addEventListener("click",()=>{O()});const r=new MutationObserver(()=>{if(window.innerWidth<=768&&we()){const t=e.querySelector("#wf-config-panel");t&&!t.classList.contains("mobile-open")&&(O(),t.classList.add("mobile-open"))}}),n=e.querySelector("#wf-canvas-wrap");n&&r.observe(n,{childList:!0,subtree:!0}),window.addEventListener("resize",()=>ke())}function O(){var r,n,a;const e=c();e&&((r=e.querySelector("#wf-palette"))==null||r.classList.remove("mobile-open"),(n=e.querySelector("#wf-config-panel"))==null||n.classList.remove("mobile-open"),(a=e.querySelector("#wf-scrim"))==null||a.classList.remove("active"))}let B=null;async function L(){var d;const e=(d=c())==null?void 0:d.querySelector("#wf-testing-body");if(!e)return;const[r,n]=await Promise.all([ce(),U()]),a=n.filter(t=>t.live),i=y();if(r.length===0){e.innerHTML='<p class="empty-state" style="font-size:11px;color:var(--text-tertiary)">No registered devices found. Open the app on a device to register it.</p>';return}e.innerHTML=r.map(t=>{const s=a.find(V=>{var P;return((P=V.device)==null?void 0:P.deviceId)===t.device_id}),l=!!s,p=l&&s.publisherStandby===!1;l&&s.publisherStandby;const $=(s==null?void 0:s.activeWorkflowId)===(i==null?void 0:i.id),I=l?p?'<span class="wf-testing-badge wf-testing-badge-streaming">Streaming</span>':'<span class="wf-testing-badge wf-testing-badge-standby">Standby</span>':'<span class="wf-testing-badge wf-testing-badge-offline">Offline</span>',_=$?'<span class="wf-testing-badge wf-testing-badge-activated">Activated</span>':"",A=!l&&!!t.apnsToken,T=l&&!$,N=l&&!p,F=p;return`
      <div class="wf-testing-device-card" data-device-id="${t.device_id}">
        <div class="wf-testing-device-header">
          <div>
            <div class="wf-testing-device-name">${m(t.deviceName??t.device_id.slice(0,12))}</div>
            <div class="wf-testing-device-model">${m(t.deviceModel??"")}</div>
          </div>
        </div>
        <div class="wf-testing-device-status">
          ${I} ${_}
        </div>
        <div class="wf-testing-device-actions">
          <button class="btn wf-test-wake" data-device-id="${t.device_id}" ${A?"":"disabled"}>Wake</button>
          <button class="btn wf-test-activate" data-session-id="${(s==null?void 0:s.sessionId)??""}" ${T?"":"disabled"}>Activate</button>
          ${F?`<button class="btn wf-test-stop-stream" data-session-id="${s.sessionId}" style="border-color:rgba(248,113,113,0.4)">Stop</button>`:`<button class="btn wf-test-start-stream" data-session-id="${(s==null?void 0:s.sessionId)??""}" ${N?"":"disabled"}>Stream</button>`}
        </div>
      </div>
    `}).join(""),e.querySelectorAll(".wf-test-wake:not([disabled])").forEach(t=>{t.addEventListener("click",async()=>{const s=t.dataset.deviceId,l=await j(s);if(!(l!=null&&l.ok)){alert((l==null?void 0:l.error)??"Wake failed");return}setTimeout(L,3e3)})}),e.querySelectorAll(".wf-test-activate:not([disabled])").forEach(t=>{t.addEventListener("click",async()=>{const s=y(),l=t.dataset.sessionId;if(!(s!=null&&s.id)||!l)return;let p=await z(s.id,l);if(!p){alert("Activation failed");return}if(p.status==="conflict"&&p.conflict){if(!confirm("Session has active AI. Override?"))return;if(p=await z(s.id,l,{override:!0,reason:"Manual override"}),!p){alert("Override failed");return}}setTimeout(L,1500)})}),e.querySelectorAll(".wf-test-start-stream:not([disabled])").forEach(t=>{t.addEventListener("click",async()=>{const s=t.dataset.sessionId;if(!s)return;const l=await Be(s);if(!(l!=null&&l.ok)){alert((l==null?void 0:l.error)??"Stream failed");return}setTimeout(L,2e3)})}),e.querySelectorAll(".wf-test-stop-stream").forEach(t=>{t.addEventListener("click",async()=>{const s=t.dataset.sessionId;if(!s)return;const l=await Ye(s);if(!(l!=null&&l.ok)){alert((l==null?void 0:l.error)??"Stop failed");return}setTimeout(L,1500)})})}function lt(){he(),B=setInterval(()=>{var r;const e=(r=c())==null?void 0:r.querySelector("#wf-testing-panel");e&&e.style.display!=="none"&&L()},15e3)}function he(){B&&(clearInterval(B),B=null)}let E=null;function ct(e,r){E&&(ue(E),E=null),ne(),r&&(e&&de(e),Fe(r),lt(),E=()=>{const n=y(),a=c();if(!n||!a)return;const i=a.querySelector("#wf-canvas-wrap");if(!i)return;const d=Qe(),t=new Map;for(const[,N]of d)t.set(N.nodeId,N.executionState);const s=M(),l=i.querySelector("#wf-fab-group"),p=l?l.outerHTML:be();i.innerHTML=Re(n,Ue(),we(),t,1,"wf-svg",void 0,s,d)+p,re(),ge();const S=a.querySelector("#wf-preview-status");S&&(S.style.display=M()?"":"none");const $=pe(),I=a.querySelector("#wf-stream-start-btn"),_=a.querySelector("#wf-stream-stop-btn"),A=M();I&&(I.disabled=!A||$==="live"),_&&(_.disabled=!A||$!=="live");const T=a.querySelector("#wf-fab-stream");T&&(T.textContent=$==="live"?"Stop":"Stream"),le()},Ve(E))}function dt(){E&&(ue(E),E=null),ne(),he(),Ke()}const vt={init(e){at(e),ft()},destroy(){const e=X();e&&(clearInterval(e),se(null)),document.removeEventListener("keydown",fe),dt(),st(),et()}};function ft(){const e=tt();e==="list"?nt():ve(e==="new")}export{vt as default,vt as page};
