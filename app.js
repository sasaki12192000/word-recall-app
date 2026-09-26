'use strict';

const DB_NAME = 'WordRecallDB';
const DB_VERSION = 2;
const STORE_NAME = 'app';
const IMAGE_STORE = 'images';
const STATE_KEY = 'state';
const DAY = 86400000;
const LEVEL_DAYS = [0,1,3,7,14,30,60,120];
let state = defaultState();
let session = null;
let pendingBulkData = null;
let dbPromise = null;
let saveChain = Promise.resolve();
let migratedImageCount = 0;
let migrationWarning = false;

// Image data is intentionally kept OUT of `state`.
// The lightweight vocabulary/statistics state lives in STORE_NAME,
// while image Blobs live separately in IMAGE_STORE keyed by word id.
const imageUrlCache = new Map();
let pendingImageMode = 'unchanged'; // unchanged | replace | remove
let pendingImageBlob = null;
let pendingPreviewUrl = null;

const $ = (id) => document.getElementById(id);
const $$ = (sel) => [...document.querySelectorAll(sel)];

function defaultState(){ return { version:2, words:[], settings:{} }; }
function openDb(){
  if(dbPromise) return dbPromise;
  dbPromise = new Promise((resolve,reject)=>{
    const req=indexedDB.open(DB_NAME,DB_VERSION);
    req.onupgradeneeded=()=>{
      const db=req.result;
      if(!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
      if(!db.objectStoreNames.contains(IMAGE_STORE)) db.createObjectStore(IMAGE_STORE);
    };
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>{ dbPromise=null; reject(req.error); };
    req.onblocked=()=>console.warn('IndexedDB upgrade is blocked by another open tab.');
  });
  return dbPromise;
}
function stateForStorage(source=state){
  return {
    ...source,
    version:2,
    words:(source.words||[]).map(w=>{
      const clean={...w,hasImage:!!w.hasImage};
      delete clean.image;
      return clean;
    })
  };
}
function migrate(s){
  const base = defaultState();
  s = {...base,...s,version:2};
  s.words = (s.words||[]).map(w => {
    const template=newWordTemplate();
    const merged={...template,...w, stats:{...template.stats,...(w.stats||{}), recall:{...template.stats.recall,...(w.stats?.recall||{})}, use:{...template.stats.use,...(w.stats?.use||{})}, connect:{...template.stats.connect,...(w.stats?.connect||{})}}};
    merged.hasImage=!!(w.hasImage || (typeof w.image==='string' && w.image.startsWith('data:image/')));
    return merged;
  });
  return s;
}
function dataUrlToBlob(dataUrl){
  if(typeof dataUrl!=='string' || !dataUrl.startsWith('data:')) throw new Error('Invalid image data');
  const comma=dataUrl.indexOf(',');
  if(comma<0) throw new Error('Invalid image data');
  const meta=dataUrl.slice(0,comma);
  const body=dataUrl.slice(comma+1);
  const mime=(meta.match(/^data:([^;]+)/)||[])[1]||'application/octet-stream';
  if(/;base64/i.test(meta)){
    const bin=atob(body);
    const bytes=new Uint8Array(bin.length);
    for(let i=0;i<bin.length;i++) bytes[i]=bin.charCodeAt(i);
    return new Blob([bytes],{type:mime});
  }
  return new Blob([decodeURIComponent(body)],{type:mime});
}
function blobToDataUrl(blob){
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onload=()=>resolve(reader.result);
    reader.onerror=()=>reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
async function readRawState(){
  const db=await openDb();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(STORE_NAME,'readonly');
    const req=tx.objectStore(STORE_NAME).get(STATE_KEY);
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
  });
}
async function migrateEmbeddedImagesIfNeeded(source){
  let count=0;
  // Move one image at a time. Each step atomically writes the image Blob and
  // removes only that image from the old state record. This means an interrupted
  // migration can safely continue on the next launch without recreating images.
  for(const w of (source.words||[])){
    if(typeof w.image!=='string' || !w.image.startsWith('data:image/')) continue;
    const blob=dataUrlToBlob(w.image);
    const originalImage=w.image;
    delete w.image;
    w.hasImage=true;
    try{
      const db=await openDb();
      await new Promise((resolve,reject)=>{
        const tx=db.transaction([STORE_NAME,IMAGE_STORE],'readwrite');
        tx.objectStore(IMAGE_STORE).put(blob,w.id);
        // Keep still-unmigrated image fields on the other words as a checkpoint.
        tx.objectStore(STORE_NAME).put(source,STATE_KEY);
        tx.oncomplete=resolve;
        tx.onerror=()=>reject(tx.error);
        tx.onabort=()=>reject(tx.error||new Error('Image migration aborted'));
      });
      count++;
    }catch(err){
      // Restore the in-memory legacy image. The database transaction was atomic,
      // so this image remains in its original location as well.
      w.image=originalImage;
      throw err;
    }
  }

  const clean=stateForStorage(source);
  if(count || (source.words||[]).some(w=>Object.prototype.hasOwnProperty.call(w,'image'))){
    const db=await openDb();
    await new Promise((resolve,reject)=>{
      const tx=db.transaction(STORE_NAME,'readwrite');
      tx.objectStore(STORE_NAME).put(clean,STATE_KEY);
      tx.oncomplete=resolve;
      tx.onerror=()=>reject(tx.error);
    });
  }
  return {state:clean,count};
}
async function loadState(){
  let raw;
  try{
    raw=await readRawState();
  }catch(e){
    console.error('IndexedDB load failed',e);
    return defaultState();
  }
  if(!raw) return defaultState();
  const migrated=migrate(raw);
  try{
    const result=await migrateEmbeddedImagesIfNeeded(migrated);
    migratedImageCount=result.count;
    return result.state;
  }catch(e){
    // Keep the still-embedded legacy images in memory and in IndexedDB.
    // We never replace the user data with an empty state just because migration failed.
    console.error('Image separation migration is incomplete',e);
    migrationWarning=true;
    return migrated;
  }
}
async function persistStateNow(){
  // If a previous migration was interrupted, finish moving remaining embedded
  // images BEFORE saving lightweight state. This prevents accidental image loss.
  if((state.words||[]).some(w=>typeof w.image==='string' && w.image.startsWith('data:image/'))){
    const result=await migrateEmbeddedImagesIfNeeded(state);
    state=result.state;
    migratedImageCount+=result.count;
    migrationWarning=false;
  }
  const clean=stateForStorage();
  const db=await openDb();
  await new Promise((resolve,reject)=>{
    const tx=db.transaction(STORE_NAME,'readwrite');
    tx.objectStore(STORE_NAME).put(clean,STATE_KEY);
    tx.oncomplete=resolve;
    tx.onerror=()=>reject(tx.error);
    tx.onabort=()=>reject(tx.error||new Error('State save aborted'));
  });
}
function persistState(){
  saveChain=saveChain.then(()=>persistStateNow()).catch(e=>{
    console.error('IndexedDB state save failed',e);
    toast('学習データの保存に失敗しました。ブラウザの空き容量をご確認ください。');
  });
  return saveChain;
}
function saveState(){ persistState(); renderAll(); }
async function getImageBlob(wordId){
  const db=await openDb();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(IMAGE_STORE,'readonly');
    const req=tx.objectStore(IMAGE_STORE).get(wordId);
    req.onsuccess=()=>{
      const value=req.result;
      if(typeof value==='string' && value.startsWith('data:image/')){
        try{ resolve(dataUrlToBlob(value)); }catch{ resolve(null); }
      } else resolve(value instanceof Blob ? value : null);
    };
    req.onerror=()=>reject(req.error);
  });
}
async function putImageBlob(wordId,blob){
  if(!(blob instanceof Blob)) throw new Error('Image blob is required');
  const db=await openDb();
  await new Promise((resolve,reject)=>{
    const tx=db.transaction(IMAGE_STORE,'readwrite');
    tx.objectStore(IMAGE_STORE).put(blob,wordId);
    tx.oncomplete=resolve;
    tx.onerror=()=>reject(tx.error);
    tx.onabort=()=>reject(tx.error||new Error('Image save aborted'));
  });
  invalidateImageUrl(wordId);
}
async function deleteImageBlob(wordId){
  const db=await openDb();
  await new Promise((resolve,reject)=>{
    const tx=db.transaction(IMAGE_STORE,'readwrite');
    tx.objectStore(IMAGE_STORE).delete(wordId);
    tx.oncomplete=resolve;
    tx.onerror=()=>reject(tx.error);
  });
  invalidateImageUrl(wordId);
}
function invalidateImageUrl(wordId){
  const old=imageUrlCache.get(wordId);
  if(old){ URL.revokeObjectURL(old); imageUrlCache.delete(wordId); }
}
async function getImageUrl(wordId){
  if(imageUrlCache.has(wordId)) return imageUrlCache.get(wordId);
  const blob=await getImageBlob(wordId);
  if(!blob) return null;
  const url=URL.createObjectURL(blob);
  imageUrlCache.set(wordId,url);
  return url;
}
async function showStoredImage(w,imgId,wrapId){
  const img=$(imgId), wrap=$(wrapId);
  if(!img || !wrap) return;
  const token=`${w?.id||'none'}-${Math.random()}`;
  img.dataset.imageToken=token;
  wrap.classList.add('hidden');
  img.removeAttribute('src');
  if(typeof w?.image==='string' && w.image.startsWith('data:image/')){
    img.src=w.image; wrap.classList.remove('hidden'); return;
  }
  if(!w?.hasImage) return;
  try{
    const url=await getImageUrl(w.id);
    if(img.dataset.imageToken!==token) return;
    if(url){ img.src=url; wrap.classList.remove('hidden'); }
  }catch(err){ console.warn('Image load failed',err); }
}
async function clearAllImages(){
  const db=await openDb();
  await new Promise((resolve,reject)=>{
    const tx=db.transaction(IMAGE_STORE,'readwrite');
    tx.objectStore(IMAGE_STORE).clear();
    tx.oncomplete=resolve;
    tx.onerror=()=>reject(tx.error);
  });
  for(const url of imageUrlCache.values()) URL.revokeObjectURL(url);
  imageUrlCache.clear();
}
async function replaceStateAndImages(newState,imageEntries){
  const clean=stateForStorage(newState);
  const db=await openDb();
  await new Promise((resolve,reject)=>{
    const tx=db.transaction([STORE_NAME,IMAGE_STORE],'readwrite');
    const images=tx.objectStore(IMAGE_STORE);
    images.clear();
    for(const [id,blob] of imageEntries) images.put(blob,id);
    tx.objectStore(STORE_NAME).put(clean,STATE_KEY);
    tx.oncomplete=resolve;
    tx.onerror=()=>reject(tx.error);
    tx.onabort=()=>reject(tx.error||new Error('Restore aborted'));
  });
  for(const url of imageUrlCache.values()) URL.revokeObjectURL(url);
  imageUrlCache.clear();
}
function newWordTemplate(){
  const now = Date.now();
  return {id:crypto.randomUUID ? crypto.randomUUID() : String(now)+Math.random(),word:'',pos:'',core:'',hasImage:false,sentenceJa:'',sentenceEn:'',alternatives:[],choices:[],correctChoice:0,connectExplanation:'',createdAt:now,updatedAt:now,stats:{level:0,nextDueAt:now,recall:{attempts:0,correct:0,streak:0,wrongStreak:0,totalMs:0,lastCorrectAt:null,lastWrongAt:null},use:{attempts:0,correct:0,almost:0},connect:{attempts:0,correct:0}}};
}
function normalizeWord(s){ return (s||'').trim().toLowerCase().replace(/[’]/g,"'"); }
function normalizeSentence(s){ return (s||'').trim().toLowerCase().replace(/[’]/g,"'").replace(/[.,!?;:\"“”]/g,'').replace(/\s+/g,' '); }
function pct(c,a){ return a ? Math.round(c/a*100) : 0; }
function fmtDue(ts){
  if(!ts) return '—'; const d = new Date(ts); const today = new Date();
  const diff = Math.ceil((startDay(d)-startDay(today))/DAY);
  if(diff < 0) return `${Math.abs(diff)}日遅れ`; if(diff===0) return '今日'; if(diff===1) return '明日'; return `${diff}日後`;
}
function startDay(d){ return new Date(d.getFullYear(),d.getMonth(),d.getDate()).getTime(); }
function escapeHtml(s){ return String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m])); }
function toast(msg){ $('toast').textContent=msg; $('toast').classList.remove('hidden'); clearTimeout(toast.t); toast.t=setTimeout(()=>$('toast').classList.add('hidden'),2200); }

