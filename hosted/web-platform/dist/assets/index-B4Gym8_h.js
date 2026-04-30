import{s as Y,p as c,q as se,e as v,n as ae,r as j,t as T,u as z,v as ne,x as q,y as ie,z as oe,A as re,B as le,C as x,D as y,E as G,F as ce,G as de,H as P,I as fe,J as ue,K as pe,L as O,M as we,N as C,O as ve,P as R,Q as X,R as F,S as M,T as be,U as ge,V as ye,g as me,a as Se,W as he,X as A,Y as ke,Z as $e,_ as V,$ as H,a0 as Le,a1 as Ee,a2 as Ie,a3 as J,a4 as B,a5 as _e,a6 as qe,a7 as xe,a8 as Ae,a9 as Te,aa as Pe,ab as Me,ac as Ne,ad as De}from"./main-BpcJlS5E.js";import"./modulepreload-polyfill-B5Qt9EMX.js";async function We(){var o;const e=c();e&&(e.innerHTML=`
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
  `,(o=e.querySelector("#wf-new-btn"))==null||o.addEventListener("click",()=>{location.hash="/workflows/new"}),await N(),T()&&clearInterval(T()),Y(setInterval(()=>N(),15e3)))}async function N(){var l;const e=(l=c())==null?void 0:l.querySelector("#wf-list");if(!e)return;const o=await se();if(o.length===0){e.innerHTML='<p class="empty-state">No workflows yet. Click "+ New" to create one.</p>';return}e.innerHTML=o.map(i=>{const s=i.status==="published"?"wf-status-published":i.status==="archived"?"wf-status-archived":"wf-status-draft";return`
      <div class="wf-card" data-id="${v(i.id)}">
        <div class="wf-card-header">
          <span class="wf-card-name">${v(i.name)}</span>
          <span class="wf-card-status ${s}">${v(i.status)}</span>
        </div>
        <p class="wf-card-desc">${v(i.description||"No description")}</p>
        <div class="wf-card-meta">
          <span>${i.nodeCount} nodes</span>
          <span>${ae(i.updatedAt)}</span>
        </div>
        <div class="wf-card-actions">
          <button class="btn btn-sm wf-edit-btn" data-id="${v(i.id)}">Edit</button>
          <button class="btn btn-sm btn-danger wf-delete-btn" data-id="${v(i.id)}">Delete</button>
        </div>
      </div>
    `}).join(""),e.querySelectorAll(".wf-edit-btn").forEach(i=>{i.addEventListener("click",()=>{location.hash=`/workflows/${i.dataset.id}`})}),e.querySelectorAll(".wf-delete-btn").forEach(i=>{i.addEventListener("click",async()=>{confirm("Delete this workflow?")&&(await j(i.dataset.id),await N())})})}const U={"deepgram-stt":{status:"unavailable",reason:"Deepgram integration pending"},"jepa-vision":{status:"unavailable",reason:"JEPA integration pending"},"jepa-trigger":{status:"unavailable",reason:"JEPA integration pending"}};function Oe(e){return Ce(e)==="available"}function Ce(e){var o;return((o=U[e])==null?void 0:o.status)??"available"}function Ve(e){var o;return((o=U[e])==null?void 0:o.reason)??null}async function K(e){const o=c();if(!o)return;if(P(!1),X(null),Le(0),Ee(0),Ie(1),await ne(),e){const s=Date.now();q({id:"",name:"Untitled Workflow",description:"",status:"draft",ownerId:null,nodes:[{id:`n_cam_${s}`,type:"camera-source",label:"Camera",config:{visionFps:1,codec:"jpeg"},positionX:50,positionY:160},{id:`n_mic_${s}`,type:"phone-mic-source",label:"Phone Mic",config:{},positionX:50,positionY:280},{id:`n_txt_${s}`,type:"text",label:"Text Content",config:{text:"You are a helpful assistant."},positionX:320,positionY:100},{id:`n_ai_${s}`,type:"s2s-live",label:"AI Assistant",config:{model:"gemini-2.5-flash-native-audio-latest"},positionX:320,positionY:260},{id:`n_ovl_${s}`,type:"overlays",label:"Overlays",config:{},positionX:600,positionY:260}],edges:[{id:`e_cam_ai_${s}`,sourceNodeId:`n_cam_${s}`,targetNodeId:`n_ai_${s}`},{id:`e_mic_ai_${s}`,sourceNodeId:`n_mic_${s}`,targetNodeId:`n_ai_${s}`},{id:`e_txt_ai_${s}`,sourceNodeId:`n_txt_${s}`,targetNodeId:`n_ai_${s}`},{id:`e_ai_ovl_${s}`,sourceNodeId:`n_ai_${s}`,targetNodeId:`n_ovl_${s}`}],canvasViewport:{x:0,y:0,zoom:1},flowConfig:null,settings:null,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()})}else{const s=ie();if(!s){location.hash="/workflows";return}const d=await oe(s);if(!d){location.hash="/workflows";return}q(d)}const l=y(),i=l.id?await re(l.id):null;o.innerHTML=`
    <div class="page workflow-editor-page">
      <div class="wf-editor-layout">
        <div class="wf-palette" id="wf-palette">
          ${Be()}
        </div>
        <div class="wf-scrim" id="wf-scrim"></div>
        <div class="wf-canvas-wrap" id="wf-canvas-wrap">
          ${le()}
          ${Z()}
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
        <span id="wf-preview-status" style="font-size:11px;margin-left:8px;${i?"":"display:none"}">
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
  `,Ye(),je(),Q(),Ge(i,l.id),ee(),x()}const He=[{label:"Inputs",accent:"#14b8a6",match:e=>e.role==="source"&&e.type!=="gesture-source"},{label:"AI",accent:"#22c55e",match:e=>e.activationMode==="ai"||e.activationMode==="jepa"},{label:"Vision",accent:"#8b5cf6",match:e=>e.activationMode==="vision"},{label:"Enhance",accent:"#84cc16",match:e=>e.activationMode==="enhance"},{label:"Audio",accent:"#06b6d4",match:e=>e.activationMode==="speech"||e.activationMode==="stt"},{label:"Sensors",accent:"#06b6d4",match:e=>e.activationMode==="sensor"},{label:"Triggers",accent:"#eab308",match:e=>e.role==="trigger"||e.type==="gesture-source"},{label:"Outputs",accent:"#f97316",match:e=>e.role==="sink"||e.role==="transform"},{label:"Reference",accent:"#94a3b8",match:e=>e.role==="reference"}];function Be(){const e=ye(),o=new Set;return He.map(l=>{const i=e.filter(s=>!o.has(s.type)&&l.match(s));return i.forEach(s=>o.add(s.type)),i.length===0?"":`
        <h3 class="wf-palette-title" style="border-left:3px solid ${l.accent};padding-left:6px">${l.label}</h3>
        ${i.map(s=>{const d=(s.runtime??[]).map(f=>f==="mobile"?'<span class="wf-rt-badge" style="background:#06b6d4">MOB</span>':'<span class="wf-rt-badge" style="background:#8b5cf6">SRV</span>').join(""),a=Oe(s.type),t=a?"":`<span class="wf-avail-badge" title="${v(Ve(s.type)??"")}">&#x1f512;</span>`;return`
                  <button class="${a?"wf-palette-item":"wf-palette-item wf-palette-item-locked"}" data-type="${s.type}" ${a?"":"disabled"}>
                    <span class="wf-palette-dot" style="background:${s.color.header}"></span>
                    <span class="wf-palette-label">${v(s.label)}</span>
                    <span class="wf-palette-runtime">${d}${t}</span>
                  </button>`}).join("")}`}).join("")}function Z(){return`
    <div class="wf-fab-group" id="wf-fab-group">
      <button class="wf-fab wf-fab-primary" id="wf-fab-toggle">&#8230;</button>
    </div>`}function Q(){var l;const e=c(),o=e==null?void 0:e.querySelector("#wf-fab-group");o&&((l=o.querySelector("#wf-fab-toggle"))==null||l.addEventListener("click",()=>{var d;const i=(d=c())==null?void 0:d.querySelector("#wf-testing-panel");if(!i)return;const s=i.style.display!=="none";i.style.display=s?"none":"flex",s||g()}))}function Ye(){var e,o,l,i,s,d,a,t,n,f,m,w,L,E;G(),(e=c())==null||e.querySelectorAll(".wf-palette-item").forEach(r=>{r.addEventListener("click",()=>{const u=y();if(!u)return;const p=r.dataset.type,b=ce(p),k=de(),S=u.nodes.length*30,I=b?{...b.defaultConfig}:{};u.nodes.push({id:k,type:p,label:(b==null?void 0:b.defaultLabel)??p.replace(/-/g," "),config:I,positionX:200+S,positionY:150+S}),P(!0),fe(),ue(),$()})}),(l=(o=c())==null?void 0:o.querySelector("#wf-save-btn"))==null||l.addEventListener("click",async()=>{await pe();const r=y();if(r!=null&&r.id&&r.status!=="published"){const u=await O(r.id,{status:"published"});u&&q(u)}we()}),(s=(i=c())==null?void 0:i.querySelector("#wf-publish-btn"))==null||s.addEventListener("click",async()=>{var k,S,I,D;const r=y();if(!(r!=null&&r.id)||C()&&!confirm("You have unsaved changes. Save before publishing?"))return;const p={status:r.status==="published"?"draft":"published"};C()&&(r.name=((S=(k=c())==null?void 0:k.querySelector("#wf-name"))==null?void 0:S.value)??r.name,r.description=((D=(I=c())==null?void 0:I.querySelector("#wf-desc"))==null?void 0:D.value)??r.description,p.name=r.name,p.description=r.description,p.nodes=r.nodes.map(W=>({...W,config:JSON.stringify(W.config)})),p.edges=r.edges);const b=await O(r.id,p);b&&(q(b),P(!1)),K(!1)}),(a=(d=c())==null?void 0:d.querySelector("#wf-del-btn"))==null||a.addEventListener("click",async()=>{const r=y();r!=null&&r.id&&confirm("Delete this workflow?")&&(await j(r.id),location.hash="/workflows")}),(n=(t=c())==null?void 0:t.querySelector("#wf-settings-btn"))==null||n.addEventListener("click",()=>{const r=Ae();ve(!r),x()}),(m=(f=c())==null?void 0:f.querySelector("#wf-test-btn"))==null||m.addEventListener("click",()=>{var p;const r=(p=c())==null?void 0:p.querySelector("#wf-testing-panel");if(!r)return;const u=r.style.display!=="none";r.style.display=u?"none":"flex",u||g()}),(L=(w=c())==null?void 0:w.querySelector("#wf-testing-close"))==null||L.addEventListener("click",()=>{var u;const r=(u=c())==null?void 0:u.querySelector("#wf-testing-panel");r&&(r.style.display="none")}),document.addEventListener("keydown",R),(E=c())==null||E.addEventListener("click",r=>{r.target.closest(".wf-flow-dot")&&(r.stopPropagation(),X(null),x())})}function ee(){const e=c();if(!e)return;const o=window.innerWidth<=768;e.querySelectorAll(".wf-mobile-toggle").forEach(i=>{i.style.display=o?"inline-flex":"none"}),e.querySelectorAll(".wf-toolbar-desktop").forEach(i=>{i.style.display=o?"none":"inline-flex"});const l=e.querySelector("#wf-fab-group");l&&(l.style.display=o?"flex":"none")}function je(){var i,s,d;const e=c();if(!e)return;(i=e.querySelector("#wf-nodes-toggle"))==null||i.addEventListener("click",()=>{const a=e.querySelector("#wf-palette"),t=e.querySelector("#wf-scrim");if(!a)return;const n=a.classList.contains("mobile-open");$(),n||(a.classList.add("mobile-open"),t==null||t.classList.add("active"))}),(s=e.querySelector("#wf-config-toggle"))==null||s.addEventListener("click",()=>{const a=e.querySelector("#wf-config-panel"),t=e.querySelector("#wf-scrim");if(!a)return;const n=a.classList.contains("mobile-open");$(),n||(a.classList.add("mobile-open"),t==null||t.classList.add("active"))}),(d=e.querySelector("#wf-scrim"))==null||d.addEventListener("click",()=>{$()});const o=new MutationObserver(()=>{if(window.innerWidth<=768&&F()){const a=e.querySelector("#wf-config-panel");a&&!a.classList.contains("mobile-open")&&($(),a.classList.add("mobile-open"))}}),l=e.querySelector("#wf-canvas-wrap");l&&o.observe(l,{childList:!0,subtree:!0}),window.addEventListener("resize",()=>ee())}function $(){var o,l,i;const e=c();e&&((o=e.querySelector("#wf-palette"))==null||o.classList.remove("mobile-open"),(l=e.querySelector("#wf-config-panel"))==null||l.classList.remove("mobile-open"),(i=e.querySelector("#wf-scrim"))==null||i.classList.remove("active"))}let _=null;async function g(){var d;const e=(d=c())==null?void 0:d.querySelector("#wf-testing-body");if(!e)return;const[o,l]=await Promise.all([me(),Se()]),i=l.filter(a=>a.live),s=y();if(o.length===0){e.innerHTML='<p class="empty-state" style="font-size:11px;color:var(--text-tertiary)">No registered devices found. Open the app on a device to register it.</p>';return}e.innerHTML=o.map(a=>{const t=i.find(k=>{var S;return((S=k.device)==null?void 0:S.deviceId)===a.device_id}),n=!!t,f=n&&t.publisherStandby===!1;n&&t.publisherStandby;const w=(t==null?void 0:t.activeWorkflowId)===(s==null?void 0:s.id),L=n?f?'<span class="wf-testing-badge wf-testing-badge-streaming">Streaming</span>':'<span class="wf-testing-badge wf-testing-badge-standby">Standby</span>':'<span class="wf-testing-badge wf-testing-badge-offline">Offline</span>',E=w?'<span class="wf-testing-badge wf-testing-badge-activated">Activated</span>':"",r=!n&&!!a.apnsToken,u=n&&!w,p=n&&!f,b=f;return`
      <div class="wf-testing-device-card" data-device-id="${a.device_id}">
        <div class="wf-testing-device-header">
          <div>
            <div class="wf-testing-device-name">${v(a.deviceName??a.device_id.slice(0,12))}</div>
            <div class="wf-testing-device-model">${v(a.deviceModel??"")}</div>
          </div>
        </div>
        <div class="wf-testing-device-status">
          ${L} ${E}
        </div>
        <div class="wf-testing-device-actions">
          <button class="btn wf-test-wake" data-device-id="${a.device_id}" ${r?"":"disabled"}>Wake</button>
          ${w?`<button class="btn wf-test-deactivate" data-session-id="${t.sessionId}" style="border-color:rgba(248,113,113,0.4)">Stop</button>
               <button class="btn wf-test-rerun" data-session-id="${t.sessionId}">Re-run</button>`:`<button class="btn wf-test-activate" data-session-id="${(t==null?void 0:t.sessionId)??""}" ${u?"":"disabled"}>Activate</button>`}
          ${b?`<button class="btn wf-test-stop-stream" data-session-id="${t.sessionId}" style="border-color:rgba(248,113,113,0.4)">Stop Stream</button>`:`<button class="btn wf-test-start-stream" data-session-id="${(t==null?void 0:t.sessionId)??""}" ${p?"":"disabled"}>Stream</button>`}
        </div>
      </div>
    `}).join(""),e.querySelectorAll(".wf-test-wake:not([disabled])").forEach(a=>{a.addEventListener("click",async()=>{const t=a.dataset.deviceId,n=await he(t);if(!(n!=null&&n.ok)){alert((n==null?void 0:n.error)??"Wake failed");return}setTimeout(g,3e3)})}),e.querySelectorAll(".wf-test-activate:not([disabled])").forEach(a=>{a.addEventListener("click",async()=>{const t=y(),n=a.dataset.sessionId;if(!(t!=null&&t.id)||!n)return;let f=await A(t.id,n);if(!f){alert("Activation failed");return}if(f.status==="conflict"&&f.conflict){if(!confirm("Session has active AI. Override?"))return;if(f=await A(t.id,n,{override:!0,reason:"Manual override"}),!f){alert("Override failed");return}}setTimeout(g,1500)})}),e.querySelectorAll(".wf-test-start-stream:not([disabled])").forEach(a=>{a.addEventListener("click",async()=>{const t=a.dataset.sessionId;if(!t)return;const n=await ke(t);if(!(n!=null&&n.ok)){alert((n==null?void 0:n.error)??"Stream failed");return}setTimeout(g,2e3)})}),e.querySelectorAll(".wf-test-stop-stream").forEach(a=>{a.addEventListener("click",async()=>{const t=a.dataset.sessionId;if(!t)return;const n=await $e(t);if(!(n!=null&&n.ok)){alert((n==null?void 0:n.error)??"Stop failed");return}setTimeout(g,1500)})}),e.querySelectorAll(".wf-test-deactivate").forEach(a=>{a.addEventListener("click",async()=>{const t=a.dataset.sessionId;if(!t)return;H()!==t&&(M(t),await new Promise(f=>setTimeout(f,500))),V({type:"deactivate_app"}),setTimeout(g,1500)})}),e.querySelectorAll(".wf-test-rerun").forEach(a=>{a.addEventListener("click",async()=>{const t=y(),n=a.dataset.sessionId;if(!(t!=null&&t.id)||!n)return;if(H()!==n&&(M(n),await new Promise(w=>setTimeout(w,500))),V({type:"deactivate_app"}),await new Promise(w=>setTimeout(w,1e3)),!await A(t.id,n,{override:!0,reason:"Re-run"})){alert("Re-run failed");return}setTimeout(g,1500)})})}function ze(){te(),_=setInterval(()=>{var o;const e=(o=c())==null?void 0:o.querySelector("#wf-testing-panel");e&&e.style.display!=="none"&&g()},15e3)}function te(){_&&(clearInterval(_),_=null)}let h=null;function Ge(e,o){h&&(J(h),h=null),z(),o&&(e&&M(e),be(o),ze(),h=()=>{const l=y(),i=c();if(!l||!i)return;const s=i.querySelector("#wf-canvas-wrap");if(!s)return;const d=Te(),a=new Map;for(const[,w]of d)a.set(w.nodeId,w.executionState);const t=B(),n=s.querySelector("#wf-fab-group"),f=n?n.outerHTML:Z();s.innerHTML=_e(l,qe(),F(),a,1,"wf-svg",void 0,t,d)+f,G(),Q();const m=i.querySelector("#wf-preview-status");m&&(m.style.display=B()?"":"none"),x()},ge(h))}function Re(){h&&(J(h),h=null),z(),te(),xe()}const Ue={init(e){De(e),Xe()},destroy(){const e=T();e&&(clearInterval(e),Y(null)),document.removeEventListener("keydown",R),Re(),Ne(),Pe()}};function Xe(){const e=Me();e==="list"?We():K(e==="new")}export{Ue as default,Ue as page};
