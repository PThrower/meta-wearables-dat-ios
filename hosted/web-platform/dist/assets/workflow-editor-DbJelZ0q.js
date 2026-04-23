import{e as p,m as W,n as H,l as G,p as C,u as X,q as R,a as U,r as j}from"./main-CH8lqoXj.js";import"./modulepreload-polyfill-B5Qt9EMX.js";const se={init(i){o=i,K()},destroy(){I&&(clearInterval(I),I=null),document.removeEventListener("keydown",F),o=null,m=!1,t=null,b=null,x=0,N=0,g=1,y=null,v=null}};let o=null,I=null,t=null,m=!1,b=null,y=null,v=null,x=0,N=0,g=1;const A={"camera-source":{fill:"#0d3d38",header:"#14b8a6",stroke:"#14b8a6"},"s2s-live":{fill:"#0d3320",header:"#22c55e",stroke:"#22c55e"},"s2s-rest":{fill:"#0d2040",header:"#3b82f6",stroke:"#3b82f6"},output:{fill:"#3d2000",header:"#f97316",stroke:"#f97316"}},S=180,k=80,T=8;function O(){return`n_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,7)}`}function z(){const i=location.hash.slice(1);return i==="/workflows"?"list":i==="/workflows/new"?"new":"edit"}function B(){const e=location.hash.slice(1).match(/^\/workflows\/(.+)$/);return e?e[1]:null}function K(){const i=z();i==="list"?J():q(i==="new")}async function J(){var i;o&&(o.innerHTML=`
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
  `,(i=o.querySelector("#wf-new-btn"))==null||i.addEventListener("click",()=>{location.hash="/workflows/new"}),await D(),I&&clearInterval(I),I=setInterval(()=>D(),15e3))}async function D(){const i=o==null?void 0:o.querySelector("#wf-list");if(!i)return;const e=await H();if(e.length===0){i.innerHTML='<p class="empty-state">No workflows yet. Click "+ New" to create one.</p>';return}i.innerHTML=e.map(n=>{const f=n.status==="published"?"wf-status-published":n.status==="archived"?"wf-status-archived":"wf-status-draft";return`
      <div class="wf-card" data-id="${p(n.id)}">
        <div class="wf-card-header">
          <span class="wf-card-name">${p(n.name)}</span>
          <span class="wf-card-status ${f}">${p(n.status)}</span>
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
    `}).join(""),i.querySelectorAll(".wf-edit-btn").forEach(n=>{n.addEventListener("click",()=>{location.hash=`/workflows/${n.dataset.id}`})}),i.querySelectorAll(".wf-delete-btn").forEach(n=>{n.addEventListener("click",async()=>{confirm("Delete this workflow?")&&(await C(n.dataset.id),await D())})})}async function q(i){if(o){if(m=!1,b=null,x=0,N=0,g=1,i){const e=Date.now();t={id:"",name:"Untitled Workflow",description:"",status:"draft",ownerId:null,nodes:[{id:`n_src_${e}`,type:"camera-source",label:"Camera",config:{},positionX:100,positionY:150},{id:`n_ai_${e}`,type:"s2s-live",label:"AI Assistant",config:{model:"gemini-2.5-flash-native-audio-latest"},positionX:400,positionY:150},{id:`n_out_${e}`,type:"output",label:"Output",config:{outputTarget:"guidance"},positionX:700,positionY:150}],edges:[{id:`e_1_${e}`,sourceNodeId:`n_src_${e}`,targetNodeId:`n_ai_${e}`},{id:`e_2_${e}`,sourceNodeId:`n_ai_${e}`,targetNodeId:`n_out_${e}`}],canvasViewport:{x:0,y:0,zoom:1},createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}}else{const e=B();if(!e){location.hash="/workflows";return}const n=await W(e);if(!n){location.hash="/workflows";return}t=n}o.innerHTML=`
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
          ${P()}
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
  `,Q()}}function P(){if(!t)return"";const i=t.nodes,e=t.edges,n=i.map(s=>{const a=A[s.type]??A.output,d=s.type==="s2s-live"||s.type==="s2s-rest"?(s.config.model??"").slice(0,20):s.type==="output"?s.config.outputTarget??"guidance":"Live feed",r=b===s.id;return`
      <g class="wf-node" data-id="${s.id}" transform="translate(${s.positionX}, ${s.positionY})">
        <rect class="wf-node-bg" width="${S}" height="${k}" rx="${T}" fill="${a.fill}" stroke="${r?"#fff":a.stroke}" stroke-width="${r?2:1}" />
        <rect class="wf-node-header" width="${S}" height="24" rx="${T}" fill="${a.header}" />
        <rect x="0" y="${T}" width="${S}" height="${24-T}" fill="${a.header}" />
        <text x="${S/2}" y="16" text-anchor="middle" fill="#fff" font-size="10" font-weight="600">${p(s.type.replace("-"," "))}</text>
        <text x="12" y="44" fill="#ccc" font-size="11">${p(s.label||s.type)}</text>
        <text x="12" y="60" fill="#888" font-size="9">${p(d)}</text>
        <circle class="wf-port wf-port-in" cx="0" cy="${k/2}" r="6" fill="${a.stroke}" stroke="#0a0a0a" stroke-width="2" />
        <circle class="wf-port wf-port-out" cx="${S}" cy="${k/2}" r="6" fill="${a.stroke}" stroke="#0a0a0a" stroke-width="2" />
      </g>
    `}).join(""),f=e.map(s=>{const a=i.find(h=>h.id===s.sourceNodeId),d=i.find(h=>h.id===s.targetNodeId);if(!a||!d)return"";const r=a.positionX+S,c=a.positionY+k/2,u=d.positionX,w=d.positionY+k/2,$=(r+u)/2;return`<path class="wf-edge" data-id="${s.id}" d="M ${r} ${c} C ${$} ${c}, ${$} ${w}, ${u} ${w}" fill="none" stroke="#64748b" stroke-width="2" />`}).join("");return`<svg class="wf-canvas-svg" id="wf-svg" viewBox="${x} ${N} ${900/g} ${600/g}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <pattern id="wf-grid" width="20" height="20" patternUnits="userSpaceOnUse">
        <path d="M 20 0 L 0 0 0 20" fill="none" stroke="rgba(255,255,255,0.04)" stroke-width="0.5" />
      </pattern>
    </defs>
    <rect x="-5000" y="-5000" width="10000" height="10000" fill="url(#wf-grid)" />
  ${f}${n}</svg>`}function L(){const i=o==null?void 0:o.querySelector("#wf-canvas-wrap");i&&(i.innerHTML=P(),V())}function Q(){var i,e,n,f;V(),o==null||o.querySelectorAll(".wf-palette-item").forEach(l=>{l.addEventListener("click",()=>{if(!t)return;const s=l.dataset.type;if(s==="camera-source"&&t.nodes.some(r=>r.type==="camera-source")||s==="output"&&t.nodes.some(r=>r.type==="output"))return;const a=O(),d=t.nodes.length*30;t.nodes.push({id:a,type:s,label:s.replace("-"," "),config:s==="s2s-live"?{model:"gemini-2.5-flash-native-audio-latest"}:s==="s2s-rest"?{model:"gemma-4-27b"}:s==="output"?{outputTarget:"guidance"}:{},positionX:200+d,positionY:150+d}),m=!0,L()})}),(i=o==null?void 0:o.querySelector("#wf-save-btn"))==null||i.addEventListener("click",async()=>{var s,a;if(!t)return;t.name=((s=o==null?void 0:o.querySelector("#wf-name"))==null?void 0:s.value)??t.name,t.description=((a=o==null?void 0:o.querySelector("#wf-desc"))==null?void 0:a.value)??t.description;const l=t.nodes.map(d=>({...d,config:JSON.stringify(d.config)}));if(t.id){const d=await X(t.id,{name:t.name,description:t.description,nodes:l,edges:t.edges,canvasViewport:JSON.stringify({x,y:N,zoom:g}),status:"published"});d&&(t=d)}else{const d=await R({name:t.name,description:t.description,nodes:l,edges:t.edges});d&&(t=await X(d.id,{status:"published"})??d,history.replaceState(null,"",`#/workflows/${t.id}`))}m=!1,q(!1)}),(e=o==null?void 0:o.querySelector("#wf-publish-btn"))==null||e.addEventListener("click",async()=>{var d,r;if(!(t!=null&&t.id)||m&&!confirm("You have unsaved changes. Save before publishing?"))return;const s={status:t.status==="published"?"draft":"published"};m&&(t.name=((d=o==null?void 0:o.querySelector("#wf-name"))==null?void 0:d.value)??t.name,t.description=((r=o==null?void 0:o.querySelector("#wf-desc"))==null?void 0:r.value)??t.description,s.name=t.name,s.description=t.description,s.nodes=t.nodes.map(c=>({...c,config:JSON.stringify(c.config)})),s.edges=t.edges);const a=await X(t.id,s);a&&(t=a,m=!1),q(!1)}),(n=o==null?void 0:o.querySelector("#wf-del-btn"))==null||n.addEventListener("click",async()=>{t!=null&&t.id&&confirm("Delete this workflow?")&&(await C(t.id),location.hash="/workflows")}),(f=o==null?void 0:o.querySelector("#wf-activate-btn"))==null||f.addEventListener("click",async()=>{if(!(t!=null&&t.id))return;const s=(await U()).filter(u=>u.live);if(s.length===0){alert("No live sessions available");return}const a=s.map(u=>{var w;return`${u.sessionId.slice(0,8)} (${((w=u.device)==null?void 0:w.deviceName)??"unknown"})`}).join(`
`),d=prompt(`Activate against which session?
${a}`);if(!d)return;const r=s.find(u=>u.sessionId.startsWith(d)||u.sessionId===d);if(!r){alert("Session not found");return}const c=await j(t.id,r.sessionId);alert(c?`Activated! App: ${c.appId}, Status: ${c.status}`:"Activation failed")}),document.addEventListener("keydown",F)}function F(i){if((i.key==="Delete"||i.key==="Backspace")&&b&&t){if(i.target.tagName==="INPUT"||i.target.tagName==="TEXTAREA")return;i.preventDefault();const e=b;t.nodes=t.nodes.filter(n=>n.id!==e),t.edges=t.edges.filter(n=>n.sourceNodeId!==e&&n.targetNodeId!==e),b=null,m=!0,L(),Y()}}function V(){const i=o==null?void 0:o.querySelector("#wf-svg");i&&(i.querySelectorAll(".wf-node").forEach(e=>{e.addEventListener("mousedown",n=>{const f=n,l=e.getAttribute("data-id"),s=f.target;if(s.classList.contains("wf-port-out")){ee(f,l,i);return}b=l,Y(),L(),s.classList.contains("wf-port-in")||_(f,l)})}),i.querySelectorAll(".wf-edge").forEach(e=>{e.addEventListener("click",()=>{if(!t)return;const n=e.getAttribute("data-id");t.edges=t.edges.filter(f=>f.id!==n),m=!0,L()})}),i.addEventListener("mousedown",e=>{const n=e;(n.target===i||n.target.tagName==="rect")&&(n.button===1||n.ctrlKey||n.metaKey?(e.preventDefault(),n.clientX,n.clientY):(b=null,Y(),L()))}),i.addEventListener("wheel",e=>{e.preventDefault();const f=e.deltaY>0?.9:1.1;g=Math.max(.3,Math.min(3,g*f)),i.setAttribute("viewBox",`${x} ${N} ${900/g} ${600/g}`)},{passive:!1}))}function Z(i,e,n,f){for(const l of n){if(l.sourceNodeId!==e.id&&l.targetNodeId!==e.id)continue;const s=i.querySelector(`[data-id="${l.id}"]`);if(!s)continue;const a=f.find(h=>h.id===l.sourceNodeId),d=f.find(h=>h.id===l.targetNodeId);if(!a||!d)continue;const r=a.positionX+S,c=a.positionY+k/2,u=d.positionX,w=d.positionY+k/2,$=(r+u)/2;s.setAttribute("d",`M ${r} ${c} C ${$} ${c}, ${$} ${w}, ${u} ${w}`)}}function _(i,e){if(!t)return;const n=t.nodes.find(s=>s.id===e);if(!n)return;y={nodeId:e,startX:i.clientX,startY:i.clientY,nodeStartX:n.positionX,nodeStartY:n.positionY};const f=s=>{if(!y||!t)return;const a=(s.clientX-y.startX)/g,d=(s.clientY-y.startY)/g,r=t.nodes.find(c=>c.id===y.nodeId);if(r){r.positionX=Math.round(y.nodeStartX+a),r.positionY=Math.round(y.nodeStartY+d),m=!0;const c=o==null?void 0:o.querySelector("#wf-svg"),u=c==null?void 0:c.querySelector(`[data-id="${y.nodeId}"]`);u&&(u.setAttribute("transform",`translate(${r.positionX}, ${r.positionY})`),Z(c,r,t.edges,t.nodes))}},l=()=>{y=null,document.removeEventListener("mousemove",f),document.removeEventListener("mouseup",l),L()};document.addEventListener("mousemove",f),document.addEventListener("mouseup",l)}function ee(i,e,n){const f=t==null?void 0:t.nodes.find(c=>c.id===e);if(!f)return;n.getBoundingClientRect();const l=f.positionX+S,s=f.positionY+k/2,a=document.createElementNS("http://www.w3.org/2000/svg","line");a.setAttribute("x1",String(l)),a.setAttribute("y1",String(s)),a.setAttribute("x2",String(l)),a.setAttribute("y2",String(s)),a.setAttribute("stroke","#94a3b3"),a.setAttribute("stroke-width","2"),a.setAttribute("stroke-dasharray","4"),n.appendChild(a),v={sourceNodeId:e,tempLine:a};const d=c=>{if(!v)return;const u=n.getBoundingClientRect(),w=x+(c.clientX-u.left)/u.width*(900/g),$=N+(c.clientY-u.top)/u.height*(600/g);v.tempLine.setAttribute("x2",String(w)),v.tempLine.setAttribute("y2",String($))},r=c=>{v!=null&&v.tempLine.parentNode&&v.tempLine.parentNode.removeChild(v.tempLine);const u=n.getBoundingClientRect(),w=x+(c.clientX-u.left)/u.width*(900/g),$=N+(c.clientY-u.top)/u.height*(600/g),h=t==null?void 0:t.nodes.find(E=>w>=E.positionX&&w<=E.positionX+S&&$>=E.positionY&&$<=E.positionY+k&&E.id!==v.sourceNodeId);h&&t&&(t.edges.some(M=>M.sourceNodeId===v.sourceNodeId&&M.targetNodeId===h.id)||(t.edges.push({id:O(),sourceNodeId:v.sourceNodeId,targetNodeId:h.id}),m=!0,L())),v=null,document.removeEventListener("mousemove",d),document.removeEventListener("mouseup",r)};document.addEventListener("mousemove",d),document.addEventListener("mouseup",r)}function Y(){var f;const i=o==null?void 0:o.querySelector("#wf-config-panel");if(!i||!t)return;if(!b){i.innerHTML='<p class="empty-state">Select a node</p>';return}const e=t.nodes.find(l=>l.id===b);if(!e){i.innerHTML='<p class="empty-state">Select a node</p>';return}const n=A[e.type]??A.output;if(e.type==="camera-source")i.innerHTML=`
      <div class="wf-config-header" style="border-left: 3px solid ${n.header}">
        <span class="wf-config-type">Camera Source</span>
        <span class="wf-config-label">${p(e.label)}</span>
      </div>
      <div class="wf-config-field">
        <label>Label</label>
        <input type="text" class="wf-config-input" data-field="label" value="${p(e.label)}" />
      </div>
      <div class="wf-config-info">Live camera feed from device</div>
      <button class="btn btn-danger btn-sm wf-config-delete" data-id="${e.id}">Delete Node</button>
    `;else if(e.type==="s2s-live")i.innerHTML=`
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
        <label>System Prompt</label>
        <textarea class="wf-config-input wf-config-textarea" data-field="config.systemPrompt" rows="6">${p(e.config.systemPrompt??"")}</textarea>
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
    `;else if(e.type==="s2s-rest")i.innerHTML=`
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
        <label>System Prompt</label>
        <textarea class="wf-config-input wf-config-textarea" data-field="config.systemPrompt" rows="6">${p(e.config.systemPrompt??"")}</textarea>
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
    `;else if(e.type==="output"){const l=e.config.outputTarget??"guidance";i.innerHTML=`
      <div class="wf-config-header" style="border-left: 3px solid ${n.header}">
        <span class="wf-config-type">Output</span>
      </div>
      <div class="wf-config-field">
        <label>Label</label>
        <input type="text" class="wf-config-input" data-field="label" value="${p(e.label)}" />
      </div>
      <div class="wf-config-field">
        <label>Target</label>
        <div class="wf-config-radio">
          <label><input type="radio" name="outputTarget" value="guidance" ${l==="guidance"?"checked":""} data-field="config.outputTarget" /> Guidance</label>
          <label><input type="radio" name="outputTarget" value="tts" ${l==="tts"?"checked":""} data-field="config.outputTarget" /> TTS</label>
          <label><input type="radio" name="outputTarget" value="log" ${l==="log"?"checked":""} data-field="config.outputTarget" /> Log only</label>
        </div>
      </div>
      <button class="btn btn-danger btn-sm wf-config-delete" data-id="${e.id}">Delete Node</button>
    `}i.querySelectorAll("[data-field]").forEach(l=>{l.addEventListener("change",()=>{if(!t||!b)return;const s=t.nodes.find(r=>r.id===b);if(!s)return;const a=l.dataset.field,d=l.value;if(a.startsWith("config.")){const r=a.slice(7),c=l.type==="range"?parseFloat(d):d;s.config[r]=c}else s[a]=d;m=!0,L()})}),(f=i.querySelector(".wf-config-delete"))==null||f.addEventListener("click",()=>{if(!t)return;const l=i.querySelector(".wf-config-delete").dataset.id;t.nodes=t.nodes.filter(s=>s.id!==l),t.edges=t.edges.filter(s=>s.sourceNodeId!==l&&s.targetNodeId!==l),b=null,m=!0,L(),Y()})}export{se as default,se as page};
