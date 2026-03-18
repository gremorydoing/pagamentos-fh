// SUPABASE
const SB_URL="https://ejzemhsagyxcndxwpimf.supabase.co";
const SB_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVqemVtaHNhZ3l4Y25keHdwaW1mIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMxNzUzNTIsImV4cCI6MjA4ODc1MTM1Mn0.v85WNMeK4RRLahBPYaPt8NoUnY2Gp9wfPL25JtOp9c4";
const SB_AUTH_URL = SB_URL + '/auth/v1';

// ── AUTENTICACAO DINAMICA COM RENOVAÇÃO DE TOKEN ─────────────────────
async function authApiFetch(path, options = {}) {
  let token = getStoredToken() || SB_KEY;
  options.headers = { ...options.headers, 'apikey': SB_KEY, 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };
  
  let res = await fetch(SB_URL + path, options);
  if (res.status === 401) {
    const refreshed = await attemptTokenRefresh();
    if (refreshed) {
      token = getStoredToken();
      options.headers['Authorization'] = 'Bearer ' + token;
      res = await fetch(SB_URL + path, options);
    } else {
      doLogout();
      throw new Error("Sessao expirada. Redirecionando...");
    }
  }
  if (!res.ok) throw new Error(await res.text());
  return res;
}

async function attemptTokenRefresh() {
  const session = getStoredSession();
  if (!session?.refresh_token) return false;
  try {
    const res = await fetch(SB_AUTH_URL + '/token?grant_type=refresh_token', {
      method: 'POST',
      headers: { 'apikey': SB_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: session.refresh_token })
    });
    if (!res.ok) return false;
    const data = await res.json();
    storeSession(data);
    return true;
  } catch (e) {
    return false;
  }
}

// ── NEW: registros table (individual rows) ────────────────────────────
async function sbGetAll(){
  const res = await authApiFetch("/rest/v1/registros?order=id.asc&limit=5000", { method: 'GET' });
  return res.json();
}

