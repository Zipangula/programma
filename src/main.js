import './style.css';

// Firebase via npm (bundlato da Vite, meno problemi con adblock)
import { initializeApp } from 'firebase/app';
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut } from 'firebase/auth';
import { getFirestore, doc, setDoc, getDoc, onSnapshot, enableIndexedDbPersistence } from 'firebase/firestore';

// PWA (vite-plugin-pwa): registra service worker e gestisce update/offline
import { registerSW } from 'virtual:pwa-register';

const updateSW = registerSW({
  onNeedRefresh() {
    // semplice prompt: puoi renderlo più "carino" con un toast
    if (confirm('È disponibile un aggiornamento. Vuoi ricaricare ora?')) updateSW(true);
  },
  onOfflineReady() {
    console.info('App pronta per funzionare offline.');
  }
});

const firebaseConfig = {
  apiKey: "AIzaSyDf5y-wlgT4gylL4d_cMQe_ik8s_S09VRc",
  authDomain: "programma-dieta-952d7.firebaseapp.com",
  projectId: "programma-dieta-952d7",
  storageBucket: "programma-dieta-952d7.firebasestorage.app",
  messagingSenderId: "16575395211",
  appId: "1:16575395211:web:f96fe4db36fcc85cf96b8e",
  measurementId: "G-17Q7WZDRQ0"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

enableIndexedDbPersistence(db).catch(() => {});

let BOOTING = true;

/* ========= Polyfill ========= */
if (!('crypto' in window) || !crypto.randomUUID){
  window.crypto = window.crypto || {};
  crypto.randomUUID = () => 'id-' + Math.random().toString(36).slice(2,10) + Date.now().toString(36);
}

/* ========= Utils ========= */

// Sicurezza: escape per stringhe inserite in HTML (nomi alimento/pasto/profilo)
const escapeHtml = (s='') => String(s)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');
const escapeAttr = escapeHtml;
const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));
const fmt  = n => (Math.round(n*10)/10).toString().replace('.', ','); // 1 dec
const fmt0 = n => String(Math.round(n)); // intero
const parse = v => isNaN(parseFloat(v))?0:parseFloat(v);
const KCAL_C=4, KCAL_P=4, KCAL_F=9;

/* ========= Storage ========= */
const KEY = 'diet-planner-v1';
let state = load() || seed();
function load(){ try{ return JSON.parse(localStorage.getItem(KEY)); }catch{ return null; } }
function save(){
  if (BOOTING) {
    localStorage.setItem(KEY, JSON.stringify(state));
    return;
  }
 
// ===== Cloud Sync (per utente) =====
let remote = { uid:null, unsub:null, applyingRemote:false, saveTimer:null };
let lastSyncAt = 0;

function setSyncStatus(msg){ if (els.syncStatus) els.syncStatus.textContent = msg; }
function setNetStatus(){
  if(!els.netStatus) return;
  const on = navigator.onLine;
  els.netStatus.textContent = on ? 'Online' : 'Offline';
  els.netStatus.className = 'muted ' + (on ? '' : 'err');
}
window.addEventListener('online', setNetStatus);
window.addEventListener('offline', setNetStatus);

function userDocRef(uid){ return doc(db, 'users', uid, 'apps', 'dietPlanner'); }

function estimateBytes(obj){
  try { return new TextEncoder().encode(JSON.stringify(obj)).length; } catch { return 0; }
}

async function pushStateToCloud(){
  if(!remote.uid) return;
  const ref = userDocRef(remote.uid);
  const bytes = estimateBytes(state);
  // limite documento Firestore ~ 1 MiB: se cresci troppo avvisiamo
  if (bytes > 950_000) {
    console.warn('[SYNC] State molto grande:', bytes, 'bytes');
    setSyncStatus('⚠️ Stato molto grande ('+Math.round(bytes/1024)+' KB). Valuta di separare i dati.');
  }
  try {
    await setDoc(ref, { state }, { merge: true });
    lastSyncAt = Date.now();
    setSyncStatus('✅ Salvato sul cloud (' + new Date(lastSyncAt).toLocaleTimeString() + ')');
  } catch (e) {
    console.error('[SYNC] setDoc error:', e);
    setSyncStatus('❌ Errore sync: ' + (e.code || e.message));
  }
}

function scheduleRemoteSave(){
  if(!remote.uid) return;
  if(remote.applyingRemote) return;
  clearTimeout(remote.saveTimer);
  remote.saveTimer = setTimeout(() => { pushStateToCloud().catch(console.error); }, 600);
}

async function forcePullFromCloud(){
  if(!remote.uid) { alert('Fai login prima.'); return; }
  const ref = userDocRef(remote.uid);
  const snap = await getDoc(ref);
  if(!snap.exists()) { alert('Nessun dato sul cloud per questo utente.'); return; }
  const cloudState = snap.data().state;
  remote.applyingRemote = true;
  state = cloudState;
  localStorage.setItem(KEY, JSON.stringify(state));
  initProfileUI();
  remote.applyingRemote = false;
  lastSyncAt = Date.now();
  setSyncStatus('✅ Ripristino forzato completato (' + new Date(lastSyncAt).toLocaleTimeString() + ')');
}

async function startCloudSync(uid){
  remote.uid = uid;
  const ref = userDocRef(uid);
  const snap = await getDoc(ref);
  const localTs = state?._meta?.updatedAt || 0;

  if(snap.exists()){
    const cloudState = snap.data().state;
    const cloudTs = cloudState?._meta?.updatedAt || 0;
    if(cloudTs > localTs){
      remote.applyingRemote = true;
      state = cloudState;
      localStorage.setItem(KEY, JSON.stringify(state));
      initProfileUI();
      remote.applyingRemote = false;
      setSyncStatus('✅ Ripristinato dal cloud');
    } else if (localTs > cloudTs) {
      await pushStateToCloud();
    } else {
      setSyncStatus('ℹ️ In sync');
    }
  } else {
    await pushStateToCloud();
  }

  if(remote.unsub) remote.unsub();
  remote.unsub = onSnapshot(ref, (docSnap) => {
    if(!docSnap.exists()) return;
    const cloudState = docSnap.data().state;
    const cloudTs = cloudState?._meta?.updatedAt || 0;
    const localTs2 = state?._meta?.updatedAt || 0;
    if(cloudTs > localTs2){
      remote.applyingRemote = true;
      state = cloudState;
      localStorage.setItem(KEY, JSON.stringify(state));
      initProfileUI();
      remote.applyingRemote = false;
      lastSyncAt = Date.now();
      setSyncStatus('✅ Aggiornato dal cloud (' + new Date(lastSyncAt).toLocaleTimeString() + ')');
    }
  }, (err) => {
    console.error('[SYNC] onSnapshot error:', err);
    setSyncStatus('❌ Listener sync: ' + (err.code || err.message));
  });
}
 state._meta = state._meta || {};
  state._meta.schemaVersion = state._meta.schemaVersion || 2;
  state._meta.updatedAt = Date.now();
  localStorage.setItem(KEY, JSON.stringify(state));
  scheduleRemoteSave();
}