function speakEnglish(text){
  if(!text || !('speechSynthesis' in window)) return;
  try{
    window.speechSynthesis.cancel();
    const utterance=new SpeechSynthesisUtterance(text);
    utterance.lang='en-US';
    utterance.rate=0.88;
    utterance.pitch=1;
    const voices=window.speechSynthesis.getVoices?.()||[];
    const voice=voices.find(v=>/^en-US$/i.test(v.lang)) || voices.find(v=>/^en-US/i.test(v.lang)) || voices.find(v=>/^en/i.test(v.lang));
    if(voice) utterance.voice=voice;
    window.speechSynthesis.speak(utterance);
  }catch(err){ console.warn('Speech synthesis failed',err); }
}


function renderAll(){ renderHome(); renderWords(); renderStats(); }
function renderHome(){
  const now=Date.now(); $('homeTotal').textContent=state.words.length; $('homeDue').textContent=state.words.filter(w=>(w.stats.nextDueAt||0)<=now).length; $('homeMastered').textContent=state.words.filter(w=>w.stats.level>=5).length; $('noWordsNotice').classList.toggle('hidden',state.words.length>0);
}
function renderWords(){
  const list=$('wordList'); list.innerHTML=''; $('wordEmpty').classList.toggle('hidden',state.words.length>0);
  [...state.words].sort((a,b)=>a.word.localeCompare(b.word)).forEach(w=>{
    const el=document.createElement('div'); el.className='word-row';
    el.innerHTML=`<div class="word-main"><strong>${escapeHtml(w.word)}</strong><small>${escapeHtml(w.pos||'')}</small></div><div class="word-core">${escapeHtml(w.core)}</div><div class="word-meta">Lv.${w.stats.level}<br>Recall ${pct(w.stats.recall.correct,w.stats.recall.attempts)}%<br>${fmtDue(w.stats.nextDueAt)}</div>`;
    el.onclick=()=>openWordDialog(w.id); list.appendChild(el);
  });
}
function renderStats(){
  const total=state.words.length, attempts=state.words.reduce((s,w)=>s+w.stats.recall.attempts,0), correct=state.words.reduce((s,w)=>s+w.stats.recall.correct,0), due=state.words.filter(w=>(w.stats.nextDueAt||0)<=Date.now()).length, mastered=state.words.filter(w=>w.stats.level>=5).length;
  $('statsSummary').innerHTML=[['登録単語',total],['Recall 正解率',`${pct(correct,attempts)}%`],['今日の復習',due],['Level 5+',mastered]].map(([l,v])=>`<div class="summary-card"><strong>${v}</strong><span>${l}</span></div>`).join('');
  $('statsTable').innerHTML=[...state.words].sort((a,b)=>(a.stats.nextDueAt||0)-(b.stats.nextDueAt||0)).map(w=>{
    const r=w.stats.recall,u=w.stats.use,c=w.stats.connect, avg=r.attempts ? (r.totalMs/r.attempts/1000).toFixed(1)+'秒':'—';
    return `<tr><td><b>${escapeHtml(w.word)}</b></td><td>${w.stats.level}</td><td>${pct(r.correct,r.attempts)}% (${r.correct}/${r.attempts})</td><td>${avg}</td><td>${pct(u.correct,u.attempts)}%</td><td>${pct(c.correct,c.attempts)}%</td><td>${fmtDue(w.stats.nextDueAt)}</td></tr>`;
  }).join('');
}