async function sbUpsert(row){
  await authApiFetch("/rest/v1/registros", {
    method: "POST",
    headers: { "Prefer": "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(row)
  });
}

async function sbUpsertMany(rows){
  if(!rows.length) return;
  await authApiFetch("/rest/v1/registros", {
    method: "POST",
    headers: { "Prefer": "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(rows)
  });
}

// DATA_RAW removed — all data loaded from Supabase registros table;

// Chart.js instance registry — destroy before re-creating to avoid memory leaks
// This is important: Chart.js holds canvas references, if you create a new chart
// on the same canvas without destroying the old one, you get ghost charts
const CHARTS = {};
function destroyChart(key){
  if(CHARTS[key]){CHARTS[key].destroy();delete CHARTS[key];}
}
function mkChart(key, canvasId, config){
  destroyChart(key);
  const el = document.getElementById(canvasId);
  if(!el) return;
  // Read CSS variables for colors (so charts respect light/dark theme)
  const style = getComputedStyle(document.body);
  const mu = style.getPropertyValue('--mu').trim() || '#647086';
  const br = style.getPropertyValue('--br').trim() || '#232d3f';
  const tx = style.getPropertyValue('--tx').trim() || '#e2e8f4';
  // Inject theme-aware defaults into config
  if(!config.options) config.options = {};
  if(!config.options.plugins) config.options.plugins = {};
  if(!config.options.plugins.legend) config.options.plugins.legend = {};
  config.options.plugins.legend.labels = {
    ...config.options.plugins.legend.labels,
    color: tx, font: {family: "'DM Sans', sans-serif", size: 11}
  };
  if(config.options.scales){
    Object.values(config.options.scales).forEach(ax=>{
      if(!ax.ticks) ax.ticks = {};
      ax.ticks.color = mu;
      ax.ticks.font = {family: "'DM Sans', sans-serif", size: 11};
      if(!ax.grid) ax.grid = {};
      ax.grid.color = br;
      if(!ax.border) ax.border = {};
      ax.border.color = br;
    });
  }
  config.options.responsive = true;
  config.options.maintainAspectRatio = false;
  config.options.animation = {duration: 400, easing: 'easeOutQuart'};
  CHARTS[key] = new Chart(el, config);
  return CHARTS[key];
}


// Normalize legacy status strings on load (fixes data imported before typo fix)
function normalizeStatuses(){
  const MAP = {
    '5 -Enviar OC ao fornecedor':  '5 - Enviar OC ao fornecedor',
    '7- Aguardando lancamento NF': '7 - Aguardando lancamento NF',
  };
  let changed = false;
  data.forEach(r=>{
    if(r.status && MAP[r.status]){r.status=MAP[r.status];changed=true;}
  });
  if(changed) saveState();
}
// ── FUSE.JS — FUZZY SEARCH ──────────────────────────────────────────
// Fuse indexes the data array and lets us search across multiple fields
// We rebuild the index whenever data changes (new record, load from DB)
let fuseIndex = null;

function buildFuse(){
  // keys = fields to search + their weights (higher = more important)
  // threshold: 0.0 = perfect match only, 1.0 = match anything
  // 0.35 is a good balance: finds typos but avoids noise
  fuseIndex = new Fuse(data, {
    keys: [
      {name:'desc',    weight:0.35},  // description — most important
      {name:'forn',    weight:0.30},  // supplier name
      {name:'rc',      weight:0.15},  // RC number
      {name:'oc',      weight:0.10},  // OC number
      {name:'_resp',   weight:0.05},  // responsible person
      {name:'obs',     weight:0.03},  // observations
      {name:'sn',      weight:0.02},  // SN code
    ],
    threshold: 0.35,
    includeScore: true,
    ignoreLocation: true,   // don't penalize matches far from string start
    minMatchCharLength: 2,  // ignore single-char queries
  });
}

// Search hint CSS + pill indicator

const MONTHS = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
const STATUS_ORDER = [
  '0 - Aguardando confirmacao','1 - Abertura RC','2 - Aprovacao RC','3 - Gerar Pedido',
  '4 - Aprovacao Pedido','5 - Enviar OC ao fornecedor',
  '6 - Aguardando envio da NF','7 - Aguardando lancamento NF',
  '8 - Liberar FBL1N','9 - Aguardando Pgto','10 - Pago','11 - Cancelado'
];
const ST = {
  '10 - Pago':{bg:'rgba(30,201,122,.14)',c:'#1ec97a',d:'#1ec97a'},
  '11 - Cancelado':{bg:'rgba(255,63,94,.12)',c:'#ff3f5e',d:'#ff3f5e'},
  '9 - Aguardando Pgto':{bg:'rgba(245,165,36,.13)',c:'#f5a524',d:'#f5a524'},
  '8 - Liberar FBL1N':{bg:'rgba(100,140,255,.14)',c:'#7aabff',d:'#6b9fff'},
  '7 - Aguardando lancamento NF':{bg:'rgba(167,139,250,.12)',c:'#c4b5fd',d:'#a78bfa'},
  '6 - Aguardando envio da NF':{bg:'rgba(45,212,191,.11)',c:'#2dd4bf',d:'#2dd4bf'},
  '5 - Enviar OC ao fornecedor':{bg:'rgba(255,123,59,.12)',c:'#ff7b3b',d:'#ff7b3b'},
  '5 - Enviar OC ao fornecedor':{bg:'rgba(255,123,59,.12)',c:'#ff7b3b',d:'#ff7b3b'},
  '4 - Aprovacao Pedido':{bg:'rgba(251,191,36,.12)',c:'#fbbf24',d:'#fbbf24'},
  '3 - Gerar Pedido':{bg:'rgba(100,112,139,.17)',c:'#94a3b8',d:'#94a3b8'},
  '2 - Aprovacao RC':{bg:'rgba(100,112,139,.13)',c:'#7c8ca0',d:'#64748b'},
  '1 - Abertura RC':{bg:'rgba(100,112,139,.11)',c:'#6b7a8a',d:'#475569'},
  '0 - Aguardando confirmacao':{bg:'rgba(100,112,139,.09)',c:'#5a6a7a',d:'#334155'},
};
const RESP_CLR = {
  'Isabella Robaina':{bg:'#7c3aed',t:'#fff'},
  'Isabela Comparoni':{bg:'#0891b2',t:'#fff'},
  'Eduardo Bertelli':{bg:'#059669',t:'#fff'},
  'Julia Magalhaes':{bg:'#db2777',t:'#fff'}
};
const RESP_ALIASES = {'Bella':'Isabella Robaina','Isa':'Isabela Comparoni','Du':'Eduardo Bertelli','Edu':'Eduardo Bertelli','Ju':'Julia Magalhaes'};
const CHART_C = ['#c92434','#1ec97a','#f5a524','#3d72ff','#a78bfa','#2dd4bf','#ff7b3b','#f472b6','#fbbf24','#60a5fa'];

// DATA: already pre-processed with _resp, _ano, _mes, _id
let data = []; // populated from Supabase registros on login

let filtered = [...data];
let sortCol = 'dl', sortDir = -1;
let curTab = 'table';
let curYear = 'all', curMon = 'all';
let dashYear = 'all', dashMon = 'all';
let editId = null, archId = null, archRestore = false, detailId = null;
let budgets = {};


// ── COLUMN RESIZE ────────────────────────────────────────────────────
// Default widths in px — used when no saved preference exists
const COL_DEFAULTS = {
  'col-dl':96,'col-rc':100,'col-desc':220,'col-forn':160,
  'col-val':100,'col-area':110,'col-st':170,'col-resp':110,
  'col-tipo':82,'col-dp':94,'col-obs':130
};
const COL_MIN = 48; // minimum column width in px

// Load saved widths from localStorage (per-user, never synced)
function loadColWidths(){
  try{
    const saved = JSON.parse(localStorage.getItem('fh-col-widths')||'{}');
    Object.entries({...COL_DEFAULTS,...saved}).forEach(([id,w])=>{
      const col = document.getElementById(id);
      if(col) col.style.width = w+'px';
    });
  }catch(e){}
}

function saveColWidths(){
  try{
    const widths = {};
    Object.keys(COL_DEFAULTS).forEach(id=>{
      const col = document.getElementById(id);
      if(col) widths[id] = parseInt(col.style.width)||COL_DEFAULTS[id];
    });
    localStorage.setItem('fh-col-widths', JSON.stringify(widths));
  }catch(e){}
}

function resetColWidths(){
  try{localStorage.removeItem('fh-col-widths');}catch(e){}
  Object.entries(COL_DEFAULTS).forEach(([id,w])=>{
    const col = document.getElementById(id);
    if(col) col.style.width = w+'px';
  });
  toast('Colunas restauradas ao padrao');
}

// Resize logic — tracks mouse from mousedown on .col-resizer
let _resizeThId = null;
let _resizeStartX = 0;
let _resizeStartW = 0;

function startResize(e, thId){
  e.preventDefault();
  e.stopPropagation(); // prevent sortBy from firing

  // Map th-xx -> col-xx (col elements control width with table-layout:fixed)
  const colId = thId.replace('th-','col-');
  const th  = document.getElementById(thId);
  const col = document.getElementById(colId);
  if(!col) return;

  _resizeStartX = e.clientX;
  _resizeStartW = th.offsetWidth; // read actual rendered width from th
  th.classList.add('resizing');
  const handle = e.target;
  handle.classList.add('dragging');
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';

  function onMove(ev){
    const delta = ev.clientX - _resizeStartX;
    const newW  = Math.max(COL_MIN, _resizeStartW + delta);
    col.style.width = newW+'px'; // set width on col element
  }

  function onUp(){
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    th.classList.remove('resizing');
    handle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    saveColWidths();
    _resizeThId = null;
  }

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// ── THEME ───────────────────────────────────────────────────────────────
function applyTheme(t){
  document.body.dataset.theme = t;
  const themeBtn = document.getElementById('theme-btn');
  if(themeBtn) themeBtn.innerHTML = t==='dark' ? '&#127769;' : '&#9728;&#65039;';
  try{localStorage.setItem('fh-theme',t);}catch(e){}
}
function toggleTheme(){applyTheme(document.body.dataset.theme==='dark'?'light':'dark');}


// ── ROW <-> RECORD CONVERTERS ────────────────────────────────────────
// registros table uses snake_case; app uses short keys
function rowToRecord(r){
  return {
    _id:       r.id,
    dl:        r.dl        || null,
    rc:        r.rc        || null,
    oc:        r.oc        || null,
    cc:        r.cc        || null,
    area:      r.area      || null,
    desc:      r.descricao || null,
    valor:     r.valor     != null ? Number(r.valor) : null,
    codforn:   r.codforn   || null,
    forn:      r.forn      || null,
    status:    r.status    || null,
    tipo:      r.tipo      || null,
    sn:        r.sn        || null,
    ndoc:      r.ndoc      || null,
    dp:        r.dp        || null,
    obs:       r.obs       || null,
    _resp:     r.resp      || null,
    resppgto:  r.resp      || null,
    _ano:      r.ano       || null,
    _mes:      r.mes       != null ? Number(r.mes) : null,
    _archived: r.archived  || false,
    _audit:    r.audit     || [],
  };
}
function recordToRow(r){
  return {
    id:         r._id,
    dl:         r.dl        || null,
    rc:         r.rc        || null,
    oc:         r.oc        || null,
    cc:         r.cc        || null,
    area:       r.area      || null,
    descricao:  r.desc      || null,
    valor:      r.valor     != null ? Number(r.valor) : null,
    codforn:    r.codforn   || null,
    forn:       r.forn      || null,
    status:     r.status    || null,
    tipo:       r.tipo      || null,
    sn:         r.sn        || null,
    ndoc:       r.ndoc      || null,
    dp:         r.dp        || null,
    obs:        r.obs       || null,
    resp:       r._resp     || null,
    ano:        r._ano      || null,
    mes:        r._mes      != null ? Number(r._mes) : null,
    archived:   r._archived || false,
    audit:      r._audit    || [],
    updated_at: new Date().toISOString(),
  };
}
// ── PERSISTENCE ─────────────────────────────────────────────────────────
// buildPayload removed — replaced by recordToRow
function setSyncState(state,lbl){
  const dot=document.getElementById('sync-dot');
  const circ=document.getElementById('sync-circle');
  const lb=document.getElementById('sync-lbl');
  if(!dot)return;
  dot.classList.add('vis');
  circ.className='sync-circle'+(state==='saving'?' spin':state==='err'?' err':'');
  lb.textContent=lbl||'Sincronizado';
  if(state==='ok')setTimeout(()=>dot.classList.remove('vis'),2500);
}
let saveTimer=null;
// dirty set — tracks which record IDs changed since last push
const _dirty = new Set();
function markDirty(id){ _dirty.add(id); }

function saveState(id){
  if(id !== undefined) markDirty(id);
  else data.forEach(r=>_dirty.add(r._id)); // mark all if no id given
  clearTimeout(saveTimer);
  saveTimer=setTimeout(()=>pushToSupabase(),800);
}
async function pushToSupabase(){
  if(!_dirty.size) return;
  setSyncState('saving','Salvando...');
  const bar=document.getElementById('sync-bar-inner');
  if(bar){bar.style.width='40%';bar.style.opacity='1';}
  try{
    const toSave = data.filter(r=>_dirty.has(r._id)).map(r=>recordToRow(r));
    await sbUpsertMany(toSave);
    _dirty.clear();
    if(bar){bar.style.width='100%';setTimeout(()=>{bar.style.opacity='0';setTimeout(()=>bar.style.width='0',500);},400);}
    setSyncState('ok','Salvo');
    try{localStorage.setItem('fh-cache-v8',JSON.stringify(data.map(r=>recordToRow(r))));}catch(e){}
  }catch(e){
    if(bar){bar.style.opacity='0';}
    setSyncState('err','Erro ao salvar');
    toast('Erro de conexao. Dados salvos localmente.','err');
    try{localStorage.setItem('fh-cache-v8',JSON.stringify(data.map(r=>recordToRow(r))));}catch(ex){}
    console.error('Supabase error:',e);
  }
}
async function loadState(){
  setSyncState('saving','Carregando...');
  try{
    const rows = await sbGetAll();
    if(rows && rows.length){
      data = rows.map(r=>rowToRecord(r));
      setSyncState('ok','Sincronizado');
      try{localStorage.setItem('fh-cache-v8',JSON.stringify(rows));}catch(e){}
    } else {
      loadFromCache();
      setSyncState('ok','Sem dados remotos');
    }
  }catch(e){
    console.warn('Supabase offline, usando cache:',e);
    loadFromCache();
    setSyncState('err','Offline - cache local');
  }
}
function loadFromCache(){
  try{
    const s=JSON.parse(localStorage.getItem('fh-cache-v8')||'[]');
    if(s.length) data = s.map(r=>rowToRecord(r));
  }catch(e){}
}
// applyRemoteState removed — replaced by rowToRecord
function loadBudgets(){try{const b=localStorage.getItem('fh-budgets');if(b)budgets=JSON.parse(b);}catch(e){}}

// ── FORMAT ──────────────────────────────────────────────────────────────
function fmtR(v){return 'R$ '+Math.round(v||0).toLocaleString('pt-BR');}
function fmtRD(v){return v==null?'&#8212;':'R$ '+(v).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2});}
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function esc2(s){return String(s).replace(/[^a-zA-Z0-9]/g,'_');}

// ── INIT ────────────────────────────────────────────────────────────────
// appInit() defined in auth section below

function buildSelects(){
  const resps = [...new Set(data.map(r=>r._resp).filter(Boolean))].sort();
  const ccs   = [...new Set(data.map(r=>r.cc).filter(Boolean))].sort();
  const stats = [...new Set(data.filter(r=>!r._archived).map(r=>r.status).filter(Boolean))].sort((a,b)=>STATUS_ORDER.indexOf(a)-STATUS_ORDER.indexOf(b));
  const tipos = [...new Set(data.filter(r=>!r._archived).map(r=>r.tipo).filter(Boolean))].sort();
  fillSel('t-status',stats); fillSel('t-resp',resps); fillSel('k-resp',resps); fillSel('d-resp',resps);
  fillSel('t-cc',ccs); fillSel('k-cc',ccs); fillSel('d-cc',ccs);
  fillSel('t-tipo',tipos);
}
function fillSel(id,vals){const s=document.getElementById(id);if(!s)return;while(s.options.length>1)s.remove(1);vals.forEach(v=>{const o=document.createElement('option');o.value=v;o.textContent=v;s.appendChild(o);});}

// ── DATE NAVIGATOR ──────────────────────────────────────────────────────
// Hierarchical: select year first, then months for that year light up
function buildDateNav(){
  const years = [...new Set(data.map(r=>r._ano).filter(Boolean))].sort();
  const yg = document.getElementById('year-group');
  yg.innerHTML = '';

  // "Todos" button
  const allBtn = document.createElement('button');
  allBtn.className = 'year-btn active';
  allBtn.textContent = 'Todos os anos';
  allBtn.dataset.y = 'all';
  allBtn.onclick = () => setYear('all');
  yg.appendChild(allBtn);

  years.forEach(y => {
    const btn = document.createElement('button');
    btn.className = 'year-btn';
    btn.textContent = y;
    btn.dataset.y = y;
    btn.onclick = () => setYear(y);
    yg.appendChild(btn);
  });

  buildMonthStrip('all');
}

function buildMonthStrip(year){
  const avail = new Set(data.filter(r => year==='all' || r._ano===year).map(r=>r._mes).filter(Boolean));
  const strip = document.getElementById('month-strip');
  const sep = document.getElementById('date-sep');
  strip.innerHTML = '';

  if(year === 'all'){
    sep.style.display = 'none';
    return;
  }
  sep.style.display = 'block';

  // "Todos os meses"
  const allM = document.createElement('button');
  allM.className = 'month-btn active';
  allM.textContent = 'Todos';
  allM.dataset.m = 'all';
  allM.onclick = () => setMonth('all');
  strip.appendChild(allM);

  for(let m=1; m<=12; m++){
    const btn = document.createElement('button');
    btn.className = 'month-btn' + (avail.has(m) ? '' : ' disabled');
    btn.textContent = MONTHS[m-1];
    btn.dataset.m = String(m);
    btn.onclick = () => setMonth(String(m));
    strip.appendChild(btn);
  }
}

function setYear(y){
  curYear = y; curMon = 'all';
  document.querySelectorAll('#year-group .year-btn').forEach(b=>b.classList.toggle('active',b.dataset.y===y));
  buildMonthStrip(y);
  if(curTab==='dash'){dashYear=y;dashMon='all';renderDash();}
  else applyFilters();
}

function setMonth(m){
  curMon = m;
  if(curTab==='dash') dashMon = m;
  document.querySelectorAll('#month-strip .month-btn').forEach(b=>b.classList.toggle('active',b.dataset.m===m));
  if(curTab==='dash') renderDash();
  else applyFilters();
}

// ── FILTERS ─────────────────────────────────────────────────────────────
function gv(id){const e=document.getElementById(id);return e?e.value:'';}
function applyFilters(){
  const q    = gv('t-search').trim();
  const st   = gv('t-status');
  const resp = gv('t-resp') || gv('k-resp');
  const cc   = gv('t-cc') || gv('k-cc');
  const tipo = gv('t-tipo');
  const showArch = document.getElementById('t-arch')?.checked;

  // Toggle clear button visibility
  const clr = document.getElementById('t-search-clear');
  if(clr) clr.classList.toggle('vis', q.length > 0);

  // Step 1 — apply dropdown filters (exact match, fast)
  let pool = data.filter(r => {
    if(!showArch && r._archived) return false;
    if(curYear !== 'all' && r._ano !== curYear) return false;
    if(curMon !== 'all' && String(r._mes) !== curMon) return false;
    if(st   && r.status !== st)   return false;
    if(resp && r._resp  !== resp) return false;
    if(cc   && r.cc     !== cc)   return false;
    if(tipo && r.tipo   !== tipo) return false;
    return true;
  });

  // Step 2 — apply text search
  if(q.length >= 2){
    // Check if query looks like a number (RC/OC) — use exact includes for those
    const isNumeric = /^\d+$/.test(q);
    if(isNumeric){
      // Exact substring match for numeric codes — faster and more accurate
      pool = pool.filter(r=>[r.rc,r.oc,r.sn,r.ndoc].join(' ').includes(q));
    } else {
      // Fuzzy search on the filtered pool
      // We create a temporary Fuse on the current pool for accurate results
      const poolFuse = new Fuse(pool, {
        keys:[
          {name:'desc',  weight:0.35},
          {name:'forn',  weight:0.30},
          {name:'rc',    weight:0.15},
          {name:'oc',    weight:0.10},
          {name:'_resp', weight:0.05},
          {name:'obs',   weight:0.03},
          {name:'sn',    weight:0.02},
        ],
        threshold:0.35,
        includeScore:true,
        ignoreLocation:true,
        minMatchCharLength:2,
      });
      // fuse.search() returns [{item, score}] sorted by best match
      pool = poolFuse.search(q).map(r=>r.item);
    }
  }

  filtered = pool;

  applySort();
  renderKPI(); checkAlerts();
  if(curTab==='table') renderTable();
  else if(curTab==='kanban') renderKanban();
  else renderDash();

  const total = data.filter(r=>showArch||!r._archived).length;
  const countEl = document.getElementById('t-count');
  if(countEl){
    const fuzzyNote = (q.length>=2 && !/^\d+$/.test(q)) ? ' (busca inteligente)' : '';
    countEl.textContent = filtered.length+' de '+total+' registros'+fuzzyNote;
  }
  // Update empty state message
  const emptySub = document.getElementById('t-empty-sub');
  if(emptySub){
    if(q.length>=2) emptySub.textContent = 'Nenhum resultado para "'+q+'" — tente outros termos';
    else if(st||resp||cc||tipo) emptySub.textContent = 'Nenhum registro com os filtros aplicados';
    else emptySub.textContent = 'Nenhum registro para o periodo selecionado';
  }
  const kc = document.getElementById('k-count');
  if(kc) kc.textContent = filtered.length+' registros';
}

function clearSearch(){
  const inp = document.getElementById('t-search');
  if(inp){inp.value='';inp.focus();}
  applyFilters();
}

function clearFilters(){
  ['t-search','t-status','t-resp','t-cc','t-tipo','k-resp','k-cc'].forEach(id=>{const e=document.getElementById(id);if(e)e.value='';});
  const cb=document.getElementById('t-arch');if(cb)cb.checked=false;
  setYear('all');
  applyFilters();
}
function clearDashF(){
  ['d-resp','d-cc'].forEach(id=>{const e=document.getElementById(id);if(e)e.value='';});
  renderDash();
}

// ── SORT ────────────────────────────────────────────────────────────────
function sortBy(col){
  if(sortCol===col)sortDir*=-1;else{sortCol=col;sortDir=1;}
  applySort();renderTable();
  // Update sorted class on headers
  document.querySelectorAll('th').forEach(th=>th.classList.remove('sorted'));
  const map={'dl':'si-dl','rc':'si-rc','desc':'si-desc','forn':'si-forn','valor':'si-val','area':'si-area','status':'si-st','_resp':'si-resp','tipo':'si-tipo','dp':'si-pgto','obs':'si-obs'};
  const sid=map[col]; if(sid){const sp=document.getElementById(sid);if(sp&&sp.parentElement){sp.parentElement.classList.add('sorted');sp.textContent=sortDir===1?'↑':'↓';}}
  // Reset others
  Object.entries(map).filter(([k])=>k!==col).forEach(([,sid])=>{const sp=document.getElementById(sid);if(sp)sp.textContent='↕';});
}
function applySort(){
  filtered.sort((a,b)=>{
    let av=a[sortCol], bv=b[sortCol];
    if(av==null)av=''; if(bv==null)bv='';
    if(typeof av==='number'&&typeof bv==='number')return(av-bv)*sortDir;
    return String(av).localeCompare(String(bv),'pt-BR')*sortDir;
  });
}

// ── KPIs ────────────────────────────────────────────────────────────────
function renderKPI(){
  const vis = filtered.filter(r=>!r._archived);
  const pagos = vis.filter(r=>r.status==='10 - Pago');
  const emAnd = vis.filter(r=>r.status&&r.status!=='10 - Pago'&&r.status!=='11 - Cancelado');
  const agu   = vis.filter(r=>r.status==='9 - Aguardando Pgto');
  const canc  = vis.filter(r=>r.status==='11 - Cancelado');
  const total = vis.reduce((s,r)=>s+(r.valor||0),0);
  document.getElementById('kpi-row').innerHTML =
    kpiCard('Total',fmtR(total),vis.length+' lancamentos','','','accent-ac') +
    kpiCard('Pago',fmtR(pagos.reduce((s,r)=>s+(r.valor||0),0)),pagos.length+' registros','#1ec97a','color:var(--gr)','accent-gr') +
    kpiCard('Em Andamento',fmtR(emAnd.reduce((s,r)=>s+(r.valor||0),0)),emAnd.length+' registros','#f5a524','color:var(--yw)','accent-yw') +
    kpiCard('Aguard. Pgto',fmtR(agu.reduce((s,r)=>s+(r.valor||0),0)),agu.length+' registros','#f5a524','color:var(--yw)','accent-yw') +
    kpiCard('Cancelado',fmtR(canc.reduce((s,r)=>s+(r.valor||0),0)),canc.length+' registros','#ff3f5e','color:var(--rd)','accent-rd');
}
function kpiCard(lbl,val,sub,dotC,valStyle,accentCls){
  return '<div class="kpi'+(accentCls?' '+accentCls:'')+'"><div class="kpi-lbl">'+(dotC?'<span class="kpi-dot" style="background:'+dotC+'"></span>':'')+lbl+'</div><div class="kpi-val" style="'+(valStyle||'')+'">'+val+'</div><div class="kpi-sub">'+sub+'</div></div>';
}

// ── ALERTS ──────────────────────────────────────────────────────────────
function checkAlerts(){
  const bar = document.getElementById('alert-bar'); if(!bar)return;
  const today = new Date(); today.setHours(0,0,0,0);
  const alerts = [];
  data.filter(r=>!r._archived&&r.status!=='10 - Pago'&&r.status!=='11 - Cancelado').forEach(r=>{
    if(!r.dp)return;
    const pgto = new Date(r.dp+'T00:00:00');
    const diff = Math.round((pgto-today)/86400000);
    if(diff<0) alerts.push({r,diff,type:'ov',lbl:'Vencido ha '+Math.abs(diff)+'d'});
    else if(diff<=7) alerts.push({r,diff,type:'soon',lbl:'Vence em '+diff+'d'});
  });
  if(!alerts.length){bar.style.display='none';return;}
  alerts.sort((a,b)=>a.diff-b.diff);
  bar.style.display = 'flex';
  bar.innerHTML = '<span style="font-weight:600;font-size:12px;white-space:nowrap">&#9888;&#65039; Alertas de pagamento:</span>'+
    alerts.slice(0,5).map(({r,type,lbl})=>
      '<span class="alert-item '+type+'" onclick="openDetail('+r._id+')" title="'+esc(r.desc||'')+'">'+
      (type==='ov'?'&#128308;':'&#128993;')+' <strong>'+lbl+'</strong>: '+(r.desc||'').substring(0,28)+((r.desc||'').length>28?'...':'')+
      '</span>'
    ).join('')+
    (alerts.length>5?'<span style="font-size:12px;color:var(--mu)">+'+(alerts.length-5)+' mais</span>':'');
}

// ── TABLE ───────────────────────────────────────────────────────────────
// ── INLINE EDIT HELPERS ─────────────────────────────────────────────────
function ieStatus(id){
  const r=data.find(x=>x._id===id); if(!r)return;
  const cell=document.getElementById('ie-st-'+id); if(!cell)return;
  const sel=document.createElement('select');
  sel.className='ie-sel';
  STATUS_ORDER.forEach(s=>{const o=document.createElement('option');o.value=s;o.textContent=s;if(r.status===s)o.selected=true;sel.appendChild(o);});
  sel.onchange=()=>{
    sel.onblur = null; // previne conflito de eventos
    const nd=new Date().toLocaleDateString('pt-BR');
    const old=r.status; r.status=sel.value;
    if(!r._audit)r._audit=[];
    r._audit.push({dt:nd,msg:'Status: '+old+' => '+r.status});
    saveState(r._id); buildSelects(); applyFilters(); toast('Status atualizado');
  };
  sel.onblur=()=>{
    sel.onchange = null; // previne conflito de eventos
    applyFilters();
  }
  cell.innerHTML=''; cell.appendChild(sel); sel.focus();
}
function ieResp(id){
  const r=data.find(x=>x._id===id); if(!r)return;
  const cell=document.getElementById('ie-rp-'+id); if(!cell)return;
  const RESPS=[['Isabella Robaina','Bella'],['Isabela Comparoni','Isa'],['Eduardo Bertelli','Du/Edu'],['Julia Magalhaes','Ju']];
  const sel=document.createElement('select');
  sel.className='ie-sel';
  const blank=document.createElement('option');blank.value='';blank.textContent='—';sel.appendChild(blank);
  RESPS.forEach(([v,a])=>{const o=document.createElement('option');o.value=v;o.textContent=v.split(' ')[0]+' ('+a+')';if(r._resp===v)o.selected=true;sel.appendChild(o);});
  sel.onchange=()=>{
    sel.onblur = null;
    r._resp=sel.value||null;saveState();applyFilters();toast('Responsavel atualizado');
  };
  sel.onblur=()=>{
    sel.onchange = null;
    applyFilters();
  }
  cell.innerHTML=''; cell.appendChild(sel); sel.focus();
}
function ieObs(id){
  const r=data.find(x=>x._id===id); if(!r)return;
  const cell=document.getElementById('ie-ob-'+id); if(!cell)return;

  const wrap=document.createElement('div');
  wrap.style.cssText='display:flex;flex-direction:column;gap:4px';

  const ta=document.createElement('textarea');
  ta.className='ie-ta'; ta.value=r.obs||'';
  ta.placeholder='Adicionar observacao...';

  const btns=document.createElement('div');
  btns.style.cssText='display:flex;gap:4px';

  const confirm=document.createElement('button');
  confirm.textContent='Salvar';
  confirm.style.cssText='padding:3px 9px;border-radius:6px;border:none;background:var(--ac);color:#fff;font-family:var(--fn);font-size:11px;font-weight:600;cursor:pointer';

  const cancel=document.createElement('button');
  cancel.textContent='Cancelar';
  cancel.style.cssText='padding:3px 9px;border-radius:6px;border:1px solid var(--br);background:transparent;color:var(--mu);font-family:var(--fn);font-size:11px;cursor:pointer';

  function saveObs(){
    const nd=new Date().toLocaleDateString('pt-BR');
    r.obs=ta.value.trim()||null;
    r._audit=r._audit||[];
    r._audit.push({dt:nd,msg:'Observacao atualizada'});
    saveState(); applyFilters(); toast('Obs salva');
  }

  confirm.onclick=saveObs;
  cancel.onclick=()=>applyFilters();
  ta.onkeydown=e=>{if(e.key==='Escape')applyFilters();if(e.key==='Enter'&&e.ctrlKey)saveObs();};

  btns.appendChild(confirm); btns.appendChild(cancel);
  wrap.appendChild(ta); wrap.appendChild(btns);
  cell.innerHTML=''; cell.appendChild(wrap);
  ta.focus(); ta.setSelectionRange(ta.value.length,ta.value.length);
}
function ieDp(id){
  const r=data.find(x=>x._id===id); if(!r)return;
  const cell=document.getElementById('ie-dp-'+id); if(!cell)return;

  // Wrap: input + confirm btn + cancel btn
  const wrap=document.createElement('div');
  wrap.style.cssText='display:flex;align-items:center;gap:5px;flex-wrap:wrap';

  const inp=document.createElement('input');
  inp.type='date'; inp.className='ie-date'; inp.value=r.dp||'';

  const confirm=document.createElement('button');
  confirm.textContent='OK';
  confirm.style.cssText='padding:3px 9px;border-radius:6px;border:none;background:var(--ac);color:#fff;font-family:var(--fn);font-size:11px;font-weight:600;cursor:pointer';

  const cancel=document.createElement('button');
  cancel.textContent='X';
  cancel.style.cssText='padding:3px 7px;border-radius:6px;border:1px solid var(--br);background:transparent;color:var(--mu);font-family:var(--fn);font-size:11px;cursor:pointer';

  function saveDate(){
    const val=inp.value||null;
    r.dp=val;
    if(val){
      const m=val.match(/^(\d{4})-(\d{2})/);
      if(m){r._ano=m[1];r._mes=parseInt(m[2]);}
    }
    if(!r._audit)r._audit=[];
    r._audit.push({dt:new Date().toLocaleDateString('pt-BR'),msg:'Data pagamento: '+(val||'removida')});
    saveState(); applyFilters(); toast('Data de pagamento atualizada');
  }

  confirm.onclick=saveDate;
  cancel.onclick=()=>applyFilters();
  inp.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();saveDate();}else if(e.key==='Escape')applyFilters();};

  wrap.appendChild(inp); wrap.appendChild(confirm); wrap.appendChild(cancel);
  cell.innerHTML=''; cell.appendChild(wrap); inp.focus();
}