/* ========= Dataset base (senza alcool/fibra/zuccheri) ========= */
function F(name,kcal,c,p,fat){
  const id = crypto.randomUUID();
  return {id,name,kcal,c,p,fat,group:dominant(c,p,fat)};
}
const CURATED_VERSION = '1.2';
const CURATED_FOODS = [
  F('Riso bianco crudo', 360, 79, 7, 0.6), F('Riso basmati crudo', 356, 78, 8, 0.8),
  F('Pasta secca cruda', 353, 72, 13, 1.5), F('Fiocchi di avena', 371, 59, 13, 7),
  F('Quinoa cruda', 368, 64, 14, 6), F('Farro perlato crudo', 335, 67, 15, 2),
  F('Orzo perlato crudo', 354, 77, 10, 1.2), F('Riso bianco cotto', 130, 28, 2.7, 0.3),
  F('Pasta cotta', 131, 25, 5, 1.1), F('Patate lesse', 87, 20, 1.9, 0.1),
  F('Patate dolci cotte', 90, 21, 2, 0.2), F('Lenticchie cotte', 116, 20, 9, 0.4),
  F('Ceci cotti', 164, 27.4, 8.9, 2.6), F('Fagioli borlotti cotti', 127, 22.8, 8.7, 0.5),
  F('Fagioli neri cotti', 132, 23.7, 8.9, 0.5), F('Piselli cotti', 84, 15, 5.4, 0.2),
  F('Petto di pollo', 120, 0, 23, 2.6), F('Fesa di tacchino', 114, 0, 24, 1),
  F('Manzo magro (5% grasso)', 137, 0, 20, 6), F('Lonza di maiale', 143, 0, 21, 6),
  F('Merluzzo', 82, 0, 18, 0.7), F('Salmone atlantico', 208, 0, 20, 13),
  F('Tonno fresco', 144, 0, 23, 4.9), F('Uova intere', 143, 0.7, 12.6, 10.6),
  F('Albume', 52, 0.7, 10.9, 0.2), F('Yogurt greco 0%', 59, 3.6, 10, 0.4),
  F('Latte scremato', 34, 5, 3.4, 0.1), F('Olio extravergine di oliva', 884, 0, 0, 100),
  F('Avocado', 160, 9, 2, 15), F('Mandorle', 579, 21.6, 21.2, 49.9),
  F('Noci', 654, 13.7, 15.2, 65.2), F('Nocciole', 628, 16.7, 15, 60.8),
  F('Pistacchi', 560, 28, 20, 45), F('Anacardi', 553, 30, 18, 44),
  F('Semi di chia', 486, 42, 16, 31), F('Semi di lino', 534, 29, 18, 42),
  F('Semi di zucca', 559, 11, 30, 49), F('Banana', 89, 23, 1.1, 0.3),
  F('Mela', 52, 14, 0.3, 0.2), F('Arancia', 47, 12, 0.9, 0.1),
  F('Pera', 57, 15, 0.4, 0.1), F('Fragole', 32, 7.7, 0.7, 0.3),
  F('Mirtilli', 57, 14, 0.7, 0.3), F('Kiwi', 61, 15, 1.1, 0.5),
  F('Spinaci', 23, 3.6, 2.9, 0.4), F('Broccoli', 34, 7, 2.8, 0.4),
  F('Zucchine', 17, 3.1, 1.2, 0.3), F('Pomodori', 18, 3.9, 0.9, 0.2),
  F('Carote', 41, 10, 0.9, 0.2), F('Peperoni rossi', 31, 6, 1, 0.3),
  F('Melanzane', 25, 6, 1, 0.2), F('Lattuga', 15, 2.9, 1.4, 0.2),
  F('Pane integrale', 247, 41, 8.5, 2.5)
];

/* ========= Stato ========= */
function dominant(c,p,f){ const arr=[{k:'c',v:c},{k:'p',v:p},{k:'f',v:f}]; arr.sort((a,b)=>b.v-a.v); return arr[0].k; }
function makeProfile(name){
  return {
    id: crypto.randomUUID(), name,
    phase:'bulk', weight:70, kcalTarget:2400, macroMode:'auto',
    macros:{c:0,p:0,f:0},
    mealsCount:3, splitMode:'percent',
    percentages:[],
    meals:[],
    factors:{ bulk:{p:1.6,f:1.0}, cut:{p:2.2,f:0.8} }
  };
}
function seed(){
  const profile = makeProfile('Profilo 1');
  return {
 _meta: { updatedAt: 0, schemaVersion: 2 },
    foods: [],
    foodsVersion: null,
    profiles:[profile],
    currentProfileId: profile.id,
    ui:{ showHints:true, foodsCollapsed:{c:false,p:false,f:false}, snapManual5:false, preview:{showC:true,showP:true,showF:true,showTargets:true} }
  };
}
function currentProfile(){ return state.profiles.find(p=>p.id===state.currentProfileId); }

/* ========= Elementi ========= */
const els = {
  // Tabs/pages
  previewContainer: $('#previewContainer'), previewExportBtn: $('#previewExportBtn'),
  // Planner
  mealsContainer: $('#mealsContainer'), dailySummary: $('#dailySummary'), warnings: $('#warnings'),
  // Settings
  profileSelect: $('#profileSelect'), addProfileBtn: $('#addProfileBtn'),
  renameProfileBtn: $('#renameProfileBtn'), delProfileBtn: $('#delProfileBtn'),
  exportProfileBtn: $('#exportProfileBtn'), importProfileBtn: $('#importProfileBtn'),
  profileFile: $('#profileFile'),
  phase: $('#phase'), weight: $('#weight'), kcalTarget: $('#kcalTarget'),
  macroMode: $('#macroMode'), carbDay: $('#carbDay'), protDay: $('#protDay'), fatDay: $('#fatDay'),
  macroHint: $('#macroHint'),
  mealsCount: $('#mealsCount'), splitMode: $('#splitMode'), percentages: $('#percentages'),
  applySplitBtn: $('#applySplitBtn'), resetMealsBtn: $('#resetMealsBtn'),
  toggleHints: $('#toggleHints'),
  // Moltiplicatori
  bulkProt: $('#bulkProt'), bulkFat: $('#bulkFat'), cutProt: $('#cutProt'), cutFat: $('#cutFat'),
  resetFactorsBtn: $('#resetFactorsBtn'), factorFieldHint: $('#factorFieldHint'),
  // Interfaccia/Anteprima (globali)
  snapManual5: $('#snapManual5'),
  showColC: $('#showColC'), showColP: $('#showColP'), showColF: $('#showColF'), showTargets: $('#showTargets'),
  // Foods
  foodSearch: $('#foodSearch'),
  fName: $('#fName'), fKcal: $('#fKcal'), fCarb: $('#fCarb'), fProt: $('#fProt'),
  fFat: $('#fFat'), addFoodBtn: $('#addFoodBtn'),
  foodsGroups: $('#foodsGroups'), exportFoodsBtn: $('#exportFoodsBtn'), importFoodsBtn: $('#importFoodsBtn'),
  foodsFile: $('#foodsFile'),
  collapseAllBtn: $('#collapseAllBtn'), expandAllBtn: $('#expandAllBtn'),
  // Foods preview + hint
  foodDominant: $('#foodDominant'), foodMacroLine: $('#foodMacroLine'), foodKcalEst: $('#foodKcalEst'),
  foodFieldHint: $('#foodFieldHint'),

 // Auth (Email/Password)
 email: $('#email'),
 password: $('#password'),
 loginBtn: $('#loginBtn'),
 registerBtn: $('#registerBtn'),
 logoutBtn: $('#logoutBtn'),
 forcePullBtn: $('#forcePullBtn'),
 wipeLocalBtn: $('#wipeLocalBtn'),
 syncStatus: $('#syncStatus'),
 netStatus: $('#netStatus'),
};

/* ========= Tabs ========= */
const tabButtons = $$('.tab-btn');
function setTab(id){
  $$('.page').forEach(p=>p.classList.toggle('active', p.id===id));
  tabButtons.forEach(b=>b.classList.toggle('active', b.dataset.tab===id));
  localStorage.setItem('diet-tab', id);
}
tabButtons.forEach(b=> b.addEventListener('click', ()=> setTab(b.dataset.tab)));
const lastTab = localStorage.getItem('diet-tab');
if (lastTab) setTab(lastTab);

