import{e as p,m as V,n as W,l as H,p as q,u as D,q as G,a as R,r as U}from"./main-YjdusoCp.js";import"./modulepreload-polyfill-B5Qt9EMX.js";const ie={init(i){o=i,B()},destroy(){E&&(clearInterval(E),E=null),document.removeEventListener("keydown",P),o=null,t=null,m=null,L=0,x=0,g=1,$=null,v=null}};let o=null,E=null,t=null,m=null,$=null,v=null,L=0,x=0,g=1;const I={"camera-source":{fill:"#0d3d38",header:"#14b8a6",stroke:"#14b8a6"},"s2s-live":{fill:"#0d3320",header:"#22c55e",stroke:"#22c55e"},"s2s-rest":{fill:"#0d2040",header:"#3b82f6",stroke:"#3b82f6"},output:{fill:"#3d2000",header:"#f97316",stroke:"#f97316"}},y=180,S=80,A=8;function M(){return`n_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,7)}`}function j(){const i=location.hash.slice(1);return i==="/workflows"?"list":i==="/workflows/new"?"new":"edit"}function z(){const e=location.hash.slice(1).match(/^\/workflows\/(.+)$/);return e?e[1]:null}function B(){const i=j();i==="list"?K():C(i==="new")}async function K(){var i;o&&(o.innerHTML=`
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
  `,(i=o.querySelector("#wf-new-btn"))==null||i.addEventListener("click",()=>{location.hash="/workflows/new"}),await X(),E&&clearInterval(E),E=setInterval(()=>X(),15e3))}async function X(){const i=o==null?void 0:o.querySelector("#wf-list");if(!i)return;const e=await W();if(e.length===0){i.innerHTML='<p class="empty-state">No workflows yet. Click "+ New" to create one.</p>';return}i.innerHTML=e.map(s=>{const c=s.status==="published"?"wf-status-published":s.status==="archived"?"wf-status-archived":"wf-status-draft";return`
      <div class="wf-card" data-id="${p(s.id)}">
        <div class="wf-card-header">
          <span class="wf-card-name">${p(s.name)}</span>
          <span class="wf-card-status ${c}">${p(s.status)}</span>
        </div>
        <p class="wf-card-desc">${p(s.description||"No description")}</p>
        <div class="wf-card-meta">
          <span>${s.nodeCount} nodes</span>
          <span>${H(s.updatedAt)}</span>
        </div>
        <div class="wf-card-actions">
          <button class="btn btn-sm wf-edit-btn" data-id="${p(s.id)}">Edit</button>
          <button class="btn btn-sm btn-danger wf-delete-btn" data-id="${p(s.id)}">Delete</button>
        </div>
      </div>
    `}).join(""),i.querySelectorAll(".wf-edit-btn").forEach(s=>{s.addEventListener("click",()=>{location.hash=`/workflows/${s.dataset.id}`})}),i.querySelectorAll(".wf-delete-btn").forEach(s=>{s.addEventListener("click",async()=>{confirm("Delete this workflow?")&&(await q(s.dataset.id),await X())})})}async function C(i){if(o){if(m=null,L=0,x=0,g=1,i){const e=Date.now();t={id:"",name:"Untitled Workflow",description:"",status:"draft",ownerId:null,nodes:[{id:`n_src_${e}`,type:"camera-source",label:"Camera",config:{},positionX:100,positionY:150},{id:`n_ai_${e}`,type:"s2s-live",label:"AI Assistant",config:{model:"gemini-2.5-flash-native-audio-latest"},positionX:400,positionY:150},{id:`n_out_${e}`,type:"output",label:"Output",config:{outputTarget:"guidance"},positionX:700,positionY:150}],edges:[{id:`e_1_${e}`,sourceNodeId:`n_src_${e}`,targetNodeId:`n_ai_${e}`},{id:`e_2_${e}`,sourceNodeId:`n_ai_${e}`,targetNodeId:`n_out_${e}`}],canvasViewport:{x:0,y:0,zoom:1},createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}}else{const e=z();if(!e){location.hash="/workflows";return}const s=await V(e);if(!s){location.hash="/workflows";return}t=s}o.innerHTML=`
    <div class="page workflow-editor-page">
      <div class="wf-editor-layout">
        <div class="wf-palette">
          <h3 class="wf-palette-title">Nodes</h3>
          ${Object.entries(I).map(([e,s])=>`
            <button class="wf-palette-item" data-type="${e}">
              <span class="wf-palette-dot" style="background:${s.header}"></span>
              <span class="wf-palette-label">${e.replace("-"," ")}</span>
            </button>
          `).join("")}
        </div>
        <div class="wf-canvas-wrap" id="wf-canvas-wrap">
          ${O()}
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
  `,J()}}function O(){if(!t)return"";const i=t.nodes,e=t.edges,s=i.map(n=>{const a=I[n.type]??I.output,d=n.type==="s2s-live"||n.type==="s2s-rest"?(n.config.model??"").slice(0,20):n.type==="output"?n.config.outputTarget??"guidance":"Live feed",r=m===n.id;return`
      <g class="wf-node" data-id="${n.id}" transform="translate(${n.positionX}, ${n.positionY})">
        <rect class="wf-node-bg" width="${y}" height="${S}" rx="${A}" fill="${a.fill}" stroke="${r?"#fff":a.stroke}" stroke-width="${r?2:1}" />
        <rect class="wf-node-header" width="${y}" height="24" rx="${A}" fill="${a.header}" />
        <rect x="0" y="${A}" width="${y}" height="${24-A}" fill="${a.header}" />
        <text x="${y/2}" y="16" text-anchor="middle" fill="#fff" font-size="10" font-weight="600">${p(n.type.replace("-"," "))}</text>
        <text x="12" y="44" fill="#ccc" font-size="11">${p(n.label||n.type)}</text>
        <text x="12" y="60" fill="#888" font-size="9">${p(d)}</text>
        <circle class="wf-port wf-port-in" cx="0" cy="${S/2}" r="6" fill="${a.stroke}" stroke="#0a0a0a" stroke-width="2" />
        <circle class="wf-port wf-port-out" cx="${y}" cy="${S/2}" r="6" fill="${a.stroke}" stroke="#0a0a0a" stroke-width="2" />
      </g>
    `}).join(""),c=e.map(n=>{const a=i.find(b=>b.id===n.sourceNodeId),d=i.find(b=>b.id===n.targetNodeId);if(!a||!d)return"";const r=a.positionX+y,f=a.positionY+S/2,u=d.positionX,w=d.positionY+S/2,h=(r+u)/2;return`<path class="wf-edge" data-id="${n.id}" d="M ${r} ${f} C ${h} ${f}, ${h} ${w}, ${u} ${w}" fill="none" stroke="#64748b" stroke-width="2" />`}).join("");return`<svg class="wf-canvas-svg" id="wf-svg" viewBox="${L} ${x} ${900/g} ${600/g}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <pattern id="wf-grid" width="20" height="20" patternUnits="userSpaceOnUse">
        <path d="M 20 0 L 0 0 0 20" fill="none" stroke="rgba(255,255,255,0.04)" stroke-width="0.5" />
      </pattern>
    </defs>
    <rect x="-5000" y="-5000" width="10000" height="10000" fill="url(#wf-grid)" />
  ${c}${s}</svg>`}function k(){const i=o==null?void 0:o.querySelector("#wf-canvas-wrap");i&&(i.innerHTML=O(),F())}function J(){var i,e,s,c;F(),o==null||o.querySelectorAll(".wf-palette-item").forEach(l=>{l.addEventListener("click",()=>{if(!t)return;const n=l.dataset.type;if(n==="camera-source"&&t.nodes.some(r=>r.type==="camera-source")||n==="output"&&t.nodes.some(r=>r.type==="output"))return;const a=M(),d=t.nodes.length*30;t.nodes.push({id:a,type:n,label:n.replace("-"," "),config:n==="s2s-live"?{model:"gemini-2.5-flash-native-audio-latest"}:n==="s2s-rest"?{model:"gemma-4-27b"}:n==="output"?{outputTarget:"guidance"}:{},positionX:200+d,positionY:150+d}),k()})}),(i=o==null?void 0:o.querySelector("#wf-save-btn"))==null||i.addEventListener("click",async()=>{var l,n;if(t)if(t.name=((l=o==null?void 0:o.querySelector("#wf-name"))==null?void 0:l.value)??t.name,t.description=((n=o==null?void 0:o.querySelector("#wf-desc"))==null?void 0:n.value)??t.description,t.id){const a=await D(t.id,{name:t.name,description:t.description,nodes:t.nodes.map(d=>({...d,config:JSON.stringify(d.config)})),edges:t.edges,canvasViewport:JSON.stringify({x:L,y:x,zoom:g})});a&&(t=a)}else{const a=await G({name:t.name,description:t.description,nodes:t.nodes.map(d=>({...d,config:JSON.stringify(d.config)})),edges:t.edges});a&&(t=a,history.replaceState(null,"",`#/workflows/${a.id}`))}}),(e=o==null?void 0:o.querySelector("#wf-publish-btn"))==null||e.addEventListener("click",async()=>{if(!(t!=null&&t.id))return;const l=t.status==="published"?"draft":"published",n=await D(t.id,{status:l});n&&(t=n),C(!1)}),(s=o==null?void 0:o.querySelector("#wf-del-btn"))==null||s.addEventListener("click",async()=>{t!=null&&t.id&&confirm("Delete this workflow?")&&(await q(t.id),location.hash="/workflows")}),(c=o==null?void 0:o.querySelector("#wf-activate-btn"))==null||c.addEventListener("click",async()=>{if(!(t!=null&&t.id))return;const n=(await R()).filter(u=>u.live);if(n.length===0){alert("No live sessions available");return}const a=n.map(u=>{var w;return`${u.sessionId.slice(0,8)} (${((w=u.device)==null?void 0:w.deviceName)??"unknown"})`}).join(`
`),d=prompt(`Activate against which session?
${a}`);if(!d)return;const r=n.find(u=>u.sessionId.startsWith(d)||u.sessionId===d);if(!r){alert("Session not found");return}const f=await U(t.id,r.sessionId);alert(f?`Activated! App: ${f.appId}, Status: ${f.status}`:"Activation failed")}),document.addEventListener("keydown",P)}function P(i){if((i.key==="Delete"||i.key==="Backspace")&&m&&t){if(i.target.tagName==="INPUT"||i.target.tagName==="TEXTAREA")return;i.preventDefault();const e=m;t.nodes=t.nodes.filter(s=>s.id!==e),t.edges=t.edges.filter(s=>s.sourceNodeId!==e&&s.targetNodeId!==e),m=null,k(),T()}}function F(){const i=o==null?void 0:o.querySelector("#wf-svg");i&&(i.querySelectorAll(".wf-node").forEach(e=>{e.addEventListener("mousedown",s=>{const c=s,l=e.getAttribute("data-id"),n=c.target;if(n.classList.contains("wf-port-out")){_(c,l,i);return}m=l,T(),k(),n.classList.contains("wf-port-in")||Z(c,l)})}),i.querySelectorAll(".wf-edge").forEach(e=>{e.addEventListener("click",()=>{if(!t)return;const s=e.getAttribute("data-id");t.edges=t.edges.filter(c=>c.id!==s),k()})}),i.addEventListener("mousedown",e=>{const s=e;(s.target===i||s.target.tagName==="rect")&&(s.button===1||s.ctrlKey||s.metaKey?(e.preventDefault(),s.clientX,s.clientY):(m=null,T(),k()))}),i.addEventListener("wheel",e=>{e.preventDefault();const c=e.deltaY>0?.9:1.1;g=Math.max(.3,Math.min(3,g*c)),i.setAttribute("viewBox",`${L} ${x} ${900/g} ${600/g}`)},{passive:!1}))}function Q(i,e,s,c){for(const l of s){if(l.sourceNodeId!==e.id&&l.targetNodeId!==e.id)continue;const n=i.querySelector(`[data-id="${l.id}"]`);if(!n)continue;const a=c.find(b=>b.id===l.sourceNodeId),d=c.find(b=>b.id===l.targetNodeId);if(!a||!d)continue;const r=a.positionX+y,f=a.positionY+S/2,u=d.positionX,w=d.positionY+S/2,h=(r+u)/2;n.setAttribute("d",`M ${r} ${f} C ${h} ${f}, ${h} ${w}, ${u} ${w}`)}}function Z(i,e){if(!t)return;const s=t.nodes.find(n=>n.id===e);if(!s)return;$={nodeId:e,startX:i.clientX,startY:i.clientY,nodeStartX:s.positionX,nodeStartY:s.positionY};const c=n=>{if(!$||!t)return;const a=(n.clientX-$.startX)/g,d=(n.clientY-$.startY)/g,r=t.nodes.find(f=>f.id===$.nodeId);if(r){r.positionX=Math.round($.nodeStartX+a),r.positionY=Math.round($.nodeStartY+d);const f=o==null?void 0:o.querySelector("#wf-svg"),u=f==null?void 0:f.querySelector(`[data-id="${$.nodeId}"]`);u&&(u.setAttribute("transform",`translate(${r.positionX}, ${r.positionY})`),Q(f,r,t.edges,t.nodes))}},l=()=>{$=null,document.removeEventListener("mousemove",c),document.removeEventListener("mouseup",l),k()};document.addEventListener("mousemove",c),document.addEventListener("mouseup",l)}function _(i,e,s){const c=t==null?void 0:t.nodes.find(f=>f.id===e);if(!c)return;s.getBoundingClientRect();const l=c.positionX+y,n=c.positionY+S/2,a=document.createElementNS("http://www.w3.org/2000/svg","line");a.setAttribute("x1",String(l)),a.setAttribute("y1",String(n)),a.setAttribute("x2",String(l)),a.setAttribute("y2",String(n)),a.setAttribute("stroke","#94a3b3"),a.setAttribute("stroke-width","2"),a.setAttribute("stroke-dasharray","4"),s.appendChild(a),v={sourceNodeId:e,tempLine:a};const d=f=>{if(!v)return;const u=s.getBoundingClientRect(),w=L+(f.clientX-u.left)/u.width*(900/g),h=x+(f.clientY-u.top)/u.height*(600/g);v.tempLine.setAttribute("x2",String(w)),v.tempLine.setAttribute("y2",String(h))},r=f=>{v!=null&&v.tempLine.parentNode&&v.tempLine.parentNode.removeChild(v.tempLine);const u=s.getBoundingClientRect(),w=L+(f.clientX-u.left)/u.width*(900/g),h=x+(f.clientY-u.top)/u.height*(600/g),b=t==null?void 0:t.nodes.find(N=>w>=N.positionX&&w<=N.positionX+y&&h>=N.positionY&&h<=N.positionY+S&&N.id!==v.sourceNodeId);b&&t&&(t.edges.some(Y=>Y.sourceNodeId===v.sourceNodeId&&Y.targetNodeId===b.id)||(t.edges.push({id:M(),sourceNodeId:v.sourceNodeId,targetNodeId:b.id}),k())),v=null,document.removeEventListener("mousemove",d),document.removeEventListener("mouseup",r)};document.addEventListener("mousemove",d),document.addEventListener("mouseup",r)}function T(){var c;const i=o==null?void 0:o.querySelector("#wf-config-panel");if(!i||!t)return;if(!m){i.innerHTML='<p class="empty-state">Select a node</p>';return}const e=t.nodes.find(l=>l.id===m);if(!e){i.innerHTML='<p class="empty-state">Select a node</p>';return}const s=I[e.type]??I.output;if(e.type==="camera-source")i.innerHTML=`
      <div class="wf-config-header" style="border-left: 3px solid ${s.header}">
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
      <div class="wf-config-header" style="border-left: 3px solid ${s.header}">
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
      <div class="wf-config-header" style="border-left: 3px solid ${s.header}">
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
      <div class="wf-config-header" style="border-left: 3px solid ${s.header}">
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
    `}i.querySelectorAll("[data-field]").forEach(l=>{l.addEventListener("change",()=>{if(!t||!m)return;const n=t.nodes.find(r=>r.id===m);if(!n)return;const a=l.dataset.field,d=l.value;if(a.startsWith("config.")){const r=a.slice(7),f=l.type==="range"?parseFloat(d):d;n.config[r]=f}else n[a]=d;k()})}),(c=i.querySelector(".wf-config-delete"))==null||c.addEventListener("click",()=>{if(!t)return;const l=i.querySelector(".wf-config-delete").dataset.id;t.nodes=t.nodes.filter(n=>n.id!==l),t.edges=t.edges.filter(n=>n.sourceNodeId!==l&&n.targetNodeId!==l),m=null,k(),T()})}export{ie as default,ie as page};
