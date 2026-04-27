import{s as W,p as r,q as P,e as p,n as H,r as C,t as S,u as X,v as k,x as j,y as G,z,A as B,B as b,C as F,D as R,E as U,F as _,G as J,H as K,I as Q,J as q,K as Z,L as x,a as ee,M as T,N as M,O as te,P as ae,Q as se,R as ie,S as ne,T as oe,U as re,V as le,W as ce}from"./main-sqM6c7BW.js";import"./modulepreload-polyfill-B5Qt9EMX.js";async function de(){var i;const a=r();a&&(a.innerHTML=`
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
  `,(i=a.querySelector("#wf-new-btn"))==null||i.addEventListener("click",()=>{location.hash="/workflows/new"}),await I(),S()&&clearInterval(S()),W(setInterval(()=>I(),15e3)))}async function I(){var l;const a=(l=r())==null?void 0:l.querySelector("#wf-list");if(!a)return;const i=await P();if(i.length===0){a.innerHTML='<p class="empty-state">No workflows yet. Click "+ New" to create one.</p>';return}a.innerHTML=i.map(e=>{const s=e.status==="published"?"wf-status-published":e.status==="archived"?"wf-status-archived":"wf-status-draft";return`
      <div class="wf-card" data-id="${p(e.id)}">
        <div class="wf-card-header">
          <span class="wf-card-name">${p(e.name)}</span>
          <span class="wf-card-status ${s}">${p(e.status)}</span>
        </div>
        <p class="wf-card-desc">${p(e.description||"No description")}</p>
        <div class="wf-card-meta">
          <span>${e.nodeCount} nodes</span>
          <span>${H(e.updatedAt)}</span>
        </div>
        <div class="wf-card-actions">
          <button class="btn btn-sm wf-edit-btn" data-id="${p(e.id)}">Edit</button>
          <button class="btn btn-sm btn-danger wf-delete-btn" data-id="${p(e.id)}">Delete</button>
        </div>
      </div>
    `}).join(""),a.querySelectorAll(".wf-edit-btn").forEach(e=>{e.addEventListener("click",()=>{location.hash=`/workflows/${e.dataset.id}`})}),a.querySelectorAll(".wf-delete-btn").forEach(e=>{e.addEventListener("click",async()=>{confirm("Delete this workflow?")&&(await C(e.dataset.id),await I())})})}async function O(a){const i=r();if(!i)return;if(_(!1),ae(null),se(0),ie(0),ne(1),await X(),a){const e=Date.now();k({id:"",name:"Untitled Workflow",description:"",status:"draft",ownerId:null,nodes:[{id:`n_cam_${e}`,type:"camera-source",label:"Camera",config:{visionFps:1,codec:"jpeg"},positionX:50,positionY:160},{id:`n_mic_${e}`,type:"phone-mic-source",label:"Phone Mic",config:{},positionX:50,positionY:280},{id:`n_txt_${e}`,type:"text",label:"Text Content",config:{text:"You are a helpful assistant."},positionX:320,positionY:100},{id:`n_ai_${e}`,type:"s2s-live",label:"AI Assistant",config:{model:"gemini-2.5-flash-native-audio-latest"},positionX:320,positionY:260},{id:`n_ovl_${e}`,type:"overlays",label:"Overlays",config:{},positionX:600,positionY:260}],edges:[{id:`e_cam_ai_${e}`,sourceNodeId:`n_cam_${e}`,targetNodeId:`n_ai_${e}`},{id:`e_mic_ai_${e}`,sourceNodeId:`n_mic_${e}`,targetNodeId:`n_ai_${e}`},{id:`e_txt_ai_${e}`,sourceNodeId:`n_txt_${e}`,targetNodeId:`n_ai_${e}`},{id:`e_ai_ovl_${e}`,sourceNodeId:`n_ai_${e}`,targetNodeId:`n_ovl_${e}`}],canvasViewport:{x:0,y:0,zoom:1},flowConfig:null,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()})}else{const e=j();if(!e){location.hash="/workflows";return}const s=await G(e);if(!s){location.hash="/workflows";return}k(s)}const l=b();i.innerHTML=`
    <div class="page workflow-editor-page">
      <div class="wf-editor-layout">
        <div class="wf-palette">
          ${fe()}
        </div>
        <div class="wf-canvas-wrap" id="wf-canvas-wrap">
          ${z()}
        </div>
        <div class="wf-config-panel" id="wf-config-panel">
          <p class="empty-state">Select a node</p>
        </div>
      </div>
      <div class="wf-toolbar">
        <input type="text" class="wf-toolbar-input" id="wf-name" value="${p(l.name)}" placeholder="Workflow name" />
        <input type="text" class="wf-toolbar-input wf-toolbar-desc" id="wf-desc" value="${p(l.description)}" placeholder="Description" />
        <button class="btn btn-primary" id="wf-save-btn">Save</button>
        <span id="wf-save-status" style="font-size:11px;color:var(--text-tertiary);margin-left:4px;">Saved</span>
        <button class="btn" id="wf-publish-btn">${l.status==="published"?"Unpublish":"Publish"}</button>
        <button class="btn btn-danger" id="wf-del-btn">Delete</button>
        <button class="btn" id="wf-activate-btn">Activate</button>
      </div>
    </div>
  `,ue()}function fe(){return[{role:"source",label:"Source"},{role:"reference",label:"Reference"},{role:"processor",label:"Processor"},{role:"trigger",label:"Trigger"},{role:"transform",label:"Transform"},{role:"sink",label:"Sink"}].map(({role:i,label:l})=>{const e=B().filter(s=>s.role===i);return e.length===0?"":`
        <h3 class="wf-palette-title">${l}</h3>
        ${e.map(s=>{const y=(s.runtime??[]).map(h=>h==="mobile"?'<span class="wf-rt-badge" style="background:#06b6d4">MOB</span>':'<span class="wf-rt-badge" style="background:#8b5cf6">SRV</span>').join("");return`
                  <button class="wf-palette-item" data-type="${s.type}">
                    <span class="wf-palette-dot" style="background:${s.color.header}"></span>
                    <span class="wf-palette-label">${p(s.label)}</span>
                    <span class="wf-palette-runtime">${y}</span>
                  </button>`}).join("")}`}).join("")}function ue(){var a,i,l,e,s,y,h,L,A,E;F(),(a=r())==null||a.querySelectorAll(".wf-palette-item").forEach(t=>{t.addEventListener("click",()=>{const c=b();if(!c)return;const u=t.dataset.type,d=R(u),n=U(),w=c.nodes.length*30,v=d?{...d.defaultConfig}:{};c.nodes.push({id:n,type:u,label:(d==null?void 0:d.defaultLabel)??u.replace(/-/g," "),config:v,positionX:200+w,positionY:150+w}),_(!0),J(),K()})}),(l=(i=r())==null?void 0:i.querySelector("#wf-save-btn"))==null||l.addEventListener("click",async()=>{await Q();const t=b();if(t!=null&&t.id&&t.status!=="published"){const c=await q(t.id,{status:"published"});c&&k(c)}Z()}),(s=(e=r())==null?void 0:e.querySelector("#wf-publish-btn"))==null||s.addEventListener("click",async()=>{var n,w,v,m;const t=b();if(!(t!=null&&t.id)||x()&&!confirm("You have unsaved changes. Save before publishing?"))return;const u={status:t.status==="published"?"draft":"published"};x()&&(t.name=((w=(n=r())==null?void 0:n.querySelector("#wf-name"))==null?void 0:w.value)??t.name,t.description=((m=(v=r())==null?void 0:v.querySelector("#wf-desc"))==null?void 0:m.value)??t.description,u.name=t.name,u.description=t.description,u.nodes=t.nodes.map(g=>({...g,config:JSON.stringify(g.config)})),u.edges=t.edges);const d=await q(t.id,u);d&&(k(d),_(!1)),O(!1)}),(h=(y=r())==null?void 0:y.querySelector("#wf-del-btn"))==null||h.addEventListener("click",async()=>{const t=b();t!=null&&t.id&&confirm("Delete this workflow?")&&(await C(t.id),location.hash="/workflows")}),(A=(L=r())==null?void 0:L.querySelector("#wf-activate-btn"))==null||A.addEventListener("click",async()=>{var v,m,g,N;const t=b();if(!(t!=null&&t.id))return;const c=(v=r())==null?void 0:v.querySelector(".wf-activate-dropdown");if(c){c.remove();return}const d=(await ee()).filter(f=>f.live);if(d.length===0){alert("No live sessions available");return}const n=document.createElement("div");n.className="wf-activate-dropdown",n.innerHTML=`
      <select class="wf-activate-select">
        ${d.map(f=>{var o;return`<option value="${f.sessionId}">${((o=f.device)==null?void 0:o.deviceName)??"unknown"} (${f.sessionId.slice(0,8)})</option>`}).join("")}
      </select>
      <button class="wf-activate-go">Go</button>
    `,(g=(m=r())==null?void 0:m.querySelector("#wf-activate-btn"))==null||g.after(n),(N=n.querySelector(".wf-activate-go"))==null||N.addEventListener("click",async()=>{var D;const f=(D=n.querySelector(".wf-activate-select"))==null?void 0:D.value;if(!f)return;n.remove();let o=await T(t.id,f);if(!o){alert("Activation failed");return}if(o.status==="conflict"&&o.conflict){const $=o.conflict,V=$.activeAppId??"unknown",Y=$.activatedAt?new Date($.activatedAt).toLocaleTimeString():"unknown";if(!confirm(`Session already has active AI:
  App: ${V}
  Active since: ${Y}

Override and activate this workflow instead?`))return;if(o=await T(t.id,f,{override:!0,reason:"Manual override"}),!o){alert("Override failed");return}}o.status==="passive"?alert("Activated (passive). No AI processor — sinks/transforms configured on device."):o.appId?alert(`Activated! App: ${o.appId}, Status: ${o.status}`):alert("Activation failed")});const w=f=>{n.contains(f.target)||(n.remove(),document.removeEventListener("click",w))};setTimeout(()=>document.addEventListener("click",w),0)}),document.addEventListener("keydown",M),(E=r())==null||E.addEventListener("click",t=>{t.target.closest(".wf-flow-dot")&&(t.stopPropagation(),te(!0))})}const me={init(a){ce(a),pe()},destroy(){const a=S();a&&(clearInterval(a),W(null)),document.removeEventListener("keydown",M),re(),le()}};function pe(){const a=oe();a==="list"?de():O(a==="new")}export{me as default,me as page};
