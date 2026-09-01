'use strict';

// Word Recall v0.6 UI enhancement patch
// - Word list sorting: alphabet / registration order / Recall accuracy
// - Ascending / descending toggle
// - Larger, easier-to-tap next buttons after answers

(() => {
  const SORT_PREF_KEY = 'wordRecall.wordSort.v05';
  const DEFAULT_SORT = { key: 'alpha', dir: 'asc' };

  function loadSortPref(){
    try{
      const saved = JSON.parse(localStorage.getItem(SORT_PREF_KEY) || 'null');
      if(saved && ['alpha','created','accuracy'].includes(saved.key) && ['asc','desc'].includes(saved.dir)) return saved;
    }catch(_){ }
    return {...DEFAULT_SORT};
  }

  function saveSortPref(pref){
    try{ localStorage.setItem(SORT_PREF_KEY, JSON.stringify(pref)); }catch(_){ }
  }

  const wordSort = loadSortPref();

  function recallRate(w){
    const r = w?.stats?.recall || {};
    return r.attempts ? (r.correct || 0) / r.attempts : 0;
  }

  function compareWords(a,b){
    let result = 0;

    if(wordSort.key === 'created'){
      const aTime = Number(a.createdAt || 0);
      const bTime = Number(b.createdAt || 0);
      result = aTime - bTime;
      if(result === 0){
        const ai = state.words.findIndex(w => w.id === a.id);
        const bi = state.words.findIndex(w => w.id === b.id);
        result = ai - bi;
      }
    }else if(wordSort.key === 'accuracy'){
      result = recallRate(a) - recallRate(b);
    }else{
      result = String(a.word || '').localeCompare(String(b.word || ''), 'en', {sensitivity:'base'});
    }

    if(result === 0 && wordSort.key !== 'alpha'){
      result = String(a.word || '').localeCompare(String(b.word || ''), 'en', {sensitivity:'base'});
    }

    return wordSort.dir === 'desc' ? -result : result;
  }

  function directionText(){
    if(wordSort.key === 'alpha') return wordSort.dir === 'asc' ? '↑ A → Z' : '↓ Z → A';
    if(wordSort.key === 'created') return wordSort.dir === 'asc' ? '↑ 古い → 新しい' : '↓ 新しい → 古い';
    return wordSort.dir === 'asc' ? '↑ 低い → 高い' : '↓ 高い → 低い';
  }

  function syncSortControls(){
    const select = document.getElementById('wordSortKey');
    const toggle = document.getElementById('wordSortDirection');
    if(select) select.value = wordSort.key;
    if(toggle){
      toggle.textContent = directionText();
      toggle.setAttribute('aria-label', `並び順を反転。現在は${directionText().replace(/[↑↓]/g,'').trim()}`);
    }
  }

  // Replace the original alphabetical-only renderer while keeping the same row design.
  renderWords = function(){
    const list = $('wordList');
    list.innerHTML = '';
    $('wordEmpty').classList.toggle('hidden', state.words.length > 0);

    [...state.words].sort(compareWords).forEach(w => {
      const el = document.createElement('div');
      el.className = 'word-row';
      el.innerHTML = `<div class="word-main"><strong>${escapeHtml(w.word)}</strong><small>${escapeHtml(w.pos||'')}</small></div><div class="word-core">${escapeHtml(w.core)}</div><div class="word-meta">Lv.${w.stats.level}<br>Recall ${pct(w.stats.recall.correct,w.stats.recall.attempts)}%<br>${fmtDue(w.stats.nextDueAt)}</div>`;
      el.onclick = () => openWordDialog(w.id);
      list.appendChild(el);
    });
  };

  const sortKey = document.getElementById('wordSortKey');
  const sortDirection = document.getElementById('wordSortDirection');

  if(sortKey){
    sortKey.addEventListener('change', () => {
      wordSort.key = sortKey.value;
      saveSortPref(wordSort);
      syncSortControls();
      renderWords();
    });
  }

  if(sortDirection){
    sortDirection.addEventListener('click', () => {
      wordSort.dir = wordSort.dir === 'asc' ? 'desc' : 'asc';
      saveSortPref(wordSort);
      syncSortControls();
      renderWords();
    });
  }

  // Styling is injected here so the existing styles.css does not need to be replaced.
  const style = document.createElement('style');
  style.textContent = `
    .word-sort-bar{
      display:flex;
      align-items:center;
      gap:10px;
      flex-wrap:wrap;
      margin:-4px 0 16px;
      padding:12px 14px;
      background:#fff;
      border:1px solid var(--line);
      border-radius:14px;
    }
    .word-sort-label{
      font-size:13px;
      font-weight:800;
      color:#344054;
      white-space:nowrap;
    }
    .word-sort-select{
      min-height:44px;
      border:1px solid #d0d5dd;
      border-radius:11px;
      background:#fff;
      color:var(--text);
      padding:9px 36px 9px 12px;
      font:inherit;
      font-weight:700;
    }
    #wordSortDirection{
      min-height:44px;
      min-width:132px;
    }
    #fixNext{
      display:block;
      width:min(100%,560px);
      min-height:56px;
      margin:24px auto 0;
      padding:16px 28px;
      font-size:17px;
    }
    .feedback-actions>.primary-btn:only-child{
      min-width:min(100%,320px);
      min-height:52px;
      padding:14px 24px;
    }
    @media (max-width:640px){
      .word-sort-bar{align-items:stretch;}
      .word-sort-label{width:100%;}
      .word-sort-select{flex:1;min-width:0;}
      #wordSortDirection{flex:1;}
      #fixNext{width:100%;}
    }
  `;
  document.head.appendChild(style);

  syncSortControls();
})();
