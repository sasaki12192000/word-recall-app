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
  return {id:crypto.randomUUID ? crypto.randomUUID() : String(now)+Math.random(),word:'',pos:'',core:'',hasImage:false,sentenceJa:'',sentenceEn:'',clozeJaTarget:'',clozeSentence:'',clozeAnswer:'',alternatives:[],choices:[],correctChoice:0,connectExplanation:'',createdAt:now,updatedAt:now,stats:{level:0,nextDueAt:now,recall:{attempts:0,correct:0,streak:0,wrongStreak:0,totalMs:0,lastCorrectAt:null,lastWrongAt:null},use:{attempts:0,correct:0,almost:0},connect:{attempts:0,correct:0}}};
}
function normalizeWord(s){ return (s||'').trim().toLowerCase().replace(/[’]/g,"'"); }
const BUILTIN_CLOZE_JA_TARGETS = Object.freeze({"gauge":"圧力計","for instance":"たとえば","have repaired":"スマホを修理してもらった","microscope":"顕微鏡","go wrong with":"おかしくなった","practical":"実用的な","subject":"科目","academic":"学問的な","geometry":"幾何学","concept":"基本的な考え方","focus on":"に集中した","chapter":"1章","barrel":"樽","tiny":"小さかった","multiply":"かけ算で求めた","volume":"体積","calculate":"計算した","learn by heart":"内容を暗記した","formula":"公式","definition":"定義","visible":"見えます","naked eye":"肉眼","barely":"ぎりぎり","particle":"粒子","minute":"ごく小さな","barometer":"気圧計","thermometer":"温度計","precise":"正確に","call for":"必要だ","above all":"何よりも","valid":"有効です","premise":"前提","whether":"かどうか","think over":"よく考えて","ought to do":"謝るべきだ","handwriting":"字","terrible":"ひどい","apart from":"彼を除いて","desire":"強い願望","mad":"激怒した","bet":"賭けた","deadline":"締め切り","meet":"会った","what if":"もし","i have my hands full":"手いっぱいです","turn in":"提出した","look over":"目を通した","a piece of cake":"とても簡単だった","leave it to me":"私に任せて","complicated":"複雑すぎる","deal with":"対処する","to the point":"要点を突いていた","concise":"簡潔","essay":"小論文","obscure":"はっきり見えなかった","theme":"テーマ","to begin with":"まず最初に","make sense":"意味がわかった","thesis":"修士論文","flunk":"落ちた","diligent":"勤勉な","anything but":"静かどころではなかった","no later than":"遅くとも","assignment":"課題","hand in":"提出して","time will tell":"時間が経てばわかる","just wait and see":"まあ見てて","be supposed to":"ことになっています","beat around the bush":"遠回しに言わないで","isolated":"孤立している","stubborn":"頑固だ","at one's disposal":"自由に使える","property":"私有地","enormous":"ものすごく高かった","claim":"主張している","turn away":"追い返した","frown":"眉をひそめた","compliment":"ほめてくれた","in spite of":"雨にもかかわらず","somebody":"大物","as if":"かのように","behave":"行儀よくしていた","it's not that":"嫌いなわけじゃない","status":"現在の状況","wealth":"富","be jealous of":"うらやましい","hostile":"敵対的だった","muscle tissue":"筋肉組織","consist of":"構成されています","vast":"非常に多くの","substance":"物質","mostly":"ほとんど","compose":"構成されています","oxygen":"酸素","hydrogen":"水素","exact":"正確な","temperature":"気温","degree celsius":"20度","show off":"見せびらかす","figure":"スタイル","thin":"細かった","envy":"うらやましく思った","go on a diet":"ダイエットを始めます","at first sight":"初めて見た瞬間に","take a chance":"思い切って","turn down":"断った","by chance":"偶然","gentle":"優しくて","what's more":"おまけに","nephew":"おい","bring up":"育てられた","modest":"控えめで","considerate":"思いやりのある","folks":"人たち","take to":"好きになりました","at once":"すぐに","judge":"判断されるべきです","not so much a as b":"見た目よりも、その人がどんな人間かによって","how a look":"見た目","who i am":"どんな人間か","it is a that":"肩書きではない","title":"肩書き","count":"大事なのは","for sure":"絶対","exclaim":"声を上げた","as he put it":"彼の言い方を借りれば","self-made":"自力で成功した","of a":"非常に硬く美しい性質","vision":"先見の明","make good":"成功しました","in the end":"結局","keep in mind":"心に留めておいてください","youth":"若さ","eternal":"永遠","figure out":"どうしてもわかりません","on earth":"いったいなぜ","contempt for":"軽蔑","can't help doing":"笑わずにはいられません","laugh at":"彼を笑わずには","keep on doing":"繰り返す","stupid":"ばかな","make a mistake":"ばかなミスを繰り返す","the last person to do":"ような人ではまずない","learn one's lesson":"教訓を学ぶ","to make matters worse":"さらに悪いことに","be conscious of":"気づいていない","annoy":"いら立たせている","get away with":"罰を受けずに済みました","as for":"私について言えば","suspend":"停学処分になりました","cheat":"カンニングしている","turn a blind eye":"見て見ぬふりをしました","bully":"いじめていました","on purpose":"わざと","skip":"抜きました","ignore":"無視しました","be against":"反対です","since":"急いでいるので","be in a hurry":"急いでいる","put on":"着て","glove":"手袋","by mistake":"間違えて","inside out":"裏返しに","fat":"太りました","clumsy":"不器用で","leap":"飛び越えました","shallow":"浅い","stream":"小川","stumble":"つまずいて","twist":"ひねりました","ankle":"足首","be scared of":"怖い","height":"高いところ","coward":"臆病","passive":"消極的","seldom":"めったに","express":"表現できません","in public":"人前で","convince":"納得させる","superstition":"迷信","irrational":"非合理的","tremble":"震えます","fear":"恐怖","at the thought of":"考えると","injection":"注射","lazy":"怠け者","at heart":"心の底では","frequently":"しばしば","neglect":"怠ります","duty":"仕事","at work":"仕事中","be absorbed in":"夢中になっていました","silly":"くだらない","soap opera":"昼ドラ","think much of a":"あまり高く評価していません","as a matter of fact":"実を言うと","boring":"退屈","cartoon":"アニメ","it occurs to":"ふと思いました","hold back":"涙をこらえようとしました","look a in the eye":"目を見て","wouldn't":"聞こうとしませんでした","patience":"我慢","give out":"尽きました","grab":"つかみました","collar":"襟","swear at":"罵りました","admit":"認めました","quarrel":"口論しました","now and then":"時々","generally":"たいてい","be on good terms with":"仲が良い","do you mind if":"てもいいですか","not at all":"もちろん、構いませんよ","be my guest":"どうぞ、遠慮なく","hold on":"ちょっと待って","hang up":"電話を切らないで","respect":"尊重","will":"意志","assure you that":"本当にすべてうまくいきますよ","turn out":"分かりました","let go of":"手放した","maintain":"維持する","attitude":"態度","fair":"公平な","regardless of":"関係なく","national origin":"国籍的な出自","creed":"信条","equality":"平等","guarantee":"保障しています","constitution":"憲法","lean against":"もたれかかり","pillar":"柱","gaze at":"じっと見つめました","statue":"像","liberty":"自由","pass by":"そばを通り過ぎた","give off":"放っています","subtle":"ほのかな","scent":"香り","perfume":"香水","it reminds me of":"思い出します","awful":"最悪","terrific":"素晴らしかった","soaked with":"びっしょり","sweat":"汗","stink":"臭いました","be beside oneself":"我を忘れていました","scarcely":"ほとんど","can tell a from b":"見分ける","fact":"事実","fiction":"作り話","combine a with b":"組み合わせています","prose":"散文","gift for":"才能","poetry":"詩","up to date":"最新","edition":"版","encyclopedia":"百科事典","come out":"発売されます","fascinating":"とても面白くて","fairy tale":"おとぎ話","plain":"シンプルな","passage":"一節","quote":"引用しました","well-known":"よく知られた","fable":"寓話","abundant":"豊富に","cut in":"割り込まないで","after all":"結局","bear":"もたらしました","revolution":"革命","content":"内容","privilege":"特権","abuse":"乱用しました","aristocrat":"貴族","destiny":"運命","alter":"変更する","be anxious to":"始めたがっています","slave":"奴隷","phase":"段階","crucial":"極めて重要な","before long":"まもなく","be under way":"進行中","little":"ほとんど","disarmament":"軍縮","make progress":"進展しています","significant":"大きな","prospect":"見込み","shelter":"雨宿りできる場所","seek":"求めました","abolish":"廃止しました","monarchy":"君主制","financial":"財政","developing country":"発展途上国","provide":"提供しています","parliament":"議会","risk":"リスク","desperate":"必死","turn one's back on":"見捨てませんでした","earnest":"真剣に","deregulation":"規制緩和","sweeping":"広範囲にわたる","undertake":"実施する","competitiveness":"競争力","keep up":"ついていく","in order to":"ために","regulation":"規制","in short":"要するに","crisis":"危機","unprecedented":"前例のない","be faced with":"直面しています","value":"高く評価しています","abandon":"放棄しました","development":"発展","in the course of":"過程で","manufactured goods":"工業製品","raw materials":"原材料","various":"さまざまな","invest":"投資しました","discourage":"やる気をなくしました","a number of":"いくつもの","aggressive":"攻撃的な","resent":"腹を立てていました","get down to":"取りかかりましょう","so much for":"おしまいだね","inherit":"相続しました","be particular about":"こだわりがあります","as long as":"なら","will do":"大丈夫です","auditorium":"講堂","come to":"意識を取り戻しました","fatigue":"疲労","hunger":"空腹","faint":"気を失いました","thirst":"喉の渇き","be dying of":"たまらない","shade":"木陰","outlook":"考え方","brief":"短い","intense":"激しい","can afford":"買う余裕がありません","as it is":"そのままで","compensate":"補償しました","entitle":"無料で入場できます","somewhat":"多少","differ":"異なります","view":"考え","let alone":"おろか","apply":"応募しました","next to":"ほとんど不可能","overcome":"克服しました","possess":"持っています","chore":"雑用","sit back":"何もしないで見ているだけ","plunge into":"全力で取り組み始めました","blow up":"爆破されました","wisdom":"知恵","admire":"尊敬しています","flatter":"お世辞を言いました","obstacle":"障害","familiar":"聞き覚えがあります","contemporary":"現代","literature":"文学","at times":"たまに","confuse":"混同します","curve":"カーブしています","carve":"彫りました","more or less":"だいたい","pronunciation":"発音","correct":"正しい","contain":"入っています","tip":"コツ","those who":"人","eager":"始めたくてたまりません","increase":"増やしました","vocabulary":"語彙","work":"作品","be on display":"展示されています","fabulous":"素晴らしかった","beyond description":"言葉では言い表せない","move over":"席を詰めて","realize":"気づきました","take up":"場所を取りすぎます","ugly":"醜く","object":"物","abstract":"抽象的","beg":"頼み込みました","shake one's head":"首を横に振りました","be broke":"お金がありません","be apt to":"しがちです","on impulse":"衝動的に","so am i":"私もです","whenever":"いつでも","ordinary":"普通","purchase":"購入しました","luxury":"高級感のある","anticipate":"予想しています","in a row":"連続で","cut down on":"減らそう","expense":"出費","from now on":"これからは","keep track of":"把握する","on a daily basis":"毎日","in any case":"いずれにせよ","union":"労働組合","compromise":"妥協案","to a certain extent":"ある程度","competent":"有能な","mechanic":"整備士","be in demand":"需要があります","earn":"稼いでいます","decent":"まずまずの","wages":"賃金","concrete":"具体的な","carry out":"実行する","welfare":"福祉","reform":"改革","policy":"政策","no doubt":"きっと","lead to":"つながりました","consequence":"結果","thorough":"徹底的な","review":"見直す","dismal":"ひどい","it goes without saying that":"言うまでもありません","aging":"高齢化","society":"社会","inevitable":"避けられません","take a look at":"見てみて","chart":"図","indicate":"示しています","juvenile":"少年","delinquency":"非行","be on the increase":"増加傾向にあります","at an alarming rate":"驚くべき速さで","district":"地区","vacant":"空いている","be for sale":"売りに出されています","for years":"何年もの間","population":"人口","density":"密度","metropolis":"大都市","gradually":"徐々に","decrease":"減っています","in all likelihood":"おそらく","birth rate":"出生率","continue to decline":"低下し続ける","steadily":"着実に","for years to come":"今後何年にもわたって","power plant":"発電所","supply a with b":"遠く離れた地域に電力を供給しています","remote":"遠く離れた","county":"郡","electricity":"電力","be allowed to do":"操作できます","operate":"操作","device":"装置","permission":"許可","inhabitant":"住民","inhabit":"生息しています","expose a to b":"さらしてはいけません","radiation":"放射線","worry":"心配","concern":"懸念","suggest":"提案します","propose":"提案しました","recommend":"おすすめします","efficient":"効率的","effective":"効果的","emphasize":"強調","potential":"潜在的な","danger":"危険性","nuclear":"原子力","energy":"エネルギー","press":"報道機関","overlook":"見落として","if anything":"どちらかといえば","make too much of":"大げさに考えない","as well as":"だけでなく","cultivate":"栽培されています","grain":"穀物","farmer":"農家","run":"経営しています","grocery store":"食料品店","institute":"研究所","foundation":"財団","establish":"設立されました","why don't you":"してみたらどうですか","consult":"相談","in person":"直接","by far":"断然","prominent":"著名な","attorney":"弁護士","write it down":"書き留めて","just in case":"念のため","client":"依頼人","legal":"法的","take action":"行動を起こす","insurance":"保険","against":"反対","be entitled to":"権利がある","compensate for":"補えません","injury":"けが","so far":"これまでのところ","no less than":"なんと500人もの","die of":"インフルエンザで亡くなりました","flu":"インフルエンザ","epidemic":"大流行","effect":"効果","pill":"一錠","have a habit of":"癖があります","bite":"噛んで","nail":"爪","absolutely":"本当に","disgusting":"気持ち悪い","strain":"背中を痛めました","bend":"曲げて","hug":"抱きしめました","light on the cheese":"チーズは少なめ","heavy on the cheese":"チーズは多め","insult":"侮辱しました","no matter what":"何があっても","unlimited":"無制限に","sort of":"ちょっと","as soon as":"たらすぐに","this is way more than":"よりずっと多い","run out of":"なくなってしまいました","depend on":"次第","at least":"最低でも","on a work assignment":"仕事の赴任で","special rates for long-term stays":"長期滞在向けの特別料金","before making a decision":"決断する前に","an idea of the monthly rate":"月額料金のだいたいの目安","any flexibility on the rate":"料金に少し融通","miss out":"経験を逃したく","fulfilling life":"充実した人生","the day before the test":"テストの前日","apply for":"応募しました","apply to":"適用されます","agree with":"賛成","agree on":"合意しました","look for":"探しています","look into":"調査します","deal in":"取り扱っています","hear about":"について聞きました","hear from":"から連絡がありました","think about":"について少し考えます","think of":"思いつきました","work on":"に取り組んでいます","ask for":"上司に助けを求めました","ask about":"について尋ねました","care for":"世話をしています","care about":"大切にしています","work well together":"一緒に仕事をするとうまくいく","thanks in advance for your help":"あらかじめ感謝します","actual expense":"実際にかかった費用","alongside":"と一緒に","oversee":"統括しています","go with this plan":"この案で進めましょう","make the final decision":"最終判断","progress":"進捗","delay":"遅れ","on schedule":"予定通り","behind schedule":"予定より2週間遅れ","complete":"完了","pending":"保留中","on the right track":"予定通り完了できるペースで進んでいます","issue":"問題","cause":"原因","root cause":"根本原因","countermeasure":"対策","corrective action":"是正処置","preventive action":"予防処置","impact":"影響","report back to me":"私に報告してください","reject":"却下しました","accept":"受け入れました","proceed":"進めましょう","hold":"止めて","postpone":"延期","urgent":"緊急の","handle":"対応します","commit":"約束します","meet the deadline":"締切に間に合わせる","miss the deadline":"締切に間に合いません","keep me updated":"進捗を共有してください","responsibility":"責任","authority":"権限","delegate":"任せます","retain":"保持します","arrange":"手配して","execute":"実行","manage":"調整","drive":"主導","own":"責任を持って担当","prioritize":"優先","streamline":"簡素化","escalate":"上位者に報告して判断を仰ぎます","deliver":"成果を出します","align":"認識をそろえましょう","spearhead":"主導しました","accelerate":"速めます","leverage":"最大限に活用","secure":"確保しました","resolve":"解決しました","unblock":"停滞を解消","pivot":"方向転換しました","ship":"リリースしました","close":"契約をまとめました","champion":"積極的に推進しました","negotiate":"交渉して","overhaul":"抜本的に見直しました","scale":"規模へ広げる","consolidate":"統合しました","mobilize":"動員しました","challenge":"疑問を呈したい","mentor":"指導しています","navigate":"うまく乗り切りました","exceed":"上回りました","stiff":"こわばっています","herbal":"ハーブ","remedy":"家庭療法","medical":"医療","breakthrough":"大きな進展","bring about":"もたらす","benefit":"役に立つ","humanity":"人類","as a whole":"全体","forbid":"禁止しています","technique":"手法","human beings":"人間","whale":"クジラ","classify":"分類します","mammal":"哺乳類","theory":"理論","evolution":"進化論","beyond the reach of":"解明できない領域","biologist":"生物学者","be proud of":"誇りに思っています","historic":"歴史的な","discovery":"発見","boast about":"自慢しています","on ethical grounds":"倫理上の理由で","be opposed to":"反対しています","so-called":"いわゆる","gene":"遺伝子","therapy":"療法","initial":"最初の","symptom":"症状","disease":"病気","fever":"高熱","sore":"痛みます","throat":"喉","structure":"構造","brain":"脳","complex":"複雑な","owing to":"のため","illness":"病気","representative":"代表者","be absent from":"欠席しました","annual":"年次","conference":"会議","little by little":"少しずつ","son in law":"娘の夫","recover from":"から順調に回復","stomach":"おなか","cancer":"がん","be in good spirits":"明るく元気","fake":"偽物","genuine":"本物","antique":"アンティーク","no way":"まさか","rug":"ラグ","including":"含めて","look good on":"よく似合っています","try on":"試着して","be in":"流行っています","get out of":"から降りました","cab":"タクシー","in haste":"慌てて","keep the change":"お釣りは取っておいて","be available":"空いている","slight extra charge":"少し追加料金","treat someone":"ごちそうします","split":"割り勘","hang out":"ぶらぶらしました","run into":"偶然会いました","be short of":"足りません","withdraw":"引き出しました","deposit":"預け入れました","bank account":"銀行口座","on my way home":"家に帰る途中","be robbed of":"ハンドバッグを奪われました","purse":"ハンドバッグ","odd":"変だな","tell me":"教えてください","how it happened":"どうやって起きたのか","explain it to you":"あなたに説明します","curfew":"門限","as a punishment":"罰として","break a promise":"約束を破りました","as the proverb goes":"ことわざにもあるように","the end justifies the means":"目的が手段を正当化する","now that":"なのだから","i have found that":"ことがわかりました","there is no one to turn to":"頼れる人が誰もいません","stand on my own two feet":"自分の力で生活できる","chairman":"議長","cut me off":"話を遮りました","time to wind things up":"会議を終える時間","take a vote":"採決しましょう","exchange frank opinions":"率直な意見を交わしました","consensus":"合意","have yet to be reached":"まだ達成されていません","regarding":"について","matter":"件","disagree with":"賛成できません","be on your side":"あなたの味方です","strictly speaking":"厳密に言えば","differ from":"異なります","go over":"詳細を説明します","make out":"理解できませんでした","be getting at":"言おうとしている","back you up":"支持します","eventually":"最終的には","talk him into":"説得して","go along with":"賛成して","perseverance":"粘り強く","courage":"勇気","you flatter me":"褒めすぎですよ","in making a decision":"決定をする際に","rely on":"頼りにします","not a but b":"直感ではなく論理","logic":"論理","instinct":"直感","come up with":"考え出しました","ingenious":"巧妙な","sensible":"賢明な","solution":"解決策","immediately":"すぐに","put it into practice":"実際にやってみましょう","from an objective viewpoint":"客観的な視点から","the former":"前者","the latter":"後者","be inferior to":"劣っています","idea":"考え","sound":"良さそう","marvelous":"素晴らしかった","in theory":"理論上","yet":"ですが","in practice":"実際には","intend":"つもりです"});

