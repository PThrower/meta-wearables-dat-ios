import{e as p,m as O,n as W,l as G,p as T,u as D,q as j,a as K,r as R}from"./main-R9T4tZoC.js";import"./modulepreload-polyfill-B5Qt9EMX.js";const se={init(s){o=s,U()},destroy(){I&&(clearInterval(I),I=null),document.removeEventListener("keydown",H),o=null,w=!1,t=null,m=null,L=0,N=0,g=1,$=null,v=null}};let o=null,I=null,t=null,w=!1,m=null,$=null,v=null,L=0,N=0,g=1;const A={"camera-source":{fill:"#0d3d38",header:"#14b8a6",stroke:"#14b8a6"},text:{fill:"#1a1a2e",header:"#e2e8f0",stroke:"#94a3b8"},"s2s-live":{fill:"#0d3320",header:"#22c55e",stroke:"#22c55e"},"s2s-rest":{fill:"#0d2040",header:"#3b82f6",stroke:"#3b82f6"},"s2s-e4b":{fill:"#2d1050",header:"#a855f7",stroke:"#a855f7"},output:{fill:"#3d2000",header:"#f97316",stroke:"#f97316"}},k=180,x=80,M=8;function P(){return`n_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,7)}`}function z(){const s=location.hash.slice(1);return s==="/workflows"?"list":s==="/workflows/new"?"new":"edit"}function B(){const e=location.hash.slice(1).match(/^\/workflows\/(.+)$/);return e?e[1]:null}function U(){const s=z();s==="list"?J():q(s==="new")}async function J(){var s;o&&(o.innerHTML=`
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
  `,(s=o.querySelector("#wf-new-btn"))==null||s.addEventListener("click",()=>{location.hash="/workflows/new"}),await X(),I&&clearInterval(I),I=setInterval(()=>X(),15e3))}async function X(){const s=o==null?void 0:o.querySelector("#wf-list");if(!s)return;const e=await W();if(e.length===0){s.innerHTML='<p class="empty-state">No workflows yet. Click "+ New" to create one.</p>';return}s.innerHTML=e.map(n=>{const u=n.status==="published"?"wf-status-published":n.status==="archived"?"wf-status-archived":"wf-status-draft";return`
      <div class="wf-card" data-id="${p(n.id)}">
        <div class="wf-card-header">
          <span class="wf-card-name">${p(n.name)}</span>
          <span class="wf-card-status ${u}">${p(n.status)}</span>
        </div>
        <p class="wf-card-desc">${p(n.description||"No description")}</p>
        <div class="wf-card-meta">
          <span>${n.nodeCount} nodes</span>
          <span>${G(n.updatedAt)}</span>
        </div>
        <div class="wf-card-actions">
          <button class="btn btn-sm wf-edit-btn" data-id="${p(n.id)}">Edit</button>
          <button class="btn btn-sm btn-danger wf-delete-btn" data-id="${p(n.id)}">Delete</button>
        </div>
      </div>
    `}).join(""),s.querySelectorAll(".wf-edit-btn").forEach(n=>{n.addEventListener("click",()=>{location.hash=`/workflows/${n.dataset.id}`})}),s.querySelectorAll(".wf-delete-btn").forEach(n=>{n.addEventListener("click",async()=>{confirm("Delete this workflow?")&&(await T(n.dataset.id),await X())})})}async function q(s){if(o){if(w=!1,m=null,L=0,N=0,g=1,s){const e=Date.now();t={id:"",name:"Untitled Workflow",description:"",status:"draft",ownerId:null,nodes:[{id:`n_src_${e}`,type:"camera-source",label:"Input",config:{video:!0,phoneMic:!0,glassesMic:!1,gestures:!0,visionFps:1},positionX:100,positionY:200},{id:`n_txt_${e}`,type:"text",label:"Prompt",config:{text:""},positionX:400,positionY:80},{id:`n_ai_${e}`,type:"s2s-live",label:"AI Assistant",config:{model:"gemini-2.5-flash-native-audio-latest"},positionX:400,positionY:250},{id:`n_out_${e}`,type:"output",label:"Output",config:{viewers:!0,overlays:!0,speaker:!0,recording:!0},positionX:700,positionY:250}],edges:[{id:`e_1_${e}`,sourceNodeId:`n_src_${e}`,targetNodeId:`n_ai_${e}`},{id:`e_2_${e}`,sourceNodeId:`n_txt_${e}`,targetNodeId:`n_ai_${e}`},{id:`e_3_${e}`,sourceNodeId:`n_ai_${e}`,targetNodeId:`n_out_${e}`}],canvasViewport:{x:0,y:0,zoom:1},createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}}else{const e=B();if(!e){location.hash="/workflows";return}const n=await O(e);if(!n){location.hash="/workflows";return}t=n}o.innerHTML=`
    <div class="page workflow-editor-page">
      <div class="wf-editor-layout">
        <div class="wf-palette">
          <h3 class="wf-palette-title">Nodes</h3>
          ${Object.entries(A).map(([e,n])=>`
            <button class="wf-palette-item" data-type="${e}">
              <span class="wf-palette-dot" style="background:${n.header}"></span>
              <span class="wf-palette-label">${e.replace("-"," ")}</span>
            </button>
          `).join("")}
        </div>
        <div class="wf-canvas-wrap" id="wf-canvas-wrap">
          ${C()}
        </div>
        <div class="wf-config-panel" id="wf-config-panel">
          <p class="empty-state">Select a node</p>
        </div>
      </div>
      <div class="wf-toolbar">
        <input type="text" class="wf-toolbar-input" id="wf-name" value="${p(t.name)}" placeholder="Workflow name" />
        <input type="text" class="wf-toolbar-input wf-toolbar-desc" id="wf-desc" value="${p(t.description)}" placeholder="Description" />
        <button class="btn btn-primary" id="wf-save-btn">Save</button>
        <button class="btn" id="wf-publish-btn">${t.status==="published"?"Unpublish":"Publish"}</button>
        <button class="btn btn-danger" id="wf-del-btn">Delete</button>
        <button class="btn" id="wf-activate-btn">Activate</button>
      </div>
    </div>
  `,_()}}function C(){if(!t)return"";const s=t.nodes,e=t.edges,n=s.map(i=>{const a=A[i.type]??A.output,l=i.type==="s2s-live"||i.type==="s2s-rest"||i.type==="s2s-e4b"?(i.config.model??"").slice(0,20):i.type==="text"?(i.config.text??"").slice(0,22)||"Empty":i.type==="output"?Object.entries({viewers:"view",overlays:"overlay",speaker:"speaker",recording:"rec"}).filter(([,f])=>i.config[f]!==!1).map(([f])=>f).join(", ")||"all":i.type==="camera-source"?[i.config.video!==!1?"video":"",i.config.phoneMic!==!1?"phone-mic":"",i.config.glassesMic===!0?"glasses-mic":"",i.config.gestures!==!1?"gestures":""].filter(Boolean).join(", ")||"none":"Live feed",c=m===i.id;return`
      <g class="wf-node" data-id="${i.id}" transform="translate(${i.positionX}, ${i.positionY})">
        <rect class="wf-node-bg" width="${k}" height="${x}" rx="${M}" fill="${a.fill}" stroke="${c?"#fff":a.stroke}" stroke-width="${c?2:1}" />
        <rect class="wf-node-header" width="${k}" height="24" rx="${M}" fill="${a.header}" />
        <rect x="0" y="${M}" width="${k}" height="${24-M}" fill="${a.header}" />
        <text x="${k/2}" y="16" text-anchor="middle" fill="#fff" font-size="10" font-weight="600">${p(i.type.replace("-"," "))}</text>
        <text x="12" y="44" fill="#ccc" font-size="11">${p(i.label||i.type)}</text>
        <text x="12" y="60" fill="#888" font-size="9">${p(l)}</text>
        <circle class="wf-port wf-port-in" cx="0" cy="${x/2}" r="6" fill="${a.stroke}" stroke="#0a0a0a" stroke-width="2" />
        <circle class="wf-port wf-port-out" cx="${k}" cy="${x/2}" r="6" fill="${a.stroke}" stroke="#0a0a0a" stroke-width="2" />
      </g>
    `}).join(""),u=e.map(i=>{const a=s.find(h=>h.id===i.sourceNodeId),l=s.find(h=>h.id===i.targetNodeId);if(!a||!l)return"";const c=a.positionX+k,f=a.positionY+x/2,r=l.positionX,b=l.positionY+x/2,y=(c+r)/2;return`<path class="wf-edge" data-id="${i.id}" d="M ${c} ${f} C ${y} ${f}, ${y} ${b}, ${r} ${b}" fill="none" stroke="#64748b" stroke-width="2" />`}).join("");return`<svg class="wf-canvas-svg" id="wf-svg" viewBox="${L} ${N} ${900/g} ${600/g}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <pattern id="wf-grid" width="20" height="20" patternUnits="userSpaceOnUse">
        <path d="M 20 0 L 0 0 0 20" fill="none" stroke="rgba(255,255,255,0.04)" stroke-width="0.5" />
      </pattern>
    </defs>
    <rect x="-5000" y="-5000" width="10000" height="10000" fill="url(#wf-grid)" />
  ${u}${n}</svg>`}function S(){const s=o==null?void 0:o.querySelector("#wf-canvas-wrap");s&&(s.innerHTML=C(),V())}function _(){var s,e,n,u;V(),o==null||o.querySelectorAll(".wf-palette-item").forEach(d=>{d.addEventListener("click",()=>{if(!t)return;const i=d.dataset.type;if(i==="camera-source"&&t.nodes.some(r=>r.type==="camera-source")||i==="output"&&t.nodes.some(r=>r.type==="output"))return;const a=r=>r==="s2s-live"||r==="s2s-rest"||r==="s2s-e4b";if(a(i)&&t.nodes.some(r=>a(r.type)))return;const l=P(),c=t.nodes.length*30,f=i==="s2s-live"?{model:"gemini-2.5-flash-native-audio-latest"}:i==="s2s-rest"?{model:"gemma-4-27b"}:i==="s2s-e4b"?{model:"gemma-4-e4b-it"}:i==="text"?{text:""}:i==="output"?{viewers:!0,overlays:!0,speaker:!0,recording:!0}:{};t.nodes.push({id:l,type:i,label:i.replace(/-/g," "),config:f,positionX:200+c,positionY:150+c}),w=!0,S()})}),(s=o==null?void 0:o.querySelector("#wf-save-btn"))==null||s.addEventListener("click",async()=>{var i,a;if(!t)return;t.name=((i=o==null?void 0:o.querySelector("#wf-name"))==null?void 0:i.value)??t.name,t.description=((a=o==null?void 0:o.querySelector("#wf-desc"))==null?void 0:a.value)??t.description;const d=t.nodes.map(l=>({...l,config:JSON.stringify(l.config)}));if(t.id){const l=await D(t.id,{name:t.name,description:t.description,nodes:d,edges:t.edges,canvasViewport:JSON.stringify({x:L,y:N,zoom:g}),status:"published"});l&&(t=l)}else{const l=await j({name:t.name,description:t.description,nodes:d,edges:t.edges});l&&(t=await D(l.id,{status:"published"})??l,history.replaceState(null,"",`#/workflows/${t.id}`))}w=!1,q(!1)}),(e=o==null?void 0:o.querySelector("#wf-publish-btn"))==null||e.addEventListener("click",async()=>{var l,c;if(!(t!=null&&t.id)||w&&!confirm("You have unsaved changes. Save before publishing?"))return;const i={status:t.status==="published"?"draft":"published"};w&&(t.name=((l=o==null?void 0:o.querySelector("#wf-name"))==null?void 0:l.value)??t.name,t.description=((c=o==null?void 0:o.querySelector("#wf-desc"))==null?void 0:c.value)??t.description,i.name=t.name,i.description=t.description,i.nodes=t.nodes.map(f=>({...f,config:JSON.stringify(f.config)})),i.edges=t.edges);const a=await D(t.id,i);a&&(t=a,w=!1),q(!1)}),(n=o==null?void 0:o.querySelector("#wf-del-btn"))==null||n.addEventListener("click",async()=>{t!=null&&t.id&&confirm("Delete this workflow?")&&(await T(t.id),location.hash="/workflows")}),(u=o==null?void 0:o.querySelector("#wf-activate-btn"))==null||u.addEventListener("click",async()=>{if(!(t!=null&&t.id))return;const i=(await K()).filter(r=>r.live);if(i.length===0){alert("No live sessions available");return}const a=i.map(r=>{var b;return`${r.sessionId.slice(0,8)} (${((b=r.device)==null?void 0:b.deviceName)??"unknown"})`}).join(`
`),l=prompt(`Activate against which session?
${a}`);if(!l)return;const c=i.find(r=>r.sessionId.startsWith(l)||r.sessionId===l);if(!c){alert("Session not found");return}const f=await R(t.id,c.sessionId);alert(f?`Activated! App: ${f.appId}, Status: ${f.status}`:"Activation failed")}),document.addEventListener("keydown",H)}function H(s){if((s.key==="Delete"||s.key==="Backspace")&&m&&t){if(s.target.tagName==="INPUT"||s.target.tagName==="TEXTAREA")return;s.preventDefault();const e=m;t.nodes=t.nodes.filter(n=>n.id!==e),t.edges=t.edges.filter(n=>n.sourceNodeId!==e&&n.targetNodeId!==e),m=null,w=!0,S(),Y()}}function V(){const s=o==null?void 0:o.querySelector("#wf-svg");s&&(s.querySelectorAll(".wf-node").forEach(e=>{e.addEventListener("mousedown",n=>{const u=n,d=e.getAttribute("data-id"),i=u.target;if(i.classList.contains("wf-port-out")){ee(u,d,s);return}m=d,Y(),S(),i.classList.contains("wf-port-in")||Z(u,d)})}),s.querySelectorAll(".wf-edge").forEach(e=>{e.addEventListener("click",()=>{if(!t)return;const n=e.getAttribute("data-id");t.edges=t.edges.filter(u=>u.id!==n),w=!0,S()})}),s.addEventListener("mousedown",e=>{const n=e;(n.target===s||n.target.tagName==="rect")&&(n.button===1||n.ctrlKey||n.metaKey?(e.preventDefault(),n.clientX,n.clientY):(m=null,Y(),S()))}),s.addEventListener("wheel",e=>{e.preventDefault();const u=e.deltaY>0?.9:1.1;g=Math.max(.3,Math.min(3,g*u)),s.setAttribute("viewBox",`${L} ${N} ${900/g} ${600/g}`)},{passive:!1}))}function Q(s,e,n,u){for(const d of n){if(d.sourceNodeId!==e.id&&d.targetNodeId!==e.id)continue;const i=s.querySelector(`[data-id="${d.id}"]`);if(!i)continue;const a=u.find(h=>h.id===d.sourceNodeId),l=u.find(h=>h.id===d.targetNodeId);if(!a||!l)continue;const c=a.positionX+k,f=a.positionY+x/2,r=l.positionX,b=l.positionY+x/2,y=(c+r)/2;i.setAttribute("d",`M ${c} ${f} C ${y} ${f}, ${y} ${b}, ${r} ${b}`)}}function Z(s,e){if(!t)return;const n=t.nodes.find(i=>i.id===e);if(!n)return;$={nodeId:e,startX:s.clientX,startY:s.clientY,nodeStartX:n.positionX,nodeStartY:n.positionY};const u=i=>{if(!$||!t)return;const a=(i.clientX-$.startX)/g,l=(i.clientY-$.startY)/g,c=t.nodes.find(f=>f.id===$.nodeId);if(c){c.positionX=Math.round($.nodeStartX+a),c.positionY=Math.round($.nodeStartY+l),w=!0;const f=o==null?void 0:o.querySelector("#wf-svg"),r=f==null?void 0:f.querySelector(`[data-id="${$.nodeId}"]`);r&&(r.setAttribute("transform",`translate(${c.positionX}, ${c.positionY})`),Q(f,c,t.edges,t.nodes))}},d=()=>{$=null,document.removeEventListener("mousemove",u),document.removeEventListener("mouseup",d),S()};document.addEventListener("mousemove",u),document.addEventListener("mouseup",d)}function ee(s,e,n){const u=t==null?void 0:t.nodes.find(f=>f.id===e);if(!u)return;n.getBoundingClientRect();const d=u.positionX+k,i=u.positionY+x/2,a=document.createElementNS("http://www.w3.org/2000/svg","line");a.setAttribute("x1",String(d)),a.setAttribute("y1",String(i)),a.setAttribute("x2",String(d)),a.setAttribute("y2",String(i)),a.setAttribute("stroke","#94a3b3"),a.setAttribute("stroke-width","2"),a.setAttribute("stroke-dasharray","4"),n.appendChild(a),v={sourceNodeId:e,tempLine:a};const l=f=>{if(!v)return;const r=n.getBoundingClientRect(),b=L+(f.clientX-r.left)/r.width*(900/g),y=N+(f.clientY-r.top)/r.height*(600/g);v.tempLine.setAttribute("x2",String(b)),v.tempLine.setAttribute("y2",String(y))},c=f=>{v!=null&&v.tempLine.parentNode&&v.tempLine.parentNode.removeChild(v.tempLine);const r=n.getBoundingClientRect(),b=L+(f.clientX-r.left)/r.width*(900/g),y=N+(f.clientY-r.top)/r.height*(600/g),h=t==null?void 0:t.nodes.find(E=>b>=E.positionX&&b<=E.positionX+k&&y>=E.positionY&&y<=E.positionY+x&&E.id!==v.sourceNodeId);h&&t&&(t.edges.some(F=>F.sourceNodeId===v.sourceNodeId&&F.targetNodeId===h.id)||(t.edges.push({id:P(),sourceNodeId:v.sourceNodeId,targetNodeId:h.id}),w=!0,S())),v=null,document.removeEventListener("mousemove",l),document.removeEventListener("mouseup",c)};document.addEventListener("mousemove",l),document.addEventListener("mouseup",c)}function Y(){var u;const s=o==null?void 0:o.querySelector("#wf-config-panel");if(!s||!t)return;if(!m){s.innerHTML='<p class="empty-state">Select a node</p>';return}const e=t.nodes.find(d=>d.id===m);if(!e){s.innerHTML='<p class="empty-state">Select a node</p>';return}const n=A[e.type]??A.output;if(e.type==="camera-source"){const d=e.config.visionFps??1,i=e.config.video!==!1,a=e.config.phoneMic!==!1,l=e.config.glassesMic===!0,c=e.config.gestures!==!1;s.innerHTML=`
      <div class="wf-config-header" style="border-left: 3px solid ${n.header}">
        <span class="wf-config-type">Input</span>
      </div>
      <div class="wf-config-field">
        <label>Label</label>
        <input type="text" class="wf-config-input" data-field="label" value="${p(e.label)}" />
      </div>
      <div class="wf-config-field">
        <label>Modalities</label>
        <div class="wf-config-checks">
          <label><input type="checkbox" data-field="config.video" ${i?"checked":""} /> Video (frames)</label>
          <label><input type="checkbox" data-field="config.phoneMic" ${a?"checked":""} /> Phone mic (48kHz)</label>
          <label><input type="checkbox" data-field="config.glassesMic" ${l?"checked":""} /> Glasses HFP mic (8kHz)</label>
          <label><input type="checkbox" data-field="config.gestures" ${c?"checked":""} /> Gestures</label>
        </div>
      </div>
      <div class="wf-config-field">
        <label>Vision FPS: ${d}</label>
        <input type="range" min="0.2" max="2" step="0.1" data-field="config.visionFps" value="${d}" />
      </div>
      <button class="btn btn-danger btn-sm wf-config-delete" data-id="${e.id}">Delete Node</button>
    `}else if(e.type==="text"){const d=e.config.text??"";s.innerHTML=`
      <div class="wf-config-header" style="border-left: 3px solid ${n.header}">
        <span class="wf-config-type">Text / Prompt</span>
      </div>
      <div class="wf-config-field">
        <label>Label</label>
        <input type="text" class="wf-config-input" data-field="label" value="${p(e.label)}" />
      </div>
      <div class="wf-config-field">
        <label>System Prompt</label>
        <textarea class="wf-config-input wf-config-textarea" data-field="config.text" rows="10" placeholder="Enter system prompt...">${p(d)}</textarea>
      </div>
      <button class="btn btn-danger btn-sm wf-config-delete" data-id="${e.id}">Delete Node</button>
    `}else if(e.type==="s2s-live")s.innerHTML=`
      <div class="wf-config-header" style="border-left: 3px solid ${n.header}">
        <span class="wf-config-type">S2S Live (Gemini)</span>
      </div>
      <div class="wf-config-field">
        <label>Label</label>
        <input type="text" class="wf-config-input" data-field="label" value="${p(e.label)}" />
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
      <div class="wf-config-header" style="border-left: 3px solid ${n.header}">
        <span class="wf-config-type">S2S REST (Gemma)</span>
      </div>
      <div class="wf-config-field">
        <label>Label</label>
        <input type="text" class="wf-config-input" data-field="label" value="${p(e.label)}" />
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
      <div class="wf-config-header" style="border-left: 3px solid ${n.header}">
        <span class="wf-config-type">S2S E4B (Gemma Voice)</span>
      </div>
      <div class="wf-config-field">
        <label>Label</label>
        <input type="text" class="wf-config-input" data-field="label" value="${p(e.label)}" />
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
    `;else if(e.type==="output"){const d=e.config.viewers!==!1,i=e.config.overlays!==!1,a=e.config.speaker!==!1,l=e.config.recording!==!1;s.innerHTML=`
      <div class="wf-config-header" style="border-left: 3px solid ${n.header}">
        <span class="wf-config-type">Output</span>
      </div>
      <div class="wf-config-field">
        <label>Label</label>
        <input type="text" class="wf-config-input" data-field="label" value="${p(e.label)}" />
      </div>
      <div class="wf-config-field">
        <label>Channels</label>
        <div class="wf-config-checks">
          <label><input type="checkbox" data-field="config.viewers" ${d?"checked":""} /> Viewers (WS fanout)</label>
          <label><input type="checkbox" data-field="config.overlays" ${i?"checked":""} /> Overlays (bbox)</label>
          <label><input type="checkbox" data-field="config.speaker" ${a?"checked":""} /> Speaker (HFP)</label>
          <label><input type="checkbox" data-field="config.recording" ${l?"checked":""} /> Recording (R2)</label>
        </div>
      </div>
      <button class="btn btn-danger btn-sm wf-config-delete" data-id="${e.id}">Delete Node</button>
    `}s.querySelectorAll("[data-field]").forEach(d=>{d.addEventListener("change",()=>{if(!t||!m)return;const i=t.nodes.find(c=>c.id===m);if(!i)return;const a=d.dataset.field,l=d;if(a.startsWith("config.")){const c=a.slice(7);l.type==="range"?i.config[c]=parseFloat(l.value):l.type==="checkbox"?i.config[c]=l.checked:i.config[c]=l.value}else i[a]=l.value;w=!0,S()})}),(u=s.querySelector(".wf-config-delete"))==null||u.addEventListener("click",()=>{if(!t)return;const d=s.querySelector(".wf-config-delete").dataset.id;t.nodes=t.nodes.filter(i=>i.id!==d),t.edges=t.edges.filter(i=>i.sourceNodeId!==d&&i.targetNodeId!==d),m=null,w=!0,S(),Y()})}export{se as default,se as page};
