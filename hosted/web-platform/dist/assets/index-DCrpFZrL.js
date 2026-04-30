import{s as z,p as c,q as te,e as v,n as se,r as B,t as A,u as G,v as ne,x as q,y as ie,z as ae,A as oe,B as re,C as x,D as y,E as le,F as X,G as ce,H as de,I as P,J as fe,K as ue,L as pe,M as O,N as we,O as C,P as ve,Q as j,R as F,S as R,T as M,U as be,V as ge,g as ye,a as me,W as Se,X as T,Y as he,Z as ke,_ as V,$ as H,a0 as Le,a1 as $e,a2 as _e,a3 as J,a4 as Y,a5 as Ee,a6 as Ie,a7 as qe,a8 as xe,a9 as Te,aa as Ae,ab as Pe,ac as Me,ad as Ne}from"./main-CwVPW-ON.js";import"./modulepreload-polyfill-B5Qt9EMX.js";async function We(){var r;const e=c();e&&(e.innerHTML=`
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
  `,(r=e.querySelector("#wf-new-btn"))==null||r.addEventListener("click",()=>{location.hash="/workflows/new"}),await N(),A()&&clearInterval(A()),z(setInterval(()=>N(),15e3)))}async function N(){var l;const e=(l=c())==null?void 0:l.querySelector("#wf-list");if(!e)return;const r=await te();if(r.length===0){e.innerHTML='<p class="empty-state">No workflows yet. Click "+ New" to create one.</p>';return}e.innerHTML=r.map(a=>{const i=a.status==="published"?"wf-status-published":a.status==="archived"?"wf-status-archived":"wf-status-draft";return`
      <div class="wf-card" data-id="${v(a.id)}">
        <div class="wf-card-header">
          <span class="wf-card-name">${v(a.name)}</span>
          <span class="wf-card-status ${i}">${v(a.status)}</span>
        </div>
        <p class="wf-card-desc">${v(a.description||"No description")}</p>
        <div class="wf-card-meta">
          <span>${a.nodeCount} nodes</span>
          <span>${se(a.updatedAt)}</span>
        </div>
        <div class="wf-card-actions">
          <button class="btn btn-sm wf-edit-btn" data-id="${v(a.id)}">Edit</button>
          <button class="btn btn-sm btn-danger wf-delete-btn" data-id="${v(a.id)}">Delete</button>
        </div>
      </div>
    `}).join(""),e.querySelectorAll(".wf-edit-btn").forEach(a=>{a.addEventListener("click",()=>{location.hash=`/workflows/${a.dataset.id}`})}),e.querySelectorAll(".wf-delete-btn").forEach(a=>{a.addEventListener("click",async()=>{confirm("Delete this workflow?")&&(await B(a.dataset.id),await N())})})}async function U(e){const r=c();if(!r)return;if(P(!1),F(null),Le(0),$e(0),_e(1),await ne(),e){const i=Date.now();q({id:"",name:"Untitled Workflow",description:"",status:"draft",ownerId:null,nodes:[{id:`n_cam_${i}`,type:"camera-source",label:"Camera",config:{visionFps:1,codec:"jpeg"},positionX:50,positionY:160},{id:`n_mic_${i}`,type:"phone-mic-source",label:"Phone Mic",config:{},positionX:50,positionY:280},{id:`n_txt_${i}`,type:"text",label:"Text Content",config:{text:"You are a helpful assistant."},positionX:320,positionY:100},{id:`n_ai_${i}`,type:"s2s-live",label:"AI Assistant",config:{model:"gemini-2.5-flash-native-audio-latest"},positionX:320,positionY:260},{id:`n_ovl_${i}`,type:"overlays",label:"Overlays",config:{},positionX:600,positionY:260}],edges:[{id:`e_cam_ai_${i}`,sourceNodeId:`n_cam_${i}`,targetNodeId:`n_ai_${i}`},{id:`e_mic_ai_${i}`,sourceNodeId:`n_mic_${i}`,targetNodeId:`n_ai_${i}`},{id:`e_txt_ai_${i}`,sourceNodeId:`n_txt_${i}`,targetNodeId:`n_ai_${i}`},{id:`e_ai_ovl_${i}`,sourceNodeId:`n_ai_${i}`,targetNodeId:`n_ovl_${i}`}],canvasViewport:{x:0,y:0,zoom:1},flowConfig:null,settings:null,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()})}else{const i=ie();if(!i){location.hash="/workflows";return}const d=await ae(i);if(!d){location.hash="/workflows";return}q(d)}const l=y(),a=l.id?await oe(l.id):null;r.innerHTML=`
    <div class="page workflow-editor-page">
      <div class="wf-editor-layout">
        <div class="wf-palette" id="wf-palette">
          ${De()}
        </div>
        <div class="wf-scrim" id="wf-scrim"></div>
        <div class="wf-canvas-wrap" id="wf-canvas-wrap">
          ${re()}
          ${K()}
        </div>
        <div class="wf-config-panel" id="wf-config-panel">
          <p class="empty-state">Select a node</p>
        </div>
      </div>
      <div class="wf-toolbar">
        <input type="text" class="wf-toolbar-input" id="wf-name" value="${v(l.name)}" placeholder="Workflow name" />
        <input type="text" class="wf-toolbar-input wf-toolbar-desc" id="wf-desc" value="${v(l.description)}" placeholder="Description" />
        <button class="btn btn-primary" id="wf-save-btn">Save</button>
        <span id="wf-save-status" style="font-size:11px;color:var(--text-tertiary);margin-left:4px;">Saved</span>
        <button class="btn" id="wf-publish-btn">${l.status==="published"?"Unpublish":"Publish"}</button>
        <button class="btn btn-danger" id="wf-del-btn">Delete</button>
        <button class="btn" id="wf-settings-btn">Settings</button>
        <span class="wf-toolbar-sep" style="width:1px;height:20px;background:var(--border);margin:0 4px;display:inline-block;vertical-align:middle"></span>
        <button class="btn" id="wf-test-btn" title="Open fleet testing panel">Testing</button>
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
  `,Oe(),Ce(),Z(),He(a,l.id),Q(),x()}function De(){return[{role:"source",label:"Source"},{role:"reference",label:"Reference"},{role:"processor",label:"Processor"},{role:"trigger",label:"Trigger"},{role:"transform",label:"Transform"},{role:"sink",label:"Sink"}].map(({role:r,label:l})=>{const a=le().filter(i=>i.role===r);return a.length===0?"":`
        <h3 class="wf-palette-title">${l}</h3>
        ${a.map(i=>{const d=(i.runtime??[]).map(s=>s==="mobile"?'<span class="wf-rt-badge" style="background:#06b6d4">MOB</span>':'<span class="wf-rt-badge" style="background:#8b5cf6">SRV</span>').join("");return`
                  <button class="wf-palette-item" data-type="${i.type}">
                    <span class="wf-palette-dot" style="background:${i.color.header}"></span>
                    <span class="wf-palette-label">${v(i.label)}</span>
                    <span class="wf-palette-runtime">${d}</span>
                  </button>`}).join("")}`}).join("")}function K(){return`
    <div class="wf-fab-group" id="wf-fab-group">
      <button class="wf-fab wf-fab-primary" id="wf-fab-toggle">&#8230;</button>
    </div>`}function Z(){var l;const e=c(),r=e==null?void 0:e.querySelector("#wf-fab-group");r&&((l=r.querySelector("#wf-fab-toggle"))==null||l.addEventListener("click",()=>{var d;const a=(d=c())==null?void 0:d.querySelector("#wf-testing-panel");if(!a)return;const i=a.style.display!=="none";a.style.display=i?"none":"flex",i||g()}))}function Oe(){var e,r,l,a,i,d,s,t,n,f,m,w,$,_;X(),(e=c())==null||e.querySelectorAll(".wf-palette-item").forEach(o=>{o.addEventListener("click",()=>{const u=y();if(!u)return;const p=o.dataset.type,b=ce(p),k=de(),S=u.nodes.length*30,E=b?{...b.defaultConfig}:{};u.nodes.push({id:k,type:p,label:(b==null?void 0:b.defaultLabel)??p.replace(/-/g," "),config:E,positionX:200+S,positionY:150+S}),P(!0),fe(),ue(),L()})}),(l=(r=c())==null?void 0:r.querySelector("#wf-save-btn"))==null||l.addEventListener("click",async()=>{await pe();const o=y();if(o!=null&&o.id&&o.status!=="published"){const u=await O(o.id,{status:"published"});u&&q(u)}we()}),(i=(a=c())==null?void 0:a.querySelector("#wf-publish-btn"))==null||i.addEventListener("click",async()=>{var k,S,E,W;const o=y();if(!(o!=null&&o.id)||C()&&!confirm("You have unsaved changes. Save before publishing?"))return;const p={status:o.status==="published"?"draft":"published"};C()&&(o.name=((S=(k=c())==null?void 0:k.querySelector("#wf-name"))==null?void 0:S.value)??o.name,o.description=((W=(E=c())==null?void 0:E.querySelector("#wf-desc"))==null?void 0:W.value)??o.description,p.name=o.name,p.description=o.description,p.nodes=o.nodes.map(D=>({...D,config:JSON.stringify(D.config)})),p.edges=o.edges);const b=await O(o.id,p);b&&(q(b),P(!1)),U(!1)}),(s=(d=c())==null?void 0:d.querySelector("#wf-del-btn"))==null||s.addEventListener("click",async()=>{const o=y();o!=null&&o.id&&confirm("Delete this workflow?")&&(await B(o.id),location.hash="/workflows")}),(n=(t=c())==null?void 0:t.querySelector("#wf-settings-btn"))==null||n.addEventListener("click",()=>{const o=xe();ve(!o),x()}),(m=(f=c())==null?void 0:f.querySelector("#wf-test-btn"))==null||m.addEventListener("click",()=>{var p;const o=(p=c())==null?void 0:p.querySelector("#wf-testing-panel");if(!o)return;const u=o.style.display!=="none";o.style.display=u?"none":"flex",u||g()}),($=(w=c())==null?void 0:w.querySelector("#wf-testing-close"))==null||$.addEventListener("click",()=>{var u;const o=(u=c())==null?void 0:u.querySelector("#wf-testing-panel");o&&(o.style.display="none")}),document.addEventListener("keydown",j),(_=c())==null||_.addEventListener("click",o=>{o.target.closest(".wf-flow-dot")&&(o.stopPropagation(),F(null),x())})}function Q(){const e=c();if(!e)return;const r=window.innerWidth<=768;e.querySelectorAll(".wf-mobile-toggle").forEach(a=>{a.style.display=r?"inline-flex":"none"}),e.querySelectorAll(".wf-toolbar-desktop").forEach(a=>{a.style.display=r?"none":"inline-flex"});const l=e.querySelector("#wf-fab-group");l&&(l.style.display=r?"flex":"none")}function Ce(){var a,i,d;const e=c();if(!e)return;(a=e.querySelector("#wf-nodes-toggle"))==null||a.addEventListener("click",()=>{const s=e.querySelector("#wf-palette"),t=e.querySelector("#wf-scrim");if(!s)return;const n=s.classList.contains("mobile-open");L(),n||(s.classList.add("mobile-open"),t==null||t.classList.add("active"))}),(i=e.querySelector("#wf-config-toggle"))==null||i.addEventListener("click",()=>{const s=e.querySelector("#wf-config-panel"),t=e.querySelector("#wf-scrim");if(!s)return;const n=s.classList.contains("mobile-open");L(),n||(s.classList.add("mobile-open"),t==null||t.classList.add("active"))}),(d=e.querySelector("#wf-scrim"))==null||d.addEventListener("click",()=>{L()});const r=new MutationObserver(()=>{if(window.innerWidth<=768&&R()){const s=e.querySelector("#wf-config-panel");s&&!s.classList.contains("mobile-open")&&(L(),s.classList.add("mobile-open"))}}),l=e.querySelector("#wf-canvas-wrap");l&&r.observe(l,{childList:!0,subtree:!0}),window.addEventListener("resize",()=>Q())}function L(){var r,l,a;const e=c();e&&((r=e.querySelector("#wf-palette"))==null||r.classList.remove("mobile-open"),(l=e.querySelector("#wf-config-panel"))==null||l.classList.remove("mobile-open"),(a=e.querySelector("#wf-scrim"))==null||a.classList.remove("active"))}let I=null;async function g(){var d;const e=(d=c())==null?void 0:d.querySelector("#wf-testing-body");if(!e)return;const[r,l]=await Promise.all([ye(),me()]),a=l.filter(s=>s.live),i=y();if(r.length===0){e.innerHTML='<p class="empty-state" style="font-size:11px;color:var(--text-tertiary)">No registered devices found. Open the app on a device to register it.</p>';return}e.innerHTML=r.map(s=>{const t=a.find(k=>{var S;return((S=k.device)==null?void 0:S.deviceId)===s.device_id}),n=!!t,f=n&&t.publisherStandby===!1;n&&t.publisherStandby;const w=(t==null?void 0:t.activeWorkflowId)===(i==null?void 0:i.id),$=n?f?'<span class="wf-testing-badge wf-testing-badge-streaming">Streaming</span>':'<span class="wf-testing-badge wf-testing-badge-standby">Standby</span>':'<span class="wf-testing-badge wf-testing-badge-offline">Offline</span>',_=w?'<span class="wf-testing-badge wf-testing-badge-activated">Activated</span>':"",o=!n&&!!s.apnsToken,u=n&&!w,p=n&&!f,b=f;return`
      <div class="wf-testing-device-card" data-device-id="${s.device_id}">
        <div class="wf-testing-device-header">
          <div>
            <div class="wf-testing-device-name">${v(s.deviceName??s.device_id.slice(0,12))}</div>
            <div class="wf-testing-device-model">${v(s.deviceModel??"")}</div>
          </div>
        </div>
        <div class="wf-testing-device-status">
          ${$} ${_}
        </div>
        <div class="wf-testing-device-actions">
          <button class="btn wf-test-wake" data-device-id="${s.device_id}" ${o?"":"disabled"}>Wake</button>
          ${w?`<button class="btn wf-test-deactivate" data-session-id="${t.sessionId}" style="border-color:rgba(248,113,113,0.4)">Stop</button>
               <button class="btn wf-test-rerun" data-session-id="${t.sessionId}">Re-run</button>`:`<button class="btn wf-test-activate" data-session-id="${(t==null?void 0:t.sessionId)??""}" ${u?"":"disabled"}>Activate</button>`}
          ${b?`<button class="btn wf-test-stop-stream" data-session-id="${t.sessionId}" style="border-color:rgba(248,113,113,0.4)">Stop Stream</button>`:`<button class="btn wf-test-start-stream" data-session-id="${(t==null?void 0:t.sessionId)??""}" ${p?"":"disabled"}>Stream</button>`}
        </div>
      </div>
    `}).join(""),e.querySelectorAll(".wf-test-wake:not([disabled])").forEach(s=>{s.addEventListener("click",async()=>{const t=s.dataset.deviceId,n=await Se(t);if(!(n!=null&&n.ok)){alert((n==null?void 0:n.error)??"Wake failed");return}setTimeout(g,3e3)})}),e.querySelectorAll(".wf-test-activate:not([disabled])").forEach(s=>{s.addEventListener("click",async()=>{const t=y(),n=s.dataset.sessionId;if(!(t!=null&&t.id)||!n)return;let f=await T(t.id,n);if(!f){alert("Activation failed");return}if(f.status==="conflict"&&f.conflict){if(!confirm("Session has active AI. Override?"))return;if(f=await T(t.id,n,{override:!0,reason:"Manual override"}),!f){alert("Override failed");return}}setTimeout(g,1500)})}),e.querySelectorAll(".wf-test-start-stream:not([disabled])").forEach(s=>{s.addEventListener("click",async()=>{const t=s.dataset.sessionId;if(!t)return;const n=await he(t);if(!(n!=null&&n.ok)){alert((n==null?void 0:n.error)??"Stream failed");return}setTimeout(g,2e3)})}),e.querySelectorAll(".wf-test-stop-stream").forEach(s=>{s.addEventListener("click",async()=>{const t=s.dataset.sessionId;if(!t)return;const n=await ke(t);if(!(n!=null&&n.ok)){alert((n==null?void 0:n.error)??"Stop failed");return}setTimeout(g,1500)})}),e.querySelectorAll(".wf-test-deactivate").forEach(s=>{s.addEventListener("click",async()=>{const t=s.dataset.sessionId;if(!t)return;H()!==t&&(M(t),await new Promise(f=>setTimeout(f,500))),V({type:"deactivate_app"}),setTimeout(g,1500)})}),e.querySelectorAll(".wf-test-rerun").forEach(s=>{s.addEventListener("click",async()=>{const t=y(),n=s.dataset.sessionId;if(!(t!=null&&t.id)||!n)return;if(H()!==n&&(M(n),await new Promise(w=>setTimeout(w,500))),V({type:"deactivate_app"}),await new Promise(w=>setTimeout(w,1e3)),!await T(t.id,n,{override:!0,reason:"Re-run"})){alert("Re-run failed");return}setTimeout(g,1500)})})}function Ve(){ee(),I=setInterval(()=>{var r;const e=(r=c())==null?void 0:r.querySelector("#wf-testing-panel");e&&e.style.display!=="none"&&g()},15e3)}function ee(){I&&(clearInterval(I),I=null)}let h=null;function He(e,r){h&&(J(h),h=null),G(),r&&(e&&M(e),be(r),Ve(),h=()=>{const l=y(),a=c();if(!l||!a)return;const i=a.querySelector("#wf-canvas-wrap");if(!i)return;const d=Te(),s=new Map;for(const[,w]of d)s.set(w.nodeId,w.executionState);const t=Y(),n=i.querySelector("#wf-fab-group"),f=n?n.outerHTML:K();i.innerHTML=Ee(l,Ie(),R(),s,1,"wf-svg",void 0,t,d)+f,X(),Z();const m=a.querySelector("#wf-preview-status");m&&(m.style.display=Y()?"":"none"),x()},ge(h))}function Ye(){h&&(J(h),h=null),G(),ee(),qe()}const Xe={init(e){Ne(e),ze()},destroy(){const e=A();e&&(clearInterval(e),z(null)),document.removeEventListener("keydown",j),Ye(),Me(),Ae()}};function ze(){const e=Pe();e==="list"?We():U(e==="new")}export{Xe as default,Xe as page};
