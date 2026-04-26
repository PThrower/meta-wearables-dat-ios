import{s as T,p as r,q as Y,e as p,n as H,r as W,t as S,u as P,v as k,x as X,y as j,z as G,A as z,B as b,C as B,D as R,E as U,F as _,G as F,H as J,I as K,J as D,K as Q,L as q,a as Z,M as x,N as M,O as ee,P as te,Q as ae,R as se,S as ie,T as ne,U as oe,V as re}from"./main-7YxB_TCy.js";import"./modulepreload-polyfill-B5Qt9EMX.js";async function le(){var i;const a=r();a&&(a.innerHTML=`
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
  `,(i=a.querySelector("#wf-new-btn"))==null||i.addEventListener("click",()=>{location.hash="/workflows/new"}),await I(),S()&&clearInterval(S()),T(setInterval(()=>I(),15e3)))}async function I(){var l;const a=(l=r())==null?void 0:l.querySelector("#wf-list");if(!a)return;const i=await Y();if(i.length===0){a.innerHTML='<p class="empty-state">No workflows yet. Click "+ New" to create one.</p>';return}a.innerHTML=i.map(e=>{const s=e.status==="published"?"wf-status-published":e.status==="archived"?"wf-status-archived":"wf-status-draft";return`
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
    `}).join(""),a.querySelectorAll(".wf-edit-btn").forEach(e=>{e.addEventListener("click",()=>{location.hash=`/workflows/${e.dataset.id}`})}),a.querySelectorAll(".wf-delete-btn").forEach(e=>{e.addEventListener("click",async()=>{confirm("Delete this workflow?")&&(await W(e.dataset.id),await I())})})}async function O(a){const i=r();if(!i)return;if(_(!1),ee(null),te(0),ae(0),se(1),await P(),a){const e=Date.now();k({id:"",name:"Untitled Workflow",description:"",status:"draft",ownerId:null,nodes:[{id:`n_cam_${e}`,type:"camera-source",label:"Camera",config:{visionFps:1,codec:"jpeg"},positionX:50,positionY:160},{id:`n_mic_${e}`,type:"phone-mic-source",label:"Phone Mic",config:{},positionX:50,positionY:280},{id:`n_txt_${e}`,type:"text",label:"Text Content",config:{text:"You are a helpful assistant."},positionX:320,positionY:100},{id:`n_ai_${e}`,type:"s2s-live",label:"AI Assistant",config:{model:"gemini-2.5-flash-native-audio-latest"},positionX:320,positionY:260},{id:`n_ovl_${e}`,type:"overlays",label:"Overlays",config:{},positionX:600,positionY:260}],edges:[{id:`e_cam_ai_${e}`,sourceNodeId:`n_cam_${e}`,targetNodeId:`n_ai_${e}`},{id:`e_mic_ai_${e}`,sourceNodeId:`n_mic_${e}`,targetNodeId:`n_ai_${e}`},{id:`e_txt_ai_${e}`,sourceNodeId:`n_txt_${e}`,targetNodeId:`n_ai_${e}`},{id:`e_ai_ovl_${e}`,sourceNodeId:`n_ai_${e}`,targetNodeId:`n_ovl_${e}`}],canvasViewport:{x:0,y:0,zoom:1},createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()})}else{const e=X();if(!e){location.hash="/workflows";return}const s=await j(e);if(!s){location.hash="/workflows";return}k(s)}const l=b();i.innerHTML=`
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
  `,de()}function ce(){return[{role:"source",label:"Source"},{role:"reference",label:"Reference"},{role:"processor",label:"Processor"},{role:"trigger",label:"Trigger"},{role:"transform",label:"Transform"},{role:"sink",label:"Sink"}].map(({role:i,label:l})=>{const e=z().filter(s=>s.role===i);return e.length===0?"":`
        <h3 class="wf-palette-title">${l}</h3>
        ${e.map(s=>{const y=(s.runtime??[]).map(h=>h==="mobile"?'<span class="wf-rt-badge" style="background:#06b6d4">MOB</span>':'<span class="wf-rt-badge" style="background:#8b5cf6">SRV</span>').join("");return`
                  <button class="wf-palette-item" data-type="${s.type}">
                    <span class="wf-palette-dot" style="background:${s.color.header}"></span>
                    <span class="wf-palette-label">${p(s.label)}</span>
                    <span class="wf-palette-runtime">${y}</span>
                  </button>`}).join("")}`}).join("")}function de(){var a,i,l,e,s,y,h,L,A;B(),(a=r())==null||a.querySelectorAll(".wf-palette-item").forEach(t=>{t.addEventListener("click",()=>{const f=b();if(!f)return;const u=t.dataset.type,c=R(u),n=U(),w=f.nodes.length*30,v=c?{...c.defaultConfig}:{};f.nodes.push({id:n,type:u,label:(c==null?void 0:c.defaultLabel)??u.replace(/-/g," "),config:v,positionX:200+w,positionY:150+w}),_(!0),F(),J()})}),(l=(i=r())==null?void 0:i.querySelector("#wf-save-btn"))==null||l.addEventListener("click",async()=>{await K();const t=b();if(t!=null&&t.id&&t.status!=="published"){const f=await D(t.id,{status:"published"});f&&k(f)}Q()}),(s=(e=r())==null?void 0:e.querySelector("#wf-publish-btn"))==null||s.addEventListener("click",async()=>{var n,w,v,m;const t=b();if(!(t!=null&&t.id)||q()&&!confirm("You have unsaved changes. Save before publishing?"))return;const u={status:t.status==="published"?"draft":"published"};q()&&(t.name=((w=(n=r())==null?void 0:n.querySelector("#wf-name"))==null?void 0:w.value)??t.name,t.description=((m=(v=r())==null?void 0:v.querySelector("#wf-desc"))==null?void 0:m.value)??t.description,u.name=t.name,u.description=t.description,u.nodes=t.nodes.map(g=>({...g,config:JSON.stringify(g.config)})),u.edges=t.edges);const c=await D(t.id,u);c&&(k(c),_(!1)),O(!1)}),(h=(y=r())==null?void 0:y.querySelector("#wf-del-btn"))==null||h.addEventListener("click",async()=>{const t=b();t!=null&&t.id&&confirm("Delete this workflow?")&&(await W(t.id),location.hash="/workflows")}),(A=(L=r())==null?void 0:L.querySelector("#wf-activate-btn"))==null||A.addEventListener("click",async()=>{var v,m,g,E;const t=b();if(!(t!=null&&t.id))return;const f=(v=r())==null?void 0:v.querySelector(".wf-activate-dropdown");if(f){f.remove();return}const c=(await Z()).filter(d=>d.live);if(c.length===0){alert("No live sessions available");return}const n=document.createElement("div");n.className="wf-activate-dropdown",n.innerHTML=`
      <select class="wf-activate-select">
        ${c.map(d=>{var o;return`<option value="${d.sessionId}">${((o=d.device)==null?void 0:o.deviceName)??"unknown"} (${d.sessionId.slice(0,8)})</option>`}).join("")}
      </select>
      <button class="wf-activate-go">Go</button>
    `,(g=(m=r())==null?void 0:m.querySelector("#wf-activate-btn"))==null||g.after(n),(E=n.querySelector(".wf-activate-go"))==null||E.addEventListener("click",async()=>{var N;const d=(N=n.querySelector(".wf-activate-select"))==null?void 0:N.value;if(!d)return;n.remove();let o=await x(t.id,d);if(!o){alert("Activation failed");return}if(o.status==="conflict"&&o.conflict){const $=o.conflict,V=$.activeAppId??"unknown",C=$.activatedAt?new Date($.activatedAt).toLocaleTimeString():"unknown";if(!confirm(`Session already has active AI:
  App: ${V}
  Active since: ${C}

Override and activate this workflow instead?`))return;if(o=await x(t.id,d,{override:!0,reason:"Manual override"}),!o){alert("Override failed");return}}o.status==="passive"?alert("Activated (passive). No AI processor — sinks/transforms configured on device."):o.appId?alert(`Activated! App: ${o.appId}, Status: ${o.status}`):alert("Activation failed")});const w=d=>{n.contains(d.target)||(n.remove(),document.removeEventListener("click",w))};setTimeout(()=>document.addEventListener("click",w),0)}),document.addEventListener("keydown",M)}const ve={init(a){re(a),fe()},destroy(){const a=S();a&&(clearInterval(a),T(null)),document.removeEventListener("keydown",M),ne(),oe()}};function fe(){const a=ie();a==="list"?le():O(a==="new")}export{ve as default,ve as page};