function showView(name){
  $$('.view').forEach(v=>v.classList.remove('active')); const v=$('view-'+name); if(v)v.classList.add('active');
  $$('.nav-btn').forEach(b=>b.classList.toggle('active',b.dataset.view===name));
}
$$('.nav-btn').forEach(b=>b.addEventListener('click',()=>showView(b.dataset.view)));

function weightedOrder(words){
  const now=Date.now();
  return words.map(w=>{
    const r=w.stats.recall, rate=r.attempts?r.correct/r.attempts:.35;
    const overdue=Math.max(0,(now-(w.stats.nextDueAt||now))/DAY);
    const slow=r.attempts?r.totalMs/r.attempts/1000:8;
    const score=10+Math.min(30,overdue*2)+(1-rate)*25+(7-w.stats.level)*3+Math.min(8,slow/2)+(Math.random()*8);
    return {w,key:Math.pow(Math.random(),1/Math.max(1,score))};
  }).sort((a,b)=>b.key-a.key).map(x=>x.w);
}
function startStudy(mode){
  if(!state.words.length){ toast('先に単語を登録してください'); showView('words'); return; }
  const now=Date.now(), includeEarly=$('includeEarly').checked;
  let candidates=state.words.filter(w=>includeEarly || (w.stats.nextDueAt||0)<=now);
  if(!candidates.length){ toast('今日の復習対象はありません。「復習日前も追加練習」をONにできます。'); return; }
  candidates=weightedOrder(candidates);
  const size=$('sessionSize').value; if(size!=='all') candidates=candidates.slice(0,Number(size));
  session={mode, queue:candidates.map(w=>w.id), index:0, initialCount:candidates.length, completed:0, currentId:null, recallStart:0, requeued:{}};
  $('studyModeLabel').textContent= mode==='recall'?'⚡ 単語集中':mode==='recall-use'?'🔹 標準学習':'🔥 深掘り学習';
  showView('study'); nextWord();
}
$$('.mode-card').forEach(b=>b.addEventListener('click',()=>startStudy(b.dataset.mode)));
$('quitStudy').onclick=()=>{ session=null; showView('home'); renderAll(); };