function applyBuiltInClozeJaTargets(source=state){
  let changed=0;
  for(const w of (source.words||[])){
    if((w.clozeJaTarget||'').trim()) continue;
    const target=BUILTIN_CLOZE_JA_TARGETS[normalizeWord(w.word)];
    if(target && (w.sentenceJa||'').includes(target)){
      w.clozeJaTarget=target;
      changed++;
    }
  }
  return changed;
}
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
    el.innerHTML=`<div class="word-main"><strong>${escapeHtml(w.word)}</strong><small>${escapeHtml(w.pos||'')}</small></div><div class="word-core">${escapeHtml(w.core)}</div><div class="word-meta">Lv.${w.stats.level}<br>Sentence ${pct(w.stats.recall.correct,w.stats.recall.attempts)}%<br>${fmtDue(w.stats.nextDueAt)}</div>`;
    el.onclick=()=>openWordDialog(w.id); list.appendChild(el);
  });
}
function renderStats(){
  const total=state.words.length, attempts=state.words.reduce((s,w)=>s+w.stats.recall.attempts,0), correct=state.words.reduce((s,w)=>s+w.stats.recall.correct,0), due=state.words.filter(w=>(w.stats.nextDueAt||0)<=Date.now()).length, mastered=state.words.filter(w=>w.stats.level>=5).length;
  $('statsSummary').innerHTML=[['登録単語',total],['Sentence 正解率',`${pct(correct,attempts)}%`],['今日の復習',due],['Level 5+',mastered]].map(([l,v])=>`<div class="summary-card"><strong>${v}</strong><span>${l}</span></div>`).join('');
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
  let candidates=state.words.filter(w=>(mode!=='cloze' || (w.sentenceJa && w.sentenceEn)) && (includeEarly || (w.stats.nextDueAt||0)<=now));
  if(!candidates.length){ toast('今日の復習対象はありません。「復習日前も追加練習」をONにできます。'); return; }
  candidates=weightedOrder(candidates);
  const size=$('sessionSize').value; if(size!=='all') candidates=candidates.slice(0,Number(size));
  session={mode, queue:candidates.map(w=>w.id), index:0, initialCount:candidates.length, completed:0, currentId:null, recallStart:0, requeued:{}};
  $('studyModeLabel').textContent= mode==='cloze'?'⌨️ 文脈タイピング':mode==='recall'?'⚡ 単語集中':mode==='recall-use'?'🔹 標準学習':'🔥 深掘り学習';
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
  session.currentId=session.queue[session.index++]; updateStudyProgress(); const w=getWord(session.currentId); if(session.mode==='cloze') showCloze(w); else showRecall(w);
}
function finishSession(){
  $('progressBar').style.width='100%'; $('studyCard').innerHTML=`<div style="text-align:center;padding:32px"><div style="font-size:48px">✅</div><h2>今日の学習完了</h2><p style="color:#667085">${session.completed}件の学習を終えました。</p><button id="backHomeAfter" class="primary-btn">学習画面へ戻る</button></div>`; $('backHomeAfter').onclick=()=>location.reload();
}
function hideStages(){ ['clozeStage','recallStage','fixationStage','useStage','connectStage'].forEach(id=>$(id).classList.add('hidden')); }
function getClozeData(w){
  const manualSentence=(w.clozeSentence||'').trim();
  const manualAnswer=(w.clozeAnswer||'').trim();
  if(manualSentence && manualAnswer) return {sentence:manualSentence,answer:manualAnswer,manual:true};
  const full=(w.sentenceEn||'').trim();
  const target=(w.word||'').trim();
  if(full && target){
    const fullNorm=full.toLowerCase().replace(/[’]/g,"'");
    const targetNorm=target.toLowerCase().replace(/[’]/g,"'");
    const i=fullNorm.indexOf(targetNorm);
    if(i>=0) return {sentence:full.slice(0,i)+'______'+full.slice(i+target.length),answer:full.slice(i,i+target.length),manual:false};
  }
  // Safety fallback for old cards that have not received the migration pack yet.
  // After importing the v0.7 migration pack, all existing cards use explicit cloze data.
  return {sentence:'______',answer:full||target,manual:false};
}
function renderClozeJapanese(w){
  const el=$('clozeJa');
  const sentence=(w.sentenceJa||w.core||'').trim();
  const target=(w.clozeJaTarget||'').trim();
  if(target && sentence.includes(target)){
    const i=sentence.indexOf(target);
    el.innerHTML=escapeHtml(sentence.slice(0,i))+'<span class="cloze-ja-target">'+escapeHtml(target)+'</span>'+escapeHtml(sentence.slice(i+target.length));
    return;
  }
  el.textContent=sentence;
}
function showCloze(w){
  hideStages();
  $('clozeStage').classList.remove('hidden');
  $('stageBadge').classList.add('hidden');
  const c=getClozeData(w);
  renderClozeJapanese(w);
  $('clozeSentence').textContent=c.sentence;
  $('clozeInput').value='';
  $('clozeFeedback').className='feedback hidden';
  $('clozeFeedback').innerHTML='';
  $('clozeSubmitBtn').textContent='判定（Enter）';
  $('clozeDontKnowBtn').classList.remove('hidden');
  showStoredImage(w,'clozeImage','clozeImageWrap');
  session.clozeAnswered=false;
  session.recallStart=performance.now();
  // iOS will not open the software keyboard before the user's first gesture.
  // Once the learner has tapped the field, however, keeping the same input
  // focused lets the keyboard stay open across answers and questions.
  setTimeout(()=>focusClozeInput(),60);
}
function focusClozeInput(){
  const input=$('clozeInput');
  if(!input)return;
  try{ input.focus({preventScroll:true}); }catch(_){ input.focus(); }
}
function showClozeResult(w,wasCorrect,userInput=''){
  const c=getClozeData(w);
  const completed=(c.sentence||'').replace(/_{3,}/,c.answer).trim() || (w.sentenceEn||'').trim();
  const f=$('clozeFeedback');
  f.className='feedback '+(wasCorrect?'good':'bad');
  const wrongLine=!wasCorrect && userInput
    ? `<div class="cloze-result-user">あなたの入力：${escapeHtml(userInput)}</div>`
    : '';
  const coreLine=(w.core||'').trim()
    ? `<div class="cloze-result-core"><span class="cloze-result-core-label">コアイメージ：</span>${escapeHtml(w.core)}</div>`
    : '';
  f.innerHTML=`<div class="cloze-result-status">${wasCorrect?'✅ 正解':'❌ 不正解'}</div>${wrongLine}<div class="cloze-result-answer">正解：<b>${escapeHtml(c.answer)}</b></div>${coreLine}<div class="cloze-result-sentence">${escapeHtml(completed)}</div><div class="cloze-result-hint">Enterでもう一度 → 次の問題</div>`;
  $('clozeSubmitBtn').textContent='次の問題（Enter）';
  $('clozeDontKnowBtn').classList.add('hidden');
  session.clozeAnswered=true;
  speakEnglish(completed||c.answer||w.word);
  // Do not hide/replace the input: losing this element's focus closes the iOS keyboard.
  requestAnimationFrame(()=>focusClozeInput());
}
$('clozeForm').addEventListener('submit',e=>{
  e.preventDefault();
  if(!session)return;
  if(session.clozeAnswered){
    completeCurrent();
    requestAnimationFrame(()=>focusClozeInput());
    return;
  }
  const w=getWord(session.currentId);
  const input=$('clozeInput').value.trim();
  if(!input)return;
  const c=getClozeData(w);
  gradeRecall(w,normalizeSentence(input)===normalizeSentence(c.answer),input);
});
$('clozeDontKnowBtn').addEventListener('click',()=>{
  if(!session)return;
  if(session.clozeAnswered)return;
  gradeRecall(getWord(session.currentId),false,'');
  requestAnimationFrame(()=>focusClozeInput());
});
// Prevent tapping the two cloze buttons from stealing focus from the text field.
['clozeSubmitBtn','clozeDontKnowBtn'].forEach(id=>{
  $(id).addEventListener('pointerdown',e=>e.preventDefault());
});

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
    saveState();
    if(session.mode==='cloze') showClozeResult(w,true,userInput); else showFixation(w,true);
  } else {
    r.streak=0; r.wrongStreak++; r.lastWrongAt=Date.now();
    w.stats.level=Math.max(0,(w.stats.level||0)-2);
    w.stats.nextDueAt=Date.now();
    scheduleRetry(w.id);
    saveState();
    if(session.mode==='cloze') showClozeResult(w,false,userInput); else showFixation(w,false,userInput);
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
  const cloze=session?.mode==='cloze'?getClozeData(w):null;
  $('fixWord').textContent=cloze?cloze.answer:w.word;
  $('fixCore').textContent=cloze?`${w.word} — ${w.core}`:w.core;
  // In cloze mode, always reconstruct the exact sentence shown in the question.
  // This prevents the answer screen from showing a different example sentence.
  const completedClozeSentence = cloze
    ? cloze.sentence.replace(/_{3,}/, cloze.answer).trim()
    : '';
  const resultSentence = cloze
    ? (completedClozeSentence || (w.sentenceEn||'').trim())
    : (w.sentenceEn||'').trim();
  if(resultSentence){
    $('fixSentence').textContent=resultSentence;
    $('fixSentenceWrap').classList.remove('hidden');
  } else {
    $('fixSentence').textContent='';
    $('fixSentenceWrap').classList.add('hidden');
  }
  showStoredImage(w,'fixImage','fixImageWrap');
  const audioText=session?.mode==='cloze'?(resultSentence||cloze?.answer||w.word):w.word;
  $('replayAudio').onclick=()=>speakEnglish(audioText);
  speakEnglish(audioText);
  $('fixNext').textContent = session.mode==='cloze'?'次の問題':(wasCorrect ? ((session.mode==='recall')?'次の単語':'次へ') : '次の単語');
  $('fixNext').onclick=()=>{
    if(session.mode==='cloze' || !wasCorrect || session.mode==='recall'){ completeCurrent(); return; }
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
  $('fieldClozeJaTarget').value=w.clozeJaTarget||'';
  $('fieldClozeSentence').value=w.clozeSentence||'';
  $('fieldClozeAnswer').value=w.clozeAnswer||'';
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
  w.clozeJaTarget=$('fieldClozeJaTarget').value.trim();
  w.clozeSentence=$('fieldClozeSentence').value.trim();
  w.clozeAnswer=$('fieldClozeAnswer').value.trim();
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
    clozeJaTarget:typeof raw.clozeJaTarget==='string'?raw.clozeJaTarget.trim():null,
    clozeSentence:typeof raw.clozeSentence==='string'?raw.clozeSentence.trim():null,
    clozeAnswer:typeof raw.clozeAnswer==='string'?raw.clozeAnswer.trim():null,
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
      $('bulkImportPreview').innerHTML=`<strong>${words.length}語を読み込みました</strong><div class="bulk-counts"><span>🖼️ 画像 ${withImages}</span><span>⌨️ Sentence ${withUse}</span><span>3️⃣ CONNECT ${withConnect}</span></div><div class="bulk-preview-list">${words.map(w=>escapeHtml(w.word)+(w.pos?` <small>(${escapeHtml(w.pos)})</small>`:'')).join(' / ')}</div>`;
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
      w.sentenceJa=raw.sentenceJa; w.sentenceEn=raw.sentenceEn; if(raw.clozeJaTarget!==null) w.clozeJaTarget=raw.clozeJaTarget; if(raw.clozeSentence!==null) w.clozeSentence=raw.clozeSentence; if(raw.clozeAnswer!==null) w.clozeAnswer=raw.clozeAnswer; w.alternatives=raw.alternatives;
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
  // v0.7.4: Older on-device cards may already have clozeSentence/clozeAnswer
  // but not clozeJaTarget. Fill only missing Japanese targets from the bundled
  // 753-card migration map. IDs, images and learning statistics are untouched.
  const jaTargetMigrated=applyBuiltInClozeJaTargets(state);
  if(jaTargetMigrated){
    try{ await persistStateNow(); }
    catch(err){ console.warn('Japanese cloze target migration could not be persisted',err); }
  }
  renderAll();
  if(migrationWarning) setTimeout(()=>toast('画像移行が途中です。データは保持されています。空き容量を確保して再読み込みしてください。'),250);
  else if(migratedImageCount>0) setTimeout(()=>toast(`既存画像 ${migratedImageCount}枚を安全に分離保存しました`),250);
}
init();