function renderTable(){
  const tbody = document.getElementById('t-body');
  const empty = document.getElementById('t-empty');
  if(!filtered.length){tbody.innerHTML='';empty.style.display='flex';return;}
  empty.style.display='none';
  tbody.innerHTML = filtered.map(r=>{
    const s = ST[r.status]||{bg:'rgba(100,112,139,.1)',c:'#94a3b8',d:'#94a3b8'};
    const rc2 = RESP_CLR[r._resp]||{bg:'#334155',t:'#94a3b8'};
    const ini = r._resp ? r._resp.split(' ').map(w=>w[0]).slice(0,2).join('') : '?';
    const stLbl = (r.status||'').replace(/^\d+\s*-?\s*/,'');
    const archItem = r._archived
      ? '<button class="ctx-item restore" onclick="askRestore('+r._id+')">&#9851;&#65039; Restaurar</button>'
      : '<button class="ctx-item danger" onclick="askArch('+r._id+')">&#128194; Arquivar</button>';
    return '<tr class="'+(r._archived?'arch':'')+'">'+
      '<td class="mo">'+(r.dl||'&#8212;')+'</td>'+
      '<td class="mo">'+(r.rc||'&#8212;')+'</td>'+
      '<td title="'+esc(r.desc||'')+'"><div class="cd">'+esc(r.desc||'&#8212;')+'</div></td>'+
      '<td title="'+esc(r.forn||'')+'"><div class="cf">'+esc(r.forn||'&#8212;')+'</div></td>'+
      '<td><span class="vl">'+fmtRD(r.valor)+'</span></td>'+
      '<td style="font-size:12px;color:var(--mu)">'+(r.area||'&#8212;')+'</td>'+
      // STATUS — inline edit on click
      '<td id="ie-st-'+r._id+'"><span class="ie-wrap badge" style="background:'+s.bg+';color:'+s.c+'" onclick="ieStatus('+r._id+')" title="Clique para editar status"><span class="bd2" style="background:'+s.d+'"></span>'+stLbl+'</span></td>'+
      // RESP — inline edit on click
      '<td id="ie-rp-'+r._id+'">'+(r._resp
        ? '<div class="ie-wrap" onclick="ieResp('+r._id+')" title="Clique para editar responsavel" style="display:inline-flex;align-items:center;gap:5px"><span class="av" style="background:'+rc2.bg+';color:'+rc2.t+'">'+ini+'</span><span style="font-size:12px">'+r._resp.split(' ')[0]+'</span></div>'
        : '<span class="ie-wrap" onclick="ieResp('+r._id+')" style="color:var(--mu);font-size:12px">+ Atribuir</span>'
      )+'</td>'+
      '<td style="color:var(--mu);font-size:12px">'+(r.tipo||'&#8212;')+'</td>'+
      // DATA PGTO — inline edit on click
      '<td id="ie-dp-'+r._id+'"><span class="ie-wrap mo" onclick="ieDp('+r._id+')" title="Clique para editar data">'+(r.dp||'<span style="color:var(--mu)">+ Data</span>')+'</span></td>'+
      // OBS — inline edit on click
      '<td id="ie-ob-'+r._id+'"><span class="ie-wrap" onclick="ieObs('+r._id+')" title="Clique para editar obs" style="display:block;min-width:60px">'+(r.obs?'<span class="co">'+esc(r.obs)+'</span>':'<span style="color:var(--mu);font-size:12px">+ Obs</span>')+'</span></td>'+
      // ACTIONS — context menu
      '<td><div class="ctx-btn" tabindex="0">'+
        '<button class="ib sm" style="font-size:16px;letter-spacing:1px" title="Acoes">&#8943;</button>'+
        '<div class="ctx-menu">'+
          '<button class="ctx-item" onclick="openDetail('+r._id+')">&#128065; Ver detalhes</button>'+
          '<button class="ctx-item" onclick="openEditModal('+r._id+')">&#9999;&#65039; Editar completo</button>'+
          archItem+
        '</div>'+
      '</div></td>'+
    '</tr>';
  }).join('');
}