/* ========= Foods bootstrap ========= */
(function ensureCuratedFoods(){
  if (!state.ui) state.ui = {};
  if (typeof state.ui.showHints !== 'boolean') state.ui.showHints = true;
  if (!state.ui.foodsCollapsed) state.ui.foodsCollapsed = {c:false,p:false,f:false};
  if (typeof state.ui.snapManual5 !== 'boolean') state.ui.snapManual5 = false;
  if (!state.ui.preview) state.ui.preview = {showC:true,showP:true,showF:true,showTargets:true};
  if (!state.foodsVersion || state.foodsVersion !== CURATED_VERSION){
    state.foods = CURATED_FOODS.slice();
    state.foodsVersion = CURATED_VERSION;
    save();
  }
})();

/* ========= Rendering Alimenti (gruppi, integer display) ========= */
function foodItemHTML(f){
  const g = f.group;
  return `
    <div class="item">
      <div>
        <div style="font-weight:600">${escapeHtml(f.name)} <span class="tag ${g}">${g.toUpperCase()}</span></div>
        <div class="meta">
          ${fmt0(f.kcal)} kcal - <span class="tag c">C</span> ${fmt0(f.c)} g - <span class="tag p">P</span> ${fmt0(f.p)} g - <span class="tag f">G</span> ${fmt0(f.fat)} g (per 100 g)
        </div>
      </div>
      <div class="inline">
        <button class="secondary" data-act="edit" data-id="${f.id}">Modifica</button>
        <button class="secondary danger" data-act="del" data-id="${f.id}">Elimina</button>
      </div>
    </div>
  `;
}
function renderFoods(){
  const q = els.foodSearch.value.trim().toLowerCase();
  const groups = { c:[], p:[], f:[] };
  state.foods
    .filter(f=>!q || f.name.toLowerCase().includes(q))
    .sort((a,b)=> a.name.localeCompare(b.name))
    .forEach(f => { if (groups[f.group]) groups[f.group].push(f); });

  const container = els.foodsGroups;
  container.innerHTML = '';

  const meta = {
    c: { titolo: 'Carboidrati', tagClass:'c' },
    p: { titolo: 'Proteine',   tagClass:'p' },
    f: { titolo: 'Grassi',     tagClass:'f' }
  };

  let totalItems = 0;
  ['c','p','f'].forEach(k => {
    const arr = groups[k];
    totalItems += arr.length;
    if (arr.length === 0) return;

    const collapsed = !!state.ui.foodsCollapsed[k];

    const groupEl = document.createElement('div');
    groupEl.className = 'group';
    groupEl.innerHTML = `
      <div class="group-header" data-group-toggle="${k}">
        <div class="group-title">
          <span class="tag ${meta[k].tagClass}">${meta[k].titolo}</span>
          <span class="group-count">(${arr.length})</span>
        </div>
        <div class="group-actions">
          <button class="secondary" data-group-toggle="${k}">${collapsed ? '[+]' : '[-]'}</button>
        </div>
      </div>
      <div class="group-body ${collapsed ? 'hidden' : ''}">
        <div class="list">
          ${arr.map(f=> foodItemHTML(f)).join('')}
        </div>
      </div>
    `;
    container.appendChild(groupEl);
  });

  if (totalItems === 0){
    container.innerHTML = `<div class="muted">Nessun alimento trovato</div>`;
  }
}
els.foodsGroups.addEventListener('click', e=>{
  const btn = e.target.closest('button[data-act]');
  if (btn){
    const id = btn.dataset.id;
    if (btn.dataset.act==='edit') editFood(id);
    else if (btn.dataset.act==='del') delFood(id);
    return;
  }
  const tog = e.target.closest('[data-group-toggle]');
  if (tog){
    const k = tog.getAttribute('data-group-toggle');
    state.ui.foodsCollapsed[k] = !state.ui.foodsCollapsed[k];
    save(); renderFoods();
  }
});
els.collapseAllBtn.addEventListener('click', ()=>{
  state.ui.foodsCollapsed = { c:true, p:true, f:true };
  save(); renderFoods();
});
els.expandAllBtn.addEventListener('click', ()=>{
  state.ui.foodsCollapsed = { c:false, p:false, f:false };
  save(); renderFoods();
});

/* ========= Hint + anteprima (Alimenti) ========= */
const FOOD_FIELD_META = {
  fName:{label:'Nome', unit:'testo libero'},
  fKcal:{label:'Energia', unit:'kcal per 100 g'},
  fCarb:{label:'Carboidrati', unit:'g per 100 g'},
  fProt:{label:'Proteine', unit:'g per 100 g'},
  fFat :{label:'Grassi', unit:'g per 100 g'}
};
function showFoodFieldHint(target){
  const meta = FOOD_FIELD_META[target.id];
  Object.keys(FOOD_FIELD_META).forEach(k=> els[k]?.classList.remove('hl'));
  target.classList.add('hl');
  els.foodFieldHint.textContent = meta ? `Campo: ${meta.label} — ${meta.unit}` : '';
}
function updateFoodPreview(){
  const c = parse(els.fCarb.value), p = parse(els.fProt.value), f = parse(els.fFat.value);
  const dom = dominant(c,p,f);
  els.foodDominant.className = 'tag ' + (dom || '');
  els.foodDominant.textContent = dom==='c' ? 'CARBOIDRATI' : dom==='p' ? 'PROTEINE' : dom==='f' ? 'GRASSI' : '-';
  els.foodMacroLine.textContent = `C ${c} g - P ${p} g - G ${f} g`;
  const kcalEst = c*4 + p*4 + f*9;
  els.foodKcalEst.textContent = (parse(els.fKcal.value)>0) ? '' : `(stima: ${Math.round(kcalEst)} kcal/100g)`;
}
Object.keys(FOOD_FIELD_META).forEach(id=>{
  const inp = els[id]; if (!inp) return;
  inp.addEventListener('focus', e=> showFoodFieldHint(e.target));
  inp.addEventListener('input', e=> { showFoodFieldHint(e.target); updateFoodPreview(); });
});
['fCarb','fProt','fFat','fKcal'].forEach(id=> els[id]?.addEventListener('input', updateFoodPreview));

/* ========= Rounding multipli di 5g ========= */
function roundTo5WithDir(gramsExact){
  const g = Math.max(0, gramsExact||0);
  const down = Math.floor(g/5)*5;
  const up   = Math.ceil(g/5)*5;
  const errDown = Math.abs(g - down);
  const errUp   = Math.abs(up - g);
  if (errUp < errDown) return {g:up, dir:'up'};
  if (errDown < errUp) return {g:down, dir:'down'};
  return {g:down, dir:'down'}; // parità => difetto
}