function getWord(id){ return state.words.find(w=>w.id===id); }
function updateStudyProgress(){
  if(!session)return; $('studyProgress').textContent=`${Math.min(session.completed+1,session.queue.length)} / ${session.queue.length}`; const p=session.queue.length?session.completed/session.queue.length*100:0; $('progressBar').style.width=`${p}%`;
}
function nextWord(){
  if(!session)return;
  if(session.index>=session.queue.length){ finishSession(); return; }
  session.currentId=session.queue[session.index++]; updateStudyProgress(); showRecall(getWord(session.currentId));
}
function finishSession(){
  $('progressBar').style.width='100%'; $('studyCard').innerHTML=`<div style="text-align:center;padding:32px"><div style="font-size:48px">✅</div><h2>今日の学習完了</h2><p style="color:#667085">${session.completed}件の学習を終えました。</p><button id="backHomeAfter" class="primary-btn">学習画面へ戻る</button></div>`; $('backHomeAfter').onclick=()=>location.reload();
}
function hideStages(){ ['recallStage','fixationStage','useStage','connectStage'].forEach(id=>$(id).classList.add('hidden')); }
function showRecall(w){
  hideStages();
  $('recallStage').classList.remove('hidden');
  $('stageBadge').classList.add('hidden');
  $('coreText').textContent=w.core;
  $('recallInput').value='';
  $('recallFeedback').className='feedback hidden';
  showStoredImage(w,'coreImage','coreImageWrap');
  if((w.pos||'').trim()){
    $('recallPos').textContent=w.pos.trim();
    $('recallPos').classList.remove('hidden');
  } else {
    $('recallPos').textContent='';
    $('recallPos').classList.add('hidden');
  }
  session.recallStart=performance.now();
  setTimeout(()=>$('recallInput').focus(),100);
}
function gradeRecall(w,ok,userInput=''){
  if(!session || !w)return;
  const elapsed=Math.max(200,performance.now()-session.recallStart);
  const r=w.stats.recall;
  r.attempts++;
  r.totalMs+=elapsed;
  if(ok){
    r.correct++; r.streak++; r.wrongStreak=0; r.lastCorrectAt=Date.now();
    w.stats.level=Math.min(7,(w.stats.level||0)+1);
    w.stats.nextDueAt=Date.now()+LEVEL_DAYS[w.stats.level]*DAY;
    saveState(); showFixation(w,true);
  } else {
    r.streak=0; r.wrongStreak++; r.lastWrongAt=Date.now();
    w.stats.level=Math.max(0,(w.stats.level||0)-2);
    w.stats.nextDueAt=Date.now();
    scheduleRetry(w.id);
    saveState(); showFixation(w,false,userInput);
  }
}
$('recallForm').addEventListener('submit',e=>{
  e.preventDefault();
  if(!session)return;
  const w=getWord(session.currentId);
  const input=$('recallInput').value;
  if(!input.trim())return;
  gradeRecall(w,normalizeWord(input)===normalizeWord(w.word),input);
});
$('dontKnowBtn').addEventListener('click',()=>{
  if(!session)return;
  const w=getWord(session.currentId);
  gradeRecall(w,false,'');
});
function scheduleRetry(id){
  if(!session)return; const already=session.requeued[id]||0; if(already>=2)return; session.requeued[id]=already+1; const gap=5+Math.floor(Math.random()*6); const insertAt=Math.min(session.queue.length,session.index+gap); session.queue.splice(insertAt,0,id); updateStudyProgress();
}
function showFixation(w,wasCorrect,userInput=''){
  hideStages();
  $('fixationStage').classList.remove('hidden');
  $('stageBadge').classList.remove('hidden');
  $('stageBadge').textContent=wasCorrect?'✅ 正解':'❌ 不正解';
  $('fixWord').textContent=w.word;
  $('fixCore').textContent=w.core;
  if((w.sentenceEn||'').trim()){
    $('fixSentence').textContent=w.sentenceEn.trim();
    $('fixSentenceWrap').classList.remove('hidden');
  } else {
    $('fixSentence').textContent='';
    $('fixSentenceWrap').classList.add('hidden');
  }
  showStoredImage(w,'fixImage','fixImageWrap');
  $('replayAudio').onclick=()=>speakEnglish(w.word);
  speakEnglish(w.word);
  $('fixNext').textContent = wasCorrect ? ((session.mode==='recall')?'次の単語':'次へ') : '次の単語';
  $('fixNext').onclick=()=>{
    if(!wasCorrect || session.mode==='recall'){ completeCurrent(); return; }
    if(session.mode==='recall-use' || session.mode==='full'){
      if(w.sentenceJa && w.sentenceEn) showUse(w); else if(session.mode==='full' && hasConnect(w)) showConnect(w); else completeCurrent();
    }
  };
}
function completeCurrent(){ session.completed++; saveState(); nextWord(); }

