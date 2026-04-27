import{s as C,p as o,q as G,e as w,n as z,r as V,t as L,u as M,v as B,x as _,y as F,z as R,A as U,B as J,C as y,D as K,E as W,F as Z,G as Q,H as E,I as ee,J as te,K as se,L as D,M as ae,N as P,a as ie,O as T,P as O,Q as ne,R as oe,S as re,T as le,U as ce,V as de,W as fe,X as ue,Y,Z as pe,_ as we,$ as ve,a0 as be,a1 as ge,a2 as me,a3 as ye,a4 as he,a5 as Se,a6 as ke}from"./main-CZ7VDJrt.js";import"./modulepreload-polyfill-B5Qt9EMX.js";async function $e(){var n;const a=o();a&&(a.innerHTML=`
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
  `,(n=a.querySelector("#wf-new-btn"))==null||n.addEventListener("click",()=>{location.hash="/workflows/new"}),await A(),L()&&clearInterval(L()),C(setInterval(()=>A(),15e3)))}async function A(){var i;const a=(i=o())==null?void 0:i.querySelector("#wf-list");if(!a)return;const n=await G();if(n.length===0){a.innerHTML='<p class="empty-state">No workflows yet. Click "+ New" to create one.</p>';return}a.innerHTML=n.map(s=>{const t=s.status==="published"?"wf-status-published":s.status==="archived"?"wf-status-archived":"wf-status-draft";return`
      <div class="wf-card" data-id="${w(s.id)}">
        <div class="wf-card-header">
          <span class="wf-card-name">${w(s.name)}</span>
          <span class="wf-card-status ${t}">${w(s.status)}</span>
        </div>
        <p class="wf-card-desc">${w(s.description||"No description")}</p>
        <div class="wf-card-meta">
          <span>${s.nodeCount} nodes</span>
          <span>${z(s.updatedAt)}</span>
        </div>
        <div class="wf-card-actions">
          <button class="btn btn-sm wf-edit-btn" data-id="${w(s.id)}">Edit</button>
          <button class="btn btn-sm btn-danger wf-delete-btn" data-id="${w(s.id)}">Delete</button>
        </div>
      </div>
    `}).join(""),a.querySelectorAll(".wf-edit-btn").forEach(s=>{s.addEventListener("click",()=>{location.hash=`/workflows/${s.dataset.id}`})}),a.querySelectorAll(".wf-delete-btn").forEach(s=>{s.addEventListener("click",async()=>{confirm("Delete this workflow?")&&(await V(s.dataset.id),await A())})})}async function H(a){const n=o();if(!n)return;if(E(!1),ce(null),de(0),fe(0),ue(1),await B(),a){const t=Date.now();_({id:"",name:"Untitled Workflow",description:"",status:"draft",ownerId:null,nodes:[{id:`n_cam_${t}`,type:"camera-source",label:"Camera",config:{visionFps:1,codec:"jpeg"},positionX:50,positionY:160},{id:`n_mic_${t}`,type:"phone-mic-source",label:"Phone Mic",config:{},positionX:50,positionY:280},{id:`n_txt_${t}`,type:"text",label:"Text Content",config:{text:"You are a helpful assistant."},positionX:320,positionY:100},{id:`n_ai_${t}`,type:"s2s-live",label:"AI Assistant",config:{model:"gemini-2.5-flash-native-audio-latest"},positionX:320,positionY:260},{id:`n_ovl_${t}`,type:"overlays",label:"Overlays",config:{},positionX:600,positionY:260}],edges:[{id:`e_cam_ai_${t}`,sourceNodeId:`n_cam_${t}`,targetNodeId:`n_ai_${t}`},{id:`e_mic_ai_${t}`,sourceNodeId:`n_mic_${t}`,targetNodeId:`n_ai_${t}`},{id:`e_txt_ai_${t}`,sourceNodeId:`n_txt_${t}`,targetNodeId:`n_ai_${t}`},{id:`e_ai_ovl_${t}`,sourceNodeId:`n_ai_${t}`,targetNodeId:`n_ovl_${t}`}],canvasViewport:{x:0,y:0,zoom:1},flowConfig:null,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()})}else{const t=F();if(!t){location.hash="/workflows";return}const p=await R(t);if(!p){location.hash="/workflows";return}_(p)}const i=y(),s=i.id?await U(i.id):null;n.innerHTML=`
    <div class="page workflow-editor-page">
      <div class="wf-editor-layout">
        <div class="wf-palette">
          ${_e()}
        </div>
        <div class="wf-canvas-wrap" id="wf-canvas-wrap">
          ${J()}
        </div>
        <div class="wf-config-panel" id="wf-config-panel">
          <p class="empty-state">Select a node</p>
        </div>
      </div>
      <div class="wf-toolbar">
        <input type="text" class="wf-toolbar-input" id="wf-name" value="${w(i.name)}" placeholder="Workflow name" />
        <input type="text" class="wf-toolbar-input wf-toolbar-desc" id="wf-desc" value="${w(i.description)}" placeholder="Description" />
        <button class="btn btn-primary" id="wf-save-btn">Save</button>
        <span id="wf-save-status" style="font-size:11px;color:var(--text-tertiary);margin-left:4px;">Saved</span>
        <button class="btn" id="wf-publish-btn">${i.status==="published"?"Unpublish":"Publish"}</button>
        <button class="btn btn-danger" id="wf-del-btn">Delete</button>
        <button class="btn" id="wf-activate-btn">Activate</button>
        <span id="wf-preview-status" style="font-size:11px;margin-left:8px;${s?"":"display:none"}">
          <span class="wf-live-dot" style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#4ade80;margin-right:3px;vertical-align:middle"></span>
          <span style="color:#4ade80;vertical-align:middle">LIVE</span>
        </span>
      </div>
    </div>
  `,Ie(),Le(s,i.id)}function _e(){return[{role:"source",label:"Source"},{role:"reference",label:"Reference"},{role:"processor",label:"Processor"},{role:"trigger",label:"Trigger"},{role:"transform",label:"Transform"},{role:"sink",label:"Sink"}].map(({role:n,label:i})=>{const s=K().filter(t=>t.role===n);return s.length===0?"":`
        <h3 class="wf-palette-title">${i}</h3>
        ${s.map(t=>{const p=(t.runtime??[]).map(v=>v==="mobile"?'<span class="wf-rt-badge" style="background:#06b6d4">MOB</span>':'<span class="wf-rt-badge" style="background:#8b5cf6">SRV</span>').join("");return`
                  <button class="wf-palette-item" data-type="${t.type}">
                    <span class="wf-palette-dot" style="background:${t.color.header}"></span>
                    <span class="wf-palette-label">${w(t.label)}</span>
                    <span class="wf-palette-runtime">${p}</span>
                  </button>`}).join("")}`}).join("")}function Ie(){var a,n,i,s,t,p,v,h,S,N;W(),(a=o())==null||a.querySelectorAll(".wf-palette-item").forEach(e=>{e.addEventListener("click",()=>{const c=y();if(!c)return;const u=e.dataset.type,d=Z(u),r=Q(),b=c.nodes.length*30,m=d?{...d.defaultConfig}:{};c.nodes.push({id:r,type:u,label:(d==null?void 0:d.defaultLabel)??u.replace(/-/g," "),config:m,positionX:200+b,positionY:150+b}),E(!0),ee(),te()})}),(i=(n=o())==null?void 0:n.querySelector("#wf-save-btn"))==null||i.addEventListener("click",async()=>{await se();const e=y();if(e!=null&&e.id&&e.status!=="published"){const c=await D(e.id,{status:"published"});c&&_(c)}ae()}),(t=(s=o())==null?void 0:s.querySelector("#wf-publish-btn"))==null||t.addEventListener("click",async()=>{var r,b,m,k;const e=y();if(!(e!=null&&e.id)||P()&&!confirm("You have unsaved changes. Save before publishing?"))return;const u={status:e.status==="published"?"draft":"published"};P()&&(e.name=((b=(r=o())==null?void 0:r.querySelector("#wf-name"))==null?void 0:b.value)??e.name,e.description=((k=(m=o())==null?void 0:m.querySelector("#wf-desc"))==null?void 0:k.value)??e.description,u.name=e.name,u.description=e.description,u.nodes=e.nodes.map($=>({...$,config:JSON.stringify($.config)})),u.edges=e.edges);const d=await D(e.id,u);d&&(_(d),E(!1)),H(!1)}),(v=(p=o())==null?void 0:p.querySelector("#wf-del-btn"))==null||v.addEventListener("click",async()=>{const e=y();e!=null&&e.id&&confirm("Delete this workflow?")&&(await V(e.id),location.hash="/workflows")}),(S=(h=o())==null?void 0:h.querySelector("#wf-activate-btn"))==null||S.addEventListener("click",async()=>{var m,k,$,x;const e=y();if(!(e!=null&&e.id))return;const c=(m=o())==null?void 0:m.querySelector(".wf-activate-dropdown");if(c){c.remove();return}const d=(await ie()).filter(f=>f.live);if(d.length===0){alert("No live sessions available");return}const r=document.createElement("div");r.className="wf-activate-dropdown",r.innerHTML=`
      <select class="wf-activate-select">
        ${d.map(f=>{var l;return`<option value="${f.sessionId}">${((l=f.device)==null?void 0:l.deviceName)??"unknown"} (${f.sessionId.slice(0,8)})</option>`}).join("")}
      </select>
      <button class="wf-activate-go">Go</button>
    `,($=(k=o())==null?void 0:k.querySelector("#wf-activate-btn"))==null||$.after(r),(x=r.querySelector(".wf-activate-go"))==null||x.addEventListener("click",async()=>{var q;const f=(q=r.querySelector(".wf-activate-select"))==null?void 0:q.value;if(!f)return;r.remove();let l=await T(e.id,f);if(!l){alert("Activation failed");return}if(l.status==="conflict"&&l.conflict){const I=l.conflict,X=I.activeAppId??"unknown",j=I.activatedAt?new Date(I.activatedAt).toLocaleTimeString():"unknown";if(!confirm(`Session already has active AI:
  App: ${X}
  Active since: ${j}

Override and activate this workflow instead?`))return;if(l=await T(e.id,f,{override:!0,reason:"Manual override"}),!l){alert("Override failed");return}}l.status==="passive"?alert("Activated (passive). No AI processor — sinks/transforms configured on device."):l.appId?alert(`Activated! App: ${l.appId}, Status: ${l.status}`):alert("Activation failed")});const b=f=>{r.contains(f.target)||(r.remove(),document.removeEventListener("click",b))};setTimeout(()=>document.addEventListener("click",b),0)}),document.addEventListener("keydown",O),(N=o())==null||N.addEventListener("click",e=>{e.target.closest(".wf-flow-dot")&&(e.stopPropagation(),ne(!0))})}let g=null;function Le(a,n){g&&(Y(g),g=null),M(),n&&(a&&oe(a),re(n),g=()=>{const i=y(),s=o();if(!i||!s)return;const t=s.querySelector("#wf-canvas-wrap");if(!t)return;const p=me(),v=new Map;for(const[,S]of p)v.set(S.nodeId,S.executionState);v.size>0&&(t.innerHTML=pe(i,ve(),we(),v),W());const h=s.querySelector("#wf-preview-status");h&&(h.style.display=be()?"":"none"),ge()},le(g))}function Ee(){g&&(Y(g),g=null),M()}const De={init(a){ke(a),Ae()},destroy(){const a=L();a&&(clearInterval(a),C(null)),document.removeEventListener("keydown",O),Ee(),he(),Se()}};function Ae(){const a=ye();a==="list"?$e():H(a==="new")}export{De as default,De as page};
