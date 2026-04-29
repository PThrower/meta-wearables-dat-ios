import{s as ee,p as l,q as ye,e as S,n as me,r as te,t as X,u as se,v as Se,x as Y,y as ke,z as he,A as xe,B as Le,C as y,D as $e,E as ie,F as qe,G as Ee,H as F,I as Ie,J as _e,K as Ae,L as Z,M as Te,N as Q,O as Ne,P as ae,Q as j,g as ne,a as R,R as z,S as W,T as C,U as We,V as oe,W as re,X as De,Y as ce,Z as Me,_ as Pe,$ as Oe,a0 as Ce,a1 as ze,a2 as He,a3 as Ve,a4 as Be,a5 as le,a6 as Ye,a7 as je,a8 as Ge,a9 as de,aa as Xe,ab as Fe,ac as Je,ad as Re,ae as Ue,af as Ke}from"./main-BSf_8nHt.js";import"./modulepreload-polyfill-B5Qt9EMX.js";async function Ze(){var r;const e=l();e&&(e.innerHTML=`
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
  `,(r=e.querySelector("#wf-new-btn"))==null||r.addEventListener("click",()=>{location.hash="/workflows/new"}),await J(),X()&&clearInterval(X()),ee(setInterval(()=>J(),15e3)))}async function J(){var c;const e=(c=l())==null?void 0:c.querySelector("#wf-list");if(!e)return;const r=await ye();if(r.length===0){e.innerHTML='<p class="empty-state">No workflows yet. Click "+ New" to create one.</p>';return}e.innerHTML=r.map(a=>{const n=a.status==="published"?"wf-status-published":a.status==="archived"?"wf-status-archived":"wf-status-draft";return`
      <div class="wf-card" data-id="${S(a.id)}">
        <div class="wf-card-header">
          <span class="wf-card-name">${S(a.name)}</span>
          <span class="wf-card-status ${n}">${S(a.status)}</span>
        </div>
        <p class="wf-card-desc">${S(a.description||"No description")}</p>
        <div class="wf-card-meta">
          <span>${a.nodeCount} nodes</span>
          <span>${me(a.updatedAt)}</span>
        </div>
        <div class="wf-card-actions">
          <button class="btn btn-sm wf-edit-btn" data-id="${S(a.id)}">Edit</button>
          <button class="btn btn-sm btn-danger wf-delete-btn" data-id="${S(a.id)}">Delete</button>
        </div>
      </div>
    `}).join(""),e.querySelectorAll(".wf-edit-btn").forEach(a=>{a.addEventListener("click",()=>{location.hash=`/workflows/${a.dataset.id}`})}),e.querySelectorAll(".wf-delete-btn").forEach(a=>{a.addEventListener("click",async()=>{confirm("Delete this workflow?")&&(await te(a.dataset.id),await J())})})}async function fe(e){const r=l();if(!r)return;if(F(!1),ze(null),He(0),Ve(0),Be(1),await Se(),e){const n=Date.now();Y({id:"",name:"Untitled Workflow",description:"",status:"draft",ownerId:null,nodes:[{id:`n_cam_${n}`,type:"camera-source",label:"Camera",config:{visionFps:1,codec:"jpeg"},positionX:50,positionY:160},{id:`n_mic_${n}`,type:"phone-mic-source",label:"Phone Mic",config:{},positionX:50,positionY:280},{id:`n_txt_${n}`,type:"text",label:"Text Content",config:{text:"You are a helpful assistant."},positionX:320,positionY:100},{id:`n_ai_${n}`,type:"s2s-live",label:"AI Assistant",config:{model:"gemini-2.5-flash-native-audio-latest"},positionX:320,positionY:260},{id:`n_ovl_${n}`,type:"overlays",label:"Overlays",config:{},positionX:600,positionY:260}],edges:[{id:`e_cam_ai_${n}`,sourceNodeId:`n_cam_${n}`,targetNodeId:`n_ai_${n}`},{id:`e_mic_ai_${n}`,sourceNodeId:`n_mic_${n}`,targetNodeId:`n_ai_${n}`},{id:`e_txt_ai_${n}`,sourceNodeId:`n_txt_${n}`,targetNodeId:`n_ai_${n}`},{id:`e_ai_ovl_${n}`,sourceNodeId:`n_ai_${n}`,targetNodeId:`n_ovl_${n}`}],canvasViewport:{x:0,y:0,zoom:1},flowConfig:null,settings:null,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()})}else{const n=ke();if(!n){location.hash="/workflows";return}const v=await he(n);if(!v){location.hash="/workflows";return}Y(v)}const c=y(),a=c.id?await xe(c.id):null;r.innerHTML=`
    <div class="page workflow-editor-page">
      <div class="wf-editor-layout">
        <div class="wf-palette" id="wf-palette">
          ${Qe()}
        </div>
        <div class="wf-scrim" id="wf-scrim"></div>
        <div class="wf-canvas-wrap" id="wf-canvas-wrap">
          ${Le()}
          ${pe()}
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
  `,et(),tt(),ue(),it(a,c.id),ve()}function Qe(){return[{role:"source",label:"Source"},{role:"reference",label:"Reference"},{role:"processor",label:"Processor"},{role:"trigger",label:"Trigger"},{role:"transform",label:"Transform"},{role:"sink",label:"Sink"}].map(({role:r,label:c})=>{const a=$e().filter(n=>n.role===r);return a.length===0?"":`
        <h3 class="wf-palette-title">${c}</h3>
        ${a.map(n=>{const v=(n.runtime??[]).map(t=>t==="mobile"?'<span class="wf-rt-badge" style="background:#06b6d4">MOB</span>':'<span class="wf-rt-badge" style="background:#8b5cf6">SRV</span>').join("");return`
                  <button class="wf-palette-item" data-type="${n.type}">
                    <span class="wf-palette-dot" style="background:${n.color.header}"></span>
                    <span class="wf-palette-label">${S(n.label)}</span>
                    <span class="wf-palette-runtime">${v}</span>
                  </button>`}).join("")}`}).join("")}function pe(){return`
    <div class="wf-fab-group" id="wf-fab-group">
      <button class="wf-fab wf-fab-sec" id="wf-fab-wake" title="Wake device" style="display:none">Wake</button>
      <button class="wf-fab wf-fab-sec" id="wf-fab-activate" title="Activate workflow" style="display:none">Activate</button>
      <button class="wf-fab wf-fab-sec" id="wf-fab-stream" title="Start/Stop stream" style="display:none">Stream</button>
      <button class="wf-fab wf-fab-primary" id="wf-fab-toggle">&#8230;</button>
    </div>`}function ue(){var c,a,n,v;const e=l(),r=e==null?void 0:e.querySelector("#wf-fab-group");r&&((c=r.querySelector("#wf-fab-toggle"))==null||c.addEventListener("click",()=>{const t=r.classList.toggle("wf-fab-open");r.querySelectorAll(".wf-fab-sec").forEach(i=>{i.style.display=t?"flex":"none"})}),(a=r.querySelector("#wf-fab-wake"))==null||a.addEventListener("click",async()=>{const t=y();if(!(t!=null&&t.id))return;const i=t.settings;i!=null&&i.targetDeviceId&&await j(i.targetDeviceId)}),(n=r.querySelector("#wf-fab-activate"))==null||n.addEventListener("click",async()=>{const t=y();if(!(t!=null&&t.id))return;const o=(await R()).filter(h=>h.live);if(o.length===0){alert("No live sessions.");return}const g=o[0].sessionId;await z(t.id,g)}),(v=r.querySelector("#wf-fab-stream"))==null||v.addEventListener("click",()=>{W()&&(de()==="live"?C({type:"stop_stream"}):C({type:"start_stream"}))}))}function et(){var e,r,c,a,n,v,t,i,o,g,h,x,I,_,A,T,N,H,V,D,U,K;ie(),(e=l())==null||e.querySelectorAll(".wf-palette-item").forEach(s=>{s.addEventListener("click",()=>{const p=y();if(!p)return;const w=s.dataset.type,b=qe(w),f=Ee(),m=p.nodes.length*30,k=b?{...b.defaultConfig}:{};p.nodes.push({id:f,type:w,label:(b==null?void 0:b.defaultLabel)??w.replace(/-/g," "),config:k,positionX:200+m,positionY:150+m}),F(!0),Ie(),_e(),O()})}),(c=(r=l())==null?void 0:r.querySelector("#wf-save-btn"))==null||c.addEventListener("click",async()=>{await Ae();const s=y();if(s!=null&&s.id&&s.status!=="published"){const p=await Z(s.id,{status:"published"});p&&Y(p)}Te()}),(n=(a=l())==null?void 0:a.querySelector("#wf-publish-btn"))==null||n.addEventListener("click",async()=>{var f,m,k,$;const s=y();if(!(s!=null&&s.id)||Q()&&!confirm("You have unsaved changes. Save before publishing?"))return;const w={status:s.status==="published"?"draft":"published"};Q()&&(s.name=((m=(f=l())==null?void 0:f.querySelector("#wf-name"))==null?void 0:m.value)??s.name,s.description=(($=(k=l())==null?void 0:k.querySelector("#wf-desc"))==null?void 0:$.value)??s.description,w.name=s.name,w.description=s.description,w.nodes=s.nodes.map(q=>({...q,config:JSON.stringify(q.config)})),w.edges=s.edges);const b=await Z(s.id,w);b&&(Y(b),F(!1)),fe(!1)}),(t=(v=l())==null?void 0:v.querySelector("#wf-del-btn"))==null||t.addEventListener("click",async()=>{const s=y();s!=null&&s.id&&confirm("Delete this workflow?")&&(await te(s.id),location.hash="/workflows")}),(o=(i=l())==null?void 0:i.querySelector("#wf-settings-btn"))==null||o.addEventListener("click",()=>{const s=Xe();Ne(!s),ae()}),(h=(g=l())==null?void 0:g.querySelector("#wf-wake-btn"))==null||h.addEventListener("click",async()=>{var k,$,q,M;const s=y();if(!(s!=null&&s.id))return;const p=s.settings;if(p!=null&&p.targetDeviceId){const d=await j(p.targetDeviceId);if(!(d!=null&&d.ok)){alert((d==null?void 0:d.error)??"Wake failed");return}alert(`Wake sent to device ${p.targetDeviceId.slice(0,8)}...`),L();return}const w=(k=l())==null?void 0:k.querySelector(".wf-wake-dropdown");if(w){w.remove();return}const b=await ne();if(b.length===0){alert("No registered devices. Open the app on a device first.");return}const f=document.createElement("div");f.className="wf-wake-dropdown",f.style.cssText="position:absolute;right:200px;bottom:60px;background:var(--bg-surface);border:1px solid var(--border);border-radius:8px;padding:8px;z-index:200;min-width:220px",f.innerHTML=`
      <div style="font-size:11px;color:var(--text-secondary);margin-bottom:4px;">Select device to wake:</div>
      <select class="wf-wake-select" style="width:100%;margin-bottom:6px;padding:4px;background:var(--bg-surface-alt);border:1px solid var(--border);border-radius:4px;color:var(--text-primary);font-size:12px">
        ${b.map(d=>`<option value="${d.device_id}">${d.deviceName??d.device_id.slice(0,8)} ${d.deviceModel??""}</option>`).join("")}
      </select>
      <button class="btn" style="width:100%">Wake Device</button>
    `,(q=($=l())==null?void 0:$.querySelector(".workflow-editor-page"))==null||q.appendChild(f),(M=f.querySelector(".btn"))==null||M.addEventListener("click",async()=>{var P;const d=(P=f.querySelector(".wf-wake-select"))==null?void 0:P.value;if(!d)return;f.remove();const u=await j(d);if(!(u!=null&&u.ok)){alert((u==null?void 0:u.error)??"Wake failed");return}alert(`Wake sent to ${d.slice(0,8)}...`),L()});const m=d=>{f.contains(d.target)||(f.remove(),document.removeEventListener("click",m))};setTimeout(()=>document.addEventListener("click",m),0)}),(I=(x=l())==null?void 0:x.querySelector("#wf-activate-btn"))==null||I.addEventListener("click",async()=>{var k,$,q,M;const s=y();if(!(s!=null&&s.id))return;const p=(k=l())==null?void 0:k.querySelector(".wf-activate-dropdown");if(p){p.remove();return}const b=(await R()).filter(d=>d.live);if(b.length===0){alert("No live sessions. Wake a device first, then activate.");return}const f=document.createElement("div");f.className="wf-activate-dropdown",f.style.cssText="position:absolute;right:140px;bottom:60px;background:var(--bg-surface);border:1px solid var(--border);border-radius:8px;padding:8px;z-index:200;min-width:260px",f.innerHTML=`
      <div style="font-size:11px;color:var(--text-secondary);margin-bottom:4px;">Select session:</div>
      <select class="wf-activate-select" style="width:100%;margin-bottom:6px;padding:4px;background:var(--bg-surface-alt);border:1px solid var(--border);border-radius:4px;color:var(--text-primary);font-size:12px">
        ${b.map(d=>{var u;return`<option value="${d.sessionId}">${((u=d.device)==null?void 0:u.deviceName)??"unknown"} (${d.sessionId.slice(0,8)})</option>`}).join("")}
      </select>
      <button class="btn" style="width:100%">Activate</button>
    `,(q=($=l())==null?void 0:$.querySelector(".workflow-editor-page"))==null||q.appendChild(f),(M=f.querySelector(".btn"))==null||M.addEventListener("click",async()=>{var P;const d=(P=f.querySelector(".wf-activate-select"))==null?void 0:P.value;if(!d)return;f.remove();let u=await z(s.id,d);if(!u){alert("Activation failed");return}if(u.status==="conflict"&&u.conflict){const G=u.conflict,be=G.activeAppId??"unknown",ge=G.activatedAt?new Date(G.activatedAt).toLocaleTimeString():"unknown";if(!confirm(`Session already has active AI:
  App: ${be}
  Active since: ${ge}

Override and activate this workflow instead?`))return;if(u=await z(s.id,d,{override:!0,reason:"Manual override"}),!u){alert("Override failed");return}}u.status==="passive"?alert("Activated (passive). Sinks/transforms configured on device."):u.appId?alert(`Activated! App: ${u.appId}, Status: ${u.status}`):alert("Activation result: "+u.status),L()});const m=d=>{f.contains(d.target)||(f.remove(),document.removeEventListener("click",m))};setTimeout(()=>document.addEventListener("click",m),0)}),(A=(_=l())==null?void 0:_.querySelector("#wf-stream-start-btn"))==null||A.addEventListener("click",async()=>{var f;if(W()){C({type:"start_stream"});return}const s=y(),p=((f=s==null?void 0:s.settings)==null?void 0:f.targetDeviceId)??null,w=await We(p);if(!w){alert("No live session found. Open the app on a device first.");return}oe(w);const b=()=>{W()?C({type:"start_stream"}):setTimeout(b,200)};setTimeout(b,300)}),(N=(T=l())==null?void 0:T.querySelector("#wf-stream-stop-btn"))==null||N.addEventListener("click",()=>{W()&&C({type:"stop_stream"})}),(V=(H=l())==null?void 0:H.querySelector("#wf-test-btn"))==null||V.addEventListener("click",()=>{var w;const s=(w=l())==null?void 0:w.querySelector("#wf-testing-panel");if(!s)return;const p=s.style.display!=="none";s.style.display=p?"none":"flex",p||L()}),(U=(D=l())==null?void 0:D.querySelector("#wf-testing-close"))==null||U.addEventListener("click",()=>{var p;const s=(p=l())==null?void 0:p.querySelector("#wf-testing-panel");s&&(s.style.display="none")}),document.addEventListener("keydown",re),(K=l())==null||K.addEventListener("click",s=>{s.target.closest(".wf-flow-dot")&&(s.stopPropagation(),De(!0))})}function ve(){const e=l();if(!e)return;const r=window.innerWidth<=768;e.querySelectorAll(".wf-mobile-toggle").forEach(a=>{a.style.display=r?"inline-flex":"none"}),e.querySelectorAll(".wf-toolbar-desktop").forEach(a=>{a.style.display=r?"none":"inline-flex"});const c=e.querySelector("#wf-fab-group");c&&(c.style.display=r?"flex":"none")}function tt(){var a,n,v;const e=l();if(!e)return;(a=e.querySelector("#wf-nodes-toggle"))==null||a.addEventListener("click",()=>{const t=e.querySelector("#wf-palette"),i=e.querySelector("#wf-scrim");if(!t)return;const o=t.classList.contains("mobile-open");O(),o||(t.classList.add("mobile-open"),i==null||i.classList.add("active"))}),(n=e.querySelector("#wf-config-toggle"))==null||n.addEventListener("click",()=>{const t=e.querySelector("#wf-config-panel"),i=e.querySelector("#wf-scrim");if(!t)return;const o=t.classList.contains("mobile-open");O(),o||(t.classList.add("mobile-open"),i==null||i.classList.add("active"))}),(v=e.querySelector("#wf-scrim"))==null||v.addEventListener("click",()=>{O()});const r=new MutationObserver(()=>{if(window.innerWidth<=768&&ce()){const t=e.querySelector("#wf-config-panel");t&&!t.classList.contains("mobile-open")&&(O(),t.classList.add("mobile-open"))}}),c=e.querySelector("#wf-canvas-wrap");c&&r.observe(c,{childList:!0,subtree:!0}),window.addEventListener("resize",()=>ve())}function O(){var r,c,a;const e=l();e&&((r=e.querySelector("#wf-palette"))==null||r.classList.remove("mobile-open"),(c=e.querySelector("#wf-config-panel"))==null||c.classList.remove("mobile-open"),(a=e.querySelector("#wf-scrim"))==null||a.classList.remove("active"))}let B=null;async function L(){var v;const e=(v=l())==null?void 0:v.querySelector("#wf-testing-body");if(!e)return;const[r,c]=await Promise.all([ne(),R()]),a=c.filter(t=>t.live),n=y();if(r.length===0){e.innerHTML='<p class="empty-state" style="font-size:11px;color:var(--text-tertiary)">No registered devices found. Open the app on a device to register it.</p>';return}e.innerHTML=r.map(t=>{const i=a.find(V=>{var D;return((D=V.device)==null?void 0:D.deviceId)===t.device_id}),o=!!i,g=o&&i.publisherStandby===!1;o&&i.publisherStandby;const x=(i==null?void 0:i.activeWorkflowId)===(n==null?void 0:n.id),I=o?g?'<span class="wf-testing-badge wf-testing-badge-streaming">Streaming</span>':'<span class="wf-testing-badge wf-testing-badge-standby">Standby</span>':'<span class="wf-testing-badge wf-testing-badge-offline">Offline</span>',_=x?'<span class="wf-testing-badge wf-testing-badge-activated">Activated</span>':"",A=!o&&!!t.apnsToken,T=o&&!x,N=o&&!g,H=g;return`
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
    `}).join(""),e.querySelectorAll(".wf-test-wake:not([disabled])").forEach(t=>{t.addEventListener("click",async()=>{const i=t.dataset.deviceId,o=await j(i);if(!(o!=null&&o.ok)){alert((o==null?void 0:o.error)??"Wake failed");return}setTimeout(L,3e3)})}),e.querySelectorAll(".wf-test-activate:not([disabled])").forEach(t=>{t.addEventListener("click",async()=>{const i=y(),o=t.dataset.sessionId;if(!(i!=null&&i.id)||!o)return;let g=await z(i.id,o);if(!g){alert("Activation failed");return}if(g.status==="conflict"&&g.conflict){if(!confirm("Session has active AI. Override?"))return;if(g=await z(i.id,o,{override:!0,reason:"Manual override"}),!g){alert("Override failed");return}}setTimeout(L,1500)})}),e.querySelectorAll(".wf-test-start-stream:not([disabled])").forEach(t=>{t.addEventListener("click",async()=>{const i=t.dataset.sessionId;if(!i)return;const o=await Oe(i);if(!(o!=null&&o.ok)){alert((o==null?void 0:o.error)??"Stream failed");return}setTimeout(L,2e3)})}),e.querySelectorAll(".wf-test-stop-stream").forEach(t=>{t.addEventListener("click",async()=>{const i=t.dataset.sessionId;if(!i)return;const o=await Ce(i);if(!(o!=null&&o.ok)){alert((o==null?void 0:o.error)??"Stop failed");return}setTimeout(L,1500)})})}function st(){we(),B=setInterval(()=>{var r;const e=(r=l())==null?void 0:r.querySelector("#wf-testing-panel");e&&e.style.display!=="none"&&L()},15e3)}function we(){B&&(clearInterval(B),B=null)}let E=null;function it(e,r){E&&(le(E),E=null),se(),r&&(e&&oe(e),Me(r),st(),E=()=>{const c=y(),a=l();if(!c||!a)return;const n=a.querySelector("#wf-canvas-wrap");if(!n)return;const v=Fe(),t=new Map;for(const[,N]of v)t.set(N.nodeId,N.executionState);const i=W(),o=n.querySelector("#wf-fab-group"),g=o?o.outerHTML:pe();n.innerHTML=Ye(c,je(),ce(),t,1,"wf-svg",void 0,i,v)+g,ie(),ue();const h=a.querySelector("#wf-preview-status");h&&(h.style.display=W()?"":"none");const x=de(),I=a.querySelector("#wf-stream-start-btn"),_=a.querySelector("#wf-stream-stop-btn"),A=W();I&&(I.disabled=!A||x==="live"),_&&(_.disabled=!A||x!=="live");const T=a.querySelector("#wf-fab-stream");T&&(T.textContent=x==="live"?"Stop":"Stream"),ae()},Pe(E))}function at(){E&&(le(E),E=null),se(),we(),Ge()}const lt={init(e){Ke(e),nt()},destroy(){const e=X();e&&(clearInterval(e),ee(null)),document.removeEventListener("keydown",re),at(),Ue(),Je()}};function nt(){const e=Re();e==="list"?Ze():fe(e==="new")}export{lt as default,lt as page};