function showUse(w){
  hideStages(); $('useStage').classList.remove('hidden'); $('stageBadge').classList.remove('hidden'); $('stageBadge').textContent='2️⃣ USE'; $('useTarget').textContent=w.word; $('sentenceJa').textContent=w.sentenceJa; $('useInput').value=''; $('useFeedback').className='feedback hidden'; setTimeout(()=>$('useInput').focus(),100);
}
$('useForm').addEventListener('submit',e=>{
  e.preventDefault(); const w=getWord(session.currentId), ans=$('useInput').value.trim(); if(!ans)return; const u=w.stats.use; u.attempts++;
  const accepted=[w.sentenceEn,...(w.alternatives||[])].filter(Boolean).map(normalizeSentence); const exact=accepted.includes(normalizeSentence(ans)); const hasTarget=normalizeSentence(ans).includes(normalizeWord(w.word));
  if(exact){ u.correct++; saveState(); showUseFeedback(w,'good','✅ 正解です。',true); }
  else if(hasTarget){ u.almost++; saveState(); showUseFeedback(w,'warn',`🟡 ターゲット単語は使えています。<br><b>模範：</b> ${escapeHtml(w.sentenceEn)}<br>意味が通っているなら「正解扱い」にできます。`,false,true); }
  else { saveState(); showUseFeedback(w,'bad',`❌ ターゲット単語 <b>${escapeHtml(w.word)}</b> を適切に使ってみましょう。<br><b>模範：</b> ${escapeHtml(w.sentenceEn)}`,false,false); }
});
function showUseFeedback(w,type,html,autoNext=false,selfJudge=false){
  const f=$('useFeedback'); f.className='feedback '+type; f.innerHTML=html;
  const actions=document.createElement('div'); actions.className='feedback-actions';
  if(selfJudge){
    const yes=document.createElement('button'); yes.className='primary-btn'; yes.textContent='正解扱い'; yes.onclick=()=>{w.stats.use.correct++;saveState(); afterUse(w)}; actions.appendChild(yes);
    const no=document.createElement('button'); no.className='ghost-btn'; no.textContent='不正解として進む'; no.onclick=()=>afterUse(w); actions.appendChild(no);
  } else {
    const next=document.createElement('button'); next.className='primary-btn'; next.textContent='次へ'; next.onclick=()=>afterUse(w); actions.appendChild(next);
  }
  f.appendChild(actions);
}
function afterUse(w){ if(session.mode==='full' && hasConnect(w)) showConnect(w); else completeCurrent(); }
function hasConnect(w){ return Array.isArray(w.choices) && w.choices.filter(Boolean).length>=2 && Number.isInteger(w.correctChoice) && w.choices[w.correctChoice]; }