// ── KANBAN ──────────────────────────────────────────────────────────────
let dragId = null;
function renderKanban(){
  const vis = filtered.filter(r=>!r._archived);
  const active = [...new Set(vis.map(r=>r.status).filter(Boolean))];
  const ordered = STATUS_ORDER.filter(s=>active.includes(s));
  document.getElementById('kanban-board').innerHTML = ordered.map(status=>{
    const cards = vis.filter(r=>r.status===status);
    const tot = cards.reduce((s,r)=>s+(r.valor||0),0);
    const s = ST[status]||{d:'#94a3b8'};
    const sid = esc2(status);
    return '<div class="kc" id="kc-'+sid+'" ondragover="onDOv(event,\''+sid+'\')" ondrop="onDDrop(event,\''+status+'\')" ondragleave="onDLeave(event)">'+
      '<div class="kc-hd"><div class="kc-title"><span style="width:7px;height:7px;border-radius:50%;background:'+s.d+';flex-shrink:0;display:inline-block"></span>'+status.replace(/^\d+\s*-?\s*/,'')+'<span class="kcnt">'+cards.length+'</span></div><span class="ktot">'+fmtR(tot)+'</span></div>'+
      '<div class="k-cards" id="kcd-'+sid+'">'+
        '<div class="kph" id="kph-'+sid+'"></div>'+
        cards.map(r=>{
          const rc=RESP_CLR[r._resp]||{bg:'#334155',t:'#94a3b8'};
          const ini=r._resp?r._resp.split(' ').map(w=>w[0]).slice(0,2).join(''):'?';
          return '<div class="kcard" id="kcard-'+r._id+'" draggable="true" ondragstart="onDStart(event,'+r._id+')" ondragend="onDEnd(event)" onclick="openDetail('+r._id+')">'+
            '<div class="kc-desc">'+esc(r.desc||'&#8212;')+'</div>'+
            '<div class="kc-forn">'+esc(r.forn||'&#8212;')+'</div>'+
            '<div class="kc-meta"><span class="mo" style="font-size:11px">'+(r.rc||'&#8212;')+'</span><span class="kc-val">'+fmtR(r.valor||0)+'</span></div>'+
            (r._resp?'<div style="display:flex;justify-content:flex-end;margin-top:5px"><span class="av" style="background:'+rc.bg+';color:'+rc.t+';width:20px;height:20px;font-size:8px" title="'+r._resp+'">'+ini+'</span></div>':'')+
          '</div>';
        }).join('')+
      '</div>'+
    '</div>';
  }).join('');
}
function onDStart(e,id){dragId=id;setTimeout(()=>{const el=document.getElementById('kcard-'+id);if(el)el.classList.add('dragging');},0);e.dataTransfer.effectAllowed='move';}
function onDEnd(){if(dragId!=null){const el=document.getElementById('kcard-'+dragId);if(el)el.classList.remove('dragging');}document.querySelectorAll('.kc').forEach(c=>c.classList.remove('dov'));document.querySelectorAll('.kph').forEach(p=>p.classList.remove('vis'));dragId=null;}
function onDOv(e,sid){e.preventDefault();const col=document.getElementById('kc-'+sid);if(col){col.classList.add('dov');const ph=document.getElementById('kph-'+sid);if(ph)ph.classList.add('vis');}}
function onDLeave(e){const col=e.currentTarget;if(col&&!col.contains(e.relatedTarget)){col.classList.remove('dov');const sid=col.id.replace('kc-','');const ph=document.getElementById('kph-'+sid);if(ph)ph.classList.remove('vis');}}
function onDDrop(e,newStatus){
  e.preventDefault(); if(dragId===null)return;
  const r=data.find(x=>x._id===dragId);
  if(r&&r.status!==newStatus){
    const old=r.status; r.status=newStatus;
    const d=new Date().toLocaleDateString('pt-BR');
    r._audit.push({dt:d,msg:'Status: '+old+' => '+newStatus});
    saveState(); toast('Movido: '+(r.desc||'').substring(0,28)+'...');
    applyFilters();
  }
  dragId=null;
}

// ── DASHBOARD ───────────────────────────────────────────────────────────
function getDashData(){
  const rf=gv('d-resp'),ccf=gv('d-cc');
  return data.filter(r=>{
    if(r._archived)return false;
    if(curYear!=='all'&&r._ano!==curYear)return false;
    if(curMon!=='all'&&String(r._mes)!==curMon)return false;
    if(rf&&r._resp!==rf)return false;
    if(ccf&&r.cc!==ccf)return false;
    return true;
  });
}
function renderDash(){
  const d = getDashData();
  const byG=(fn)=>{const m={};d.forEach(r=>{const k=fn(r)||'N/A';if(!m[k])m[k]={val:0,cnt:0};m[k].val+=r.valor||0;m[k].cnt++;});return m;};
  const toE=m=>Object.entries(m).sort((a,b)=>b[1].val-a[1].val).map(([k,v])=>({lbl:k,val:v.val,cnt:v.cnt}));
  const CC = ['#c92434','#1ec97a','#f5a524','#3d72ff','#a78bfa','#2dd4bf','#ff7b3b','#f472b6','#fbbf24','#60a5fa'];

  const total  = d.reduce((s,r)=>s+(r.valor||0),0);
  const pagoT  = d.filter(r=>r.status==='10 - Pago').reduce((s,r)=>s+(r.valor||0),0);
  const andT   = d.filter(r=>r.status&&r.status!=='10 - Pago'&&r.status!=='11 - Cancelado').reduce((s,r)=>s+(r.valor||0),0);
  const cancT  = d.filter(r=>r.status==='11 - Cancelado').reduce((s,r)=>s+(r.valor||0),0);

  const respM = byG(r=>r._resp);
  const fornM = byG(r=>r.forn);
  const tipoM = byG(r=>r.tipo);
  const stM   = byG(r=>r.status);
  // Build monthly data sorted Jan→Dez
  const mesM  = byG(r=>r._mes?MONTHS[r._mes-1]:null);
  const mesOrdered = MONTHS.filter(m=>mesM[m]).map(m=>({lbl:m,val:mesM[m].val,cnt:mesM[m].cnt}));

  const respE = toE(respM);
  const fornE = toE(fornM).slice(0,8);
  const tipoE = toE(tipoM);
  const stE   = STATUS_ORDER.filter(s=>stM[s]).map(s=>({lbl:s.replace(/^\d+\s*-?\s*/,''),val:stM[s].val,cnt:stM[s].cnt}));

  // Budget data
  const spent = {};
  data.filter(r=>!r._archived).forEach(r=>{if(r.cc&&r.valor)spent[r.cc]=(spent[r.cc]||0)+r.valor;});
  const bgtCCs = [...new Set(data.filter(r=>!r._archived).map(r=>r.cc).filter(Boolean))].filter(cc=>budgets[cc]);

  // ── Render HTML shell first ──────────────────────────────────────
  document.getElementById('dash-content').innerHTML =
    // KPI row
    '<div class="dash-kpi-grid">'+
      dKpi('Total Lancado', fmtR(total), d.length+' registros', '')+
      dKpi('Pago', fmtR(pagoT), ((total>0?(pagoT/total*100):0).toFixed(1))+'% do total', 'color:var(--gr)')+
      dKpi('Em Andamento', fmtR(andT), '', 'color:var(--yw)')+
      dKpi('Cancelado', fmtR(cancT), '', 'color:var(--rd)')+
      dKpi('Ticket Medio', d.length?fmtR(total/d.length):'—', '', '')+
    '</div>'+
    // Row 1: Mensal (line) + Status (horizontal bar)
    '<div class="dgrid dg2" style="margin-bottom:12px">'+
      '<div class="cc"><div class="ct">Volume por Mes</div><div class="cs">Evolucao mensal do valor lancado</div><div class="chart-canvas-wrap"><canvas id="ch-mes"></canvas></div></div>'+
      '<div class="cc"><div class="ct">Por Status</div><div class="cs">Distribuicao por etapa do fluxo SAP</div><div class="chart-canvas-wrap tall"><canvas id="ch-st"></canvas></div></div>'+
    '</div>'+
    // Row 2: Responsavel (doughnut) + Fornecedores (bar)
    '<div class="dgrid dg2" style="margin-bottom:12px">'+
      '<div class="cc"><div class="ct">Por Responsavel</div><div class="cs">Volume total por analista</div><div class="chart-canvas-wrap"><canvas id="ch-resp"></canvas></div></div>'+
      '<div class="cc"><div class="ct">Top Fornecedores</div><div class="cs">Maiores volumes (R$)</div><div class="chart-canvas-wrap tall"><canvas id="ch-forn"></canvas></div></div>'+
    '</div>'+
    // Row 3: Tipo (pie) + Orcamento (custom)
    '<div class="dgrid dg2">'+
      '<div class="cc"><div class="ct">Por Tipo de Documento</div><div class="cs">Distribuicao por tipo de NF</div><div class="chart-canvas-wrap short"><canvas id="ch-tipo"></canvas></div></div>'+
      '<div class="cc"><div class="ct">Orcamento por CC</div><div class="cs">Utilizacao do orcamento anual</div><div id="bgt-content">'+renderBgt(bgtCCs,spent,budgets)+'</div></div>'+
    '</div>';

  // ── Create charts after DOM is ready ────────────────────────────
  // Chart.js needs the canvas to exist in the DOM before new Chart()
  // That's why we build HTML first, then create charts
  requestAnimationFrame(()=>{

    // 1. LINE CHART — Volume por Mes
    // Line charts are great for showing trends over time
    mkChart('mes','ch-mes',{
      type:'line',
      data:{
        labels: mesOrdered.map(e=>e.lbl),
        datasets:[{
          label:'Valor (R$)',
          data: mesOrdered.map(e=>e.val),
          borderColor:'#c92434',
          backgroundColor:'rgba(201,36,52,.12)',
          borderWidth:2,
          pointBackgroundColor:'#c92434',
          pointRadius:4,
          pointHoverRadius:6,
          fill:true,
          tension:0.35  // smoothing: 0=sharp, 1=very smooth
        }]
      },
      options:{
        scales:{
          y:{ticks:{callback:v=>'R$'+Math.round(v/1000)+'k'}},
          x:{}
        },
        plugins:{
          legend:{display:false},
          tooltip:{callbacks:{label:ctx=>' '+fmtR(ctx.raw)}}
        }
      }
    });

    // 2. HORIZONTAL BAR — Por Status
    // indexAxis:'y' flips the chart to horizontal — better for long labels
    mkChart('st','ch-st',{
      type:'bar',
      data:{
        labels: stE.map(e=>e.lbl),
        datasets:[{
          label:'Valor (R$)',
          data: stE.map(e=>e.val),
          backgroundColor: stE.map(e=>{
            const raw=STATUS_ORDER.find(s=>s.replace(/^\d+\s*-?\s*/,'')===e.lbl)||'';
            return (ST[raw]||{bg:'rgba(100,112,139,.25)'}).bg;
          }),
          borderRadius:5,
          borderSkipped:false
        }]
      },
      options:{
        indexAxis:'y',
        scales:{
          x:{ticks:{callback:v=>'R$'+Math.round(v/1000)+'k'}},
          y:{grid:{display:false}}
        },
        plugins:{
          legend:{display:false},
          tooltip:{callbacks:{label:ctx=>' '+fmtR(ctx.raw)}}
        }
      }
    });

    // 3. DOUGHNUT — Por Responsavel
    // Doughnut is great for part-of-whole with few categories
    mkChart('resp','ch-resp',{
      type:'doughnut',
      data:{
        labels: respE.map(e=>e.lbl),
        datasets:[{
          data: respE.map(e=>e.val),
          backgroundColor: CC.slice(0,respE.length),
          borderWidth:2,
          hoverOffset:8
        }]
      },
      options:{
        cutout:'62%',  // hole size
        plugins:{
          legend:{position:'bottom'},
          tooltip:{callbacks:{label:ctx=>ctx.label+': '+fmtR(ctx.raw)}}
        }
      }
    });

    // 4. HORIZONTAL BAR — Top Fornecedores
    mkChart('forn','ch-forn',{
      type:'bar',
      data:{
        labels: fornE.map(e=>e.lbl.length>28?e.lbl.substring(0,28)+'…':e.lbl),
        datasets:[{
          label:'Valor (R$)',
          data: fornE.map(e=>e.val),
          backgroundColor:'rgba(61,114,255,.75)',
          borderRadius:5,
          borderSkipped:false
        }]
      },
      options:{
        indexAxis:'y',
        scales:{
          x:{ticks:{callback:v=>'R$'+Math.round(v/1000)+'k'}},
          y:{grid:{display:false}}
        },
        plugins:{
          legend:{display:false},
          tooltip:{callbacks:{label:ctx=>' '+fmtR(ctx.raw)}}
        }
      }
    });

    // 5. PIE — Tipo de Documento
    mkChart('tipo','ch-tipo',{
      type:'pie',
      data:{
        labels: tipoE.map(e=>e.lbl),
        datasets:[{
          data: tipoE.map(e=>e.val),
          backgroundColor: CC.slice(0,tipoE.length),
          borderWidth:2,
          hoverOffset:6
        }]
      },
      options:{
        plugins:{
          legend:{position:'right'},
          tooltip:{callbacks:{label:ctx=>ctx.label+': '+fmtR(ctx.raw)+' ('+((ctx.raw/total)*100).toFixed(1)+'%)'}}
        }
      }
    });

  }); // end requestAnimationFrame
}

