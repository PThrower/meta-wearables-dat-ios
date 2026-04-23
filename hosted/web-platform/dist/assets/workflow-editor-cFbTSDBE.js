import{e as v,m as j,n as B,l as K,p as C,u as q,q as z,a as U,r as P}from"./main-Bi2az7yX.js";import"./modulepreload-polyfill-B5Qt9EMX.js";const le={init(s){n=s,_()},destroy(){I&&(clearInterval(I),I=null),document.removeEventListener("keydown",R),n=null,h=!1,t=null,y=null,E=0,N=0,m=1,S=null,b=null}};let n=null,I=null,t=null,h=!1,y=null,S=null,b=null,E=0,N=0,m=1;const M={"stream-input":{fill:"#0d3d38",header:"#14b8a6",stroke:"#14b8a6"},text:{fill:"#1a1a2e",header:"#e2e8f0",stroke:"#94a3b8"},"s2s-live":{fill:"#0d3320",header:"#22c55e",stroke:"#22c55e"},"s2s-rest":{fill:"#0d2040",header:"#3b82f6",stroke:"#3b82f6"},"s2s-e4b":{fill:"#2d1050",header:"#a855f7",stroke:"#a855f7"},output:{fill:"#3d2000",header:"#f97316",stroke:"#f97316"}},k=180,x=80,T=8,J={"stream-input":new Set(["s2s-live","s2s-rest","s2s-e4b","output"]),text:new Set(["s2s-live","s2s-rest","s2s-e4b"]),"s2s-live":new Set(["s2s-live","s2s-rest","s2s-e4b","output"]),"s2s-rest":new Set(["s2s-live","s2s-rest","s2s-e4b","output"]),"s2s-e4b":new Set(["s2s-live","s2s-rest","s2s-e4b","output"])};function H(){return`n_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,7)}`}function Q(){const s=location.hash.slice(1);return s==="/workflows"?"list":s==="/workflows/new"?"new":"edit"}function Z(){const e=location.hash.slice(1).match(/^\/workflows\/(.+)$/);return e?e[1]:null}function _(){const s=Q();s==="list"?ee():O(s==="new")}async function ee(){var s;n&&(n.innerHTML=`
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
  `,(s=n.querySelector("#wf-new-btn"))==null||s.addEventListener("click",()=>{location.hash="/workflows/new"}),await X(),I&&clearInterval(I),I=setInterval(()=>X(),15e3))}async function X(){const s=n==null?void 0:n.querySelector("#wf-list");if(!s)return;const e=await B();if(e.length===0){s.innerHTML='<p class="empty-state">No workflows yet. Click "+ New" to create one.</p>';return}s.innerHTML=e.map(o=>{const f=o.status==="published"?"wf-status-published":o.status==="archived"?"wf-status-archived":"wf-status-draft";return`
      <div class="wf-card" data-id="${v(o.id)}">
        <div class="wf-card-header">
          <span class="wf-card-name">${v(o.name)}</span>
          <span class="wf-card-status ${f}">${v(o.status)}</span>
        </div>
        <p class="wf-card-desc">${v(o.description||"No description")}</p>
        <div class="wf-card-meta">
          <span>${o.nodeCount} nodes</span>
          <span>${K(o.updatedAt)}</span>
        </div>
        <div class="wf-card-actions">
          <button class="btn btn-sm wf-edit-btn" data-id="${v(o.id)}">Edit</button>
          <button class="btn btn-sm btn-danger wf-delete-btn" data-id="${v(o.id)}">Delete</button>
        </div>
      </div>
    `}).join(""),s.querySelectorAll(".wf-edit-btn").forEach(o=>{o.addEventListener("click",()=>{location.hash=`/workflows/${o.dataset.id}`})}),s.querySelectorAll(".wf-delete-btn").forEach(o=>{o.addEventListener("click",async()=>{confirm("Delete this workflow?")&&(await C(o.dataset.id),await X())})})}async function O(s){if(n){if(h=!1,y=null,E=0,N=0,m=1,s){const e=Date.now();t={id:"",name:"Untitled Workflow",description:"",status:"draft",ownerId:null,nodes:[{id:`n_src_${e}`,type:"stream-input",label:"Input",config:{video:!0,phoneMic:!0,glassesMic:!1,gestures:!0,visionFps:1},positionX:100,positionY:200},{id:`n_txt_${e}`,type:"text",label:"Prompt",config:{text:""},positionX:400,positionY:80},{id:`n_ai_${e}`,type:"s2s-live",label:"AI Assistant",config:{model:"gemini-2.5-flash-native-audio-latest"},positionX:400,positionY:250},{id:`n_out_${e}`,type:"output",label:"Output",config:{viewers:!0,overlays:!0,speaker:!0,recording:!0},positionX:700,positionY:250}],edges:[{id:`e_1_${e}`,sourceNodeId:`n_src_${e}`,targetNodeId:`n_ai_${e}`},{id:`e_2_${e}`,sourceNodeId:`n_txt_${e}`,targetNodeId:`n_ai_${e}`},{id:`e_3_${e}`,sourceNodeId:`n_ai_${e}`,targetNodeId:`n_out_${e}`}],canvasViewport:{x:0,y:0,zoom:1},createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}}else{const e=Z();if(!e){location.hash="/workflows";return}const o=await j(e);if(!o){location.hash="/workflows";return}t=o}n.innerHTML=`
    <div class="page workflow-editor-page">
      <div class="wf-editor-layout">
        <div class="wf-palette">
          <h3 class="wf-palette-title">Nodes</h3>
          ${Object.entries(M).map(([e,o])=>`
            <button class="wf-palette-item" data-type="${e}">
              <span class="wf-palette-dot" style="background:${o.header}"></span>
              <span class="wf-palette-label">${{"stream-input":"Stream Input",text:"Text","s2s-live":"S2S Live","s2s-rest":"S2S REST","s2s-e4b":"S2S E4B",output:"Output"}[e]??e.replace(/-/g," ")}</span>
            </button>
          `).join("")}
        </div>
        <div class="wf-canvas-wrap" id="wf-canvas-wrap">
          ${V()}
        </div>
        <div class="wf-config-panel" id="wf-config-panel">
          <p class="empty-state">Select a node</p>
        </div>
      </div>
      <div class="wf-toolbar">
        <input type="text" class="wf-toolbar-input" id="wf-name" value="${v(t.name)}" placeholder="Workflow name" />
        <input type="text" class="wf-toolbar-input wf-toolbar-desc" id="wf-desc" value="${v(t.description)}" placeholder="Description" />
        <button class="btn btn-primary" id="wf-save-btn">Save</button>
        <button class="btn" id="wf-publish-btn">${t.status==="published"?"Unpublish":"Publish"}</button>
        <button class="btn btn-danger" id="wf-del-btn">Delete</button>
        <button class="btn" id="wf-activate-btn">Activate</button>
      </div>
    </div>
  `,te()}}function V(){if(!t)return"";const s=t.nodes,e=t.edges,o=s.map(i=>{const l=M[i.type]??M.output,a=i.type==="s2s-live"||i.type==="s2s-rest"||i.type==="s2s-e4b"?(i.config.model??"").slice(0,20):i.type==="text"?(i.config.text??"").slice(0,22)||"Empty":i.type==="output"?Object.entries({viewers:"view",overlays:"overlay",speaker:"speaker",recording:"rec"}).filter(([,r])=>i.config[r]!==!1).map(([r])=>r).join(", ")||"all":i.type==="stream-input"?[i.config.video!==!1?"video":"",i.config.phoneMic!==!1?"phone-mic":"",i.config.glassesMic===!0?"glasses-mic":"",i.config.gestures!==!1?"gestures":""].filter(Boolean).join(", ")||"none":"Live feed",c=y===i.id;return`
      <g class="wf-node" data-id="${i.id}" transform="translate(${i.positionX}, ${i.positionY})">
        <rect class="wf-node-bg" width="${k}" height="${x}" rx="${T}" fill="${l.fill}" stroke="${c?"#fff":l.stroke}" stroke-width="${c?2:1}" />
        <rect class="wf-node-header" width="${k}" height="24" rx="${T}" fill="${l.header}" />
        <rect x="0" y="${T}" width="${k}" height="${24-T}" fill="${l.header}" />
        <text x="${k/2}" y="16" text-anchor="middle" fill="#fff" font-size="10" font-weight="600">${v(i.type.replace("-"," "))}</text>
        <text x="12" y="44" fill="#ccc" font-size="11">${v(i.label||i.type)}</text>
        <text x="12" y="60" fill="#888" font-size="9">${v(a)}</text>
        <circle class="wf-port wf-port-in" cx="0" cy="${x/2}" r="6" fill="${l.stroke}" stroke="#0a0a0a" stroke-width="2" />
        <circle class="wf-port wf-port-out" cx="${k}" cy="${x/2}" r="6" fill="${l.stroke}" stroke="#0a0a0a" stroke-width="2" />
      </g>
    `}).join(""),f=e.map(i=>{const l=s.find(w=>w.id===i.sourceNodeId),a=s.find(w=>w.id===i.targetNodeId);if(!l||!a)return"";const c=l.positionX+k,r=l.positionY+x/2,u=a.positionX,p=a.positionY+x/2,g=(c+u)/2;return`<path class="wf-edge" data-id="${i.id}" d="M ${c} ${r} C ${g} ${r}, ${g} ${p}, ${u} ${p}" fill="none" stroke="#64748b" stroke-width="2" />`}).join("");return`<svg class="wf-canvas-svg" id="wf-svg" viewBox="${E} ${N} ${900/m} ${600/m}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <pattern id="wf-grid" width="20" height="20" patternUnits="userSpaceOnUse">
        <path d="M 20 0 L 0 0 0 20" fill="none" stroke="rgba(255,255,255,0.04)" stroke-width="0.5" />
      </pattern>
    </defs>
    <rect x="-5000" y="-5000" width="10000" height="10000" fill="url(#wf-grid)" />
  ${f}${o}</svg>`}function L(){const s=n==null?void 0:n.querySelector("#wf-canvas-wrap");s&&(s.innerHTML=V(),W())}function te(){var s,e,o,f;W(),n==null||n.querySelectorAll(".wf-palette-item").forEach(d=>{d.addEventListener("click",()=>{if(!t)return;const i=d.dataset.type,l=H(),a=t.nodes.length*30,c=i==="s2s-live"?{model:"gemini-2.5-flash-native-audio-latest"}:i==="s2s-rest"?{model:"gemma-4-27b"}:i==="s2s-e4b"?{model:"gemma-4-e4b-it"}:i==="text"?{text:""}:i==="output"?{viewers:!0,overlays:!0,speaker:!0,recording:!0}:{};t.nodes.push({id:l,type:i,label:{"stream-input":"Stream Input",text:"Text","s2s-live":"S2S Live","s2s-rest":"S2S REST","s2s-e4b":"S2S E4B",output:"Output"}[i]??i.replace(/-/g," "),config:c,positionX:200+a,positionY:150+a}),h=!0,L()})}),(s=n==null?void 0:n.querySelector("#wf-save-btn"))==null||s.addEventListener("click",async()=>{var i,l;if(!t)return;t.name=((i=n==null?void 0:n.querySelector("#wf-name"))==null?void 0:i.value)??t.name,t.description=((l=n==null?void 0:n.querySelector("#wf-desc"))==null?void 0:l.value)??t.description;const d=t.nodes.map(a=>({...a,config:JSON.stringify(a.config)}));if(t.id){const a=await q(t.id,{name:t.name,description:t.description,nodes:d,edges:t.edges,canvasViewport:JSON.stringify({x:E,y:N,zoom:m}),status:"published"});a&&(t=a)}else{const a=await z({name:t.name,description:t.description,nodes:d,edges:t.edges});a&&(t=await q(a.id,{status:"published"})??a,history.replaceState(null,"",`#/workflows/${t.id}`))}h=!1,O(!1)}),(e=n==null?void 0:n.querySelector("#wf-publish-btn"))==null||e.addEventListener("click",async()=>{var a,c;if(!(t!=null&&t.id)||h&&!confirm("You have unsaved changes. Save before publishing?"))return;const i={status:t.status==="published"?"draft":"published"};h&&(t.name=((a=n==null?void 0:n.querySelector("#wf-name"))==null?void 0:a.value)??t.name,t.description=((c=n==null?void 0:n.querySelector("#wf-desc"))==null?void 0:c.value)??t.description,i.name=t.name,i.description=t.description,i.nodes=t.nodes.map(r=>({...r,config:JSON.stringify(r.config)})),i.edges=t.edges);const l=await q(t.id,i);l&&(t=l,h=!1),O(!1)}),(o=n==null?void 0:n.querySelector("#wf-del-btn"))==null||o.addEventListener("click",async()=>{t!=null&&t.id&&confirm("Delete this workflow?")&&(await C(t.id),location.hash="/workflows")}),(f=n==null?void 0:n.querySelector("#wf-activate-btn"))==null||f.addEventListener("click",async()=>{var r,u;if(!(t!=null&&t.id))return;const d=n==null?void 0:n.querySelector(".wf-activate-dropdown");if(d){d.remove();return}const l=(await U()).filter(p=>p.live);if(l.length===0){alert("No live sessions available");return}const a=document.createElement("div");a.className="wf-activate-dropdown",a.innerHTML=`
      <select class="wf-activate-select">
        ${l.map(p=>{var g;return`<option value="${p.sessionId}">${((g=p.device)==null?void 0:g.deviceName)??"unknown"} (${p.sessionId.slice(0,8)})</option>`}).join("")}
      </select>
      <button class="wf-activate-go">Go</button>
    `,(r=n==null?void 0:n.querySelector("#wf-activate-btn"))==null||r.after(a),(u=a.querySelector(".wf-activate-go"))==null||u.addEventListener("click",async()=>{var w;const p=(w=a.querySelector(".wf-activate-select"))==null?void 0:w.value;if(!p)return;a.remove();let g=await P(t.id,p);if(!g){alert("Activation failed");return}if(g.status==="conflict"&&g.conflict){const A=g.conflict,$=A.activeAppId??"unknown",F=A.activatedAt?new Date(A.activatedAt).toLocaleTimeString():"unknown";if(!confirm(`Session already has active AI:
  App: ${$}
  Active since: ${F}

Override and activate this workflow instead?`))return;if(g=await P(t.id,p,{override:!0,reason:"Manual override"}),!g){alert("Override failed");return}}g.appId?alert(`Activated! App: ${g.appId}, Status: ${g.status}`):alert("Activation failed")});const c=p=>{a.contains(p.target)||(a.remove(),document.removeEventListener("click",c))};setTimeout(()=>document.addEventListener("click",c),0)}),document.addEventListener("keydown",R)}function R(s){if((s.key==="Delete"||s.key==="Backspace")&&y&&t){if(s.target.tagName==="INPUT"||s.target.tagName==="TEXTAREA")return;s.preventDefault();const e=y;t.nodes=t.nodes.filter(o=>o.id!==e),t.edges=t.edges.filter(o=>o.sourceNodeId!==e&&o.targetNodeId!==e),y=null,h=!0,L(),Y()}}function W(){const s=n==null?void 0:n.querySelector("#wf-svg");s&&(s.querySelectorAll(".wf-node").forEach(e=>{e.addEventListener("mousedown",o=>{const f=o,d=e.getAttribute("data-id"),i=f.target;if(i.classList.contains("wf-port-out")){oe(f,d,s);return}y=d,Y(),L(),i.classList.contains("wf-port-in")||se(f,d)})}),s.querySelectorAll(".wf-edge").forEach(e=>{e.addEventListener("click",()=>{if(!t)return;const o=e.getAttribute("data-id");t.edges=t.edges.filter(f=>f.id!==o),h=!0,L()})}),s.addEventListener("mousedown",e=>{const o=e;(o.target===s||o.target.tagName==="rect")&&(o.button===1||o.ctrlKey||o.metaKey?(e.preventDefault(),o.clientX,o.clientY):(y=null,Y(),L()))}),s.addEventListener("wheel",e=>{e.preventDefault();const f=e.deltaY>0?.9:1.1;m=Math.max(.3,Math.min(3,m*f)),s.setAttribute("viewBox",`${E} ${N} ${900/m} ${600/m}`)},{passive:!1}))}function ie(s,e,o,f){for(const d of o){if(d.sourceNodeId!==e.id&&d.targetNodeId!==e.id)continue;const i=s.querySelector(`[data-id="${d.id}"]`);if(!i)continue;const l=f.find(w=>w.id===d.sourceNodeId),a=f.find(w=>w.id===d.targetNodeId);if(!l||!a)continue;const c=l.positionX+k,r=l.positionY+x/2,u=a.positionX,p=a.positionY+x/2,g=(c+u)/2;i.setAttribute("d",`M ${c} ${r} C ${g} ${r}, ${g} ${p}, ${u} ${p}`)}}function se(s,e){if(!t)return;const o=t.nodes.find(i=>i.id===e);if(!o)return;S={nodeId:e,startX:s.clientX,startY:s.clientY,nodeStartX:o.positionX,nodeStartY:o.positionY};const f=i=>{if(!S||!t)return;const l=(i.clientX-S.startX)/m,a=(i.clientY-S.startY)/m,c=t.nodes.find(r=>r.id===S.nodeId);if(c){c.positionX=Math.round(S.nodeStartX+l),c.positionY=Math.round(S.nodeStartY+a),h=!0;const r=n==null?void 0:n.querySelector("#wf-svg"),u=r==null?void 0:r.querySelector(`[data-id="${S.nodeId}"]`);u&&(u.setAttribute("transform",`translate(${c.positionX}, ${c.positionY})`),ie(r,c,t.edges,t.nodes))}},d=()=>{S=null,document.removeEventListener("mousemove",f),document.removeEventListener("mouseup",d),L()};document.addEventListener("mousemove",f),document.addEventListener("mouseup",d)}function oe(s,e,o){const f=t==null?void 0:t.nodes.find(r=>r.id===e);if(!f)return;o.getBoundingClientRect();const d=f.positionX+k,i=f.positionY+x/2,l=document.createElementNS("http://www.w3.org/2000/svg","line");l.setAttribute("x1",String(d)),l.setAttribute("y1",String(i)),l.setAttribute("x2",String(d)),l.setAttribute("y2",String(i)),l.setAttribute("stroke","#94a3b3"),l.setAttribute("stroke-width","2"),l.setAttribute("stroke-dasharray","4"),o.appendChild(l),b={sourceNodeId:e,tempLine:l};const a=r=>{if(!b)return;const u=o.getBoundingClientRect(),p=E+(r.clientX-u.left)/u.width*(900/m),g=N+(r.clientY-u.top)/u.height*(600/m);b.tempLine.setAttribute("x2",String(p)),b.tempLine.setAttribute("y2",String(g))},c=r=>{var A;b!=null&&b.tempLine.parentNode&&b.tempLine.parentNode.removeChild(b.tempLine);const u=o.getBoundingClientRect(),p=E+(r.clientX-u.left)/u.width*(900/m),g=N+(r.clientY-u.top)/u.height*(600/m),w=t==null?void 0:t.nodes.find($=>p>=$.positionX&&p<=$.positionX+k&&g>=$.positionY&&g<=$.positionY+x&&$.id!==b.sourceNodeId);if(w&&t){const $=t.nodes.find(D=>D.id===b.sourceNodeId);if(!($?(A=J[$.type])==null?void 0:A.has(w.type):!1)){b=null;return}t.edges.some(D=>D.sourceNodeId===b.sourceNodeId&&D.targetNodeId===w.id)||(t.edges.push({id:H(),sourceNodeId:b.sourceNodeId,targetNodeId:w.id}),h=!0,L())}b=null,document.removeEventListener("mousemove",a),document.removeEventListener("mouseup",c)};document.addEventListener("mousemove",a),document.addEventListener("mouseup",c)}function Y(){var f;const s=n==null?void 0:n.querySelector("#wf-config-panel");if(!s||!t)return;if(!y){s.innerHTML='<p class="empty-state">Select a node</p>';return}const e=t.nodes.find(d=>d.id===y);if(!e){s.innerHTML='<p class="empty-state">Select a node</p>';return}const o=M[e.type]??M.output;if(e.type==="stream-input"){const d=e.config.visionFps??1,i=e.config.video!==!1,l=e.config.phoneMic!==!1,a=e.config.glassesMic===!0,c=e.config.gestures!==!1,r=e.config.onDisconnect??"stop",u=e.config.onReconnect??"restart",p=e.config.autoDeactivateMin??null;s.innerHTML=`
      <div class="wf-config-header" style="border-left: 3px solid ${o.header}">
        <span class="wf-config-type">Input</span>
      </div>
      <div class="wf-config-field">
        <label>Label</label>
        <input type="text" class="wf-config-input" data-field="label" value="${v(e.label)}" />
      </div>
      <div class="wf-config-field">
        <label>Modalities</label>
        <div class="wf-config-checks">
          <label><input type="checkbox" data-field="config.video" ${i?"checked":""} /> Video (frames)</label>
          <label><input type="checkbox" data-field="config.phoneMic" ${l?"checked":""} /> Phone mic (48kHz)</label>
          <label><input type="checkbox" data-field="config.glassesMic" ${a?"checked":""} /> Glasses HFP mic (8kHz)</label>
          <label><input type="checkbox" data-field="config.gestures" ${c?"checked":""} /> Gestures</label>
        </div>
      </div>
      <div class="wf-config-field">
        <label>Vision FPS: ${d}</label>
        <input type="range" min="0.2" max="2" step="0.1" data-field="config.visionFps" value="${d}" />
      </div>
      <div class="wf-config-field">
        <label>Video Codec</label>
        <select class="wf-config-input" data-field="config.codec">
          <option value="jpeg" ${(e.config.codec??"jpeg")==="jpeg"?"selected":""}>JPEG (compatible with AI models)</option>
          <option value="h264" ${e.config.codec==="h264"?"selected":""}>H.264 (lower bandwidth, viewer-only)</option>
        </select>
      </div>
      <div class="wf-config-field" style="margin-top: 12px; padding-top: 12px; border-top: 1px solid #333;">
        <label style="font-weight: 600; margin-bottom: 6px; display: block;">Lifecycle Policy</label>
        <div class="wf-config-field">
          <label>On publisher disconnect</label>
          <select class="wf-config-input" data-field="config.onDisconnect">
            <option value="stop" ${r==="stop"?"selected":""}>Stop AI</option>
            <option value="pause" ${r==="pause"?"selected":""}>Pause AI</option>
            <option value="continue" ${r==="continue"?"selected":""}>Continue until timeout</option>
          </select>
        </div>
        <div class="wf-config-field">
          <label>On publisher reconnect</label>
          <select class="wf-config-input" data-field="config.onReconnect">
            <option value="restart" ${u==="restart"?"selected":""}>Restart AI</option>
            <option value="resume" ${u==="resume"?"selected":""}>Resume AI</option>
            <option value="noop" ${u==="noop"?"selected":""}>No-op</option>
          </select>
        </div>
        <div class="wf-config-field">
          <label>Auto-deactivate after (min, 0 = never)</label>
          <input type="number" class="wf-config-input" data-field="config.autoDeactivateMin" min="0" max="480" step="5" value="${p??0}" />
        </div>
      </div>
      <button class="btn btn-danger btn-sm wf-config-delete" data-id="${e.id}">Delete Node</button>
    `}else if(e.type==="text"){const d=e.config.text??"";s.innerHTML=`
      <div class="wf-config-header" style="border-left: 3px solid ${o.header}">
        <span class="wf-config-type">Text / Prompt</span>
      </div>
      <div class="wf-config-field">
        <label>Label</label>
        <input type="text" class="wf-config-input" data-field="label" value="${v(e.label)}" />
      </div>
      <div class="wf-config-field">
        <label>System Prompt</label>
        <textarea class="wf-config-input wf-config-textarea" data-field="config.text" rows="10" placeholder="Enter system prompt...">${v(d)}</textarea>
      </div>
      <button class="btn btn-danger btn-sm wf-config-delete" data-id="${e.id}">Delete Node</button>
    `}else if(e.type==="s2s-live")s.innerHTML=`
      <div class="wf-config-header" style="border-left: 3px solid ${o.header}">
        <span class="wf-config-type">S2S Live (Gemini)</span>
      </div>
      <div class="wf-config-field">
        <label>Label</label>
        <input type="text" class="wf-config-input" data-field="label" value="${v(e.label)}" />
      </div>
      <div class="wf-config-field">
        <label>Model</label>
        <select class="wf-config-input" data-field="config.model">
          <option value="gemini-2.5-flash-native-audio-latest" ${e.config.model==="gemini-2.5-flash-native-audio-latest"?"selected":""}>gemini-2.5-flash-native-audio</option>
          <option value="gemini-2.0-flash" ${e.config.model==="gemini-2.0-flash"?"selected":""}>gemini-2.0-flash</option>
        </select>
      </div>
      <div class="wf-config-field">
        <label>Voice</label>
        <select class="wf-config-input" data-field="config.voice">
          <option value="">Default</option>
          <option value="Aoede" ${e.config.voice==="Aoede"?"selected":""}>Aoede</option>
          <option value="Puck" ${e.config.voice==="Puck"?"selected":""}>Puck</option>
          <option value="Charon" ${e.config.voice==="Charon"?"selected":""}>Charon</option>
          <option value="Fenchir" ${e.config.voice==="Fenchir"?"selected":""}>Fenchir</option>
          <option value="Kore" ${e.config.voice==="Kore"?"selected":""}>Kore</option>
          <option value="Leda" ${e.config.voice==="Leda"?"selected":""}>Leda</option>
        </select>
      </div>
      <div class="wf-config-field">
        <label>Vision FPS: ${e.config.visionFps??1}</label>
        <input type="range" min="0.5" max="2" step="0.5" data-field="config.visionFps" value="${e.config.visionFps??1}" />
      </div>
      <button class="btn btn-danger btn-sm wf-config-delete" data-id="${e.id}">Delete Node</button>
    `;else if(e.type==="s2s-rest")s.innerHTML=`
      <div class="wf-config-header" style="border-left: 3px solid ${o.header}">
        <span class="wf-config-type">S2S REST (Gemma)</span>
      </div>
      <div class="wf-config-field">
        <label>Label</label>
        <input type="text" class="wf-config-input" data-field="label" value="${v(e.label)}" />
      </div>
      <div class="wf-config-field">
        <label>Model</label>
        <select class="wf-config-input" data-field="config.model">
          <option value="gemma-4-27b" ${e.config.model==="gemma-4-27b"?"selected":""}>gemma-4-27b</option>
          <option value="gemma-4-12b" ${e.config.model==="gemma-4-12b"?"selected":""}>gemma-4-12b</option>
        </select>
      </div>
      <div class="wf-config-field">
        <label>Vision FPS: ${e.config.visionFps??1}</label>
        <input type="range" min="0.5" max="2" step="0.5" data-field="config.visionFps" value="${e.config.visionFps??1}" />
      </div>
      <div class="wf-config-field">
        <label>Temperature: ${e.config.temperature??.7}</label>
        <input type="range" min="0" max="2" step="0.1" data-field="config.temperature" value="${e.config.temperature??.7}" />
      </div>
      <button class="btn btn-danger btn-sm wf-config-delete" data-id="${e.id}">Delete Node</button>
    `;else if(e.type==="s2s-e4b")s.innerHTML=`
      <div class="wf-config-header" style="border-left: 3px solid ${o.header}">
        <span class="wf-config-type">S2S E4B (Gemma Voice)</span>
      </div>
      <div class="wf-config-field">
        <label>Label</label>
        <input type="text" class="wf-config-input" data-field="label" value="${v(e.label)}" />
      </div>
      <div class="wf-config-field">
        <label>Model</label>
        <select class="wf-config-input" data-field="config.model">
          <option value="gemma-4-e4b-it" ${e.config.model==="gemma-4-e4b-it"?"selected":""}>gemma-4-e4b-it</option>
        </select>
      </div>
      <div class="wf-config-field">
        <label>Voice</label>
        <select class="wf-config-input" data-field="config.voice">
          <option value="">Default</option>
          <option value="Aoede" ${e.config.voice==="Aoede"?"selected":""}>Aoede</option>
          <option value="Puck" ${e.config.voice==="Puck"?"selected":""}>Puck</option>
          <option value="Charon" ${e.config.voice==="Charon"?"selected":""}>Charon</option>
          <option value="Kore" ${e.config.voice==="Kore"?"selected":""}>Kore</option>
        </select>
      </div>
      <div class="wf-config-field">
        <label>Vision FPS: ${e.config.visionFps??1}</label>
        <input type="range" min="0.5" max="2" step="0.5" data-field="config.visionFps" value="${e.config.visionFps??1}" />
      </div>
      <button class="btn btn-danger btn-sm wf-config-delete" data-id="${e.id}">Delete Node</button>
    `;else if(e.type==="output"){const d=e.config.viewers!==!1,i=e.config.overlays!==!1,l=e.config.speaker!==!1,a=e.config.recording!==!1;s.innerHTML=`
      <div class="wf-config-header" style="border-left: 3px solid ${o.header}">
        <span class="wf-config-type">Output</span>
      </div>
      <div class="wf-config-field">
        <label>Label</label>
        <input type="text" class="wf-config-input" data-field="label" value="${v(e.label)}" />
      </div>
      <div class="wf-config-field">
        <label>Channels</label>
        <div class="wf-config-checks">
          <label><input type="checkbox" data-field="config.viewers" ${d?"checked":""} /> Viewers (WS fanout)</label>
          <label><input type="checkbox" data-field="config.overlays" ${i?"checked":""} /> Overlays (bbox)</label>
          <label><input type="checkbox" data-field="config.speaker" ${l?"checked":""} /> Speaker (HFP)</label>
          <label><input type="checkbox" data-field="config.recording" ${a?"checked":""} /> Recording (R2)</label>
        </div>
      </div>
      <button class="btn btn-danger btn-sm wf-config-delete" data-id="${e.id}">Delete Node</button>
    `}s.querySelectorAll("[data-field]").forEach(d=>{d.addEventListener("change",()=>{if(!t||!y)return;const i=t.nodes.find(c=>c.id===y);if(!i)return;const l=d.dataset.field,a=d;if(l.startsWith("config.")){const c=l.slice(7);a.type==="range"?i.config[c]=parseFloat(a.value):a.type==="checkbox"?i.config[c]=a.checked:i.config[c]=a.value}else i[l]=a.value;h=!0,L()})}),(f=s.querySelector(".wf-config-delete"))==null||f.addEventListener("click",()=>{if(!t)return;const d=s.querySelector(".wf-config-delete").dataset.id;t.nodes=t.nodes.filter(i=>i.id!==d),t.edges=t.edges.filter(i=>i.sourceNodeId!==d&&i.targetNodeId!==d),y=null,h=!0,L(),Y()})}export{le as default,le as page};