function showConnect(w){
  hideStages(); $('connectStage').classList.remove('hidden'); $('stageBadge').classList.remove('hidden'); $('stageBadge').textContent='3️⃣ CONNECT'; $('connectCore').textContent=w.core; $('connectFeedback').className='feedback hidden'; $('connectFeedback').dataset.answered='0'; const list=$('choiceList'); list.innerHTML='';
  w.choices.forEach((choice,i)=>{ if(!choice)return; const b=document.createElement('button'); b.className='choice-btn'; b.textContent=choice; b.onclick=()=>answerConnect(w,i,b); list.appendChild(b); });
}
function answerConnect(w,i,button){
  if($('connectFeedback').dataset.answered==='1')return; $('connectFeedback').dataset.answered='1'; const c=w.stats.connect; c.attempts++; const ok=i===w.correctChoice; if(ok)c.correct++;
  $$('#choiceList .choice-btn').forEach((b,idx)=>{ if(idx===w.correctChoice)b.classList.add('correct'); else if(idx===i)b.classList.add('wrong'); b.disabled=true; }); saveState();
  const f=$('connectFeedback'); f.className='feedback '+(ok?'good':'bad'); f.innerHTML=`${ok?'✅ 正解です。':'❌ 正解は <b>'+escapeHtml(w.choices[w.correctChoice])+'</b> です。'}${w.connectExplanation?'<br>'+escapeHtml(w.connectExplanation):''}`;
  const a=document.createElement('div');a.className='feedback-actions';const n=document.createElement('button');n.className='primary-btn';n.textContent='次の単語';n.onclick=()=>{f.dataset.answered='0';completeCurrent()};a.appendChild(n);f.appendChild(a);
}

async function openWordDialog(id=null){
  const w=id?getWord(id):newWordTemplate();
  cleanupPendingPreview();
  pendingImageMode=id?'unchanged':'remove';
  pendingImageBlob=null;
  $('wordId').value=id||'';
  $('fieldImage').value='';
  $('dialogTitle').textContent=id?'単語を編集':'単語を追加';
  $('fieldWord').value=w.word;
  $('fieldPos').value=w.pos;
  $('fieldCore').value=w.core;
  $('fieldSentenceJa').value=w.sentenceJa;
  $('fieldSentenceEn').value=w.sentenceEn;
  $('fieldAlternatives').value=(w.alternatives||[]).join('\n');
  $('fieldConnectExplanation').value=w.connectExplanation||'';
  renderConnectEditor(w.choices||[],w.correctChoice||0);
  $('deleteWordBtn').classList.toggle('hidden',!id);
  hideImagePreview();
  $('wordDialog').showModal();
  if(id && typeof w.image==='string' && w.image.startsWith('data:image/')){
    showImagePreview(w.image);
  }else if(id && w.hasImage){
    try{
      const url=await getImageUrl(w.id);
      if($('wordId').value===id && pendingImageMode==='unchanged' && url) showImagePreview(url);
    }catch(err){ console.warn('Preview image load failed',err); }
  }
}
$('addWordBtn').onclick=()=>openWordDialog();
$('closeDialog').onclick=()=>{cleanupPendingPreview();$('wordDialog').close();};
$('cancelWord').onclick=()=>{cleanupPendingPreview();$('wordDialog').close();};
$('fieldImage').addEventListener('change',async e=>{
  const file=e.target.files?.[0];
  if(!file)return;
  try{
    const blob=await compressImage(file);
    cleanupPendingPreview();
    pendingImageBlob=blob;
    pendingImageMode='replace';
    pendingPreviewUrl=URL.createObjectURL(blob);
    showImagePreview(pendingPreviewUrl);
  }catch(err){ console.error(err); toast('画像を読み込めませんでした'); }
});
function compressImage(file){
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onerror=reject;
    reader.onload=()=>{
      const img=new Image();
      img.onerror=reject;
      img.onload=()=>{
        const max=1200, scale=Math.min(1,max/Math.max(img.width,img.height));
        const canvas=document.createElement('canvas');
        canvas.width=Math.max(1,Math.round(img.width*scale));
        canvas.height=Math.max(1,Math.round(img.height*scale));
        const ctx=canvas.getContext('2d');
        // White background keeps transparent PNGs predictable after JPEG conversion.
        ctx.fillStyle='#fff'; ctx.fillRect(0,0,canvas.width,canvas.height);
        ctx.drawImage(img,0,0,canvas.width,canvas.height);
        canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('画像圧縮に失敗しました')),'image/jpeg',0.82);
      };
      img.src=reader.result;
    };
    reader.readAsDataURL(file);
  });
}
function cleanupPendingPreview(){
  if(pendingPreviewUrl){ URL.revokeObjectURL(pendingPreviewUrl); pendingPreviewUrl=null; }
}
function hideImagePreview(){
  $('imagePreview').removeAttribute('src');
  $('imagePreview').classList.add('hidden');
  $('removeImage').classList.add('hidden');
}
function showImagePreview(src){
  $('imagePreview').src=src;
  $('imagePreview').classList.remove('hidden');
  $('removeImage').classList.remove('hidden');
}
$('removeImage').onclick=()=>{
  cleanupPendingPreview();
  pendingImageBlob=null;
  pendingImageMode='remove';
  $('fieldImage').value='';
  hideImagePreview();
};
function renderConnectEditor(choices=[],correct=0){ const ed=$('connectEditor'); ed.innerHTML=''; const arr=choices.length?choices:['','']; arr.slice(0,6).forEach((c,i)=>addChoiceRow(c,i===correct)); }
function addChoiceRow(value='',checked=false){ const ed=$('connectEditor'); if(ed.children.length>=6){toast('選択肢は最大6個です');return;} const row=document.createElement('div'); row.className='connect-choice-row'; row.innerHTML=`<input type="radio" name="correctChoice" ${checked?'checked':''} aria-label="正解"><input type="text" class="choiceText" value="${escapeHtml(value)}" placeholder="選択肢"><button type="button" class="icon-btn">×</button>`; row.querySelector('.icon-btn').onclick=()=>row.remove(); ed.appendChild(row); }
$('addChoice').onclick=()=>addChoiceRow();
$('wordForm').addEventListener('submit',async e=>{
  e.preventDefault();
  const id=$('wordId').value;
  const isNew=!id;
  let w=id?getWord(id):newWordTemplate();
  w.word=$('fieldWord').value.trim();
  w.pos=$('fieldPos').value.trim();
  w.core=$('fieldCore').value.trim();
  if(!w.word||!w.core){toast('英単語とコアイメージは必須です');return;}
  w.sentenceJa=$('fieldSentenceJa').value.trim();
  w.sentenceEn=$('fieldSentenceEn').value.trim();
  w.alternatives=$('fieldAlternatives').value.split('\n').map(x=>x.trim()).filter(Boolean);
  w.connectExplanation=$('fieldConnectExplanation').value.trim();
  const rows=[...$('connectEditor').children];
  w.choices=rows.map(r=>r.querySelector('.choiceText').value.trim()).filter(Boolean);
  const checkedRow=rows.find(r=>r.querySelector('input[type=radio]').checked);
  const checkedValue=checkedRow?.querySelector('.choiceText').value.trim();
  w.correctChoice=Math.max(0,w.choices.indexOf(checkedValue));
  w.updatedAt=Date.now();

  try{
    if(pendingImageMode==='replace' && pendingImageBlob){
      await putImageBlob(w.id,pendingImageBlob);
      w.hasImage=true;
    }else if(pendingImageMode==='remove'){
      if(!isNew) await deleteImageBlob(w.id);
      w.hasImage=false;
    }
    if(isNew) state.words.push(w);
    await persistStateNow();
    renderAll();
    cleanupPendingPreview();
    $('wordDialog').close();
    toast(id?'更新しました':'登録しました');
  }catch(err){
    console.error('Word save failed',err);
    toast('保存に失敗しました。画像またはブラウザ容量をご確認ください。');
  }
});
$('deleteWordBtn').onclick=async()=>{
  const id=$('wordId').value;
  if(!id)return;
  if(confirm('この単語を削除しますか？')){
    try{
      await deleteImageBlob(id);
      state.words=state.words.filter(w=>w.id!==id);
      await persistStateNow();
      renderAll();
      cleanupPendingPreview();
      $('wordDialog').close();
      toast('削除しました');
    }catch(err){ console.error(err); toast('削除に失敗しました'); }
  }
};