function dKpi(lbl,val,sub,valStyle){
  return '<div class="dash-kpi"><div class="dash-kpi-lbl">'+lbl+'</div><div class="dash-kpi-val" style="'+valStyle+'">'+val+'</div>'+(sub?'<div class="dash-kpi-sub">'+sub+'</div>':'')+'</div>';
}
function renderBgt(ccs,spent,budgets){
  if(!ccs.length) return '<div style="font-size:12px;color:var(--mu);padding:8px 0">Clique em &#128176; para definir orcamentos por CC.</div>';
  return ccs.map(cc=>{
    const bgt=budgets[cc],sp=spent[cc]||0,pct=Math.min(100,sp/bgt*100);
    const color=pct>90?'var(--rd)':pct>70?'var(--yw)':'var(--gr)';
    return '<div style="margin-bottom:14px">'+
      '<div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:5px">'+
        '<span style="font-weight:600">'+cc+'</span>'+
        '<span style="color:var(--mu)">'+fmtR(sp)+' / '+fmtR(bgt)+'</span>'+
      '</div>'+
      '<div class="bgt-trk"><div class="bgt-fill" style="width:'+pct.toFixed(1)+'%;background:'+color+'"></div></div>'+
      '<div style="font-size:11px;color:'+color+';text-align:right;margin-top:3px;font-weight:600">'+pct.toFixed(0)+'% utilizado</div>'+
    '</div>';
  }).join('');
}

// ── DETAIL ──────────────────────────────────────────────────────────────
function openDetail(id){
  detailId=id;
  const r=data.find(x=>x._id===id); if(!r)return;
  const s=ST[r.status]||{bg:'rgba(100,112,139,.1)',c:'#94a3b8',d:'#94a3b8'};
  document.getElementById('detail-body').innerHTML=
    '<div style="margin-bottom:16px;padding:12px;background:var(--sf2);border-radius:10px;border:1px solid var(--br)">'+
      '<div style="font-size:14px;font-weight:600;margin-bottom:7px">'+esc(r.desc||'&#8212;')+'</div>'+
      '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">'+
        '<span class="badge" style="background:'+s.bg+';color:'+s.c+'"><span class="bd2" style="background:'+s.d+'"></span>'+(r.status||'&#8212;')+'</span>'+
        '<span style="font-size:18px;font-weight:700;font-family:var(--mo);color:var(--ac)">'+fmtRD(r.valor)+'</span>'+
        (r._archived?'<span class="badge" style="background:rgba(255,63,94,.12);color:var(--rd)">&#128194; Arquivado</span>':'')+
      '</div>'+
    '</div>'+
    '<div class="dg">'+
      '<div class="di"><div class="di-lbl">Data Lancamento</div><div class="di-val mo">'+(r.dl||'&#8212;')+'</div></div>'+
      '<div class="di"><div class="di-lbl">Data Pagamento</div><div class="di-val mo">'+(r.dp||'&#8212;')+'</div></div>'+
      '<div class="di"><div class="di-lbl">RC</div><div class="di-val mo">'+(r.rc||'&#8212;')+'</div></div>'+
      '<div class="di"><div class="di-lbl">Pedido / OC</div><div class="di-val mo">'+(r.oc||'&#8212;')+'</div></div>'+
      '<div class="di"><div class="di-lbl">Centro de Custo</div><div class="di-val mo">'+(r.cc||'&#8212;')+'</div></div>'+
      '<div class="di"><div class="di-lbl">Area</div><div class="di-val">'+(r.area||'&#8212;')+'</div></div>'+
      '<div class="di"><div class="di-lbl">Tipo</div><div class="di-val">'+(r.tipo||'&#8212;')+'</div></div>'+
      '<div class="di"><div class="di-lbl">Responsavel</div><div class="di-val">'+(r._resp||'&#8212;')+'</div></div>'+
      '<div class="di full"><div class="di-lbl">Fornecedor</div><div class="di-val">'+esc(r.forn||'&#8212;')+'<span style="color:var(--mu);font-family:var(--mo);font-size:11px;margin-left:6px">'+(r.codforn||'')+'</span></div></div>'+
      '<div class="di"><div class="di-lbl">Cod Chamado SN</div><div class="di-val mo">'+(r.sn||'&#8212;')+'</div></div>'+
      '<div class="di"><div class="di-lbl">N Documento</div><div class="di-val mo">'+(r.ndoc||'&#8212;')+'</div></div>'+
      (r.obs?'<div class="di full"><div class="di-lbl">Observacoes</div><div class="di-val" style="color:var(--yw);white-space:pre-wrap">'+esc(r.obs)+'</div></div>':'')+
    '</div>';
  switchDTab('info');
  openOv('ov-detail');
}
function editFromDetail(){closeOv('ov-detail');openEditModal(detailId);}
function switchDTab(tab){
  document.getElementById('dtab-info').classList.toggle('active',tab==='info');
  document.getElementById('dtab-audit').classList.toggle('active',tab==='audit');
  document.getElementById('detail-body').style.display=tab==='info'?'block':'none';
  document.getElementById('detail-audit').style.display=tab==='audit'?'block':'none';
  if(tab==='audit') renderAudit();
}
function renderAudit(){
  const r=data.find(x=>x._id===detailId);
  if(!r||!r._audit||!r._audit.length){
    document.getElementById('audit-content').innerHTML='<div style="color:var(--mu);font-size:13px;padding:12px 0">Nenhuma alteracao registrada.</div>';return;
  }
  document.getElementById('audit-content').innerHTML=
    '<div style="font-size:12px;font-weight:600;color:var(--mu);margin-bottom:8px;text-transform:uppercase;letter-spacing:.5px">Log de Alteracoes</div>'+
    [...r._audit].reverse().map(e=>'<div class="audit-e"><span class="audit-dt">'+esc(e.dt)+'</span><span>'+esc(e.msg)+'</span></div>').join('');
}

// ── WIZARD FORM ─────────────────────────────────────────────────────────
let wzType = null; // 'rc' or 'pedido'
let wzStep = 1;
let wzEditId = null;

function openWizard(mode, id){
  if(mode==='edit'){
    openEditModal(id);
    return;
  }
  // New record — wizard flow
  wzEditId = null;
  wzStep = 1;
  wzType = null;
  document.getElementById('wz-modal-title').textContent = 'Novo Registro';
  document.getElementById('wz-progress').style.display = 'none';
  goToStep(1);
  openOv('ov-form');
}

// ── FLAT EDIT MODAL ──────────────────────────────────────────────────
let editingId = null;

function openEditModal(id){
  const r = data.find(x=>x._id===id); if(!r)return;
  editingId = id;
  document.getElementById('edit-modal-title').textContent = 'Editar Registro';
  document.getElementById('edit-modal-sub').textContent = r.desc || '';

  const isRC = !r.oc || r.oc==='-';
  const ALL_STATUS = ['0 - Aguardando confirmacao','1 - Abertura RC','2 - Aprovacao RC','3 - Gerar Pedido','4 - Aprovacao Pedido','5 - Enviar OC ao fornecedor','5 - Enviar OC ao fornecedor','6 - Aguardando envio da NF','7 - Aguardando lancamento NF','8 - Liberar FBL1N','9 - Aguardando Pgto','10 - Pago','11 - Cancelado'];
  const stOpts = ALL_STATUS.map(s=>'<option value="'+s+'"'+(r.status===s?' selected':'')+'>'+s+'</option>').join('');
  const respOpts = [
    ['Isabella Robaina','Isabella Robaina (Bella)'],
    ['Isabela Comparoni','Isabela Comparoni (Isa)'],
    ['Eduardo Bertelli','Eduardo Bertelli (Du/Edu)'],
    ['Julia Magalhaes','Julia Magalhaes (Ju)']
  ].map(([v,l])=>'<option value="'+v+'"'+(r._resp===v?' selected':'')+'>'+l+'</option>').join('');
  const tipoOpts = ['NFe','Nota de Debito','Danfe','Recibo','Boleto'].map(t=>'<option'+(r.tipo===t?' selected':'')+'>'+t+'</option>').join('');

  // Determine CC select value
  const knownCC = [
    ['E9013F2602','Marketing e Comunicacao'],
    ['E9013F2602','DM'],
    ['E9011A2701','Presidencia'],
    ['E9013F2601','Comunicacao']
  ];
  const ccMatch = knownCC.find(([c,a])=>c===r.cc && a===r.area);
  const ccSelVal = ccMatch ? ccMatch[0]+'|'+ccMatch[1] : (r.cc ? 'custom' : '');
  const ccOpts = [
    ['','Selecionar...'],
    ['E9013F2602|Marketing e Comunicacao','Marketing e Comunicacao (E9013F2602)'],
    ['E9013F2602|DM','DM (E9013F2602)'],
    ['E9011A2701|Presidencia','Presidencia (E9011A2701)'],
    ['E9013F2601|Comunicacao','Comunicacao (E9013F2601)'],
    ['custom','Outro (manual)']
  ].map(([v,l])=>'<option value="'+v+'"'+(ccSelVal===v?' selected':'')+'>'+l+'</option>').join('');

  document.getElementById('edit-modal-body').innerHTML =
    '<div class="edit-section">'+
      '<div class="edit-section-title">Identificacao</div>'+
      '<div class="edit-grid">'+
        '<div class="fi-g"><label class="fi-lbl">Data Lancamento</label><input type="date" class="fi" id="ef-dl" value="'+(r.dl||'')+'"></div>'+
        '<div class="fi-g"><label class="fi-lbl">Status</label><select class="fi" id="ef-status">'+stOpts+'</select></div>'+
        '<div class="fi-g"><label class="fi-lbl">RC (8 digitos)</label><input type="text" class="fi" id="ef-rc" value="'+(r.rc&&r.rc!=='-'?r.rc:'')+'" maxlength="8" oninput="validateRCField(this)" placeholder="ex: 10741416"></div>'+
        '<div class="fi-g"><label class="fi-lbl">Pedido / OC (10 digitos)</label><input type="text" class="fi" id="ef-oc" value="'+(r.oc&&r.oc!=='-'?r.oc:'')+'" maxlength="10" oninput="validateOCField(this)" placeholder="ex: 4501094735"></div>'+
        '<div class="fi-g full"><label class="fi-lbl">Descricao</label><input type="text" class="fi" id="ef-desc" value="'+esc(r.desc||'')+'"></div>'+
      '</div>'+
    '</div>'+
    '<div class="edit-section">'+
      '<div class="edit-section-title">Classificacao</div>'+
      '<div class="edit-grid">'+
        '<div class="fi-g"><label class="fi-lbl">Centro de Custo</label><select class="fi" id="ef-cc-sel" onchange="onEditCCSel()">'+ccOpts+'</select></div>'+
        '<div class="fi-g" id="ef-cc-cw" style="display:'+(ccSelVal==='custom'?'flex':'none')+'"><label class="fi-lbl">Codigo CC</label><input type="text" class="fi" id="ef-cc-custom" value="'+(ccMatch?'':r.cc||'')+'"></div>'+
        '<div class="fi-g"><label class="fi-lbl">Area</label><input type="text" class="fi" id="ef-area" value="'+(r.area||'')+'" '+(ccSelVal&&ccSelVal!=='custom'?'readonly':'')+' placeholder="ex: Marketing e Comunicacao"></div>'+
        '<div class="fi-g"><label class="fi-lbl">Responsavel</label><select class="fi" id="ef-resp">'+respOpts+'</select></div>'+
      '</div>'+
    '</div>'+
    '<div class="edit-section">'+
      '<div class="edit-section-title">Financeiro e Documento</div>'+
      '<div class="edit-grid">'+
        '<div class="fi-g"><label class="fi-lbl">Valor (R$)</label><input type="number" class="fi" id="ef-valor" step="0.01" value="'+(r.valor||'')+'"></div>'+
        '<div class="fi-g"><label class="fi-lbl">Tipo de Documento</label><select class="fi" id="ef-tipo"><option value="">Selecionar...</option>'+tipoOpts+'</select></div>'+
        '<div class="fi-g"><label class="fi-lbl">Data de Pagamento</label><input type="date" class="fi" id="ef-dpgto" value="'+(r.dp||'')+'"></div>'+
        '<div class="fi-g"><label class="fi-lbl">Cod Fornecedor</label><input type="text" class="fi" id="ef-codforn" value="'+(r.codforn||'')+'" placeholder="ex: 1000022306"></div>'+
        '<div class="fi-g full"><label class="fi-lbl">Fornecedor</label><input type="text" class="fi" id="ef-forn" value="'+esc(r.forn||'')+'"></div>'+
        '<div class="fi-g"><label class="fi-lbl">Cod Chamado SN</label><input type="text" class="fi" id="ef-sn" value="'+(r.sn||'')+'"></div>'+
        '<div class="fi-g"><label class="fi-lbl">N Documento</label><input type="text" class="fi" id="ef-ndoc" value="'+(r.ndoc||'')+'"></div>'+
        '<div class="fi-g full"><label class="fi-lbl">Observacoes</label><textarea class="ft" id="ef-obs">'+esc(r.obs||'')+'</textarea></div>'+
      '</div>'+
    '</div>';

  openOv('ov-edit');
}

