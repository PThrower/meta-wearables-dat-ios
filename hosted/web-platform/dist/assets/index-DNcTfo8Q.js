import{s as Y,p as c,q as se,e as v,n as ne,r as z,t as T,u as j,v as ae,x as q,y as ie,z as oe,A as re,B as le,C as x,D as y,E as ce,F as G,G as de,H as fe,I as P,J as ue,K as pe,L as we,M as O,N as ve,O as C,P as be,Q as X,R,S as F,T as N,U as ge,V as ye,g as me,a as Se,W as he,X as A,Y as ke,Z as $e,_ as V,$ as H,a0 as Le,a1 as Ee,a2 as _e,a3 as J,a4 as B,a5 as Ie,a6 as qe,a7 as xe,a8 as Ae,a9 as Te,aa as Pe,ab as Ne,ac as Me,ad as De}from"./main-D1jUnoX4.js";import"./modulepreload-polyfill-B5Qt9EMX.js";async function We(){var r;const e=c();e&&(e.innerHTML=`
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
  `,(r=e.querySelector("#wf-new-btn"))==null||r.addEventListener("click",()=>{location.hash="/workflows/new"}),await M(),T()&&clearInterval(T()),Y(setInterval(()=>M(),15e3)))}async function M(){var l;const e=(l=c())==null?void 0:l.querySelector("#wf-list");if(!e)return;const r=await se();if(r.length===0){e.innerHTML='<p class="empty-state">No workflows yet. Click "+ New" to create one.</p>';return}e.innerHTML=r.map(i=>{const n=i.status==="published"?"wf-status-published":i.status==="archived"?"wf-status-archived":"wf-status-draft";return`
      <div class="wf-card" data-id="${v(i.id)}">
        <div class="wf-card-header">
          <span class="wf-card-name">${v(i.name)}</span>
          <span class="wf-card-status ${n}">${v(i.status)}</span>
        </div>
        <p class="wf-card-desc">${v(i.description||"No description")}</p>
        <div class="wf-card-meta">
          <span>${i.nodeCount} nodes</span>
          <span>${ne(i.updatedAt)}</span>
        </div>
        <div class="wf-card-actions">
          <button class="btn btn-sm wf-edit-btn" data-id="${v(i.id)}">Edit</button>
          <button class="btn btn-sm btn-danger wf-delete-btn" data-id="${v(i.id)}">Delete</button>
        </div>
      </div>
    `}).join(""),e.querySelectorAll(".wf-edit-btn").forEach(i=>{i.addEventListener("click",()=>{location.hash=`/workflows/${i.dataset.id}`})}),e.querySelectorAll(".wf-delete-btn").forEach(i=>{i.addEventListener("click",async()=>{confirm("Delete this workflow?")&&(await z(i.dataset.id),await M())})})}const U={"deepgram-stt":{status:"unavailable",reason:"Deepgram integration pending"},"jepa-vision":{status:"unavailable",reason:"JEPA integration pending"},"jepa-trigger":{status:"unavailable",reason:"JEPA integration pending"}};function Oe(e){return Ce(e)==="available"}function Ce(e){var r;return((r=U[e])==null?void 0:r.status)??"available"}function Ve(e){var r;return((r=U[e])==null?void 0:r.reason)??null}async function K(e){const r=c();if(!r)return;if(P(!1),R(null),Le(0),Ee(0),_e(1),await ae(),e){const n=Date.now();q({id:"",name:"Untitled Workflow",description:"",status:"draft",ownerId:null,nodes:[{id:`n_cam_${n}`,type:"camera-source",label:"Camera",config:{visionFps:1,codec:"jpeg"},positionX:50,positionY:160},{id:`n_mic_${n}`,type:"phone-mic-source",label:"Phone Mic",config:{},positionX:50,positionY:280},{id:`n_txt_${n}`,type:"text",label:"Text Content",config:{text:"You are a helpful assistant."},positionX:320,positionY:100},{id:`n_ai_${n}`,type:"s2s-live",label:"AI Assistant",config:{model:"gemini-2.5-flash-native-audio-latest"},positionX:320,positionY:260},{id:`n_ovl_${n}`,type:"overlays",label:"Overlays",config:{},positionX:600,positionY:260}],edges:[{id:`e_cam_ai_${n}`,sourceNodeId:`n_cam_${n}`,targetNodeId:`n_ai_${n}`},{id:`e_mic_ai_${n}`,sourceNodeId:`n_mic_${n}`,targetNodeId:`n_ai_${n}`},{id:`e_txt_ai_${n}`,sourceNodeId:`n_txt_${n}`,targetNodeId:`n_ai_${n}`},{id:`e_ai_ovl_${n}`,sourceNodeId:`n_ai_${n}`,targetNodeId:`n_ovl_${n}`}],canvasViewport:{x:0,y:0,zoom:1},flowConfig:null,settings:null,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()})}else{const n=ie();if(!n){location.hash="/workflows";return}const d=await oe(n);if(!d){location.hash="/workflows";return}q(d)}const l=y(),i=l.id?await re(l.id):null;r.innerHTML=`
    <div class="page workflow-editor-page">
      <div class="wf-editor-layout">
        <div class="wf-palette" id="wf-palette">
          ${He()}
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
  `,Be(),Ye(),Q(),je(i,l.id),ee(),x()}function He(){return[{role:"source",label:"Source"},{role:"reference",label:"Reference"},{role:"processor",label:"Processor"},{role:"trigger",label:"Trigger"},{role:"transform",label:"Transform"},{role:"sink",label:"Sink"}].map(({role:r,label:l})=>{const i=ce().filter(n=>n.role===r);return i.length===0?"":`
        <h3 class="wf-palette-title">${l}</h3>
        ${i.map(n=>{const d=(n.runtime??[]).map(f=>f==="mobile"?'<span class="wf-rt-badge" style="background:#06b6d4">MOB</span>':'<span class="wf-rt-badge" style="background:#8b5cf6">SRV</span>').join(""),s=Oe(n.type),t=s?"":`<span class="wf-avail-badge" title="${v(Ve(n.type)??"")}">&#x1f512;</span>`;return`
                  <button class="${s?"wf-palette-item":"wf-palette-item wf-palette-item-locked"}" data-type="${n.type}" ${s?"":"disabled"}>
                    <span class="wf-palette-dot" style="background:${n.color.header}"></span>
                    <span class="wf-palette-label">${v(n.label)}</span>
                    <span class="wf-palette-runtime">${d}${t}</span>
                  </button>`}).join("")}`}).join("")}function Z(){return`
    <div class="wf-fab-group" id="wf-fab-group">
      <button class="wf-fab wf-fab-primary" id="wf-fab-toggle">&#8230;</button>
    </div>`}function Q(){var l;const e=c(),r=e==null?void 0:e.querySelector("#wf-fab-group");r&&((l=r.querySelector("#wf-fab-toggle"))==null||l.addEventListener("click",()=>{var d;const i=(d=c())==null?void 0:d.querySelector("#wf-testing-panel");if(!i)return;const n=i.style.display!=="none";i.style.display=n?"none":"flex",n||g()}))}function Be(){var e,r,l,i,n,d,s,t,a,f,m,w,L,E;G(),(e=c())==null||e.querySelectorAll(".wf-palette-item").forEach(o=>{o.addEventListener("click",()=>{const u=y();if(!u)return;const p=o.dataset.type,b=de(p),k=fe(),S=u.nodes.length*30,_=b?{...b.defaultConfig}:{};u.nodes.push({id:k,type:p,label:(b==null?void 0:b.defaultLabel)??p.replace(/-/g," "),config:_,positionX:200+S,positionY:150+S}),P(!0),ue(),pe(),$()})}),(l=(r=c())==null?void 0:r.querySelector("#wf-save-btn"))==null||l.addEventListener("click",async()=>{await we();const o=y();if(o!=null&&o.id&&o.status!=="published"){const u=await O(o.id,{status:"published"});u&&q(u)}ve()}),(n=(i=c())==null?void 0:i.querySelector("#wf-publish-btn"))==null||n.addEventListener("click",async()=>{var k,S,_,D;const o=y();if(!(o!=null&&o.id)||C()&&!confirm("You have unsaved changes. Save before publishing?"))return;const p={status:o.status==="published"?"draft":"published"};C()&&(o.name=((S=(k=c())==null?void 0:k.querySelector("#wf-name"))==null?void 0:S.value)??o.name,o.description=((D=(_=c())==null?void 0:_.querySelector("#wf-desc"))==null?void 0:D.value)??o.description,p.name=o.name,p.description=o.description,p.nodes=o.nodes.map(W=>({...W,config:JSON.stringify(W.config)})),p.edges=o.edges);const b=await O(o.id,p);b&&(q(b),P(!1)),K(!1)}),(s=(d=c())==null?void 0:d.querySelector("#wf-del-btn"))==null||s.addEventListener("click",async()=>{const o=y();o!=null&&o.id&&confirm("Delete this workflow?")&&(await z(o.id),location.hash="/workflows")}),(a=(t=c())==null?void 0:t.querySelector("#wf-settings-btn"))==null||a.addEventListener("click",()=>{const o=Ae();be(!o),x()}),(m=(f=c())==null?void 0:f.querySelector("#wf-test-btn"))==null||m.addEventListener("click",()=>{var p;const o=(p=c())==null?void 0:p.querySelector("#wf-testing-panel");if(!o)return;const u=o.style.display!=="none";o.style.display=u?"none":"flex",u||g()}),(L=(w=c())==null?void 0:w.querySelector("#wf-testing-close"))==null||L.addEventListener("click",()=>{var u;const o=(u=c())==null?void 0:u.querySelector("#wf-testing-panel");o&&(o.style.display="none")}),document.addEventListener("keydown",X),(E=c())==null||E.addEventListener("click",o=>{o.target.closest(".wf-flow-dot")&&(o.stopPropagation(),R(null),x())})}function ee(){const e=c();if(!e)return;const r=window.innerWidth<=768;e.querySelectorAll(".wf-mobile-toggle").forEach(i=>{i.style.display=r?"inline-flex":"none"}),e.querySelectorAll(".wf-toolbar-desktop").forEach(i=>{i.style.display=r?"none":"inline-flex"});const l=e.querySelector("#wf-fab-group");l&&(l.style.display=r?"flex":"none")}function Ye(){var i,n,d;const e=c();if(!e)return;(i=e.querySelector("#wf-nodes-toggle"))==null||i.addEventListener("click",()=>{const s=e.querySelector("#wf-palette"),t=e.querySelector("#wf-scrim");if(!s)return;const a=s.classList.contains("mobile-open");$(),a||(s.classList.add("mobile-open"),t==null||t.classList.add("active"))}),(n=e.querySelector("#wf-config-toggle"))==null||n.addEventListener("click",()=>{const s=e.querySelector("#wf-config-panel"),t=e.querySelector("#wf-scrim");if(!s)return;const a=s.classList.contains("mobile-open");$(),a||(s.classList.add("mobile-open"),t==null||t.classList.add("active"))}),(d=e.querySelector("#wf-scrim"))==null||d.addEventListener("click",()=>{$()});const r=new MutationObserver(()=>{if(window.innerWidth<=768&&F()){const s=e.querySelector("#wf-config-panel");s&&!s.classList.contains("mobile-open")&&($(),s.classList.add("mobile-open"))}}),l=e.querySelector("#wf-canvas-wrap");l&&r.observe(l,{childList:!0,subtree:!0}),window.addEventListener("resize",()=>ee())}function $(){var r,l,i;const e=c();e&&((r=e.querySelector("#wf-palette"))==null||r.classList.remove("mobile-open"),(l=e.querySelector("#wf-config-panel"))==null||l.classList.remove("mobile-open"),(i=e.querySelector("#wf-scrim"))==null||i.classList.remove("active"))}let I=null;async function g(){var d;const e=(d=c())==null?void 0:d.querySelector("#wf-testing-body");if(!e)return;const[r,l]=await Promise.all([me(),Se()]),i=l.filter(s=>s.live),n=y();if(r.length===0){e.innerHTML='<p class="empty-state" style="font-size:11px;color:var(--text-tertiary)">No registered devices found. Open the app on a device to register it.</p>';return}e.innerHTML=r.map(s=>{const t=i.find(k=>{var S;return((S=k.device)==null?void 0:S.deviceId)===s.device_id}),a=!!t,f=a&&t.publisherStandby===!1;a&&t.publisherStandby;const w=(t==null?void 0:t.activeWorkflowId)===(n==null?void 0:n.id),L=a?f?'<span class="wf-testing-badge wf-testing-badge-streaming">Streaming</span>':'<span class="wf-testing-badge wf-testing-badge-standby">Standby</span>':'<span class="wf-testing-badge wf-testing-badge-offline">Offline</span>',E=w?'<span class="wf-testing-badge wf-testing-badge-activated">Activated</span>':"",o=!a&&!!s.apnsToken,u=a&&!w,p=a&&!f,b=f;return`
      <div class="wf-testing-device-card" data-device-id="${s.device_id}">
        <div class="wf-testing-device-header">
          <div>
            <div class="wf-testing-device-name">${v(s.deviceName??s.device_id.slice(0,12))}</div>
            <div class="wf-testing-device-model">${v(s.deviceModel??"")}</div>
          </div>
        </div>
        <div class="wf-testing-device-status">
          ${L} ${E}
        </div>
        <div class="wf-testing-device-actions">
          <button class="btn wf-test-wake" data-device-id="${s.device_id}" ${o?"":"disabled"}>Wake</button>
          ${w?`<button class="btn wf-test-deactivate" data-session-id="${t.sessionId}" style="border-color:rgba(248,113,113,0.4)">Stop</button>
               <button class="btn wf-test-rerun" data-session-id="${t.sessionId}">Re-run</button>`:`<button class="btn wf-test-activate" data-session-id="${(t==null?void 0:t.sessionId)??""}" ${u?"":"disabled"}>Activate</button>`}
          ${b?`<button class="btn wf-test-stop-stream" data-session-id="${t.sessionId}" style="border-color:rgba(248,113,113,0.4)">Stop Stream</button>`:`<button class="btn wf-test-start-stream" data-session-id="${(t==null?void 0:t.sessionId)??""}" ${p?"":"disabled"}>Stream</button>`}
        </div>
      </div>
    `}).join(""),e.querySelectorAll(".wf-test-wake:not([disabled])").forEach(s=>{s.addEventListener("click",async()=>{const t=s.dataset.deviceId,a=await he(t);if(!(a!=null&&a.ok)){alert((a==null?void 0:a.error)??"Wake failed");return}setTimeout(g,3e3)})}),e.querySelectorAll(".wf-test-activate:not([disabled])").forEach(s=>{s.addEventListener("click",async()=>{const t=y(),a=s.dataset.sessionId;if(!(t!=null&&t.id)||!a)return;let f=await A(t.id,a);if(!f){alert("Activation failed");return}if(f.status==="conflict"&&f.conflict){if(!confirm("Session has active AI. Override?"))return;if(f=await A(t.id,a,{override:!0,reason:"Manual override"}),!f){alert("Override failed");return}}setTimeout(g,1500)})}),e.querySelectorAll(".wf-test-start-stream:not([disabled])").forEach(s=>{s.addEventListener("click",async()=>{const t=s.dataset.sessionId;if(!t)return;const a=await ke(t);if(!(a!=null&&a.ok)){alert((a==null?void 0:a.error)??"Stream failed");return}setTimeout(g,2e3)})}),e.querySelectorAll(".wf-test-stop-stream").forEach(s=>{s.addEventListener("click",async()=>{const t=s.dataset.sessionId;if(!t)return;const a=await $e(t);if(!(a!=null&&a.ok)){alert((a==null?void 0:a.error)??"Stop failed");return}setTimeout(g,1500)})}),e.querySelectorAll(".wf-test-deactivate").forEach(s=>{s.addEventListener("click",async()=>{const t=s.dataset.sessionId;if(!t)return;H()!==t&&(N(t),await new Promise(f=>setTimeout(f,500))),V({type:"deactivate_app"}),setTimeout(g,1500)})}),e.querySelectorAll(".wf-test-rerun").forEach(s=>{s.addEventListener("click",async()=>{const t=y(),a=s.dataset.sessionId;if(!(t!=null&&t.id)||!a)return;if(H()!==a&&(N(a),await new Promise(w=>setTimeout(w,500))),V({type:"deactivate_app"}),await new Promise(w=>setTimeout(w,1e3)),!await A(t.id,a,{override:!0,reason:"Re-run"})){alert("Re-run failed");return}setTimeout(g,1500)})})}function ze(){te(),I=setInterval(()=>{var r;const e=(r=c())==null?void 0:r.querySelector("#wf-testing-panel");e&&e.style.display!=="none"&&g()},15e3)}function te(){I&&(clearInterval(I),I=null)}let h=null;function je(e,r){h&&(J(h),h=null),j(),r&&(e&&N(e),ge(r),ze(),h=()=>{const l=y(),i=c();if(!l||!i)return;const n=i.querySelector("#wf-canvas-wrap");if(!n)return;const d=Te(),s=new Map;for(const[,w]of d)s.set(w.nodeId,w.executionState);const t=B(),a=n.querySelector("#wf-fab-group"),f=a?a.outerHTML:Z();n.innerHTML=Ie(l,qe(),F(),s,1,"wf-svg",void 0,t,d)+f,G(),Q();const m=i.querySelector("#wf-preview-status");m&&(m.style.display=B()?"":"none"),x()},ye(h))}function Ge(){h&&(J(h),h=null),j(),te(),xe()}const Je={init(e){De(e),Xe()},destroy(){const e=T();e&&(clearInterval(e),Y(null)),document.removeEventListener("keydown",X),Ge(),Me(),Pe()}};function Xe(){const e=Ne();e==="list"?We():K(e==="new")}export{Je as default,Je as page};