/* ========= Planner: pasti + varianti ========= */
function ensureMeals(p){
  const n = parseInt(els.mealsCount.value||p.mealsCount);
  p.mealsCount = n;
  while (p.meals.length < n){
    p.meals.push({
      name:`Pasto ${p.meals.length+1}`,
      macros:{c:0,p:0,f:0,kcal:0},
      items:{c:[],p:[],f:[]},
      variants:[], activeVarId:null
    });
  }
  while (p.meals.length > n){ p.meals.pop(); }
  p.meals.forEach(m=>{
    if (!m.variants || !m.variants.length){
      const vid = crypto.randomUUID();
      m.variants = [{id:vid, name:'Tipo 1', items:cloneItems(m.items)}];
      m.activeVarId = vid;
    }else if (!m.activeVarId){
      m.activeVarId = m.variants[0].id;
    }
  });
}
function cloneItems(items){ return { c:items.c.map(i=>({...i})), p:items.p.map(i=>({...i})), f:items.f.map(i=>({...i})) }; }
function getActiveVariant(m){ return m.variants.find(v=>v.id===m.activeVarId) || m.variants[0]; }
function syncActiveVariant(mealIdx){
  const p = currentProfile(), m = p.meals[mealIdx];
  const v = getActiveVariant(m); if (!v) return;
  v.items = cloneItems(m.items);
  save();
  renderPreview();
}
function switchVariant(mealIdx, varId){
  const p = currentProfile(), m = p.meals[mealIdx];
  const v = m.variants.find(x=>x.id===varId); if (!v) return;
  m.activeVarId = varId;
  m.items = cloneItems(v.items);
  save(); renderPlanner(); renderPreview();
}
function newVariantFromCurrent(mealIdx){
  const p = currentProfile(), m = p.meals[mealIdx];
  const nextNum = m.variants.length + 1;
  const vid = crypto.randomUUID();
  m.variants.push({id:vid, name:`Tipo ${nextNum}`, items:cloneItems(m.items)});
  m.activeVarId = vid;
  save(); renderPlanner(); renderPreview();
}
function renameVariant(mealIdx){
  const p = currentProfile(), m = p.meals[mealIdx];
  const v = getActiveVariant(m); if (!v) return;
  const name = prompt('Nome tipologia:', v.name); if (!name) return;
  v.name = name; save(); renderPlanner(); renderPreview();
}
function deleteVariant(mealIdx){
  const p = currentProfile(), m = p.meals[mealIdx];
  if (m.variants.length<=1){ alert('Deve esistere almeno una tipologia.'); return; }
  if (!confirm('Eliminare la tipologia attiva?')) return;
  const idx = m.variants.findIndex(v=>v.id===m.activeVarId);
  m.variants.splice(idx,1);
  m.activeVarId = m.variants[0].id;
  m.items = cloneItems(getActiveVariant(m).items);
  save(); renderPlanner(); renderPreview();
}

/* Macro box */
function macroBox(k,label,idx,m){
  const opts = state.foods.filter(x=>x.group===k).sort((a,b)=>a.name.localeCompare(b.name))
    .map(f=>`<option value="${f.id}">${escapeHtml(f.name)}</option>`).join('');
  const items = m.items[k].map(it=>{
    const f = state.foods.find(x=>x.id===it.foodId);
    if (!f) return '';
    const tag = k==='c'?'c':k==='p'?'p':'f';
    const approx = it.approxDir ? `<span class="approx-badge ${it.approxDir==='up'?'approx-up':'approx-down'}">≈5 ${it.approxDir==='up'?'↑':'↓'}</span>` : '';
    const auto = it.auto ? `<span class="auto-badge">auto</span>` : '';
    return `
    <div class="item" style="grid-template-columns:1fr auto">
      <div>
        <div style="font-weight:600">${escapeHtml(f.name)} <span class="tag ${tag}">${label[0]}</span></div>
        <div class="meta">
          Grammi: <input type="number" step="1" min="0" value="${it.g}"
            data-meal="${idx}" data-k="${k}" data-food="${it.foodId}" data-role="grams"
            style="width:90px"/> g
          ${auto} ${approx}
        </div>
      </div>
      <div class="inline">
        <button class="secondary" data-role="auto1" data-meal="${idx}" data-k="${k}" data-food="${it.foodId}">Auto (copri ${label.toLowerCase()})</button>
        <button class="secondary danger" data-role="delItem" data-meal="${idx}" data-k="${k}" data-food="${it.foodId}">Rimuovi</button>
      </div>
    </div>
    `;
  }).join('');

  return `
  <div class="macro">
    <h5>${label}</h5>
    <div class="inline">
      <select data-role="addFood" data-meal="${idx}" data-k="${k}">
        <option value="">+ Aggiungi alimento...</option>${opts}
      </select>
      <button class="secondary" data-role="autoFill" data-meal="${idx}" data-k="${k}">Auto (1 alimento)</button>
    </div>
    <div style="margin-top:6px">${items || '<div class="muted">Nessun alimento</div>'}</div>
  </div>`;
}

/* Render Planner */
function renderPlanner(){
  const p = currentProfile();
  const cont = els.mealsContainer; cont.innerHTML='';
  p.meals.forEach((m,idx)=>{
    const kcalTotal = m.macros.c*KCAL_C + m.macros.p*KCAL_P + m.macros.f*KCAL_F;
    const variantsSelect = `
      <select data-role="variantSelect" data-meal="${idx}">
        ${m.variants.map(vv=>`<option value="${vv.id}" ${vv.id===m.activeVarId?'selected':''}>${vv.name}</option>`).join('')}
      </select>
      <button class="secondary" data-role="varNew" data-meal="${idx}">Nuova (da corrente)</button>
      <button class="secondary" data-role="varRen" data-meal="${idx}">Rinomina</button>
      <button class="secondary danger" data-role="varDel" data-meal="${idx}">Elimina</button>
    `;
    const card = document.createElement('div'); card.className='meal';
    card.innerHTML = `
      <div class="inline" style="justify-content:space-between;gap:10px;flex-wrap:wrap">
        <div class="inline" style="gap:8px">
          <h4>Pasto ${idx+1} - <input value="${escapeHtml(m.name)}" data-meal="${idx}" data-role="mealname" style="width:180px"/></h4>
          <div class="inline">${variantsSelect}</div>
        </div>
        <span class="badge">${fmt(kcalTotal)} kcal - C ${fmt(m.macros.c)} g - P ${fmt(m.macros.p)} g - G ${fmt(m.macros.f)} g</span>
      </div>
      <div class="macro-box">
        ${macroBox('c','Carboidrati',idx,m)}
        ${macroBox('p','Proteine',idx,m)}
        ${macroBox('f','Grassi',idx,m)}
      </div>
    `;
    cont.appendChild(card);
  });
  summarize();
  renderPreview();
}

/* Riepilogo */
function summarize(){
  const p = currentProfile();
  const tot = {c:0,p:0,f:0,kcal:0};
  p.meals.forEach(m=>{ tot.c+=m.macros.c; tot.p+=m.macros.p; tot.f+=m.macros.f; });
  tot.kcal = tot.c*KCAL_C + tot.p*KCAL_P + tot.f*KCAL_F;
  els.dailySummary.textContent = `${fmt(tot.kcal)} kcal - C ${fmt(tot.c)} g - P ${fmt(tot.p)} g - G ${fmt(tot.f)} g`;

  const warn = [];
  if (Math.abs(tot.c - p.macros.c) > 0.5) warn.push(`Carbo giorno diversi dal target (${fmt(p.macros.c)} g)`);
  if (Math.abs(tot.p - p.macros.p) > 0.5) warn.push(`Proteine giorno diverse dal target (${fmt(p.macros.p)} g)`);
  if (Math.abs(tot.f - p.macros.f) > 0.5) warn.push(`Grassi giorno diversi dal target (${fmt(p.macros.f)} g)`);
  els.warnings.textContent = warn.length ? `Attenzione: ${warn.join('; ')}` : `Allineato ai target giornalieri`;
}