function onEditCCSel(){
  const v = document.getElementById('ef-cc-sel').value;
  const cw = document.getElementById('ef-cc-cw');
  const ar = document.getElementById('ef-area');
  if(!cw||!ar)return;
  if(v==='custom'){cw.style.display='flex';ar.value='';ar.removeAttribute('readonly');}
  else if(v){const p=v.split('|');ar.value=p[1]||'';ar.setAttribute('readonly','');cw.style.display='none';}
  else{cw.style.display='none';ar.value='';ar.setAttribute('readonly','');}
}

function saveEdit(){
  const gv=id=>{const e=document.getElementById(id);return e?e.value.trim():'';}
  // Validate
  const rcEl=document.getElementById('ef-rc'); if(rcEl&&!validateRCField(rcEl))return;
  const ocEl=document.getElementById('ef-oc'); if(ocEl&&!validateOCField(ocEl))return;

  const ccSel=gv('ef-cc-sel');
  let cc=null, area=gv('ef-area')||null;
  if(ccSel==='custom') cc=gv('ef-cc-custom')||null;
  else if(ccSel) cc=ccSel.split('|')[0];

  const dlVal=gv('ef-dl')||null;
  const dpVal=gv('ef-dpgto')||null;
  let ano=null, mes=null;
  if(dlVal){const m=dlVal.match(/^(\d{4})-(\d{2})/);if(m){ano=m[1];mes=parseInt(m[2]);}}

  const idx=data.findIndex(r=>r._id===editingId); if(idx<0)return;
  const old={...data[idx]};
  const nd=new Date().toLocaleDateString('pt-BR');

  data[idx]={
    ...data[idx],
    dl:dlVal, rc:gv('ef-rc')||null,
    oc:gv('ef-oc')||null,
    cc, area,
    desc:gv('ef-desc')||data[idx].desc,
    valor:parseFloat(gv('ef-valor'))||data[idx].valor,
    codforn:gv('ef-codforn')||null,
    forn:gv('ef-forn')||null,
    status:gv('ef-status')||data[idx].status,
    tipo:gv('ef-tipo')||null,
    sn:gv('ef-sn')||null,
    ndoc:gv('ef-ndoc')||null,
    dp:dpVal,
    obs:document.getElementById('ef-obs')?.value.trim()||null,
    _resp:gv('ef-resp')||data[idx]._resp,
    _ano:ano||data[idx]._ano,
    _mes:mes||data[idx]._mes
  };

  if(!data[idx]._audit) data[idx]._audit=[];
  const changes=[];
  if(old.status!==data[idx].status) changes.push('Status: '+old.status+' => '+data[idx].status);
  if(old.valor!==data[idx].valor) changes.push('Valor: R$'+old.valor+' => R$'+data[idx].valor);
  if(changes.length) data[idx]._audit.push({dt:nd,msg:changes.join(' | ')});
  else data[idx]._audit.push({dt:nd,msg:'Registro editado'});

  saveState(data[idx]._id); buildFuse();
  closeOv('ov-edit');
  applyFilters();
  toast('Registro salvo');
}

function selectType(type){
  wzType = type;
  document.getElementById('tc-rc').classList.toggle('selected', type==='rc');
  document.getElementById('tc-pedido').classList.toggle('selected', type==='pedido');
}

function wzNext(){
  if(wzStep===1){
    if(!wzType){toast('Selecione o tipo de registro','err');return;}
    document.getElementById('wz-progress').style.display = 'flex';
    buildStep2(); buildStep3();
    goToStep(2);
  } else if(wzStep===2){
    if(!validateStep2()) return;
    goToStep(3);
  } else if(wzStep===3){
    saveWizard();
  }
}
function wzBack(){
  if(wzStep===2) goToStep(1);
  else if(wzStep===3) goToStep(2);
}

function goToStep(n, skipAnim){
  wzStep = n;
  [1,2,3].forEach(i=>{
    const el = document.getElementById('wz-s'+i); if(el) el.classList.toggle('active', i===n);
    const dot = document.getElementById('wzdot-'+i); if(dot){dot.classList.toggle('current',i===n);dot.classList.toggle('done',i<n);}
    const line = document.getElementById('wzline-'+i); if(line) line.classList.toggle('done', i<n);
  });
  const back = document.getElementById('wz-back');
  const next = document.getElementById('wz-next');
  back.style.display = n>1 ? 'flex' : 'none';
  next.textContent = n===3 ? 'Salvar' : 'Continuar';
  if(n===1) document.getElementById('wz-progress').style.display = 'none';
}

function buildStep2(){
  const isRC = wzType === 'rc';
  const STATUS_RC = ['0 - Aguardando confirmacao','1 - Abertura RC','2 - Aprovacao RC'];
  const STATUS_PED = ['3 - Gerar Pedido','4 - Aprovacao Pedido','5 - Enviar OC ao fornecedor','5 - Enviar OC ao fornecedor','6 - Aguardando envio da NF','7 - Aguardando lancamento NF','8 - Liberar FBL1N','9 - Aguardando Pgto','10 - Pago','11 - Cancelado'];
  const statuses = isRC ? STATUS_RC : STATUS_PED;
  const stOpts = statuses.map(s=>'<option value="'+s+'">'+s+'</option>').join('');

  document.getElementById('wz-s2-lbl').textContent = isRC ? 'Dados da Requisicao' : 'Dados do Pedido';
  document.getElementById('wz-s2-fields').innerHTML =
    '<div class="fi-g">'+
      '<label class="fi-lbl">Data Lancamento</label>'+
      '<input type="date" class="fi" id="f-dl">'+
    '</div>'+
    '<div class="fi-g">'+
      '<label class="fi-lbl">Numero RC <span style="color:var(--mu)">(8 digitos)</span></label>'+
      '<input type="text" class="fi" id="f-rc" placeholder="ex: 10741416" maxlength="8" oninput="validateRCField(this)">'+
      '<span class="fi-err" id="err-rc">RC deve ter 8 digitos numericos</span>'+
    '</div>'+
    (isRC ? '' :
    '<div class="fi-g">'+
      '<label class="fi-lbl">N Pedido / OC <span style="color:var(--mu)">(10 digitos)</span></label>'+
      '<input type="text" class="fi" id="f-oc" placeholder="ex: 4501094735" maxlength="10" oninput="validateOCField(this)">'+
      '<span class="fi-err" id="err-oc">OC deve ter 10 digitos numericos</span>'+
    '</div>')+
    '<div class="fi-g">'+
      '<label class="fi-lbl">Centro de Custo</label>'+
      '<select class="fs fi" id="f-cc-sel" onchange="onCCSel()">'+
        '<option value="">Selecionar...</option>'+
        '<option value="E9013F2602|Marketing e Comunicacao">Marketing e Comunicacao (E9013F2602)</option>'+
        '<option value="E9013F2602|DM">DM (E9013F2602)</option>'+
        '<option value="E9011A2701|Presidencia">Presidencia (E9011A2701)</option>'+
        '<option value="custom">Outro (manual)</option>'+
      '</select>'+
    '</div>'+
    '<div class="fi-g" id="f-cc-cw" style="display:none">'+
      '<label class="fi-lbl">Codigo CC</label>'+
      '<input type="text" class="fi" id="f-cc-custom">'+
    '</div>'+
    '<div class="fi-g">'+
      '<label class="fi-lbl">Area</label>'+
      '<input type="text" class="fi" id="f-area" readonly>'+
    '</div>'+
    '<div class="fi-g full">'+
      '<label class="fi-lbl">Descricao *</label>'+
      '<input type="text" class="fi" id="f-desc" placeholder="Descricao do pagamento">'+
    '</div>'+
    '<div class="fi-g">'+
      '<label class="fi-lbl">Status</label>'+
      '<select class="fs fi" id="f-status"><option value="">Selecionar...</option>'+stOpts+'</select>'+
    '</div>'+
    '<div class="fi-g">'+
      '<label class="fi-lbl">Responsavel</label>'+
      '<select class="fs fi" id="f-resp">'+
        '<option value="">Selecionar...</option>'+
        '<option value="Isabella Robaina">Isabella Robaina (Bella)</option>'+
        '<option value="Isabela Comparoni">Isabela Comparoni (Isa)</option>'+
        '<option value="Eduardo Bertelli">Eduardo Bertelli (Du/Edu)</option>'+
        '<option value="Julia Magalhaes">Julia Magalhaes (Ju)</option>'+
      '</select>'+
    '</div>';
}

function buildStep3(){
  document.getElementById('wz-s3-fields').innerHTML =
    '<div class="fi-g">'+
      '<label class="fi-lbl">Valor (R$)</label>'+
      '<input type="number" class="fi" id="f-valor" step="0.01" placeholder="0.00">'+
    '</div>'+
    '<div class="fi-g">'+
      '<label class="fi-lbl">Cod Fornecedor</label>'+
      '<input type="text" class="fi" id="f-codforn" placeholder="ex: 1000022306">'+
    '</div>'+
    '<div class="fi-g full">'+
      '<label class="fi-lbl">Fornecedor</label>'+
      '<input type="text" class="fi" id="f-forn" placeholder="Razao social">'+
    '</div>'+
    '<div class="fi-g">'+
      '<label class="fi-lbl">Tipo de Documento</label>'+
      '<select class="fs fi" id="f-tipo-f"><option value="">Selecionar...</option><option>NFe</option><option>Nota de Debito</option><option>Danfe</option><option>Recibo</option><option>Boleto</option></select>'+
    '</div>'+
    '<div class="fi-g">'+
      '<label class="fi-lbl">Data de Pagamento</label>'+
      '<input type="date" class="fi" id="f-dpgto">'+
    '</div>'+
    '<div class="fi-g">'+
      '<label class="fi-lbl">Cod Chamado SN</label>'+
      '<input type="text" class="fi" id="f-sn" placeholder="ex: RITM0287394">'+
    '</div>'+
    '<div class="fi-g">'+
      '<label class="fi-lbl">N Documento</label>'+
      '<input type="text" class="fi" id="f-ndoc">'+
    '</div>'+
    '<div class="fi-g full">'+
      '<label class="fi-lbl">Observacoes</label>'+
      '<textarea class="ft" id="f-obs" placeholder="Notas adicionais..."></textarea>'+
    '</div>';
}