function normalizeImportPack(data){
  if(!data || !Array.isArray(data.words)) throw new Error('words がありません');
  return data.words.map(raw=>({
    word:String(raw.word||'').trim(),
    pos:String(raw.pos||'').trim(),
    core:String(raw.core||'').trim(),
    imageData:(typeof raw.image==='string' && raw.image.startsWith('data:image/')) ? raw.image : null,
    sentenceJa:String(raw.sentenceJa||'').trim(),
    sentenceEn:String(raw.sentenceEn||'').trim(),
    alternatives:Array.isArray(raw.alternatives)?raw.alternatives.map(x=>String(x).trim()).filter(Boolean):[],
    choices:Array.isArray(raw.choices)?raw.choices.map(x=>String(x).trim()).filter(Boolean).slice(0,6):[],
    correctChoice:Number.isInteger(raw.correctChoice)?raw.correctChoice:0,
    connectExplanation:String(raw.connectExplanation||'').trim()
  })).filter(w=>w.word && w.core);
}
function resetBulkImportUi(){
  pendingBulkData=null;
  $('bulkImportInput').value='';
  $('bulkImportPanel').classList.add('hidden');
  $('bulkImportPreview').innerHTML='';
  $('runBulkImport').disabled=true;
}
function chooseBulkImportFile(){
  // Reset first so choosing the same file again still triggers change.
  $('bulkImportInput').value='';
  $('bulkImportInput').click();
}
$('bulkImportBtn').addEventListener('click', chooseBulkImportFile);
$('chooseBulkImportAgain').addEventListener('click', chooseBulkImportFile);
$('closeBulkImport').addEventListener('click', resetBulkImportUi);
$('bulkImportInput').addEventListener('change',e=>{
  const file=e.target.files?.[0]; if(!file)return;
  const reader=new FileReader();
  reader.onload=()=>{
    try{
      const data=JSON.parse(reader.result);
      const words=normalizeImportPack(data);
      if(!words.length) throw new Error('登録できる単語がありません');
      pendingBulkData={...data,words};
      const withImages=words.filter(w=>w.imageData).length;
      const withUse=words.filter(w=>w.sentenceJa && w.sentenceEn).length;
      const withConnect=words.filter(w=>w.choices.length>=2 && w.choices[w.correctChoice]).length;
      $('bulkImportPreview').innerHTML=`<strong>${words.length}語を読み込みました</strong><div class="bulk-counts"><span>🖼️ 画像 ${withImages}</span><span>2️⃣ USE ${withUse}</span><span>3️⃣ CONNECT ${withConnect}</span></div><div class="bulk-preview-list">${words.map(w=>escapeHtml(w.word)+(w.pos?` <small>(${escapeHtml(w.pos)})</small>`:'')).join(' / ')}</div>`;
      $('bulkImportPanel').classList.remove('hidden');
      $('runBulkImport').disabled=false;
    }catch(err){
      console.error(err); pendingBulkData=null; $('runBulkImport').disabled=true;
      $('bulkImportPreview').innerHTML='<strong>読み込めませんでした</strong><div class="bulk-preview-list">Word Recall用の一括登録JSONか確認してください。</div>';
      $('bulkImportPanel').classList.remove('hidden');
    }
  };
  reader.onerror=()=>{
    pendingBulkData=null; $('runBulkImport').disabled=true;
    $('bulkImportPreview').innerHTML='<strong>ファイルを読み込めませんでした</strong>';
    $('bulkImportPanel').classList.remove('hidden');
  };
  reader.readAsText(file);
});
$('runBulkImport').onclick=async()=>{
  if(!pendingBulkData)return;
  const mode=document.querySelector('input[name="duplicateMode"]:checked')?.value||'update';
  let added=0,updated=0,skipped=0;
  $('runBulkImport').disabled=true;
  try{
    for(const raw of pendingBulkData.words){
      const existing=state.words.find(w=>normalizeWord(w.word)===normalizeWord(raw.word));
      if(existing && mode==='skip'){ skipped++; continue; }
      const w=existing||newWordTemplate();
      w.word=raw.word; w.pos=raw.pos; w.core=raw.core;
      w.sentenceJa=raw.sentenceJa; w.sentenceEn=raw.sentenceEn; w.alternatives=raw.alternatives;
      w.choices=raw.choices; w.correctChoice=Math.min(Math.max(0,raw.correctChoice),Math.max(0,raw.choices.length-1));
      w.connectExplanation=raw.connectExplanation; w.updatedAt=Date.now();
      // Image-less update packs preserve an image that the user already registered.
      if(raw.imageData){
        await putImageBlob(w.id,dataUrlToBlob(raw.imageData));
        w.hasImage=true;
      }
      if(existing) updated++; else { state.words.push(w); added++; }
    }
    await persistStateNow();
    renderAll();
    const msg=`一括登録：追加 ${added}語 / 更新 ${updated}語${skipped?` / スキップ ${skipped}語`:''}`;
    resetBulkImportUi(); toast(msg);
  }catch(err){
    console.error('Bulk import failed',err);
    $('runBulkImport').disabled=false;
    toast('一括登録に失敗しました。ファイルまたは保存容量をご確認ください。');
  }
};