/* Anteprima (tutte le varianti, con opzioni di visibilità) */
function renderPreview(){
  const p = currentProfile();
  const root = els.previewContainer;
  if (!root) return;

  const opts = state.ui?.preview || { showC:true, showP:true, showF:true, showTargets:true };
  const cols = [];
  if (opts.showC) cols.push({title:'Carboidrati', k:'c', tag:'c'});
  if (opts.showP) cols.push({title:'Proteine',    k:'p', tag:'p'});
  if (opts.showF) cols.push({title:'Grassi',      k:'f', tag:'f'});
  const colCount = Math.max(1, cols.length);

  let html = '';
  p.meals.forEach((m,mi)=>{
    html += `
      <div class="meal">
        <div class="inline" style="justify-content:space-between">
          <h4>${mi+1}. ${escapeHtml(m.name)}</h4>
          ${opts.showTargets ? `<span class="badge">C ${fmt(m.macros.c)} g - P ${fmt(m.macros.p)} g - G ${fmt(m.macros.f)} g</span>` : ``}
        </div>
    `;
    m.variants.forEach((v,vi)=>{
      const vClass = `var${vi%6}`;
      html += `
        <div class="var-box">
          <div class="var-title"><span class="var-badge ${vClass}">${v.name}</span></div>
          <div class="grid" style="grid-template-columns:repeat(${colCount},1fr);gap:8px">
            ${cols.map(c => variantCol(c.title, c.k, c.tag, v)).join('')}
          </div>
        </div>
      `;
    });
    html += `</div>`;
  });

  function variantCol(title,k,tag,v){
    const rows = v.items[k].map(it=>{
      const f = state.foods.find(x=>x.id===it.foodId);
      if (!f) return '';
      return `<div class="item" style="grid-template-columns:1fr auto">
                <div>${escapeHtml(f.name)}</div>
                <div class="muted">${it.g||0} g</div>
              </div>`;
    }).join('') || `<div class="muted">—</div>`;
    return `<div><div class="tag ${tag}">${title}</div><div class="list" style="max-height:none">${rows}</div></div>`;
  }

  root.innerHTML = html || `<div class="muted">Nessun pasto definito.</div>`;
}

/* Auto macro */
function applyAutoMacros(){
  const p = currentProfile();
  const weight = parse(els.weight.value||p.weight);
  const kcal = parse(els.kcalTarget.value||p.kcalTarget);
  const phase = els.phase.value || p.phase;

  const fac = p.factors?.[phase] || (phase==='bulk' ? {p:1.6,f:1.0} : {p:2.2,f:0.8});
  const gP = (fac.p||0)*weight;
  const gF = (fac.f||0)*weight;
  const kcalPF = gP*KCAL_P + gF*KCAL_F;
  const gC = Math.max(0, (kcal - kcalPF)/KCAL_C);

  p.weight = weight; p.kcalTarget = kcal; p.phase = phase;
  p.macros = {c: Math.round(gC), p: Math.round(gP), f: Math.round(gF)};
  setInputsFromMacros();
  showMacroHint();
  save(); renderPreview();
}
function setInputsFromMacros(){
  const p = currentProfile();
  els.carbDay.value = p.macros.c; els.protDay.value = p.macros.p; els.fatDay.value = p.macros.f;
}
function readManualMacros(){
  const p = currentProfile();
  p.macros = { c: parse(els.carbDay.value), p: parse(els.protDay.value), f: parse(els.fatDay.value) };
  save(); renderPreview();
}
function showMacroHint(){
  const p = currentProfile();
  const kcal = p.macros.c*KCAL_C + p.macros.p*KCAL_P + p.macros.f*KCAL_F;
  els.macroHint.textContent = `Target giornaliero: ${fmt(kcal)} kcal - C ${fmt(p.macros.c)} g - P ${fmt(p.macros.p)} g - G ${fmt(p.macros.f)} g`;
}

/* Percentuali (con validazione 100%) */
function buildPercentages(){
  const p = currentProfile();
  const n = p.mealsCount;
  if (!p.percentages.length){
    for(let i=0;i<n;i++) p.percentages.push({name:`Pasto ${i+1}`, c:Math.round(100/n), p:Math.round(100/n), f:Math.round(100/n)});
  }else if (p.percentages.length<n){
    for(let i=p.percentages.length;i<n;i++) p.percentages.push({name:`Pasto ${i+1}`, c:Math.round(100/n), p:Math.round(100/n), f:Math.round(100/n)});
  }else if (p.percentages.length>n){
    p.percentages = p.percentages.slice(0,n);
  }
  save();
}
function renderPercentages(){
  const p = currentProfile();
  const wrap = els.percentages;
  wrap.innerHTML='';

  if (els.splitMode.value!=='percent'){
    wrap.innerHTML = `<div class="muted">Modalità manuale: imposta direttamente i grammi dal Planner.</div>`;
    validatePercentages();
    return;
  }

  buildPercentages();
  const n = p.mealsCount;

  const head = document.createElement('div');
  head.innerHTML = `
    <div class="hintbar">
      Stai distribuendo le <strong>percentuali dei macronutrienti</strong> per ogni pasto.
      Colonne: <span class="tag c">C</span> Carboidrati · <span class="tag p">P</span> Proteine · <span class="tag f">G</span> Grassi.
    </div>
    <div class="row four" style="margin-top:6px">
      <div class="muted" style="font-weight:700">Nome pasto</div>
      <div class="muted" style="font-weight:700">C % (Carbo)</div>
      <div class="muted" style="font-weight:700">P % (Proteine)</div>
      <div class="muted" style="font-weight:700">G % (Grassi)</div>
    </div>
  `;
  wrap.appendChild(head);

  for(let i=0;i<n;i++){
    const row = document.createElement('div'); row.className='row four';
    row.innerHTML = `
      <input data-pidx="${i}" data-k="name" placeholder="Nome pasto" value="${p.percentages[i]?.name||`Pasto ${i+1}`}" />
      <input type="number" min="0" max="100" step="1" data-pidx="${i}" data-k="c" placeholder="% Carbo" value="${p.percentages[i]?.c ?? Math.round(100/n)}"/>
      <input type="number" min="0" max="100" step="1" data-pidx="${i}" data-k="p" placeholder="% Prot"  value="${p.percentages[i]?.p ?? Math.round(100/n)}"/>
      <input type="number" min="0" max="100" step="1" data-pidx="${i}" data-k="f" placeholder="% Grassi" value="${p.percentages[i]?.f ?? Math.round(100/n)}"/>
    `;
    row.querySelectorAll('input').forEach(inp=>{
      inp.addEventListener('input', ()=>{
        const idx = Number(inp.dataset.pidx);
        const k = inp.dataset.k;
        if (k==='name'){ p.percentages[idx].name = inp.value; }
        else{
          const v = parse(inp.value);
          p.percentages[idx][k] = isNaN(v)?0:Math.max(0, Math.min(100, Math.round(v)));
          inp.value = p.percentages[idx][k];
        }
        save();
        validatePercentages();
      });
    });
    wrap.appendChild(row);
  }

  const totalsBar = document.createElement('div');
  totalsBar.id = 'percentTotals';
  totalsBar.className = 'totals-bar';
  wrap.appendChild(totalsBar);

  const hint = document.createElement('div'); hint.className='muted';
  hint.textContent = 'I tre insiemi di percentuali sono indipendenti. Ogni colonna (C, P, G) deve sommare 100%.';
  wrap.appendChild(hint);

  validatePercentages();
}
function validatePercentages(){
  const p = currentProfile();
  const totals = { c:0, p:0, f:0 };
  if (els.splitMode.value==='percent'){
    p.percentages.forEach(r=>{ totals.c += r.c||0; totals.p += r.p||0; totals.f += r.f||0; });
  }
  const bar = $('#percentTotals');
  if (bar){
    const okC = totals.c===100, okP = totals.p===100, okF = totals.f===100;
    bar.innerHTML = `
      <span class="muted">Totali colonna:</span>
      <span class="pill ${okC?'ok':'err'}">C = ${totals.c}%</span>
      <span class="pill ${okP?'ok':'err'}">P = ${totals.p}%</span>
      <span class="pill ${okF?'ok':'err'}">G = ${totals.f}%</span>
    `;
    $$('#percentages input[data-k="c"], #percentages input[data-k="p"], #percentages input[data-k="f"]').forEach(i=>i.classList.remove('input-err'));
    if (!okC) $$('#percentages input[data-k="c"]').forEach(i=>i.classList.add('input-err'));
    if (!okP) $$('#percentages input[data-k="p"]').forEach(i=>i.classList.add('input-err'));
    if (!okF) $$('#percentages input[data-k="f"]').forEach(i=>i.classList.add('input-err'));
    els.applySplitBtn.disabled = !(okC && okP && okF && els.splitMode.value==='percent');
  }else{
    els.applySplitBtn.disabled = false;
  }
}
function applyDistribution(){
  const p = currentProfile();
  if (els.splitMode.value==='percent'){
    p.meals.forEach((m,i)=>{
      m.name = p.percentages[i].name || m.name;
      m.macros.c = Math.round(p.macros.c * (p.percentages[i].c/100));
      m.macros.p = Math.round(p.macros.p * (p.percentages[i].p/100));
      m.macros.f = Math.round(p.macros.f * (p.percentages[i].f/100));
      m.macros.kcal = m.macros.c*KCAL_C + m.macros.p*KCAL_P + m.macros.f*KCAL_F;
    });
    save(); renderPlanner(); renderPreview();
  }
}