function fillStep2(r){
  const sv=(id,v)=>{const e=document.getElementById(id);if(e)e.value=v||'';};
  sv('f-dl',r.dl); sv('f-rc',r.rc); sv('f-oc',r.oc||''); sv('f-desc',r.desc); sv('f-resp',r._resp||'');
  // CC select
  const ccSel=document.getElementById('f-cc-sel');
  if(!ccSel)return;
  const known=[['E9013F2602','Marketing e Comunicacao'],['E9013F2602','DM'],['E9011A2701','Presidencia']];
  const match=known.find(([c,a])=>c===r.cc&&a===r.area);
  if(match){ccSel.value=match[0]+'|'+match[1];document.getElementById('f-area').value=r.area||'';document.getElementById('f-cc-cw').style.display='none';}
  else if(r.cc){ccSel.value='custom';const cw=document.getElementById('f-cc-custom');if(cw)cw.value=r.cc;document.getElementById('f-area').value=r.area||'';document.getElementById('f-area').removeAttribute('readonly');document.getElementById('f-cc-cw').style.display='flex';}
  sv('f-status',r.status);
}
function fillStep3(r){
  const sv=(id,v)=>{const e=document.getElementById(id);if(e)e.value=v||'';};
  sv('f-valor',r.valor); sv('f-codforn',r.codforn); sv('f-forn',r.forn);
  sv('f-tipo-f',r.tipo); sv('f-dpgto',r.dp); sv('f-sn',r.sn); sv('f-ndoc',r.ndoc); sv('f-obs',r.obs);
}

// VALIDATION
function validateRCField(el){
  const v=el.value.trim(); const err=document.getElementById('err-rc');
  if(!v){el.classList.remove('err');if(err)err.style.display='none';return true;}
  const ok=/^\d{8}$/.test(v);
  el.classList.toggle('err',!ok);
  if(err)err.style.display=ok?'none':'block';
  return ok;
}
function validateOCField(el){
  const v=el.value.trim(); const err=document.getElementById('err-oc');
  if(!v){el.classList.remove('err');if(err)err.style.display='none';return true;}
  const ok=/^\d{10}$/.test(v);
  el.classList.toggle('err',!ok);
  if(err)err.style.display=ok?'none':'block';
  return ok;
}
function validateStep2(){
  let ok=true;
  const rc=document.getElementById('f-rc'); if(rc&&!validateRCField(rc))ok=false;
  const oc=document.getElementById('f-oc'); if(oc&&!validateOCField(oc))ok=false;
  const desc=document.getElementById('f-desc');
  if(desc&&!desc.value.trim()){desc.classList.add('err');toast('Preencha a Descricao','err');ok=false;}
  else if(desc) desc.classList.remove('err');
  return ok;
}

function onCCSel(){
  const v=document.getElementById('f-cc-sel').value;
  const cw=document.getElementById('f-cc-cw');
  const ar=document.getElementById('f-area');
  if(!cw||!ar)return;
  if(v==='custom'){cw.style.display='flex';ar.value='';ar.removeAttribute('readonly');}
  else if(v){const p=v.split('|');ar.value=p[1]||'';ar.setAttribute('readonly','');cw.style.display='none';}
  else{cw.style.display='none';ar.value='';ar.setAttribute('readonly','');}
}

function saveWizard(){
  const gv2=id=>{const e=document.getElementById(id);return e?e.value.trim():'';};
  const ccSel=gv2('f-cc-sel'); let cc=null,area=gv2('f-area')||null;
  if(ccSel==='custom')cc=gv2('f-cc-custom')||null;
  else if(ccSel)cc=ccSel.split('|')[0];
  const respFull=gv2('f-resp')||null;
  const dlVal=gv2('f-dl')||null; const dpVal=gv2('f-dpgto')||null;
  let ano=null,mes=null;
  if(dlVal){const m=dlVal.match(/^(\d{4})-(\d{2})/);if(m){ano=m[1];mes=parseInt(m[2]);}}
  const nd=new Date().toLocaleDateString('pt-BR');

  const payload={
    dl:dlVal, rc:gv2('f-rc')||null, oc:gv2('f-oc')||null,
    cc, area, desc:gv2('f-desc')||null,
    valor:parseFloat(gv2('f-valor'))||null,
    codforn:gv2('f-codforn')||null, forn:gv2('f-forn')||null,
    status:gv2('f-status')||null, tipo:gv2('f-tipo-f')||null,
    sn:gv2('f-sn')||null, ndoc:gv2('f-ndoc')||null,
    dp:dpVal, obs:gv2('f-obs')||null,
    _resp:respFull, _ano:ano, _mes:mes, resppgto:null
  };

  if(wzEditId!==null){
    const idx=data.findIndex(r=>r._id===wzEditId);
    if(idx>=0){
      const old={...data[idx]};
      data[idx]={...data[idx],...payload};
      if(!data[idx]._audit)data[idx]._audit=[];
      if(old.status!==data[idx].status)data[idx]._audit.push({dt:nd,msg:'Status: '+old.status+' => '+data[idx].status});
      saveState(data[idx]._id);
      toast('Registro atualizado');
    }
  } else {
    const newId=Date.now();
    const newRec={...payload,_id:newId,_archived:false,_audit:[{dt:nd,msg:'Registro criado ('+( wzType==='rc'?'RC':'Pedido')+')'}]};
    data.push(newRec);
    saveState(newRec._id);
    toast('Registro adicionado');
  }
  closeOv('ov-form'); applyFilters();
}

// ── ARCHIVE ─────────────────────────────────────────────────────────────
function askArch(id){archId=id;archRestore=false;const r=data.find(x=>x._id===id);document.getElementById('arch-title').textContent='Arquivar Registro';document.getElementById('arch-icon').innerHTML='&#128194;';document.getElementById('arch-msg').textContent='O registro sera arquivado. Pode ser restaurado a qualquer momento.';document.getElementById('arch-prev').textContent=r?r.desc||'':'';const btn=document.getElementById('arch-btn');btn.textContent='Arquivar';btn.className='btn bd';openOv('ov-arch');}
function askRestore(id){archId=id;archRestore=true;const r=data.find(x=>x._id===id);document.getElementById('arch-title').textContent='Restaurar Registro';document.getElementById('arch-icon').innerHTML='&#9851;&#65039;';document.getElementById('arch-msg').textContent='O registro sera restaurado ao fluxo ativo.';document.getElementById('arch-prev').textContent=r?r.desc||'':'';const btn=document.getElementById('arch-btn');btn.textContent='Restaurar';btn.className='btn bp';openOv('ov-arch');}
function confirmArch(){
  const r=data.find(x=>x._id===archId);
  if(r){r._archived=!archRestore;if(!r._audit)r._audit=[];r._audit.push({dt:new Date().toLocaleDateString('pt-BR'),msg:archRestore?'Restaurado':'Arquivado'});saveState(archId);toast(archRestore?'Restaurado':'Arquivado',archRestore?'ok':'warn');}
  closeOv('ov-arch');applyFilters();archId=null;
}

// ── BUDGET ──────────────────────────────────────────────────────────────
function openBudget(){
  const ccs=[...new Set(data.filter(r=>!r._archived).map(r=>r.cc).filter(Boolean))].sort();
  const spent={};data.filter(r=>!r._archived).forEach(r=>{if(r.cc&&r.valor)spent[r.cc]=(spent[r.cc]||0)+r.valor;});
  document.getElementById('budget-list').innerHTML=ccs.map(cc=>{
    const bgt=budgets[cc]||0,sp=spent[cc]||0,pct=bgt>0?Math.min(100,sp/bgt*100):0;
    const color=pct>90?'var(--rd)':pct>70?'var(--yw)':'var(--gr)';
    return '<div class="bgt-row">'+
      '<div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px"><span style="font-weight:600">'+cc+'</span><span style="color:var(--mu)">'+fmtR(sp)+' utilizado</span></div>'+
      (bgt>0?'<div class="bgt-trk"><div class="bgt-fill" style="width:'+pct.toFixed(1)+'%;background:'+color+'"></div></div><div style="font-size:11px;color:var(--mu);text-align:right;margin-top:2px">'+pct.toFixed(1)+'% de '+fmtR(bgt)+'</div>':'')+
      '<div style="display:flex;align-items:center;gap:8px;margin-top:6px;font-size:12px"><label style="color:var(--mu)">Teto anual (R$):</label><input type="number" class="fi budget-inp" data-cc="'+cc+'" value="'+(bgt||'')+'" placeholder="0" style="flex:1;padding:5px 8px;font-size:12px"></div>'+
    '</div>';
  }).join('');
  openOv('ov-budget');
}
function saveBudgets(){
  document.querySelectorAll('.budget-inp').forEach(inp=>{const cc=inp.dataset.cc,val=parseFloat(inp.value)||0;if(val>0)budgets[cc]=val;else delete budgets[cc];});
  try{localStorage.setItem('fh-budgets',JSON.stringify(budgets));}catch(e){}
  closeOv('ov-budget');toast('Orcamentos salvos');renderDash();
}