$('exportBtn').onclick=async()=>{
  const btn=$('exportBtn');
  const old=btn.textContent;
  btn.disabled=true; btn.textContent='書き出し中…';
  try{
    const backup=stateForStorage();
    for(const w of backup.words){
      const source=getWord(w.id);
      if(typeof source?.image==='string' && source.image.startsWith('data:image/')){
        w.image=source.image;
        w.hasImage=true;
        continue;
      }
      if(!w.hasImage) continue;
      const blob=await getImageBlob(w.id);
      if(blob) w.image=await blobToDataUrl(blob);
    }
    const blob=new Blob([JSON.stringify(backup,null,2)],{type:'application/json'});
    const a=document.createElement('a');
    a.href=URL.createObjectURL(blob);
    a.download=`word-recall-backup-${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    setTimeout(()=>URL.revokeObjectURL(a.href),1000);
  }catch(err){ console.error(err); toast('バックアップの作成に失敗しました'); }
  finally{ btn.disabled=false; btn.textContent=old; }
};
$('importInput').addEventListener('change',e=>{
  const file=e.target.files?.[0]; if(!file)return;
  const reader=new FileReader();
  reader.onload=async()=>{
    try{
      const data=JSON.parse(reader.result);
      if(!Array.isArray(data.words))throw new Error();
      if(!confirm('現在のデータをバックアップ内容で置き換えますか？')){ e.target.value=''; return; }
      const restored=migrate(data);
      const entries=[];
      for(const w of restored.words){
        if(typeof w.image==='string' && w.image.startsWith('data:image/')){
          entries.push([w.id,dataUrlToBlob(w.image)]);
          w.hasImage=true;
        }else{
          // A portable backup should carry its images. If none is embedded, treat it as image-less.
          w.hasImage=false;
        }
        delete w.image;
      }
      await replaceStateAndImages(restored,entries);
      state=stateForStorage(restored);
      renderAll();
      toast(`復元しました（画像 ${entries.length}枚）`);
    }catch(err){ console.error(err); alert('有効なバックアップファイルではありません'); }
    e.target.value='';
  };
  reader.readAsText(file);
});
$('resetBtn').onclick=async()=>{
  if(!confirm('本当に全データを削除しますか？この操作は元に戻せません。')) return;
  try{
    const empty=defaultState();
    await replaceStateAndImages(empty,[]);
    state=empty;
    renderAll();
    toast('全データを削除しました');
  }catch(err){ console.error(err); toast('全データ削除に失敗しました'); }
};


async function init(){
  state=await loadState();
  renderAll();
  if(migrationWarning) setTimeout(()=>toast('画像移行が途中です。データは保持されています。空き容量を確保して再読み込みしてください。'),250);
  else if(migratedImageCount>0) setTimeout(()=>toast(`既存画像 ${migratedImageCount}枚を安全に分離保存しました`),250);
}
init();