/* ========= CRUD Alimenti ========= */
function addFoodFromForm(){
  const name = els.fName.value.trim(); if(!name){ els.fName.focus(); return; }
  const kcal = parse(els.fKcal.value), c=parse(els.fCarb.value), p=parse(els.fProt.value), fat=parse(els.fFat.value);
  let id = els.addFoodBtn.dataset.editingId || crypto.randomUUID();
  const group = dominant(c,p,fat);
  const exists = state.foods.find(x=>x.id===id);
  const entry = {id,name,kcal,c,p,fat,group};
  if (exists){ Object.assign(exists, entry); } else { state.foods.push(entry); }
  clearFoodForm(); save(); renderFoods(); updateFoodPreview();
}
function clearFoodForm(){
  ['fName','fKcal','fCarb','fProt','fFat'].forEach(id=>els[id].value='');
  els.addFoodBtn.textContent='Aggiungi/Salva'; delete els.addFoodBtn.dataset.editingId;
}
function editFood(id){
  const f = state.foods.find(x=>x.id===id); if (!f) return;
  els.fName.value = f.name; els.fKcal.value=f.kcal; els.fCarb.value=f.c; els.fProt.value=f.p; els.fFat.value=f.fat;
  els.addFoodBtn.textContent='Salva'; els.addFoodBtn.dataset.editingId = f.id;
  updateFoodPreview();
}
function delFood(id){
  state.foods = state.foods.filter(x=>x.id!==id);
  state.profiles.forEach(p=> p.meals.forEach(m=> ['c','p','f'].forEach(k=> m.items[k]=m.items[k].filter(it=>it.foodId!==id))));
  save(); renderFoods(); renderPlanner(); renderPreview();
}
function importFoodsArray(arr){
  arr.forEach(nf=>{
    if (!nf || !nf.name) return;
    const exist = state.foods.find(x=>x.name.toLowerCase()===nf.name.toLowerCase());
    const entry = {
      id: exist?exist.id:crypto.randomUUID(),
      name: nf.name,
      kcal: parse(nf.kcal), c: parse(nf.c), p: parse(nf.p), fat: parse(nf.fat)
      // eventuale nf.sug ignorato
    };
    entry.group = dominant(entry.c,entry.p,entry.fat);
    if (exist) Object.assign(exist, entry); else state.foods.push(entry);
  });
  save(); renderFoods(); renderPlanner(); renderPreview();
}

/* ========= Items & Auto (multipli di 5g) ========= */
function addItem(mealIdx,k,foodId){
  const p = currentProfile(), m=p.meals[mealIdx];
  if (!foodId) return;
  if (m.items[k].some(it=>it.foodId===foodId)) return;
  m.items[k].push({foodId, g:0, auto:false, approxDir:null});
  syncActiveVariant(mealIdx);
  save(); renderPlanner();
}
function removeItem(mealIdx,k,foodId){
  const p = currentProfile(), m=p.meals[mealIdx];
  m.items[k] = m.items[k].filter(it=>it.foodId!==foodId);
  syncActiveVariant(mealIdx);
  save(); renderPlanner();
}
function autoFillOne(mealIdx,k){
  const p = currentProfile(), m=p.meals[mealIdx];
  if (!m.items[k].length){
    const f = state.foods.find(x=>x.group===k);
    if (!f){ alert('Nessun alimento nel gruppo selezionato.'); return; }
    m.items[k].push({foodId:f.id,g:0,auto:false, approxDir:null});
  }
  const it = m.items[k][0];
  const food = state.foods.find(x=>x.id===it.foodId);
  const targetG = m.macros[k];
  const per100 = k==='c'?food.c : k==='p'?food.p : food.fat;
  if (per100<=0){ alert('Impossibile calcolare: alimento con 0 g del macro selezionato.'); return; }
  const exact = targetG / (per100/100);
  const {g,dir} = roundTo5WithDir(exact);
  it.g = g; it.auto = true; it.approxDir = dir;
  syncActiveVariant(mealIdx);
  save(); renderPlanner();
}

/* ========= Eventi Planner ========= */
els.mealsContainer.addEventListener('change', e=>{
  const t=e.target;
  if (t.dataset.role==='addFood'){ addItem(parseInt(t.dataset.meal), t.dataset.k, t.value); t.value=''; }
  else if (t.dataset.role==='grams'){
    const mealIdx = parseInt(t.dataset.meal);
    const p = currentProfile(), m=p.meals[mealIdx];
    const arr = m.items[t.dataset.k]; const it = arr.find(x=>x.foodId===t.dataset.food);
    if (it){
      let v = parse(t.value);
      if (state.ui?.snapManual5){
        const {g,dir} = roundTo5WithDir(v);
        v = g; it.approxDir = dir; t.value = g;
      } else {
        it.approxDir = null;
      }
      it.g = v;
      it.auto=false;
      syncActiveVariant(mealIdx);
      save();
    }
  }else if (t.dataset.role==='mealname'){
    const p = currentProfile(), m=p.meals[parseInt(t.dataset.meal)];
    m.name = t.value; save(); renderPreview();
  }else if (t.dataset.role==='variantSelect'){
    switchVariant(parseInt(t.dataset.meal), t.value);
  }
});
els.mealsContainer.addEventListener('click', e=>{
  const b = e.target.closest('button[data-role]'); if(!b) return;
  const role=b.dataset.role, mealIdx=parseInt(b.dataset.meal), k=b.dataset.k, food=b.dataset.food;
  if (role==='autoFill') autoFillOne(mealIdx,k);
  else if (role==='delItem') removeItem(mealIdx,k,food);
  else if (role==='auto1'){
    const p = currentProfile(), m=p.meals[mealIdx];
    const it = m.items[k].find(x=>x.foodId===food); if (!it) return;
    const f = state.foods.find(x=>x.id===food);
    const per100 = k==='c'?f.c : k==='p'?f.p : f.fat;
    if (per100<=0){ alert('Impossibile calcolare: macro = 0.'); return; }
    const exact = m.macros[k] / (per100/100);
    const {g,dir} = roundTo5WithDir(exact);
    it.g = g; it.auto = true; it.approxDir = dir;
    syncActiveVariant(mealIdx);
    save(); renderPlanner();
  }else if (role==='varNew'){ newVariantFromCurrent(mealIdx); }
  else if (role==='varRen'){ renameVariant(mealIdx); }
  else if (role==='varDel'){ deleteVariant(mealIdx); }
});

/* ========= Eventi generali ========= */

// ===== Auth UI handlers =====
function wipeLocal(){
  if(!confirm('Vuoi davvero cancellare i dati locali su questo dispositivo?')) return;
  localStorage.removeItem(KEY);
  location.reload();
}

els.forcePullBtn?.addEventListener('click', () => forcePullFromCloud().catch(console.error));
els.wipeLocalBtn?.addEventListener('click', wipeLocal);

els.loginBtn?.addEventListener('click', async () => {
  try { await signInWithEmailAndPassword(auth, els.email.value.trim(), els.password.value); }
  catch (e) { alert('Login fallito: ' + e.message); }
});

