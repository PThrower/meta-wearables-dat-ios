import{s as x,p as r,q as Y,e as p,n as H,r as M,t as $,u as P,v as k,x as X,y as j,z as G,A as z,B as b,C as B,D as R,E as U,F as I,G as F,H as J,I as K,J as D,K as Q,L as q,a as Z,M as T,N as W,O as ee,P as te,Q as se,R as ae,S as ne,T as ie,U as oe,V as re}from"./main-CudL39IM.js";import"./modulepreload-polyfill-B5Qt9EMX.js";async function le(){var n;const s=r();s&&(s.innerHTML=`
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
  `,(n=s.querySelector("#wf-new-btn"))==null||n.addEventListener("click",()=>{location.hash="/workflows/new"}),await _(),$()&&clearInterval($()),x(setInterval(()=>_(),15e3)))}async function _(){var l;const s=(l=r())==null?void 0:l.querySelector("#wf-list");if(!s)return;const n=await Y();if(n.length===0){s.innerHTML='<p class="empty-state">No workflows yet. Click "+ New" to create one.</p>';return}s.innerHTML=n.map(e=>{const a=e.status==="published"?"wf-status-published":e.status==="archived"?"wf-status-archived":"wf-status-draft";return`
      <div class="wf-card" data-id="${p(e.id)}">
        <div class="wf-card-header">
          <span class="wf-card-name">${p(e.name)}</span>
          <span class="wf-card-status ${a}">${p(e.status)}</span>
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
    `}).join(""),s.querySelectorAll(".wf-edit-btn").forEach(e=>{e.addEventListener("click",()=>{location.hash=`/workflows/${e.dataset.id}`})}),s.querySelectorAll(".wf-delete-btn").forEach(e=>{e.addEventListener("click",async()=>{confirm("Delete this workflow?")&&(await M(e.dataset.id),await _())})})}async function O(s){const n=r();if(!n)return;if(I(!1),ee(null),te(0),se(0),ae(1),await P(),s){const e=Date.now();k({id:"",name:"Untitled Workflow",description:"",status:"draft",ownerId:null,nodes:[{id:`n_src_${e}`,type:"stream-input",label:"Input",config:{video:!0,phoneMic:!0,glassesMic:!1,gestures:!0,visionFps:1},positionX:50,positionY:220},{id:`n_txt_${e}`,type:"text",label:"Text Content",config:{text:"You are a helpful assistant."},positionX:320,positionY:100},{id:`n_ai_${e}`,type:"s2s-live",label:"AI Assistant",config:{model:"gemini-2.5-flash-native-audio-latest"},positionX:320,positionY:260},{id:`n_ovl_${e}`,type:"overlays",label:"Overlays",config:{},positionX:600,positionY:260}],edges:[{id:`e_1_${e}`,sourceNodeId:`n_src_${e}`,targetNodeId:`n_ai_${e}`},{id:`e_2_${e}`,sourceNodeId:`n_txt_${e}`,targetNodeId:`n_ai_${e}`},{id:`e_3_${e}`,sourceNodeId:`n_ai_${e}`,targetNodeId:`n_ovl_${e}`}],canvasViewport:{x:0,y:0,zoom:1},createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()})}else{const e=X();if(!e){location.hash="/workflows";return}const a=await j(e);if(!a){location.hash="/workflows";return}k(a)}const l=b();n.innerHTML=`
    <div class="page workflow-editor-page">
      <div class="wf-editor-layout">
        <div class="wf-palette">
          ${ce()}
        </div>
        <div class="wf-canvas-wrap" id="wf-canvas-wrap">
          ${G()}
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
  `,de()}function ce(){return[{role:"source",label:"Source"},{role:"reference",label:"Reference"},{role:"processor",label:"Processor"},{role:"trigger",label:"Trigger"},{role:"transform",label:"Transform"},{role:"sink",label:"Sink"}].map(({role:n,label:l})=>{const e=z().filter(a=>a.role===n);return e.length===0?"":`
        <h3 class="wf-palette-title">${l}</h3>
        ${e.map(a=>{const y=(a.runtime??[]).map(h=>h==="mobile"?'<span class="wf-rt-badge" style="background:#06b6d4">MOB</span>':'<span class="wf-rt-badge" style="background:#8b5cf6">SRV</span>').join("");return`
                  <button class="wf-palette-item" data-type="${a.type}">
                    <span class="wf-palette-dot" style="background:${a.color.header}"></span>
                    <span class="wf-palette-label">${p(a.label)}</span>
                    <span class="wf-palette-runtime">${y}</span>
                  </button>`}).join("")}`}).join("")}function de(){var s,n,l,e,a,y,h,L,A;B(),(s=r())==null||s.querySelectorAll(".wf-palette-item").forEach(t=>{t.addEventListener("click",()=>{const f=b();if(!f)return;const u=t.dataset.type,c=R(u),i=U(),w=f.nodes.length*30,v=c?{...c.defaultConfig}:{};f.nodes.push({id:i,type:u,label:(c==null?void 0:c.defaultLabel)??u.replace(/-/g," "),config:v,positionX:200+w,positionY:150+w}),I(!0),F(),J()})}),(l=(n=r())==null?void 0:n.querySelector("#wf-save-btn"))==null||l.addEventListener("click",async()=>{await K();const t=b();if(t!=null&&t.id&&t.status!=="published"){const f=await D(t.id,{status:"published"});f&&k(f)}Q()}),(a=(e=r())==null?void 0:e.querySelector("#wf-publish-btn"))==null||a.addEventListener("click",async()=>{var i,w,v,g;const t=b();if(!(t!=null&&t.id)||q()&&!confirm("You have unsaved changes. Save before publishing?"))return;const u={status:t.status==="published"?"draft":"published"};q()&&(t.name=((w=(i=r())==null?void 0:i.querySelector("#wf-name"))==null?void 0:w.value)??t.name,t.description=((g=(v=r())==null?void 0:v.querySelector("#wf-desc"))==null?void 0:g.value)??t.description,u.name=t.name,u.description=t.description,u.nodes=t.nodes.map(m=>({...m,config:JSON.stringify(m.config)})),u.edges=t.edges);const c=await D(t.id,u);c&&(k(c),I(!1)),O(!1)}),(h=(y=r())==null?void 0:y.querySelector("#wf-del-btn"))==null||h.addEventListener("click",async()=>{const t=b();t!=null&&t.id&&confirm("Delete this workflow?")&&(await M(t.id),location.hash="/workflows")}),(A=(L=r())==null?void 0:L.querySelector("#wf-activate-btn"))==null||A.addEventListener("click",async()=>{var v,g,m,E;const t=b();if(!(t!=null&&t.id))return;const f=(v=r())==null?void 0:v.querySelector(".wf-activate-dropdown");if(f){f.remove();return}const c=(await Z()).filter(d=>d.live);if(c.length===0){alert("No live sessions available");return}const i=document.createElement("div");i.className="wf-activate-dropdown",i.innerHTML=`
      <select class="wf-activate-select">
        ${c.map(d=>{var o;return`<option value="${d.sessionId}">${((o=d.device)==null?void 0:o.deviceName)??"unknown"} (${d.sessionId.slice(0,8)})</option>`}).join("")}
      </select>
      <button class="wf-activate-go">Go</button>
    `,(m=(g=r())==null?void 0:g.querySelector("#wf-activate-btn"))==null||m.after(i),(E=i.querySelector(".wf-activate-go"))==null||E.addEventListener("click",async()=>{var N;const d=(N=i.querySelector(".wf-activate-select"))==null?void 0:N.value;if(!d)return;i.remove();let o=await T(t.id,d);if(!o){alert("Activation failed");return}if(o.status==="conflict"&&o.conflict){const S=o.conflict,V=S.activeAppId??"unknown",C=S.activatedAt?new Date(S.activatedAt).toLocaleTimeString():"unknown";if(!confirm(`Session already has active AI:
  App: ${V}
  Active since: ${C}

Override and activate this workflow instead?`))return;if(o=await T(t.id,d,{override:!0,reason:"Manual override"}),!o){alert("Override failed");return}}o.status==="passive"?alert("Activated (passive). No AI processor — sinks/transforms configured on device."):o.appId?alert(`Activated! App: ${o.appId}, Status: ${o.status}`):alert("Activation failed")});const w=d=>{i.contains(d.target)||(i.remove(),document.removeEventListener("click",w))};setTimeout(()=>document.addEventListener("click",w),0)}),document.addEventListener("keydown",W)}const ve={init(s){re(s),fe()},destroy(){const s=$();s&&(clearInterval(s),x(null)),document.removeEventListener("keydown",W),ie(),oe()}};function fe(){const s=ne();s==="list"?le():O(s==="new")}export{ve as default,ve as page};
