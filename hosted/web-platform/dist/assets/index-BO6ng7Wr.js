import{s as te,p as l,q as me,e as S,n as Se,r as se,t as X,u as ie,v as ke,x as Y,y as he,z as xe,A as Le,B as $e,C as y,D as qe,E as ae,F as Ee,G as Ie,H as F,I as _e,J as Ae,K as Te,L as Q,M as Ne,N as ee,O as We,P as J,Q as j,g as ne,a as U,R as z,S as W,T as C,U as De,V as oe,W as re,X as ce,Y as le,Z as Me,_ as Pe,$ as Oe,a0 as Ce,a1 as ze,a2 as He,a3 as Ve,a4 as de,a5 as Be,a6 as Ye,a7 as je,a8 as fe,a9 as Ge,aa as Xe,ab as Fe,ac as Je,ad as Re,ae as Ue}from"./main-DWB6BCMx.js";import"./modulepreload-polyfill-B5Qt9EMX.js";async function Ke(){var r;const e=l();e&&(e.innerHTML=`
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
  `,(r=e.querySelector("#wf-new-btn"))==null||r.addEventListener("click",()=>{location.hash="/workflows/new"}),await R(),X()&&clearInterval(X()),te(setInterval(()=>R(),15e3)))}async function R(){var c;const e=(c=l())==null?void 0:c.querySelector("#wf-list");if(!e)return;const r=await me();if(r.length===0){e.innerHTML='<p class="empty-state">No workflows yet. Click "+ New" to create one.</p>';return}e.innerHTML=r.map(a=>{const n=a.status==="published"?"wf-status-published":a.status==="archived"?"wf-status-archived":"wf-status-draft";return`
      <div class="wf-card" data-id="${S(a.id)}">
        <div class="wf-card-header">
          <span class="wf-card-name">${S(a.name)}</span>
          <span class="wf-card-status ${n}">${S(a.status)}</span>
        </div>
        <p class="wf-card-desc">${S(a.description||"No description")}</p>
        <div class="wf-card-meta">
          <span>${a.nodeCount} nodes</span>
          <span>${Se(a.updatedAt)}</span>
        </div>
        <div class="wf-card-actions">
          <button class="btn btn-sm wf-edit-btn" data-id="${S(a.id)}">Edit</button>
          <button class="btn btn-sm btn-danger wf-delete-btn" data-id="${S(a.id)}">Delete</button>
        </div>
      </div>
    `}).join(""),e.querySelectorAll(".wf-edit-btn").forEach(a=>{a.addEventListener("click",()=>{location.hash=`/workflows/${a.dataset.id}`})}),e.querySelectorAll(".wf-delete-btn").forEach(a=>{a.addEventListener("click",async()=>{confirm("Delete this workflow?")&&(await se(a.dataset.id),await R())})})}async function pe(e){const r=l();if(!r)return;if(F(!1),ce(null),ze(0),He(0),Ve(1),await ke(),e){const n=Date.now();Y({id:"",name:"Untitled Workflow",description:"",status:"draft",ownerId:null,nodes:[{id:`n_cam_${n}`,type:"camera-source",label:"Camera",config:{visionFps:1,codec:"jpeg"},positionX:50,positionY:160},{id:`n_mic_${n}`,type:"phone-mic-source",label:"Phone Mic",config:{},positionX:50,positionY:280},{id:`n_txt_${n}`,type:"text",label:"Text Content",config:{text:"You are a helpful assistant."},positionX:320,positionY:100},{id:`n_ai_${n}`,type:"s2s-live",label:"AI Assistant",config:{model:"gemini-2.5-flash-native-audio-latest"},positionX:320,positionY:260},{id:`n_ovl_${n}`,type:"overlays",label:"Overlays",config:{},positionX:600,positionY:260}],edges:[{id:`e_cam_ai_${n}`,sourceNodeId:`n_cam_${n}`,targetNodeId:`n_ai_${n}`},{id:`e_mic_ai_${n}`,sourceNodeId:`n_mic_${n}`,targetNodeId:`n_ai_${n}`},{id:`e_txt_ai_${n}`,sourceNodeId:`n_txt_${n}`,targetNodeId:`n_ai_${n}`},{id:`e_ai_ovl_${n}`,sourceNodeId:`n_ai_${n}`,targetNodeId:`n_ovl_${n}`}],canvasViewport:{x:0,y:0,zoom:1},flowConfig:null,settings:null,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()})}else{const n=he();if(!n){location.hash="/workflows";return}const v=await xe(n);if(!v){location.hash="/workflows";return}Y(v)}const c=y(),a=c.id?await Le(c.id):null;r.innerHTML=`
    <div class="page workflow-editor-page">
      <div class="wf-editor-layout">
        <div class="wf-palette" id="wf-palette">
          ${Ze()}
        </div>
        <div class="wf-scrim" id="wf-scrim"></div>
        <div class="wf-canvas-wrap" id="wf-canvas-wrap">
          ${$e()}
          ${ue()}
        </div>
        <div class="wf-config-panel" id="wf-config-panel">
          <p class="empty-state">Select a node</p>
        </div>
      </div>
      <div class="wf-toolbar">
        <input type="text" class="wf-toolbar-input" id="wf-name" value="${S(c.name)}" placeholder="Workflow name" />
        <input type="text" class="wf-toolbar-input wf-toolbar-desc" id="wf-desc" value="${S(c.description)}" placeholder="Description" />
        <button class="btn btn-primary" id="wf-save-btn">Save</button>
        <span id="wf-save-status" style="font-size:11px;color:var(--text-tertiary);margin-left:4px;">Saved</span>
        <button class="btn" id="wf-publish-btn">${c.status==="published"?"Unpublish":"Publish"}</button>
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
  `,Qe(),et(),ve(),st(a,c.id),we()}function Ze(){return[{role:"source",label:"Source"},{role:"reference",label:"Reference"},{role:"processor",label:"Processor"},{role:"trigger",label:"Trigger"},{role:"transform",label:"Transform"},{role:"sink",label:"Sink"}].map(({role:r,label:c})=>{const a=qe().filter(n=>n.role===r);return a.length===0?"":`
        <h3 class="wf-palette-title">${c}</h3>
        ${a.map(n=>{const v=(n.runtime??[]).map(t=>t==="mobile"?'<span class="wf-rt-badge" style="background:#06b6d4">MOB</span>':'<span class="wf-rt-badge" style="background:#8b5cf6">SRV</span>').join("");return`
                  <button class="wf-palette-item" data-type="${n.type}">
                    <span class="wf-palette-dot" style="background:${n.color.header}"></span>
                    <span class="wf-palette-label">${S(n.label)}</span>
                    <span class="wf-palette-runtime">${v}</span>
                  </button>`}).join("")}`}).join("")}function ue(){return`
    <div class="wf-fab-group" id="wf-fab-group">
      <button class="wf-fab wf-fab-sec" id="wf-fab-wake" title="Wake device" style="display:none">Wake</button>
      <button class="wf-fab wf-fab-sec" id="wf-fab-activate" title="Activate workflow" style="display:none">Activate</button>
      <button class="wf-fab wf-fab-sec" id="wf-fab-stream" title="Start/Stop stream" style="display:none">Stream</button>
      <button class="wf-fab wf-fab-primary" id="wf-fab-toggle">&#8230;</button>
    </div>`}function ve(){var c,a,n,v;const e=l(),r=e==null?void 0:e.querySelector("#wf-fab-group");r&&((c=r.querySelector("#wf-fab-toggle"))==null||c.addEventListener("click",()=>{const t=r.classList.toggle("wf-fab-open");r.querySelectorAll(".wf-fab-sec").forEach(i=>{i.style.display=t?"flex":"none"})}),(a=r.querySelector("#wf-fab-wake"))==null||a.addEventListener("click",async()=>{const t=y();if(!(t!=null&&t.id))return;const i=t.settings;i!=null&&i.targetDeviceId&&await j(i.targetDeviceId)}),(n=r.querySelector("#wf-fab-activate"))==null||n.addEventListener("click",async()=>{const t=y();if(!(t!=null&&t.id))return;const o=(await U()).filter(h=>h.live);if(o.length===0){alert("No live sessions.");return}const g=o[0].sessionId;await z(t.id,g)}),(v=r.querySelector("#wf-fab-stream"))==null||v.addEventListener("click",()=>{W()&&(fe()==="live"?C({type:"stop_stream"}):C({type:"start_stream"}))}))}function Qe(){var e,r,c,a,n,v,t,i,o,g,h,x,I,_,A,T,N,H,V,D,K,Z;ae(),(e=l())==null||e.querySelectorAll(".wf-palette-item").forEach(s=>{s.addEventListener("click",()=>{const p=y();if(!p)return;const w=s.dataset.type,b=Ee(w),f=Ie(),m=p.nodes.length*30,k=b?{...b.defaultConfig}:{};p.nodes.push({id:f,type:w,label:(b==null?void 0:b.defaultLabel)??w.replace(/-/g," "),config:k,positionX:200+m,positionY:150+m}),F(!0),_e(),Ae(),O()})}),(c=(r=l())==null?void 0:r.querySelector("#wf-save-btn"))==null||c.addEventListener("click",async()=>{await Te();const s=y();if(s!=null&&s.id&&s.status!=="published"){const p=await Q(s.id,{status:"published"});p&&Y(p)}Ne()}),(n=(a=l())==null?void 0:a.querySelector("#wf-publish-btn"))==null||n.addEventListener("click",async()=>{var f,m,k,$;const s=y();if(!(s!=null&&s.id)||ee()&&!confirm("You have unsaved changes. Save before publishing?"))return;const w={status:s.status==="published"?"draft":"published"};ee()&&(s.name=((m=(f=l())==null?void 0:f.querySelector("#wf-name"))==null?void 0:m.value)??s.name,s.description=(($=(k=l())==null?void 0:k.querySelector("#wf-desc"))==null?void 0:$.value)??s.description,w.name=s.name,w.description=s.description,w.nodes=s.nodes.map(q=>({...q,config:JSON.stringify(q.config)})),w.edges=s.edges);const b=await Q(s.id,w);b&&(Y(b),F(!1)),pe(!1)}),(t=(v=l())==null?void 0:v.querySelector("#wf-del-btn"))==null||t.addEventListener("click",async()=>{const s=y();s!=null&&s.id&&confirm("Delete this workflow?")&&(await se(s.id),location.hash="/workflows")}),(o=(i=l())==null?void 0:i.querySelector("#wf-settings-btn"))==null||o.addEventListener("click",()=>{const s=Ge();We(!s),J()}),(h=(g=l())==null?void 0:g.querySelector("#wf-wake-btn"))==null||h.addEventListener("click",async()=>{var k,$,q,M;const s=y();if(!(s!=null&&s.id))return;const p=s.settings;if(p!=null&&p.targetDeviceId){const d=await j(p.targetDeviceId);if(!(d!=null&&d.ok)){alert((d==null?void 0:d.error)??"Wake failed");return}alert(`Wake sent to device ${p.targetDeviceId.slice(0,8)}...`),L();return}const w=(k=l())==null?void 0:k.querySelector(".wf-wake-dropdown");if(w){w.remove();return}const b=await ne();if(b.length===0){alert("No registered devices. Open the app on a device first.");return}const f=document.createElement("div");f.className="wf-wake-dropdown",f.style.cssText="position:absolute;right:200px;bottom:60px;background:var(--bg-surface);border:1px solid var(--border);border-radius:8px;padding:8px;z-index:200;min-width:220px",f.innerHTML=`
      <div style="font-size:11px;color:var(--text-secondary);margin-bottom:4px;">Select device to wake:</div>
      <select class="wf-wake-select" style="width:100%;margin-bottom:6px;padding:4px;background:var(--bg-surface-alt);border:1px solid var(--border);border-radius:4px;color:var(--text-primary);font-size:12px">
        ${b.map(d=>`<option value="${d.device_id}">${d.deviceName??d.device_id.slice(0,8)} ${d.deviceModel??""}</option>`).join("")}
      </select>
      <button class="btn" style="width:100%">Wake Device</button>
    `,(q=($=l())==null?void 0:$.querySelector(".workflow-editor-page"))==null||q.appendChild(f),(M=f.querySelector(".btn"))==null||M.addEventListener("click",async()=>{var P;const d=(P=f.querySelector(".wf-wake-select"))==null?void 0:P.value;if(!d)return;f.remove();const u=await j(d);if(!(u!=null&&u.ok)){alert((u==null?void 0:u.error)??"Wake failed");return}alert(`Wake sent to ${d.slice(0,8)}...`),L()});const m=d=>{f.contains(d.target)||(f.remove(),document.removeEventListener("click",m))};setTimeout(()=>document.addEventListener("click",m),0)}),(I=(x=l())==null?void 0:x.querySelector("#wf-activate-btn"))==null||I.addEventListener("click",async()=>{var k,$,q,M;const s=y();if(!(s!=null&&s.id))return;const p=(k=l())==null?void 0:k.querySelector(".wf-activate-dropdown");if(p){p.remove();return}const b=(await U()).filter(d=>d.live);if(b.length===0){alert("No live sessions. Wake a device first, then activate.");return}const f=document.createElement("div");f.className="wf-activate-dropdown",f.style.cssText="position:absolute;right:140px;bottom:60px;background:var(--bg-surface);border:1px solid var(--border);border-radius:8px;padding:8px;z-index:200;min-width:260px",f.innerHTML=`
      <div style="font-size:11px;color:var(--text-secondary);margin-bottom:4px;">Select session:</div>
      <select class="wf-activate-select" style="width:100%;margin-bottom:6px;padding:4px;background:var(--bg-surface-alt);border:1px solid var(--border);border-radius:4px;color:var(--text-primary);font-size:12px">
        ${b.map(d=>{var u;return`<option value="${d.sessionId}">${((u=d.device)==null?void 0:u.deviceName)??"unknown"} (${d.sessionId.slice(0,8)})</option>`}).join("")}
      </select>
      <button class="btn" style="width:100%">Activate</button>
    `,(q=($=l())==null?void 0:$.querySelector(".workflow-editor-page"))==null||q.appendChild(f),(M=f.querySelector(".btn"))==null||M.addEventListener("click",async()=>{var P;const d=(P=f.querySelector(".wf-activate-select"))==null?void 0:P.value;if(!d)return;f.remove();let u=await z(s.id,d);if(!u){alert("Activation failed");return}if(u.status==="conflict"&&u.conflict){const G=u.conflict,ge=G.activeAppId??"unknown",ye=G.activatedAt?new Date(G.activatedAt).toLocaleTimeString():"unknown";if(!confirm(`Session already has active AI:
  App: ${ge}
  Active since: ${ye}

Override and activate this workflow instead?`))return;if(u=await z(s.id,d,{override:!0,reason:"Manual override"}),!u){alert("Override failed");return}}u.status==="passive"?alert("Activated (passive). Sinks/transforms configured on device."):u.appId?alert(`Activated! App: ${u.appId}, Status: ${u.status}`):alert("Activation result: "+u.status),L()});const m=d=>{f.contains(d.target)||(f.remove(),document.removeEventListener("click",m))};setTimeout(()=>document.addEventListener("click",m),0)}),(A=(_=l())==null?void 0:_.querySelector("#wf-stream-start-btn"))==null||A.addEventListener("click",async()=>{var f;if(W()){C({type:"start_stream"});return}const s=y(),p=((f=s==null?void 0:s.settings)==null?void 0:f.targetDeviceId)??null,w=await De(p);if(!w){alert("No live session found. Open the app on a device first.");return}oe(w);const b=()=>{W()?C({type:"start_stream"}):setTimeout(b,200)};setTimeout(b,300)}),(N=(T=l())==null?void 0:T.querySelector("#wf-stream-stop-btn"))==null||N.addEventListener("click",()=>{W()&&C({type:"stop_stream"})}),(V=(H=l())==null?void 0:H.querySelector("#wf-test-btn"))==null||V.addEventListener("click",()=>{var w;const s=(w=l())==null?void 0:w.querySelector("#wf-testing-panel");if(!s)return;const p=s.style.display!=="none";s.style.display=p?"none":"flex",p||L()}),(K=(D=l())==null?void 0:D.querySelector("#wf-testing-close"))==null||K.addEventListener("click",()=>{var p;const s=(p=l())==null?void 0:p.querySelector("#wf-testing-panel");s&&(s.style.display="none")}),document.addEventListener("keydown",re),(Z=l())==null||Z.addEventListener("click",s=>{s.target.closest(".wf-flow-dot")&&(s.stopPropagation(),ce(null),J())})}function we(){const e=l();if(!e)return;const r=window.innerWidth<=768;e.querySelectorAll(".wf-mobile-toggle").forEach(a=>{a.style.display=r?"inline-flex":"none"}),e.querySelectorAll(".wf-toolbar-desktop").forEach(a=>{a.style.display=r?"none":"inline-flex"});const c=e.querySelector("#wf-fab-group");c&&(c.style.display=r?"flex":"none")}function et(){var a,n,v;const e=l();if(!e)return;(a=e.querySelector("#wf-nodes-toggle"))==null||a.addEventListener("click",()=>{const t=e.querySelector("#wf-palette"),i=e.querySelector("#wf-scrim");if(!t)return;const o=t.classList.contains("mobile-open");O(),o||(t.classList.add("mobile-open"),i==null||i.classList.add("active"))}),(n=e.querySelector("#wf-config-toggle"))==null||n.addEventListener("click",()=>{const t=e.querySelector("#wf-config-panel"),i=e.querySelector("#wf-scrim");if(!t)return;const o=t.classList.contains("mobile-open");O(),o||(t.classList.add("mobile-open"),i==null||i.classList.add("active"))}),(v=e.querySelector("#wf-scrim"))==null||v.addEventListener("click",()=>{O()});const r=new MutationObserver(()=>{if(window.innerWidth<=768&&le()){const t=e.querySelector("#wf-config-panel");t&&!t.classList.contains("mobile-open")&&(O(),t.classList.add("mobile-open"))}}),c=e.querySelector("#wf-canvas-wrap");c&&r.observe(c,{childList:!0,subtree:!0}),window.addEventListener("resize",()=>we())}function O(){var r,c,a;const e=l();e&&((r=e.querySelector("#wf-palette"))==null||r.classList.remove("mobile-open"),(c=e.querySelector("#wf-config-panel"))==null||c.classList.remove("mobile-open"),(a=e.querySelector("#wf-scrim"))==null||a.classList.remove("active"))}let B=null;async function L(){var v;const e=(v=l())==null?void 0:v.querySelector("#wf-testing-body");if(!e)return;const[r,c]=await Promise.all([ne(),U()]),a=c.filter(t=>t.live),n=y();if(r.length===0){e.innerHTML='<p class="empty-state" style="font-size:11px;color:var(--text-tertiary)">No registered devices found. Open the app on a device to register it.</p>';return}e.innerHTML=r.map(t=>{const i=a.find(V=>{var D;return((D=V.device)==null?void 0:D.deviceId)===t.device_id}),o=!!i,g=o&&i.publisherStandby===!1;o&&i.publisherStandby;const x=(i==null?void 0:i.activeWorkflowId)===(n==null?void 0:n.id),I=o?g?'<span class="wf-testing-badge wf-testing-badge-streaming">Streaming</span>':'<span class="wf-testing-badge wf-testing-badge-standby">Standby</span>':'<span class="wf-testing-badge wf-testing-badge-offline">Offline</span>',_=x?'<span class="wf-testing-badge wf-testing-badge-activated">Activated</span>':"",A=!o&&!!t.apnsToken,T=o&&!x,N=o&&!g,H=g;return`
      <div class="wf-testing-device-card" data-device-id="${t.device_id}">
        <div class="wf-testing-device-header">
          <div>
            <div class="wf-testing-device-name">${S(t.deviceName??t.device_id.slice(0,12))}</div>
            <div class="wf-testing-device-model">${S(t.deviceModel??"")}</div>
          </div>
        </div>
        <div class="wf-testing-device-status">
          ${I} ${_}
        </div>
        <div class="wf-testing-device-actions">
          <button class="btn wf-test-wake" data-device-id="${t.device_id}" ${A?"":"disabled"}>Wake</button>
          <button class="btn wf-test-activate" data-session-id="${(i==null?void 0:i.sessionId)??""}" ${T?"":"disabled"}>Activate</button>
          ${H?`<button class="btn wf-test-stop-stream" data-session-id="${i.sessionId}" style="border-color:rgba(248,113,113,0.4)">Stop</button>`:`<button class="btn wf-test-start-stream" data-session-id="${(i==null?void 0:i.sessionId)??""}" ${N?"":"disabled"}>Stream</button>`}
        </div>
      </div>
    `}).join(""),e.querySelectorAll(".wf-test-wake:not([disabled])").forEach(t=>{t.addEventListener("click",async()=>{const i=t.dataset.deviceId,o=await j(i);if(!(o!=null&&o.ok)){alert((o==null?void 0:o.error)??"Wake failed");return}setTimeout(L,3e3)})}),e.querySelectorAll(".wf-test-activate:not([disabled])").forEach(t=>{t.addEventListener("click",async()=>{const i=y(),o=t.dataset.sessionId;if(!(i!=null&&i.id)||!o)return;let g=await z(i.id,o);if(!g){alert("Activation failed");return}if(g.status==="conflict"&&g.conflict){if(!confirm("Session has active AI. Override?"))return;if(g=await z(i.id,o,{override:!0,reason:"Manual override"}),!g){alert("Override failed");return}}setTimeout(L,1500)})}),e.querySelectorAll(".wf-test-start-stream:not([disabled])").forEach(t=>{t.addEventListener("click",async()=>{const i=t.dataset.sessionId;if(!i)return;const o=await Oe(i);if(!(o!=null&&o.ok)){alert((o==null?void 0:o.error)??"Stream failed");return}setTimeout(L,2e3)})}),e.querySelectorAll(".wf-test-stop-stream").forEach(t=>{t.addEventListener("click",async()=>{const i=t.dataset.sessionId;if(!i)return;const o=await Ce(i);if(!(o!=null&&o.ok)){alert((o==null?void 0:o.error)??"Stop failed");return}setTimeout(L,1500)})})}function tt(){be(),B=setInterval(()=>{var r;const e=(r=l())==null?void 0:r.querySelector("#wf-testing-panel");e&&e.style.display!=="none"&&L()},15e3)}function be(){B&&(clearInterval(B),B=null)}let E=null;function st(e,r){E&&(de(E),E=null),ie(),r&&(e&&oe(e),Me(r),tt(),E=()=>{const c=y(),a=l();if(!c||!a)return;const n=a.querySelector("#wf-canvas-wrap");if(!n)return;const v=Xe(),t=new Map;for(const[,N]of v)t.set(N.nodeId,N.executionState);const i=W(),o=n.querySelector("#wf-fab-group"),g=o?o.outerHTML:ue();n.innerHTML=Be(c,Ye(),le(),t,1,"wf-svg",void 0,i,v)+g,ae(),ve();const h=a.querySelector("#wf-preview-status");h&&(h.style.display=W()?"":"none");const x=fe(),I=a.querySelector("#wf-stream-start-btn"),_=a.querySelector("#wf-stream-stop-btn"),A=W();I&&(I.disabled=!A||x==="live"),_&&(_.disabled=!A||x!=="live");const T=a.querySelector("#wf-fab-stream");T&&(T.textContent=x==="live"?"Stop":"Stream"),J()},Pe(E))}function it(){E&&(de(E),E=null),ie(),be(),je()}const ct={init(e){Ue(e),at()},destroy(){const e=X();e&&(clearInterval(e),te(null)),document.removeEventListener("keydown",re),it(),Re(),Fe()}};function at(){const e=Je();e==="list"?Ke():pe(e==="new")}export{ct as default,ct as page};