els.registerBtn?.addEventListener('click', async () => {
  try { await createUserWithEmailAndPassword(auth, els.email.value.trim(), els.password.value); }
  catch (e) { alert('Registrazione fallita: ' + e.message); }
});

els.logoutBtn?.addEventListener('click', async () => { await signOut(auth); });

onAuthStateChanged(auth, (user) => {
  BOOTING = false;
  setNetStatus();
  if (user) {
    setSyncStatus('🔄 Connessione al cloud…');
    startCloudSync(user.uid).catch((e) => {
      console.error('[SYNC] startCloudSync error:', e);
      setSyncStatus('❌ Sync init: ' + (e.code || e.message));
    });
  } else {
    setSyncStatus('ℹ️ Sync disattivo: fai login per salvare sul cloud');
    if (remote.unsub) remote.unsub();
    remote.uid = null;
  }
});

els.addFoodBtn.addEventListener('click', addFoodFromForm);
els.foodSearch.addEventListener('input', renderFoods);
els.exportFoodsBtn.addEventListener('click', ()=>{
  const blob = new Blob([JSON.stringify(state.foods, null, 2)], {type:'application/json'});
  const a = document.createElement('a'); a.href=URL.createObjectURL(blob);
  a.download='alimenti.json'; a.click(); URL.revokeObjectURL(a.href);
});
els.importFoodsBtn.addEventListener('click', ()=> els.foodsFile.click());
els.foodsFile.addEventListener('change', e=>{
  const f = e.target.files?.[0]; if (!f) return;
  const ext = (f.name.split('.').pop()||'').toLowerCase();
  const r = new FileReader();
  r.onload = ev=>{
    try{
      if (ext==='json'){
        const arr = JSON.parse(ev.target.result);
        importFoodsArray(arr);
      }else{
        // CSV accettato: Nome;Kcal;Carbo;Proteine;Grassi;[Zuccheri] -> zuccheri ignorati se presenti
        const text = ev.target.result;
        const rows = text.split(/\r?\n/).filter(x=>x.trim()).map(r=>r.split(';').map(x=>x.trim()));
        const hdr = rows[0].map(h=>h.toLowerCase());
        const nameIdx = hdr.indexOf('nome')>-1?hdr.indexOf('nome'):0;
        const idx = k=>hdr.indexOf(k);
        const arr = rows.slice(1).map(r=>{
          const name = r[nameIdx];
          const kcal=parse(r[idx('kcal')]||0),
                c=parse(r[idx('carbo')]||r[idx('carboidrati')]||0),
                p=parse(r[idx('proteine')]||0),
                fat=parse(r[idx('grassi')]||0);
          return {name,kcal,c,p,fat};
        });
        importFoodsArray(arr);
      }
    }catch(err){ alert('Import alimenti fallito: '+err.message); }
  };
  r.readAsText(f,'utf-8'); e.target.value='';
});

/* ========= Settings / Profili ========= */
function setProfileHandlers(){
  els.addProfileBtn.addEventListener('click', ()=>{
    const name = prompt('Nome profilo?','Profilo nuovo'); if(!name) return;
    const p = makeProfile(name); state.profiles.push(p); state.currentProfileId=p.id; save(); initProfileUI();
  });
  els.renameProfileBtn.addEventListener('click', ()=>{
    const p = currentProfile(); if(!p) return;
    const name = prompt('Nuovo nome profilo:', p.name); if(!name) return;
    p.name = name; save(); renderProfiles();
  });
  els.delProfileBtn.addEventListener('click', ()=>{
    if (state.profiles.length<=1){ alert('Deve esistere almeno un profilo.'); return; }
    if (!confirm('Eliminare il profilo corrente?')) return;
    state.profiles = state.profiles.filter(p=>p.id!==state.currentProfileId);
    state.currentProfileId = state.profiles[0].id; save(); initProfileUI();
  });
  els.profileSelect.addEventListener('change', e=>{ state.currentProfileId=e.target.value; save(); initProfileUI(); });

  // Export profili+foods+ui globali
  els.exportProfileBtn.addEventListener('click', ()=>{
    const p = currentProfile();
    const blob = new Blob([JSON.stringify({profiles:state.profiles, currentProfileId:state.currentProfileId, foods:state.foods, ui:state.ui}, null, 2)], {type:'application/json'});
    const a = document.createElement('a'); a.href=URL.createObjectURL(blob);
    a.download = `dieta_${p.name.replace(/\s+/g,'_')}.json`; a.click(); URL.revokeObjectURL(a.href);
  });
  els.importProfileBtn.addEventListener('click', ()=> els.profileFile.click());
  els.profileFile.addEventListener('change', e=>{
    const f = e.target.files?.[0]; if(!f) return;
    const r = new FileReader();
    r.onload = ev=>{
      try{
        const data = JSON.parse(ev.target.result);
        if (Array.isArray(data.profiles)){
          state.profiles = data.profiles;
          state.currentProfileId = data.currentProfileId || data.profiles[0].id;
        }else if (data.profile){
          data.profile.id = crypto.randomUUID();
          state.profiles.push(data.profile);
          state.currentProfileId = data.profile.id;
        }
        if (Array.isArray(data.foods)) state.foods = data.foods;
        if (data.ui){
          state.ui = data.ui;
          if (!state.ui.foodsCollapsed) state.ui.foodsCollapsed={c:false,p:false,f:false};
          if (typeof state.ui.snapManual5 !== 'boolean') state.ui.snapManual5=false;
          if (!state.ui.preview) state.ui.preview={showC:true,showP:true,showF:true,showTargets:true};
        }
        save(); initProfileUI(); renderFoods(); renderPreview();
      }catch(err){ alert('Import fallito: '+err.message); }
    };
    r.readAsText(f); e.target.value='';
  });

  // Target & macro
  ['phase','weight','kcalTarget','macroMode'].forEach(id=>{
    els[id].addEventListener('change', ()=>{
      const p = currentProfile();
      p.phase = els.phase.value; p.weight = parse(els.weight.value);
      p.kcalTarget = parse(els.kcalTarget.value); p.macroMode = els.macroMode.value;
      if (p.macroMode==='auto') applyAutoMacros(); else readManualMacros();
      save(); showMacroHint();
    });
  });
  ['carbDay','protDay','fatDay'].forEach(id=>{
    els[id].addEventListener('input', ()=>{ if (els.macroMode.value==='manual'){ readManualMacros(); save(); showMacroHint(); }});
  });

  // Pasti & split
  els.mealsCount.addEventListener('change', ()=>{ ensureMeals(currentProfile()); buildPercentages(); renderPercentages(); renderPlanner(); save(); });
  els.splitMode.addEventListener('change', ()=>{ currentProfile().splitMode = els.splitMode.value; buildPercentages(); renderPercentages(); save(); });
  els.applySplitBtn.addEventListener('click', ()=>{ applyDistribution(); });

  // Moltiplicatori
  const META = {
    bulkProt:{label:'Proteine', phase:'Bulk'},
    bulkFat :{label:'Grassi',   phase:'Bulk'},
    cutProt :{label:'Proteine', phase:'Cut'},
    cutFat  :{label:'Grassi',   phase:'Cut'}
  };
  function updateFactorHint(target){
    const m = META[target.id]; if (!m){ els.factorFieldHint.textContent=''; return; }
    els.factorFieldHint.textContent = `Stai modificando: ${m.label} — fase ${m.phase} (g/kg)`;
    Object.keys(META).forEach(k=> els[k].classList.remove('hl'));
    target.classList.add('hl');
  }
  function onFactorsChange(){
    const p = currentProfile();
    if (!p.factors) p.factors = { bulk:{p:1.6,f:1.0}, cut:{p:2.2,f:0.8} };
    p.factors.bulk.p = parse(els.bulkProt.value);
    p.factors.bulk.f = parse(els.bulkFat.value);
    p.factors.cut.p  = parse(els.cutProt.value);
    p.factors.cut.f  = parse(els.cutFat.value);
    if (p.macroMode==='auto'){ applyAutoMacros(); }
    save(); showMacroHint();
  }
  [els.bulkProt, els.bulkFat, els.cutProt, els.cutFat].forEach(inp=>{
    inp.addEventListener('focus', e=> updateFactorHint(e.target));
    inp.addEventListener('input', e=> { updateFactorHint(e.target); onFactorsChange(); });
    inp.addEventListener('change', onFactorsChange);
  });
  els.resetFactorsBtn.addEventListener('click', ()=>{
    const p = currentProfile();
    p.factors = { bulk:{p:1.6,f:1.0}, cut:{p:2.2,f:0.8} };
    renderFactors(); if (p.macroMode==='auto') applyAutoMacros(); save(); showMacroHint();
    els.factorFieldHint.textContent='';
    [els.bulkProt,els.bulkFat,els.cutProt,els.cutFat].forEach(x=>x.classList.remove('hl'));
  });

  // UI globali
  els.toggleHints.addEventListener('change', ()=>{
    state.ui.showHints = els.toggleHints.checked; save();
  });
  els.snapManual5.addEventListener('change', ()=>{
    state.ui.snapManual5 = !!els.snapManual5.checked; save();
  });
  ['showColC','showColP','showColF','showTargets'].forEach(id=>{
    els[id].addEventListener('change', ()=>{
      if (!state.ui.preview) state.ui.preview = {showC:true,showP:true,showF:true,showTargets:true};
      state.ui.preview.showC = !!els.showColC.checked;
      state.ui.preview.showP = !!els.showColP.checked;
      state.ui.preview.showF = !!els.showColF.checked;
      state.ui.preview.showTargets = !!els.showTargets.checked;
      save(); renderPreview();
    });
  });
}
setProfileHandlers();