// ── EXPORT ──────────────────────────────────────────────────────────────
function exportCSV(){
  const showArch=document.getElementById('t-arch')?.checked;
  const rows=filtered.filter(r=>showArch||!r._archived);
  const cols=['dl','rc','oc','cc','area','desc','valor','codforn','forn','status','tipo','sn','ndoc','dp','obs','_resp'];
  const hdrs=['Data Lancamento','RC','N Pedido/OC','CC','Area','Descricao','Valor','Cod Fornecedor','Fornecedor','Status','Tipo','Cod SN','N Documento','Data Pagamento','Observacoes','Responsavel'];
  const escC=v=>{if(v==null)return'';const s=String(v);if(s.includes(',')||s.includes('"')||s.includes('\n'))return'"'+s.replace(/"/g,'""')+'"';return s;};
  let csv='\uFEFF'+hdrs.join(',')+'\n';
  rows.forEach(r=>{csv+=cols.map(c=>escC(r[c])).join(',')+'\n';});
  const blob=new Blob([csv],{type:'text/csv;charset=utf-8'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');a.href=url;
  const nd=new Date();a.download='pagamentos_'+nd.getFullYear()+(nd.getMonth()+1).toString().padStart(2,'0')+nd.getDate().toString().padStart(2,'0')+'.csv';
  a.click();URL.revokeObjectURL(url);
  toast('CSV exportado ('+rows.length+' registros)');
}

// ── TABS ────────────────────────────────────────────────────────────────
function switchTab(tab){
  curTab=tab;
  ['table','kanban','dash'].forEach(t=>{
    document.getElementById('view-'+t).style.display=t===tab?'block':'none';
    document.getElementById('tab-'+t).classList.toggle('active',t===tab);
  });
  if(tab==='table')renderTable();
  else if(tab==='kanban')renderKanban();
  else renderDash();
}

// ── OVERLAYS ────────────────────────────────────────────────────────────
function openOv(id){document.getElementById(id).classList.add('open');}
function closeOv(id){document.getElementById(id).classList.remove('open');}
document.querySelectorAll('.ov').forEach(el=>el.addEventListener('click',e=>{if(e.target===el)closeOv(el.id);}));

// ── TOAST ───────────────────────────────────────────────────────────────
function toast(msg,type){
  const el=document.createElement('div');
  el.className='toast'+(type==='err'?' err':type==='warn'?' warn':'');
  el.innerHTML='<span>'+(type==='err'?'&#10060;':type==='warn'?'&#128194;':'&#9989;')+'</span><span>'+msg+'</span>';
  document.getElementById('toasts').appendChild(el);
  setTimeout(()=>el.remove(),3200);
}

// ── AUTH (Supabase Auth) ─────────────────────────────────────────────
const SB_AUTH_URL = SB_URL + '/auth/v1';
let currentUser = null;

async function authFetch(path, method, body){
  const res = await fetch(SB_AUTH_URL + path, {
    method: method || 'GET',
    headers: {
      'apikey': SB_KEY,
      'Authorization': 'Bearer ' + (getStoredToken() || SB_KEY),
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json();
  if(!res.ok) throw data;
  return data;
}

function getStoredToken(){
  try{ return JSON.parse(localStorage.getItem('fh-session') || 'null')?.access_token; }catch(e){ return null; }
}
function getStoredSession(){
  try{ return JSON.parse(localStorage.getItem('fh-session') || 'null'); }catch(e){ return null; }
}
function storeSession(session){
  try{ localStorage.setItem('fh-session', JSON.stringify(session)); }catch(e){}
}
function clearSession(){
  try{ localStorage.removeItem('fh-session'); }catch(e){}
}

async function doLogin(){
  const email = document.getElementById('auth-email').value.trim();
  const pass  = document.getElementById('auth-pass').value;
  const btn   = document.getElementById('auth-btn');
  const err   = document.getElementById('auth-err');
  if(!email || !pass){ err.textContent = 'Preencha e-mail e senha.'; return; }
  btn.disabled = true;
  btn.textContent = 'Entrando...';
  err.textContent = '';
  try{
    const res = await authFetch('/token?grant_type=password', 'POST', {email, password: pass});
    storeSession(res);
    currentUser = res.user;
    onLoginSuccess();
  }catch(e){
    err.textContent = e.error_description || e.msg || 'E-mail ou senha incorretos.';
    btn.disabled = false;
    btn.textContent = 'Entrar';
  }
}

// Allow Enter key on password field
document.getElementById('auth-pass').addEventListener('keydown', e => {
  if(e.key === 'Enter') doLogin();
});
document.getElementById('auth-email').addEventListener('keydown', e => {
  if(e.key === 'Enter') document.getElementById('auth-pass').focus();
});

async function checkSession(){
  const session = getStoredSession();
  if(!session?.access_token) return false;
  // Verify token is still valid
  try{
    const res = await fetch(SB_AUTH_URL + '/user', {
      headers: { 'apikey': SB_KEY, 'Authorization': 'Bearer ' + session.access_token }
    });
    if(!res.ok){ clearSession(); return false; }
    currentUser = await res.json();
    return true;
  }catch(e){ return false; }
}

function onLoginSuccess(){
  // Hide login screen
  const screen = document.getElementById('auth-screen');
  screen.style.opacity = '0';
  screen.style.transition = 'opacity .3s';
  setTimeout(() => screen.style.display = 'none', 300);
  // Show user badge
  renderUserBadge();
  // Boot the app
  appInit();
}

function renderUserBadge(){
  if(!currentUser) return;
  const wrap = document.getElementById('user-badge-wrap');
  if(!wrap) return;
  const email = currentUser.email || '';
  const initials = email.substring(0,2).toUpperCase();
  wrap.style.display = 'flex';
  wrap.style.alignItems = 'center';
  wrap.style.gap = '7px';
  wrap.innerHTML =
    '<div class="user-badge">' +
      '<div class="user-avatar">'+initials+'</div>' +
      '<span class="user-email">'+email+'</span>' +
    '</div>' +
    '<button class="logout-btn" onclick="doLogout()">Sair</button>';
}

async function doLogout(){
  try{
    await authFetch('/logout', 'POST');
  }catch(e){}
  clearSession();
  currentUser = null;
  // Reload page to reset state
  location.reload();
}


// App bootstrap — called only after login
async function appInit(){
  applyTheme((function(){try{return localStorage.getItem('fh-theme')||'dark';}catch(e){return 'dark';}})()); 
  loadBudgets();
  document.getElementById('kpi-row').innerHTML='<div style="color:var(--mu);font-size:13px;padding:14px 4px">Carregando dados...</div>';
  await loadState();
  normalizeStatuses();
  buildFuse();
  buildSelects();
  buildDateNav();
  loadColWidths();
  applyFilters();
  checkAlerts();
  setInterval(async()=>{
    try{
      const rows = await sbGetAll();
      if(rows && rows.length){
        const before = JSON.stringify(data.map(r=>r._id+r.status+r.obs+r._archived));
        data = rows.map(r=>rowToRecord(r));
        const after  = JSON.stringify(data.map(r=>r._id+r.status+r.obs+r._archived));
        if(before!==after){buildSelects();applyFilters();setSyncState('ok','Atualizado');}
      }
    }catch(e){}
  },30000);
}


// ── PAPA PARSE — CSV IMPORT ──────────────────────────────────────────
// Papa Parse reads CSV files in the browser and converts them to JS objects
// It handles encoding, delimiters, quoted fields automatically

let importRows = [];   // parsed + validated rows ready to import

// Column name aliases — maps CSV headers to our internal field names
// This lets us accept both our own export format and the original Excel format
const CSV_MAP = {
  // Our export format
  'Data Lancamento': 'dl',   'RC': 'rc',
  'N Pedido/OC': 'oc',       'CC': 'cc',
  'Area': 'area',            'Descricao': 'desc',
  'Valor': 'valor',          'Cod Fornecedor': 'codforn',
  'Fornecedor': 'forn',      'Status': 'status',
  'Tipo': 'tipo',            'Cod SN': 'sn',
  'N Documento': 'ndoc',     'Data Pagamento': 'dp',
  'Observacoes': 'obs',      'Responsavel': '_resp_raw',
  // Original Excel/SAP format
  'Data Lançamento': 'dl',   'Número do pedido/OC': 'oc',
  'Área': 'area',            'Descrição': 'desc',
  'Cód fornecedor': 'codforn', 'Responsável': '_resp_raw',
  'Observações': 'obs',      'Data de Pagamento': 'dp',
  'Tipo ': 'tipo',           // trailing space variant
};

function openImport(){
  resetImport();
  openOv('ov-import');
}
function closeImport(){
  closeOv('ov-import');
  resetImport();
}
function resetImport(){
  importRows = [];
  document.getElementById('imp-step1').style.display = 'block';
  document.getElementById('imp-step2').style.display = 'none';
  document.getElementById('imp-confirm-btn').style.display = 'none';
  document.getElementById('csv-file-inp').value = '';
}

// Drag & drop handlers
function onDropOver(e){
  e.preventDefault();
  document.getElementById('drop-zone').classList.add('drag-over');
}
function onDropLeave(e){
  document.getElementById('drop-zone').classList.remove('drag-over');
}
function onDropFile(e){
  e.preventDefault();
  document.getElementById('drop-zone').classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if(file) parseCSV(file);
}
function onFileSelect(e){
  const file = e.target.files[0];
  if(file) parseCSV(file);
}

function parseCSV(file){
  // Papa Parse config:
  // header: true   → first row becomes object keys
  // skipEmptyLines → ignore blank rows
  // dynamicTyping  → "24851.2" becomes number 24851.2 automatically
  Papa.parse(file, {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: false,  // we handle conversion manually for safety
    encoding: 'UTF-8',
    complete: (results) => {
      if(!results.data || !results.data.length){
        toast('Arquivo vazio ou formato invalido', 'err'); return;
      }
      processCSV(results.data, results.meta.fields);
    },
    error: (err) => {
      toast('Erro ao ler arquivo: ' + err.message, 'err');
    }
  });
}

function processCSV(rows, headers){
  // Map CSV columns to our internal field names
  const fieldMap = {};
  headers.forEach(h => {
    const mapped = CSV_MAP[h.trim()];
    if(mapped) fieldMap[h] = mapped;
  });

  const existingRCs = new Set(data.map(r=>r.rc).filter(Boolean));
  const existingOCs = new Set(data.map(r=>r.oc).filter(Boolean));

  const parsed = rows.map((row, i) => {
    const r = {};
    // Map fields
    Object.entries(fieldMap).forEach(([csvCol, field]) => {
      r[field] = (row[csvCol] || '').toString().trim() || null;
    });

    // Normalize valor: "24.851,20" or "24851.2" → number
    if(r.valor){
      const v = r.valor.replace(/\./g,'').replace(',','.');
      r.valor = parseFloat(v) || null;
    }

    // Normalize date: dd/mm/yyyy → yyyy-mm-dd
    function normDate(d){
      if(!d) return null;
      if(/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
      const m = d.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
      if(m) return m[3]+'-'+m[2]+'-'+m[1];
      return d;
    }
    r.dl = normDate(r.dl);
    r.dp = normDate(r.dp);

    // Resolve responsavel alias
    r._resp = RESP_ALIASES[r._resp_raw] || r._resp_raw || null;
    delete r._resp_raw;

    // Infer year/month
    if(r.dl){
      const m = r.dl.match(/^(\d{4})-(\d{2})/);
      if(m){ r._ano = m[1]; r._mes = parseInt(m[2]); }
    }

    // Detect duplicate: RC already exists OR OC already exists
    const isDup = (r.rc && existingRCs.has(r.rc)) || (r.oc && existingOCs.has(r.oc));

    return { ...r, _dup: isDup, _rowNum: i+2, _valid: !!r.desc };
  });

  importRows = parsed;
  showImportPreview(parsed);
}

function showImportPreview(rows){
  const newRows  = rows.filter(r => !r._dup && r._valid);
  const dupRows  = rows.filter(r => r._dup);
  const errRows  = rows.filter(r => !r._valid);

  document.getElementById('imp-stats').innerHTML =
    '<div class="imp-stat">Total no arquivo: <strong>'+rows.length+'</strong></div>'+
    '<div class="imp-stat" style="color:var(--gr)">Novos: <strong>'+newRows.length+'</strong></div>'+
    '<div class="imp-stat" style="color:var(--yw)">Duplicados (ja existem): <strong>'+dupRows.length+'</strong></div>'+
    (errRows.length ? '<div class="imp-stat" style="color:var(--rd)">Sem descricao: <strong>'+errRows.length+'</strong></div>' : '');

  document.getElementById('imp-preview-body').innerHTML = rows.slice(0,50).map(r => {
    const cls = r._dup ? 'dup' : (!r._valid ? 'err' : 'new');
    const badge = r._dup
      ? '<span class="imp-badge dup">duplicado</span>'
      : (!r._valid ? '<span class="imp-badge err">sem desc</span>' : '<span class="imp-badge new">novo</span>');
    return '<tr class="'+cls+'">'+
      '<td>'+badge+'</td>'+
      '<td class="mo">'+(r.rc||'—')+'</td>'+
      '<td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+(r.desc||'—')+'</td>'+
      '<td style="max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--mu)">'+(r.forn||'—')+'</td>'+
      '<td class="mo" style="color:var(--ac);font-weight:600">'+(r.valor?'R$'+Math.round(r.valor).toLocaleString('pt-BR'):'—')+'</td>'+
      '<td class="mo">'+(r.dl||'—')+'</td>'+
    '</tr>';
  }).join('') + (rows.length > 50 ? '<tr><td colspan="6" style="text-align:center;color:var(--mu);font-size:11px;padding:8px">...e mais '+(rows.length-50)+' registros</td></tr>' : '');

  document.getElementById('imp-step1').style.display = 'none';
  document.getElementById('imp-step2').style.display = 'block';

  if(newRows.length > 0){
    const btn = document.getElementById('imp-confirm-btn');
    btn.style.display = 'flex';
    btn.textContent = 'Importar '+newRows.length+' registro'+(newRows.length>1?'s':'')+' novos';
  }
}

function confirmImport(){
  const newRows = importRows.filter(r => !r._dup && r._valid);
  if(!newRows.length){ toast('Nenhum registro novo para importar','err'); return; }

  const nd = new Date().toLocaleDateString('pt-BR');
  let maxId = Math.max(...data.map(r=>r._id), 9999);

  newRows.forEach(r => {
    maxId++;
    data.push({
      dl: r.dl||null, rc: r.rc||null, oc: r.oc||null,
      cc: r.cc||null, area: r.area||null, desc: r.desc||null,
      valor: r.valor||null, codforn: r.codforn||null, forn: r.forn||null,
      resppgto: null, status: r.status||'0 - Aguardando confirmacao',
      tipo: r.tipo||null, sn: r.sn||null, ndoc: r.ndoc||null,
      dp: r.dp||null, obs: r.obs||null,
      _resp: r._resp||null, _ano: r._ano||null, _mes: r._mes||null,
      _id: maxId, _archived: false,
      _audit: [{dt: nd, msg: 'Importado via CSV'}]
    });
  });

  saveState();
  buildFuse();
  buildSelects();
  applyFilters();
  closeImport();
  toast(''+newRows.length+' registro'+(newRows.length>1?'s importados':'importado')+' com sucesso');
}

// Entry point — check existing session first
(async function bootstrap(){
  applyTheme((function(){try{return localStorage.getItem('fh-theme')||'dark';}catch(e){return 'dark';}})()); 
  const valid = await checkSession();
  if(valid){
    onLoginSuccess();
  }
  // else: login screen stays visible, waiting for user input
})();