/* ========= Anteprima: Esporta PDF (tutte le varianti, senza frase) ========= */
els.previewExportBtn.addEventListener('click', exportPDF);
function exportPDF(){
  const p = currentProfile();
  const opts = state.ui?.preview || { showC:true, showP:true, showF:true, showTargets:true };
  const cols = [];
  if (opts.showC) cols.push({title:'Carboidrati', k:'c', tag:'c'});
  if (opts.showP) cols.push({title:'Proteine',    k:'p', tag:'p'});
  if (opts.showF) cols.push({title:'Grassi',      k:'f', tag:'f'});
  const colCount = Math.max(1, cols.length);

  const style = `
    <style>
      body{font-family:system-ui,-apple-system,Segoe UI,Roboto;margin:24px}
      h2{margin:0 0 8px} h3{margin:14px 0 6px}
      .meal{border:1px solid #ddd;border-radius:12px;padding:12px;margin:10px 0}
      .cols{display:grid;grid-template-columns:repeat(${colCount},1fr);gap:10px}
      .muted{color:#555;font-size:12px}
      .tag{border:1px solid #999;border-radius:999px;padding:2px 6px;font-size:11px}
      .c{background:#e0f2fe}.p{background:#dcfce7}.f{background:#fef9c3}
      table{width:100%;border-collapse:collapse} td{padding:4px 6px;border-bottom:1px solid #eee}
      .vb{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;border:1px solid #ccc;margin:2px 0}
      .v0{background:#e6ecff;color:#1e3a8a;border-color:#bcd}
      .v1{background:#e6fff3;color:#065f46;border-color:#bcd}
      .v2{background:#ffebe6;color:#7c2d12;border-color:#bcd}
      .v3{background:#f6e8ff;color:#6b21a8;border-color:#bcd}
      .v4{background:#fff4e5;color:#b45309;border-color:#bcd}
      .v5{background:#e6fffb;color:#0f766e;border-color:#bcd}
      .varbox{border:1px dashed #ccc;border-radius:10px;padding:8px;margin:6px 0}
    </style>`;
  let html = `<h2>Piano pasti - ${p.name}</h2>`;

  p.meals.forEach((m,mi)=>{
    html += `<div class="meal">
      <h3>${mi+1}. ${escapeHtml(m.name)}</h3>
      ${opts.showTargets ? `<div class="muted">Target pasto: C ${fmt(m.macros.c)} g - P ${fmt(m.macros.p)} g - G ${fmt(m.macros.f)} g</div>` : ``}
    `;
    m.variants.forEach((v,vi)=>{
      html += `<div class="varbox">
        <div class="vb v${vi%6}">${v.name}</div>
        <div class="cols">
          ${cols.map(c => pdfCol(c.title, c.k, c.tag, v)).join('')}
        </div>
      </div>`;
    });
    html += `</div>`;
  });

  function pdfCol(title,k,tag,v){
    const rows = v.items[k].map(it=>{
      const f = state.foods.find(x=>x.id===it.foodId);
      if (!f) return '';
      return `<tr><td>${escapeHtml(f.name)}</td><td style="text-align:right">${it.g||0} g</td></tr>`;
    }).join('') || '<tr><td class="muted" colspan="2">—</td></tr>';
    return `<div><div class="tag ${tag}">${title}</div><table>${rows}</table></div>`;
  }

  const win = window.open('', '_blank');
  win.document.write(`<html><head><title>PDF Dieta</title>${style}</head><body>${html}</body></html>`);
  win.document.close(); win.focus(); win.print();
}

/* ========= Init helpers ========= */
function renderProfiles(){
  const sel = els.profileSelect;
  sel.innerHTML='';
  state.profiles.forEach(p=>{
    const o=document.createElement('option'); o.value=p.id; o.textContent=p.name; sel.appendChild(o);
  });
  sel.value = state.currentProfileId;
}
function renderFactors(){
  const p = currentProfile();
  if (!p.factors) p.factors = { bulk:{p:1.6,f:1.0}, cut:{p:2.2,f:0.8} };
  els.bulkProt.value = p.factors.bulk.p; els.bulkFat.value  = p.factors.bulk.f;
  els.cutProt.value  = p.factors.cut.p;  els.cutFat.value   = p.factors.cut.f;
}
function initProfileUI(){
  renderProfiles();
  const p = currentProfile();

  // UI globali default
  if (!state.ui) state.ui = {};
  if (typeof state.ui.showHints !== 'boolean') state.ui.showHints = true;
  if (!state.ui.foodsCollapsed) state.ui.foodsCollapsed={c:false,p:false,f:false};
  if (typeof state.ui.snapManual5 !== 'boolean') state.ui.snapManual5=false;
  if (!state.ui.preview) state.ui.preview={showC:true,showP:true,showF:true,showTargets:true};

  // Sync UI toggles
  if (els.toggleHints) els.toggleHints.checked = !!state.ui.showHints;
  if (els.snapManual5) els.snapManual5.checked = !!state.ui.snapManual5;
  if (els.showColC) els.showColC.checked = !!state.ui.preview.showC;
  if (els.showColP) els.showColP.checked = !!state.ui.preview.showP;
  if (els.showColF) els.showColF.checked = !!state.ui.preview.showF;
  if (els.showTargets) els.showTargets.checked = !!state.ui.preview.showTargets;

  els.phase.value = p.phase; els.weight.value=p.weight; els.kcalTarget.value=p.kcalTarget;
  els.macroMode.value=p.macroMode;

  ensureMeals(p);
  if (p.macroMode==='auto') applyAutoMacros(); else setInputsFromMacros();
  showMacroHint();

  renderFactors();

  els.mealsCount.value = p.mealsCount;
  els.splitMode.value = p.splitMode;
  buildPercentages();
  renderPercentages();

  renderPlanner();
  renderFoods();
  renderPreview();
}
initProfileUI();
updateFoodPreview();
