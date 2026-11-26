const SECTIONS=window.__BIBLIA_CATALOGO.sections;

/* JSON on demand: cache em memória e um pedido por arquivo. */
const FILE_PENDING=new Map();
async function readJson(path){
  if(!FILE_PENDING.has(path)){
    FILE_PENDING.set(path,fetch('./'+path).then(r=>{
      if(!r.ok)throw new Error('HTTP '+r.status+': '+path);
      return r.json();
    }).catch(e=>{FILE_PENDING.delete(path);throw e;}));
  }
  return FILE_PENDING.get(path);
}
async function ensureSectionLoaded(index){
  const section=SECTIONS[index];
  if(!section)throw new Error('Seção inexistente: '+index);
  if(typeof section.content==='string')return section;
  const record=await readJson(section.path);
  if(record.href!==section.href)throw new Error('Incompatibilidade de seção: '+section.href);
  section.content=record.content;
  return section;
}
async function getCrossReferenceRecord(file,anchor){
  const path=window.__BIBLIA_CATALOGO.references[file];
  if(!path)return null;
  const data=await readJson(path);
  return data?.[anchor]||null;
}
/* Letras sobrescritas por expressão: dados isolados, sem alterar o JSON bíblico. */
const INLINE_REFERENCE_BOOKS = window.__BIBLIA_CATALOGO.inlineReferenceMarkers || {};
const INLINE_REFERENCE_CACHE = new Map();
async function ensureInlineReferenceBook(book){
  const path=INLINE_REFERENCE_BOOKS[book];
  if(!path)return null;
  if(INLINE_REFERENCE_CACHE.has(book))return INLINE_REFERENCE_CACHE.get(book);
  const record=await readJson(path);
  if(record.livro!==book || !Array.isArray(record.marcadores))throw new Error('Marcadores incompatíveis: '+book);
  INLINE_REFERENCE_CACHE.set(book,record);
  return record;
}
function insertInlineReferenceMarkers(flow, section){
  const match=/^livro_(\d+)_([^/]+)\.xhtml$/i.exec(section.href||'');
  if(!match)return;
  const [_,num,book]=match;
  const record=INLINE_REFERENCE_CACHE.get(book);
  if(!record)return;
  let inserted=0;
  for(const item of record.marcadores){
    const verse=flow.querySelector('#cap_'+item.capitulo+'_v_'+item.versiculo);
    if(!verse){console.warn('Versículo ausente no marcador',book,item);continue;}
    // Apenas nós textuais diretos: nunca insere uma letra dentro do número do
    // versículo, do botão †, de uma nota ou de outra letra já inserida.
    const textNode=[...verse.childNodes].find(node => node.nodeType===Node.TEXT_NODE && node.textContent.includes(item.antes_de));
    if(!textNode){console.warn('Expressão não encontrada',book,item);continue;}
    const position=textNode.textContent.indexOf(item.antes_de);
    const remainder=textNode.splitText(position);
    const sup=document.createElement('sup');
    sup.className='inline-ref-marker';
    const a=document.createElement('a');
    a.href='referencias_'+num+'_'+book+'.xhtml#ref_'+item.capitulo+'_'+item.versiculo;
    a.dataset.inlineRefLetter=item.letra;
    a.title='Referência '+item.letra+' sobre '+item.antes_de+' ('+section.title+' '+item.capitulo+':'+item.versiculo+')';
    a.setAttribute('aria-label',a.title);
    a.textContent=item.letra;
    sup.appendChild(a);
    verse.insertBefore(sup,remainder);
    inserted++;
  }
  if(inserted!==record.marcadores.length)console.warn('Marcadores incompletos:',book,inserted,'/',record.marcadores.length);
}
async function ensureStudyBook(book){
  const path=window.__BIBLIA_CATALOGO.notes[book];
  if(!path)return null;
  if(STUDY_NOTES_CACHE.has(book))return STUDY_NOTES_CACHE.get(book);
  const data=await readJson(path);
  const result={data,map:new Map((data.notas||[]).map(entry=>[entry.id,entry]))};
  STUDY_NOTES_CACHE.set(book,result);
  return result;
}

const $=id=>document.getElementById(id);
const KEY='bibliaMiniAppARA_v1';
const hrefMap=new Map(SECTIONS.map((s,i)=>[s.href,i]));
const genesisIndex=hrefMap.get('livro_01_Gn.xhtml') ?? 2;
let current=genesisIndex,page=0,pageCount=1,pageHeight=1,pageStarts=[0],pageOriginOffset=0,readerAnchorFocus='',historyStack=[],searchTimer=null,toastTimer=null;
let chapterPickerBookIndex=null,chapterPickerReturnPosition=null;
let chapterPickerSourceIndex=null,chapterPickerMode='chapters';
let versePickerSelectedChapter=null;
let navigationHighlightedVerse=null; // Localização temporária: nunca salva no progresso ou no JSON bíblico.
let navigationHighlightFlow=null;
let navigationHighlightAncestors=[];
const selectedVerseIds=new Set();
let ignoreVerseClickUntil=0;
// Guarda a posição durante o desvio temporário do texto para sua introdução.
let introToggleReturnPosition=null;
let readerLayoutScheduled=false,readerLayoutRequested=false,readerLayoutCallbacks=[],readerLayoutEpoch=0;
let readerRenderGeneration=0;
let gestureTransitionTimer=null,gestureTransitionBusy=false,gestureTransitionToken=0;
const defaults={version:4,section:genesisIndex,page:0,pageOffset:0,anchor:'',theme:'sepia',font:20,line:1.65,bookmarks:[]};
let data={...defaults};
try{
  const raw=localStorage.getItem(KEY);
  if(raw){
    const old=JSON.parse(raw);
    data={...defaults,...old};
    if(!old.version){
      // Migra o progresso e os marcadores da versão anterior, que incluía capa e sumário técnico.
      data.section=Number(old.section)>=2?Number(old.section)-2:genesisIndex;
      data.bookmarks=(old.bookmarks||[]).map(b=>({...b,section:Number(b.section)>=2?Number(b.section)-2:genesisIndex}));
    }
    data.version=4;
    delete data.notes;
  }
}catch(e){data={...defaults};}
if(!Number.isInteger(data.section)||data.section<0||data.section>=SECTIONS.length)data.section=genesisIndex;
if(!Number.isFinite(data.page)||data.page<0)data.page=0;
data.pageOffset=0;
if(typeof data.anchor!=='string')data.anchor='';
if(!Array.isArray(data.bookmarks))data.bookmarks=[];
function persist(){try{localStorage.setItem(KEY,JSON.stringify(data));}catch(e){toast('Não foi possível salvar neste navegador.');}}
function toast(message){const el=$('toast');el.textContent=message;el.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove('show'),1900);}
function safeText(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}

let referenceOriginState = null;
let referenceFullHref = '';


// ================================================================
// NOTAS DE GENEBRA — coleção exclusiva, carregada por livro.
// O indice é carregado uma vez; comentários de outros livros só são
// descompactados em memória quando o leitor os consulta.
// ================================================================
const STUDY_NOTES_INDEX=window.__BIBLIA_NOTES_INDEX;
const STUDY_BOOK_FILES = new Map();
const STUDY_BOOK_NAMES = new Map();
for (let i = 0; i < SECTIONS.length; i++) {
  const mt = /^livro_(\d+)_([^/]+)\.xhtml$/i.exec(SECTIONS[i].href || '');
  if (mt) {
    STUDY_BOOK_FILES.set(mt[2], {href: SECTIONS[i].href, index: i});
    STUDY_BOOK_NAMES.set(mt[2], SECTIONS[i].title);
  }
}
const STUDY_ALIASES = [["Gn","Gn"],["Gênesis","Gn"],["gen","Gn"],["genesis","Gn"],["Ex","Ex"],["Êxodo","Ex"],["êx","Ex"],["exo","Ex"],["exodo","Ex"],["Lv","Lv"],["Levítico","Lv"],["lev","Lv"],["levitico","Lv"],["Nm","Nm"],["Números","Nm"],["num","Nm"],["numeros","Nm"],["Dt","Dt"],["Deuteronômio","Dt"],["deut","Dt"],["deuteronomio","Dt"],["Js","Js"],["Josué","Js"],["jos","Js"],["josue","Js"],["Jz","Jz"],["Juízes","Jz"],["jui","Jz"],["juizes","Jz"],["Rt","Rt"],["Rute","Rt"],["rut","Rt"],["1Sm","1Sm"],["1 Samuel","1Sm"],["1 sm","1Sm"],["1sam","1Sm"],["i samuel","1Sm"],["ism","1Sm"],["2Sm","2Sm"],["2 Samuel","2Sm"],["2 sm","2Sm"],["2sam","2Sm"],["ii samuel","2Sm"],["iism","2Sm"],["1Rs","1Rs"],["1 Reis","1Rs"],["1 rs","1Rs"],["1reis","1Rs"],["i reis","1Rs"],["irs","1Rs"],["2Rs","2Rs"],["2 Reis","2Rs"],["2 rs","2Rs"],["2reis","2Rs"],["ii reis","2Rs"],["iirs","2Rs"],["1Cr","1Cr"],["1 Crônicas","1Cr"],["1 cr","1Cr"],["1cron","1Cr"],["1 cronicas","1Cr"],["i crônicas","1Cr"],["icr","1Cr"],["2Cr","2Cr"],["2 Crônicas","2Cr"],["2 cr","2Cr"],["2cron","2Cr"],["2 cronicas","2Cr"],["ii crônicas","2Cr"],["iicr","2Cr"],["Ed","Ed"],["Esdras","Ed"],["esd","Ed"],["Ne","Ne"],["Neemias","Ne"],["nee","Ne"],["Et","Et"],["Ester","Et"],["est","Et"],["Jó","Jó"],["jo","Jó"],["job","Jó"],["Sl","Sl"],["Salmos","Sl"],["sal","Sl"],["salmo","Sl"],["Pv","Pv"],["Provérbios","Pv"],["prov","Pv"],["proverbios","Pv"],["Ec","Ec"],["Eclesiastes","Ec"],["ecl","Ec"],["Ct","Ct"],["Cântico dos Cânticos","Ct"],["cant","Ct"],["cânticos","Ct"],["canticos","Ct"],["cantares","Ct"],["cantares de salomão","Ct"],["cantares de salomao","Ct"],["Is","Is"],["Isaías","Is"],["isa","Is"],["isaias","Is"],["Jr","Jr"],["Jeremias","Jr"],["jer","Jr"],["Lm","Lm"],["Lamentações de Jeremias","Lm"],["lam","Lm"],["lamentações","Lm"],["lamentacoes","Lm"],["lamentacoes de jeremias","Lm"],["Ez","Ez"],["Ezequiel","Ez"],["eze","Ez"],["Dn","Dn"],["Daniel","Dn"],["dan","Dn"],["Os","Os"],["Oseias","Os"],["ose","Os"],["oséias","Os"],["Jl","Jl"],["Joel","Jl"],["joe","Jl"],["Am","Am"],["Amós","Am"],["amo","Am"],["amos","Am"],["Ob","Ob"],["Obadias","Ob"],["oba","Ob"],["Jn","Jn"],["Jonas","Jn"],["jon","Jn"],["Mq","Mq"],["Miqueias","Mq"],["miq","Mq"],["miquéias","Mq"],["Na","Na"],["Naum","Na"],["nau","Na"],["Hc","Hc"],["Habacuque","Hc"],["hab","Hc"],["Sf","Sf"],["Sofonias","Sf"],["sof","Sf"],["Ag","Ag"],["Ageu","Ag"],["age","Ag"],["Zc","Zc"],["Zacarias","Zc"],["zac","Zc"],["Ml","Ml"],["Malaquias","Ml"],["mal","Ml"],["Mt","Mt"],["Mateus","Mt"],["mat","Mt"],["Mc","Mc"],["Marcos","Mc"],["mar","Mc"],["Lc","Lc"],["Lucas","Lc"],["luc","Lc"],["João","Jo"],["Jo","Jo"],["joã","Jo"],["joao","Jo"],["At","At"],["Atos","At"],["ato","At"],["atos dos apóstolos","At"],["atos dos apostolos","At"],["Rm","Rm"],["Romanos","Rm"],["rom","Rm"],["1Co","1Co"],["1 Coríntios","1Co"],["1 co","1Co"],["1cor","1Co"],["1 corintios","1Co"],["i coríntios","1Co"],["ico","1Co"],["2Co","2Co"],["2 Coríntios","2Co"],["2 co","2Co"],["2cor","2Co"],["2 corintios","2Co"],["ii coríntios","2Co"],["iico","2Co"],["Gl","Gl"],["Gálatas","Gl"],["gal","Gl"],["galatas","Gl"],["Ef","Ef"],["Efésios","Ef"],["efe","Ef"],["efesios","Ef"],["Fp","Fp"],["Filipenses","Fp"],["fil","Fp"],["Cl","Cl"],["Colossenses","Cl"],["col","Cl"],["1Ts","1Ts"],["1 Tessalonicenses","1Ts"],["1 ts","1Ts"],["1tess","1Ts"],["i tessalonicenses","1Ts"],["its","1Ts"],["2Ts","2Ts"],["2 Tessalonicenses","2Ts"],["2 ts","2Ts"],["2tess","2Ts"],["ii tessalonicenses","2Ts"],["iits","2Ts"],["1Tm","1Tm"],["1 Timóteo","1Tm"],["1 tm","1Tm"],["1tim","1Tm"],["1 timoteo","1Tm"],["i timóteo","1Tm"],["itm","1Tm"],["2Tm","2Tm"],["2 Timóteo","2Tm"],["2 tm","2Tm"],["2tim","2Tm"],["2 timoteo","2Tm"],["ii timóteo","2Tm"],["iitm","2Tm"],["Tt","Tt"],["Tito","Tt"],["tit","Tt"],["Fm","Fm"],["Filemom","Fm"],["flm","Fm"],["filemon","Fm"],["Hb","Hb"],["Hebreus","Hb"],["heb","Hb"],["Tg","Tg"],["Tiago","Tg"],["tia","Tg"],["1Pe","1Pe"],["1 Pedro","1Pe"],["1 pe","1Pe"],["1ped","1Pe"],["i pedro","1Pe"],["ipe","1Pe"],["2Pe","2Pe"],["2 Pedro","2Pe"],["2 pe","2Pe"],["2ped","2Pe"],["ii pedro","2Pe"],["iipe","2Pe"],["1Jo","1Jo"],["1 João","1Jo"],["1 jo","1Jo"],["1joão","1Jo"],["1 joao","1Jo"],["i joão","1Jo"],["ijo","1Jo"],["2Jo","2Jo"],["2 João","2Jo"],["2 jo","2Jo"],["2joão","2Jo"],["2 joao","2Jo"],["ii joão","2Jo"],["iijo","2Jo"],["3Jo","3Jo"],["3 João","3Jo"],["3 jo","3Jo"],["3joão","3Jo"],["3 joao","3Jo"],["iii joão","3Jo"],["iiijo","3Jo"],["Jd","Jd"],["Judas","Jd"],["jud","Jd"],["Ap","Ap"],["Apocalipse","Ap"],["apo","Ap"]];
function studyNormAlias(text) {
  return String(text).normalize('NFC').toLocaleLowerCase('pt-BR').replace(/\s+/g, '');
}
const STUDY_ALIAS_MAP = new Map();
const studyAliasPhrases = [];
for (const [alias, book] of STUDY_ALIASES) {
  STUDY_ALIAS_MAP.set(studyNormAlias(alias), book);
  studyAliasPhrases.push(alias);
}
function studyReEscape(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
const STUDY_NOTES_CACHE = new Map();
let studyDrawerOrigin = null;
let studyDrawerReferenceHref = '';
let studyVisiblePassage = null;
let studyDrawerHistory = [];
function studyNoteIds(book, chapter, verse) {
  return STUDY_NOTES_INDEX.livros?.[book]?.[String(chapter)]?.[String(verse)] || [];
}
function studyLoadBook(book){
  const cached=STUDY_NOTES_CACHE.get(book);
  if(cached)return cached;
  ensureStudyBook(book).then(()=>{
    const p=studyVisiblePassage;
    if(p?.book===book && $('referenceStudyNotes'))
      $('referenceStudyNotes').innerHTML=studyBuildNoteCards(p.book,p.chapter,p.verse);
  }).catch(e=>{console.error('Falha ao carregar notas',e);toast('Notas indisponíveis no momento.');});
  return null;
}
function studyReferenceHref(book, chapter, verse) {
  const item = STUDY_BOOK_FILES.get(book);
  if (!item || !Number.isSafeInteger(chapter) || chapter < 1) return '';
  const anchor = Number.isSafeInteger(verse) && verse > 0
    ? `cap_${chapter}_v_${verse}` : `cap_${chapter}`;
  return hasAnchorInSection(item.index, anchor) ? item.href + '#' + anchor : '';
}
// V19 — interpretação contextual. Os rótulos originais nunca são reescritos.
const STUDY_BOOK_PATTERN=[...new Set(studyAliasPhrases)]
  .sort((a,b)=>b.length-a.length).map(a=>studyReEscape(a).replace(/\s+/g,'\\s*')).join('|');
const STUDY_NUMBER='[0-9]{1,3}';
const STUDY_DASH='[-–—‑]';
const STUDY_CV=STUDY_NUMBER+'\\s*[.:]\\s*'+STUDY_NUMBER;
const STUDY_RANGE='(?:\\s*'+STUDY_DASH+'\\s*(?:'+STUDY_CV+'|'+STUDY_NUMBER+'))?';
const STUDY_EXPLICIT_RE=new RegExp('(^|[^\\p{L}\\p{N}])('+STUDY_BOOK_PATTERN+')\\s*\\.?\\s+('+STUDY_CV+'|'+STUDY_NUMBER+')'+STUDY_RANGE+'(?![\\p{L}\\p{N}]|[.:]\\s*\\d|\\s*[-–—‑]\\s*\\d)','giu');
// Abreviações sem espaço (1Co15.3, Sl88.4) são aceitas se contêm capítulo e versículo.
const STUDY_COMPACT_RE=new RegExp('(^|[^\\p{L}\\p{N}])('+STUDY_BOOK_PATTERN+')\\s*('+STUDY_CV+')'+STUDY_RANGE+'(?![\\p{L}\\p{N}]|[.:]\\s*\\d|\\s*[-–—‑]\\s*\\d)','giu');
const STUDY_RELATIVE_RE=new RegExp('(^|[^\\p{L}\\p{N}])((?:vv?|caps?)\\.\\s*(?:'+STUDY_CV+'|'+STUDY_NUMBER+')'+STUDY_RANGE+'|'+STUDY_CV+STUDY_RANGE+')(?![\\p{L}\\p{N}]|[.:]\\s*\\d|\\s*[-–—‑]\\s*\\d)','giu');
const STUDY_CONT_RE=new RegExp('^([ \\t]*[,;][ \\t]*)((?:vv?|caps?)\\.\\s*(?:'+STUDY_CV+'|'+STUDY_NUMBER+')'+STUDY_RANGE+'|'+STUDY_CV+STUDY_RANGE+'|'+STUDY_NUMBER+STUDY_RANGE+')(?![\\p{L}\\p{N}]|[.:]\\s*\\d|\\s*[-–—‑]\\s*\\d)','iu');
const STUDY_SINGLE_CHAPTER=new Set(['Ob','Fm','2Jo','3Jo','Jd']);
function studyParseNumber(label,book,contextChapter=0,mode='explicit'){
  let s=label.trim(), prefix=/^(vv?|caps?)\.\s*/i.exec(s);
  if(prefix){mode=/^cap/i.test(prefix[1])?'chapter':'verse';s=s.slice(prefix[0].length);}
  const m=/^(\d{1,3})(?:\s*[.:]\s*(\d{1,3}))?(?:\s*[-–—‑]\s*(\d{1,3})(?:\s*[.:]\s*(\d{1,3}))?)?$/.exec(s);
  if(!m||!book)return null;
  let chapter,verse,endChapter,endVerse;
  if(m[2]){chapter=+m[1];verse=+m[2];}
  else if(mode==='verse'||(mode==='explicit'&&STUDY_SINGLE_CHAPTER.has(book))){chapter=mode==='verse'?contextChapter:1;verse=+m[1];}
  else{chapter=+m[1];verse=0;}
  if(m[3]){
    if(m[4]){endChapter=+m[3];endVerse=+m[4];}
    else if(verse){endChapter=chapter;endVerse=+m[3];}
    else{endChapter=+m[3];endVerse=0;}
  }else{endChapter=chapter;endVerse=verse;}
  if(!chapter||(m[2]&&verse<1)||(mode==='verse'&&verse<1)||endChapter<chapter||(endChapter===chapter&&endVerse<verse)||(m[4]&&!endVerse))return null;
  const href=studyReferenceHref(book,chapter,verse);
  if(!href||!studyReferenceHref(book,endChapter,endVerse))return null;
  return {book,chapter,verse,endChapter,endVerse,href};
}
function studyRelativeAllowed(raw,start,opts){
  if(!opts.contextBook)return false;
  const before=raw.slice(0,start);
  // Números sem nome de livro: só em contexto de citação explícito.
  const opening=Math.max(before.lastIndexOf('('),before.lastIndexOf('['));
  const closing=Math.max(before.lastIndexOf(')'),before.lastIndexOf(']'));
  const segment=opening>closing?before.slice(opening+1):before;
  if(/(?:confiss[aã]o|catecismo|artigo|se[cç][aã]o|p[aá]g(?:ina)?\.?|\bp\.)\s*(?:de\s+f[eé]\s*)?[^;()[\]]{0,40}$/i.test(segment))return false;
  return (opening>closing&&/^(?:\s|cf\.?|ver|veja|nota(?:s)?\s+(?:em|de|sobre|a|no|na)|citado de|\d|[.,;–—-])*$/i.test(segment))||/(?:\b(?:ver|veja|cf\.?|notas?\s+(?:em|de|sobre|a|no|na)))\s*$/i.test(before);
}
function studyReferenceTokens(text,opts={}){
  const raw=String(text??''),tokens=[],seeds=[];
  for(const re of [STUDY_EXPLICIT_RE,STUDY_COMPACT_RE]){
    re.lastIndex=0;
    for(const m of raw.matchAll(re)){
      const start=m.index+m[1].length,end=m.index+m[0].length;
      const alias=m[2],book=STUDY_ALIAS_MAP.get(studyNormAlias(alias));
      if(!book)continue;
      // Evita que palavras comuns como "na", "os" e "is" sejam abreviações.
      if(/^(na|os|is|at|am|ag|ex|sl|jo)$/i.test(alias)&&alias===alias.toLocaleLowerCase('pt-BR'))continue;
      if(opts.suppressAmbiguousJo&&/^Jo$/i.test(alias))continue;
      const number=raw.slice(start+alias.length,end).trim().replace(/^\.\s*/,'');
      seeds.push({start,end,ref:studyParseNumber(number,book),explicit:true});
    }
  }
  if(opts.contextBook){
    STUDY_RELATIVE_RE.lastIndex=0;
    for(const m of raw.matchAll(STUDY_RELATIVE_RE)){
      const start=m.index+m[1].length,end=m.index+m[0].length,label=m[2];
      const prefix=/^(vv?|caps?)\./i.test(label);
      if(!prefix&&!studyRelativeAllowed(raw,start,opts))continue;
      if(prefix&&/^(?:vv?)\./i.test(label)&&!opts.contextChapter)continue;
      seeds.push({start,end,ref:studyParseNumber(label,opts.contextBook,opts.contextChapter||0,'chapter'),explicit:false});
    }
  }
  seeds.sort((a,b)=>a.start-b.start||Number(b.explicit)-Number(a.explicit)||b.end-a.end);
  let cursor=0;
  function continueList(pos,ref){
    while(ref){
      const m=STUDY_CONT_RE.exec(raw.slice(pos));if(!m)break;
      const label=m[2],start=pos+m[1].length,end=start+label.length;
      const isCV=/\d\s*[.:]\s*\d/.test(label),hasPrefix=/^(?:vv?|caps?)\./i.test(label);
      // Depois de ponto e vírgula, não adivinhar o significado de número isolado.
      if(m[1].includes(';')&&!isCV&&!hasPrefix)break;
      // A vírgula herda o capítulo apenas se a referência anterior era um versículo.
      if(!isCV&&!hasPrefix&&!ref.verse)break;
      if(!isCV&&!hasPrefix&&/^\s+\p{L}/u.test(raw.slice(end)))break;
      const next=studyParseNumber(label,ref.book,ref.endChapter,isCV?'chapter':'verse');
      if(!next){pos=end;break;}
      tokens.push({...next,start,end});ref=next;pos=end;
    }
    return pos;
  }
  if(opts.previousReference)cursor=continueList(0,opts.previousReference);
  for(const seed of seeds){
    if(seed.start<cursor)continue;
    // Uma referência inválida é consumida, mas não gera herança nem links parciais.
    cursor=seed.end;if(!seed.ref)continue;
    tokens.push({...seed.ref,start:seed.start,end:seed.end});
    cursor=continueList(cursor,seed.ref);
  }
  return tokens;
}
function studyReferenceLabel(ref){
  const name=STUDY_BOOK_NAMES.get(ref.book)||ref.book;
  const start=String(ref.chapter)+(ref.verse?':'+ref.verse:'');
  const end=ref.endChapter!==ref.chapter?ref.endChapter+(ref.endVerse?':'+ref.endVerse:''):ref.endVerse!==ref.verse?ref.endVerse:'';
  return name+' '+start+(end?'–'+end:'');
}
function studyLinkedText(text,opts={}){
  const raw=String(text??'');let output='',last=0;
  for(const t of studyReferenceTokens(raw,opts)){
    output+=safeText(raw.slice(last,t.start));
    const label=safeText(raw.slice(t.start,t.end));
    const before=raw.slice(Math.max(0,t.start-65),t.start),after=raw.slice(t.end,t.end+20);
    const notesContext=/\bnotas?\s+(?:em|sobre|de|a|no|na)\s*$/i.test(before)||/^\s*[,;]?\s*notas?\b/i.test(after);
    const full=safeText(studyReferenceLabel(t));
    if(!opts.bibleOnly&&t.verse&&notesContext&&studyNoteIds(t.book,t.chapter,t.verse).length){
      output+=`<a href="#" class="study-note-internal-link" data-study-note-target="${safeText(t.book+'|'+t.chapter+'|'+t.verse)}" title="Abrir nota de estudo de ${full}">${label}</a>`;
    }else{
      output+=`<a href="${safeText(t.href)}" class="${opts.bibleOnly?'ref-biblica':'study-note-bible-link'}" title="Abrir ${full} na Bíblia">${label}</a>`;
    }
    last=t.end;
  }
  return output+safeText(raw.slice(last));
}
// Introduções/anexos: somente nós de texto, sem recriar links/elementos existentes.
function studyLinkSupportDocument(flow,section){
  const book=/^intro_livro_\d+_([^/]+)\.xhtml$/.exec(section.href)?.[1];
  for(const block of flow.querySelectorAll('p,li,td,dd,blockquote,.intro-box')){
    if(block.querySelector('p,li,td,dd,blockquote,.intro-box'))continue;
    let previous=null;
    function visit(node){
      if(node.nodeType===Node.ELEMENT_NODE){
        if(node.matches('a')){
          const parsed=normalizeInternalHref(node.getAttribute('href')||'');
          const b=/^livro_\d+_([^/]+)\.xhtml$/.exec(parsed.file)?.[1];
          const m=/^cap_(\d+)(?:_v_(\d+))?$/.exec(parsed.anchor);
          previous=b&&m?{book:b,chapter:+m[1],verse:+(m[2]||0),endChapter:+m[1],endVerse:+(m[2]||0)}:null;
          if(previous){const ts=studyReferenceTokens(node.textContent);const t=ts.at(-1);if(t&&t.book===b&&t.chapter===previous.chapter)previous=t;}
          return;
        }
        if(node.matches('script,style,code,pre,button,sup')){previous=null;return;}
        for(const child of [...node.childNodes])visit(child);return;
      }
      if(node.nodeType!==Node.TEXT_NODE)return;
      const raw=node.textContent,opts={contextBook:book,bibleOnly:true,previousReference:previous};
      const ts=studyReferenceTokens(raw,opts);
      if(ts.length){const span=document.createElement('span');span.innerHTML=studyLinkedText(raw,opts);node.replaceWith(...span.childNodes);}
      const last=ts.at(-1);previous=last&&/^\s*$/.test(raw.slice(last.end))?last:(!raw.trim()?previous:null);
    }
    visit(block);
  }
}
// O símbolo † pertence ao final do versículo, em todos os 66 livros.
// Nos JSONs antigos de 2/3João o ícone estava dentro do número do versículo;
// a correção altera apenas o DOM, nunca a fonte bíblica original.
// Quando a referência correlata existe somente no PDF novo, cria o † de forma
// não destrutiva, junto ao final do versículo (o JSON bíblico continua intacto).
function ensureInlineVerseDagger(flow, section) {
  const match=/^livro_(\d+)_([^/]+)\.xhtml$/i.exec(section.href||'');
  if(!match)return;
  const record=INLINE_REFERENCE_CACHE.get(match[2]);
  if(!record)return;
  for(const item of [...record.marcadores,...(record.versiculos_com_referencias||[])]){
    const verse=flow.querySelector('#cap_'+item.capitulo+'_v_'+item.versiculo);
    if(!verse || verse.querySelector('.ref-marker'))continue;
    const sup=document.createElement('sup'); sup.className='ref-marker';
    const a=document.createElement('a');
    a.href='referencias_'+match[1]+'_'+match[2]+'.xhtml#ref_'+item.capitulo+'_'+item.versiculo;
    a.title='Ver todas as referências cruzadas'; a.textContent='†';
    sup.appendChild(a);
    const study=verse.querySelector('.study-note-marker');
    if(study)verse.insertBefore(sup,study); else verse.appendChild(sup);
  }
}
function normalizeVerseActionPositions(flow){
  flow.querySelectorAll('.versiculo[id^="cap_"]').forEach(verse=>{
    const dagger=verse.querySelector('.ref-marker');
    if(!dagger)return;
    const study=verse.querySelector('.study-note-marker');
    if(study)verse.insertBefore(dagger,study);
    else verse.appendChild(dagger);
  });
}
function insertStudyNoteMarkers(flow, section) {
  const book = /^livro_\d+_([^/]+)\.xhtml$/i.exec(section.href || '')?.[1];
  const chapters = book && STUDY_NOTES_INDEX.livros?.[book];
  if (!chapters) return;
  flow.querySelectorAll('.versiculo[id^="cap_"]').forEach(verse => {
    const match = /^cap_(\d+)_v_(\d+)$/.exec(verse.id);
    if (!match) return;
    const ch = Number(match[1]), v = Number(match[2]);
    if (!chapters[String(ch)]?.[String(v)]?.length) return;
    const badge = document.createElement('sup');
    badge.className = 'study-note-marker';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'study-note-trigger';
    button.dataset.studyRef = `${book}|${ch}|${v}`;
    button.title = `Notas de estudo: ${section.title} ${ch}:${v}`;
    button.setAttribute('aria-label', button.title);
    button.textContent = 'ⓘ';
    badge.appendChild(button);
    verse.appendChild(badge);
  });
}
function studyOriginVerse(book, chapter, verse) {
  const sectionBook = /^livro_\d+_([^/]+)\.xhtml$/i.exec(SECTIONS[current]?.href || '')?.[1];
  if (sectionBook !== book) return null;
  const verseElement = document.getElementById(`cap_${chapter}_v_${verse}`);
  return readerFlow()?.contains(verseElement) ? verseElement : null;
}
function studySetDrawerTabs(verse, active) {
  const crossLink = verse?.querySelector('.ref-marker a[href^="referencias_"]');
  const hasStudy = !!studyDrawerOrigin && studyNoteIds(
    studyDrawerOrigin.book, studyDrawerOrigin.chapter, studyDrawerOrigin.verse).length > 0;
  const hasCross = !!crossLink;
  studyDrawerReferenceHref = hasCross ? crossLink.getAttribute('href') : '';
  const tabs = $('referenceStudyTabs');
  tabs.hidden = !(hasCross && hasStudy);
  const crossTab = $('referenceTabCross');
  const studyTab = $('referenceTabStudy');
  crossTab.hidden = !hasCross;
  studyTab.hidden = !hasStudy;
  crossTab.setAttribute('aria-selected', String(active === 'cross'));
  studyTab.setAttribute('aria-selected', String(active === 'study'));
  $('referenceCrossContent').hidden = active !== 'cross';
  $('referenceStudyContent').hidden = active !== 'study';
  $('referencePanelTitle').textContent = active === 'study' ? 'Notas de estudo' : 'Referências cruzadas';
}
function studyPrepareFromCrossReference(verse) {
  const match = /^cap_(\d+)_v_(\d+)$/.exec(verse?.id || '');
  const book = /^livro_\d+_([^/]+)\.xhtml$/i.exec(SECTIONS[current]?.href || '')?.[1];
  studyDrawerOrigin = match && book ? {book, chapter:Number(match[1]),verse:Number(match[2])} : null;
  studyDrawerHistory = [];
  studyVisiblePassage = null;
  studySetDrawerTabs(verse, 'cross');
}
// O leitor não publica nem abre páginas dos PDFs. Os números permanecem
// somente nos campos de auditoria dos JSONs e nos relatórios editoriais.
function studyDisplayWithoutPrintedPages(value){
  return String(value||'')
    // A camada de texto de alguns PDFs junta 'na p. 1204' como 'nap.1204'.
    .replace(/\bna\s*p\.?\s*\d{3,4}\b/gi,'')
    .replace(/,?\s*(?:na\s+)?p(?:á|a)g(?:ina)?\.?\s*\d{3,4}\b/gi,'')
    .replace(/,?\s*(?:na\s+)?p\.?\s*\d{3,4}\b/gi,'')
    .replace(/,?\s*na\s+página\s+anterior\b/gi,'')
    .replace(/,?\s*nesta\s+página\b/gi,'')
    .replace(/\s+([.,;:])/g,'$1')
    .replace(/,\s*\./g,'.')
    .replace(/\s{2,}/g,' ');
}
function studyPendingTitle(remission){
  return studyDisplayWithoutPrintedPages(remission?.titulo||'')
    .replace(/\s*\(\s*página\s+impressa\s+\d{3,4}\s*\)/gi,'')
    .trim();
}
// Cópia editorial: o texto integral e a localização no JSON são mantidos juntos.
function editorialCopyButton(value,label='Copiar'){
  return `<button type="button" class="editorial-copy" data-editorial-copy="${safeText(value)}" title="${safeText(label)}" aria-label="${safeText(label)}"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg><span>Copiar</span></button>`;
}
function editorialNoteCopy(book,entry,source,kind,passage){
  const isArticle=kind==='Artigo teológico';
  const title=isArticle ? entry.titulo : (STUDY_BOOK_NAMES.get(book)||book)+' '+(entry.referencia||entry.titulo||passage);
  const body=isArticle ? (Array.isArray(entry.paragrafos)&&entry.paragrafos.length ? entry.paragrafos.map(p=>typeof p==='string'?p:[p.titulo,p.texto].filter(Boolean).join(' ')).join('\n\n'):String(entry.texto||'')) : String(entry.texto||'');
  const printed=entry.origem?.pagina_impressa??entry.pagina_impressa;
  const pages=entry.origem?.paginas_pdf || (entry.origem?.pagina_pdf?[entry.origem.pagina_pdf]:[]);
  return [title,body,'— '+source+' · '+kind,printed?'Página impressa: '+printed:'',pages.length?'Página(s) PDF: '+pages.join(', '):'',entry.origem?.pdf?'PDF: '+entry.origem.pdf:'','Arquivo: '+window.__BIBLIA_CATALOGO.notes[book],'ID: '+entry.id,'Consultado em: '+passage].filter(Boolean).join('\n\n');
}
async function editorialCopyText(value){
  try{if(navigator.clipboard?.writeText){await navigator.clipboard.writeText(value);toast('Copiado');return;}}catch(e){}
  const prev=document.activeElement;
  const area=document.createElement('textarea');area.value=value;area.setAttribute('readonly','');area.style.cssText='position:fixed;left:0;top:0;opacity:0;pointer-events:none;';document.body.appendChild(area);area.select();area.setSelectionRange(0,area.value.length);
  let ok=false;try{ok=document.execCommand('copy');}catch(e){}finally{area.remove();prev?.focus?.({preventScroll:true});}
  if(ok){toast('Copiado');return;}
  // Último recurso, não anuncia sucesso sem confirmação.
  window.prompt('Selecione e copie o texto:',value);
}
function editorialReferenceCopy(path,anchor,source,marker,body,target){
  return [source,body,'— Referências correlatas · Bíblia de Estudo ARA',marker?'Marcador: '+marker:'Marcadores: todos','Arquivo: '+path,'Chave: '+anchor,target?'Destino: '+target:''].filter(Boolean).join('\n\n');
}
function studyBuildNoteCards(book, chapter, verse) {
  const ids = studyNoteIds(book, chapter, verse);
  const cached = studyLoadBook(book);
  if (!ids.length) return '<div class="reference-empty">Não há notas vinculadas a este versículo.</div>';
  if (!cached) return '<div class="reference-empty">Carregando notas…</div>';
  return ids.map((id, index) => {
    const entry = cached.map.get(id);
    if (!entry) return `<div class="reference-empty">A nota ${safeText(id)} não foi encontrada no pacote validado.</div>`;
    const rotuloFonte = cached.data.fonte?.rotulo_app || 'Genebra';
    const heading = (STUDY_BOOK_NAMES.get(book) || book) + ' ' + (entry.referencia || `${chapter}.${verse}`);
    // Artigos são documentos independentes. Só são oferecidos quando a nota original
    // explicitamente os cita: nenhuma vinculação arbitrária por proximidade de página.
    const linkedArticles=(cached.data.artigos||[]).filter(a=>(entry.remissoes||[]).includes(a.id));
    let noteText=String(entry.texto||'').split(/\n\s*\n/g).map(p=>studyDisplayWithoutPrintedPages(p)).join('\n\n');
    const remissoesPendentes = (entry.remissoes || []).map(id =>
      (cached.data.remissoes || []).find(r => r.id===id)).filter(r=>r?.status==='pendente');
    const noteChapters=new Set((entry.abrangencia||[]).map(a=>Number(a.capitulo)).filter(Boolean));
    const noteContext={contextBook:book,contextChapter:noteChapters.size>1?0:(Number(entry.capitulo)||chapter),suppressAmbiguousJo:rotuloFonte==='Fé Reformada'&&!Array.isArray(entry.paragrafos_formatados)};
    let noteMarkup=noteText.split(/\n\s*\n/g).map(p=>studyLinkedText(p,noteContext)).join('</p><p class="study-note-text">');
    // Revisão editorial V1: títulos internos em negrito, sem interpretar HTML da fonte.
    if(Array.isArray(entry.paragrafos_formatados) && entry.paragrafos_formatados.length){
      noteMarkup=entry.paragrafos_formatados.map(p=>{
        const title=p.titulo ? `<strong>${safeText(p.titulo)}</strong> ` : '';
        return title+studyLinkedText(studyDisplayWithoutPrintedPages(p.texto),noteContext);
      }).join('</p><p class="study-note-text">');
    }
    for(const article of linkedArticles){
      // Uma chamada editorial "Ver nota teológica ..." vira ligação para o próprio artigo.
      const titleRegex=new RegExp('Ver\\s+nota\\s+teol[oó]gica[^.]*'+studyReEscape(article.titulo)+'[^.]*\\.', 'i');
      if(titleRegex.test(noteText)){
        const escapedTitle=safeText(article.titulo);
        noteMarkup=noteMarkup.replace(titleRegex, 'Abrir o artigo teológico <a href="#'+safeText(article.id)+'" data-open-reformada-article="'+safeText(article.id)+'">'+escapedTitle+'</a>.');
      }
    }
    // Remissões editoriais para notas existentes e confirmadas no índice.
    const linksDeNotas = (entry.links_notas||[]).filter(r =>
      studyNoteIds(r.livro,r.capitulo,r.versiculo).length > 0).map(r =>
      `<a href="#" class="study-note-internal-link" data-study-note-target="${safeText(r.livro+'|'+r.capitulo+'|'+r.versiculo)}">${safeText((STUDY_BOOK_NAMES.get(r.livro)||r.livro)+' '+r.capitulo+':'+r.versiculo)}</a>`);
    const linksDeNotasHTML=linksDeNotas.length
      ? `<div class="study-note-actions"><strong>Notas relacionadas:</strong> ${linksDeNotas.join(' · ')}</div>` : '';
    const linksPendentes=remissoesPendentes.length
      ? `<p class="fr-pending"><strong>Material citado, ainda não incorporado:</strong> ${remissoesPendentes.map(r=>safeText(studyPendingTitle(r))).join(' · ')}</p>` : '';
    // Remissões explícitas: registros resolvidos e IDs diretos usados nas duas frentes.
    const catalogArticles=window.__BIBLIA_CATALOGO.theologicalArticles?.itens||[];
    const externalArticles=new Map();
    for(const id of entry.remissoes||[]){
      const r=(cached.data.remissoes||[]).find(item=>item.id===id);
      if(r && r.status!=='resolvida_indice_global')continue;
      const article=catalogArticles.find(a=>a.disponivel&&a.id===(r?r.artigo_id:id));
      if(!article||!article.livro||article.livro===book)continue;
      externalArticles.set(article.id,article);
    }
    const externalArticleLinks=[...externalArticles.values()]
      .map(a=>`<details class="study-note-card fr-article" data-external-article="${safeText(a.livro+'|'+a.id)}"><summary>Artigo teológico: ${safeText(a.titulo)}</summary><div class="external-article-body">Abrindo artigo…</div></details>`).join('');
    const articleBlock=linkedArticles.map(artigo=>`<details id="${safeText(artigo.id)}" class="study-note-card fr-article">
      <summary>Artigo teológico: ${safeText(artigo.titulo)}</summary>
      <div class="editorial-copy-row">${editorialCopyButton(editorialNoteCopy(book,artigo,rotuloFonte,'Artigo teológico',`${book} ${chapter}:${verse}`),'Copiar artigo teológico')}</div>
      ${(artigo.paragrafos||[]).map(p=>`<p class="study-note-text">${studyLinkedText(typeof p==='string'?p:[p.titulo,p.texto].filter(Boolean).join(' '),{suppressAmbiguousJo:rotuloFonte==='Fé Reformada'})}</p>`).join('')}
      </details>`).join('');
    return `<article class="study-note-card"><div class="study-note-card-top"><span class="study-note-number">${safeText(rotuloFonte)} · Nota ${index+1} de ${ids.length}</span><span class="study-note-reference">${safeText(heading)}</span>${editorialCopyButton(editorialNoteCopy(book,entry,rotuloFonte,'Nota de estudo',`${book} ${chapter}:${verse}`),'Copiar nota de estudo')}</div>
       <p class="study-note-text"><strong>${safeText(entry.titulo||'')}</strong> ${noteMarkup}</p>
       ${linksPendentes}${articleBlock}${externalArticleLinks}${linksDeNotasHTML}
       <div class="study-note-actions"><button type="button" data-reference-target="${safeText(studyReferenceHref(book,chapter,verse))}">Abrir versículo</button></div></article>`;
  }).join('');
}
function studyDisplayPassage(book, chapter, verse, saveHistory) {
  const ids = studyNoteIds(book, chapter, verse);
  if (!ids.length) {toast('Não há comentário de estudo para esta passagem.');return false;}
  if (saveHistory && studyVisiblePassage) studyDrawerHistory.push(studyVisiblePassage);
  studyVisiblePassage = {book, chapter, verse};
  const display = `${book} ${chapter}:${verse}`;
  $('referenceStudyHeading').textContent = `Comentários para ${display}`;
  $('referenceStudyNotes').innerHTML = studyBuildNoteCards(book, chapter, verse);
  $('referenceStudyBack').hidden = studyDrawerHistory.length === 0;
  $('referencePanelBody').scrollTop = 0;
  return true;
}
function openStudyNoteDrawer(book, chapter, verse) {
  cancelGesturePageTransition();
  if (!studyNoteIds(book, chapter, verse).length) return;
  const originVerse = studyOriginVerse(book, chapter, verse);
  studyDrawerOrigin = {book,chapter,verse};
  studyDrawerHistory = [];
  studyVisiblePassage = null;
  referenceOriginState = {
    section:current, page, anchor:`cap_${chapter}_v_${verse}`,
    label:`${book} ${chapter}:${verse}`
  };
  $('referenceOriginLabel').textContent = `${book} ${chapter}:${verse} · Texto bíblico`;
  $('referenceOriginText').textContent = originVerse
    ? cleanVerseTextFromMarkup(originVerse.outerHTML) : 'Consulte os comentários associados a esta passagem.';
  $('referenceOriginalEntry').hidden = true;
  studyDisplayPassage(book, chapter, verse, false);
  studySetDrawerTabs(originVerse, 'study');
  $('referenceBackdrop').classList.add('open');
  $('referenceBackdrop').setAttribute('aria-hidden', 'false');
  document.body.classList.add('reference-is-open');
}
function studyReturnToPreviousNote() {
  const prev = studyDrawerHistory.pop();
  if (prev) studyDisplayPassage(prev.book, prev.chapter, prev.verse, false);
}
function studyHandleReaderButton(event) {
  const button = event.target.closest('.study-note-trigger[data-study-ref]');
  if (!button) return;
  event.preventDefault();
  const [book,chapter,verse] = button.dataset.studyRef.split('|');
  openStudyNoteDrawer(book, Number(chapter), Number(verse));
}
function studyHandleDrawerControl(event) {
  const copyButton=event.target.closest('[data-editorial-copy]');
  if(copyButton){event.preventDefault();editorialCopyText(copyButton.dataset.editorialCopy);return true;}
  const articleLink=event.target.closest('[data-open-reformada-article]');
  if(articleLink){
    event.preventDefault();
    const article=$('referenceStudyNotes')?.querySelector('#'+articleLink.dataset.openReformadaArticle);
    if(article){article.open=true;article.scrollIntoView({behavior:'smooth',block:'nearest'});}
    return true;
  }
  const note = event.target.closest('[data-study-note-target]');
  if (note) {
    event.preventDefault();
    const [book,ch,verse] = note.dataset.studyNoteTarget.split('|');
    if (studyDisplayPassage(book, Number(ch), Number(verse), true)) {
      $('referencePanelTitle').textContent = 'Notas de estudo';
      $('referenceCrossContent').hidden = true;
      $('referenceStudyContent').hidden = false;
      $('referenceTabCross').setAttribute('aria-selected','false');
      $('referenceTabStudy').setAttribute('aria-selected','true');
    }
    return true;
  }
  if (event.target.closest('#referenceStudyBack')) {
    event.preventDefault();studyReturnToPreviousNote();return true;
  }
  if (event.target.closest('#referenceTabStudy')) {
    event.preventDefault();
    const origin = studyDrawerOrigin;
    if (origin && studyNoteIds(origin.book, origin.chapter, origin.verse).length) {
      studyDrawerHistory=[];
      studyDisplayPassage(origin.book,origin.chapter,origin.verse,false);
      studySetDrawerTabs(studyOriginVerse(origin.book,origin.chapter,origin.verse), 'study');
    }
    return true;
  }
  if (event.target.closest('#referenceTabCross')) {
    event.preventDefault();
    const origin = studyDrawerOrigin;
    const verse = origin ? studyOriginVerse(origin.book,origin.chapter,origin.verse) : null;
    const link = verse?.querySelector('.ref-marker a[href^="referencias_"]');
    if (link) openReferenceDrawer(link.getAttribute('href'),link);
    return true;
  }
  return false;
}


function normalizeInternalHref(href){
  const raw=String(href||'').trim();
  const parts=raw.split('#');
  let file=parts[0]||'';
  try{file=decodeURIComponent(file);}catch(_){ }
  return {file,anchor:parts.slice(1).join('#')||''};
}
function escapeRegExp(value){return String(value).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}
function cleanVerseTextFromMarkup(markup){
  const box=document.createElement('div');box.innerHTML=markup;
  box.querySelectorAll('.num-vers,.ref-marker,.study-note-marker,.inline-ref-marker').forEach(el=>el.remove());
  return (box.textContent||'').replace(/\s+/g,' ').trim();
}
function hasAnchorInSection(index,anchor){
  return !!SECTIONS[index]?.anchors?.includes(anchor);
}
function resolveReferenceAnchor(index,anchor){
  if(!anchor||index===undefined||hasAnchorInSection(index,anchor))return anchor;
  const section=SECTIONS[index];
  const match=/^cap_(\d+)$/.exec(anchor);
  if(match&&section?.chapterHeadingCount===1&&hasAnchorInSection(index,'cap_1')){
    const verseId='cap_1_v_'+match[1];
    if(hasAnchorInSection(index,verseId))return verseId;
  }
  return anchor;
}
function getReferenceExcerpt(href){
  const parsed=normalizeInternalHref(href);
  const idx=hrefMap.get(parsed.file);
  if(idx===undefined)return '';
  const content=SECTIONS[idx].content||'';
  if(!parsed.anchor)return '';
  const resolvedAnchor=resolveReferenceAnchor(idx,parsed.anchor);
  const box=document.createElement('div');
  box.innerHTML=content;
  const target=Array.from(box.querySelectorAll('[id]')).find(el=>el.id===resolvedAnchor);
  if(!target)return '';
  let text=cleanVerseTextFromMarkup(target.outerHTML);
  if(target.classList.contains('capitulo-titulo')){
    let sibling=target.nextElementSibling;
    while(sibling&&!sibling.classList.contains('capitulo-titulo')){
      const firstVerse=sibling.matches('.versiculo')?sibling:sibling.querySelector('.versiculo');
      if(firstVerse){
        const verseText=cleanVerseTextFromMarkup(firstVerse.outerHTML);
        if(verseText)text+=(text?' — ':'')+verseText;
        break;
      }
      sibling=sibling.nextElementSibling;
    }
  }
  return text.length>260?text.slice(0,257).trimEnd()+'…':text;
}
function chapterHrefFromReference(href){
  const parsed=normalizeInternalHref(href);
  const idx=hrefMap.get(parsed.file);
  const resolved=resolveReferenceAnchor(idx,parsed.anchor);
  const match=/^cap_(\d+)(?:_v_\d+)?$/.exec(resolved);
  return match?parsed.file+'#cap_'+match[1]:href;
}
async function openReferenceDrawer(href,marker){
  cancelGesturePageTransition();
  const parsed=normalizeInternalHref(href);
  const key=parsed.file+'#'+parsed.anchor;
  referenceFullHref=key;
  const requestedLetter=marker?.dataset?.inlineRefLetter || '';
  let raw;
  try{raw=await getCrossReferenceRecord(parsed.file,parsed.anchor);}
  catch(error){console.error(error);toast('Falha ao carregar referências.');return;}
  if(!raw){toast('Não foi possível localizar esta referência.');return;}
  const box=document.createElement('div');box.innerHTML=raw;
  const heading=box.querySelector('h2');
  const sourceLabel=heading?.textContent?.trim()||'Referências cruzadas';
  const verse=marker?.closest('.versiculo');
  const originText=verse?cleanVerseTextFromMarkup(verse.outerHTML):'';
  referenceOriginState={section:current,page,anchor:verse?.id||'',label:sourceLabel};
  $('referencePanelTitle').textContent='Referências cruzadas';
  $('referenceOriginLabel').textContent=sourceLabel+' · Texto de origem';
  $('referenceOriginText').textContent=originText||'Consulte as passagens relacionadas a este versículo.';
  const originals=Array.from(box.querySelectorAll('.ref-origem')).map(el=>el.textContent.trim()).filter(Boolean);
  $('referenceOriginalEntry').textContent=originals.join(' · ');
  $('referenceOriginalEntry').hidden=!originals.length;

  const allGroups=[...box.querySelectorAll('.ref-destinos')];
  // A letra NÃO pode mostrar referências gerais quando não existe um grupo
  // editorial correspondente. Essa era a falha de 1 João (a fonte anterior
  // utilizava uma única categoria genérica 'Referências:').
  const selectedLetter=requestedLetter;
  const groups=requestedLetter ? allGroups.filter(group=>{
    const heading=group.querySelector('strong')?.textContent?.replace(/\s+/g,' ').trim()||'';
    return heading.toLocaleLowerCase('pt-BR') === ('Marcador '+requestedLetter+':').toLocaleLowerCase('pt-BR');
  }) : allGroups;
  const targets=[];const seen=new Set();
  groups.forEach(group=>group.querySelectorAll('a[href]').forEach(a=>{
    const href=a.getAttribute('href')||'';const label=(a.textContent||'').trim();
    const identity=href+'|'+label;
    if(href&&label&&!seen.has(identity)){seen.add(identity);targets.push({href,label});}
  }));
  // Só extrair trechos depois que os livros de destino estiverem disponíveis.
  try{
    await Promise.all([...new Set(targets.map(t=>hrefMap.get(normalizeInternalHref(t.href).file)))]
      .filter(i=>i!==undefined).map(i=>ensureSectionLoaded(i)));
  }catch(error){console.warn('Trechos parcialmente indisponíveis',error);}
  $('referenceDestinationsTitle').textContent=targets.length?`Passagens relacionadas (${targets.length})`:'Passagens relacionadas';
  const refPath=window.__BIBLIA_CATALOGO.references[parsed.file];
  const groupText=groups.map(group=>group.textContent.trim()).join('\n');
  if(groups.length){
    $('referenceDestinationsTitle').insertAdjacentHTML('beforeend',editorialCopyButton(editorialReferenceCopy(refPath,parsed.anchor,sourceLabel,selectedLetter,[...originals,originText,groupText].filter(Boolean).join('\n\n')),'Copiar referências exibidas'));
  }

  const filterBar=$('referenceLetterFilter');
  filterBar.hidden=!selectedLetter;
  $('referenceLetterFilterLabel').textContent=selectedLetter ? 'Referência '+selectedLetter+' · '+sourceLabel : '';
  $('referenceDestinations').innerHTML=targets.length?targets.map(target=>{
    const excerpt=getReferenceExcerpt(target.href);
    const chapterHref=chapterHrefFromReference(target.href);
    const relatedGroups=groups.filter(group=>[...group.querySelectorAll('a[href]')].some(a=>a.getAttribute('href')===target.href&&a.textContent.trim()===target.label));
    const markerLabels=relatedGroups.map(group=>group.querySelector('strong')?.textContent?.trim()).filter(Boolean).join(' · ');
    const targetParsed=normalizeInternalHref(target.href), targetSection=SECTIONS[hrefMap.get(targetParsed.file)];
    let fullExcerpt=excerpt;
    if(targetSection?.content){const scratch=document.createElement('div');scratch.innerHTML=targetSection.content;const node=[...scratch.querySelectorAll('.versiculo[id]')].find(n=>n.id===targetParsed.anchor);if(node)fullExcerpt=cleanVerseTextFromMarkup(node.outerHTML);}
    const copyValue=editorialReferenceCopy(refPath,parsed.anchor,sourceLabel,selectedLetter||markerLabels,[...originals,target.label,fullExcerpt].filter(Boolean).join('\n\n'),target.href);

    return `<article class="reference-destination"><div class="reference-destination-label">${safeText(target.label)}${editorialCopyButton(copyValue,'Copiar referência')}</div>${excerpt?`<div class="reference-destination-quote">${safeText(excerpt)}</div>`:''}<div class="reference-destination-actions"><button type="button" data-reference-target="${safeText(target.href)}">Ir ao versículo</button><button type="button" data-reference-target="${safeText(chapterHref)}">Abrir capítulo</button></div></article>`;
  }).join(''):`<div class="reference-empty">${selectedLetter ? 'Ainda não foram classificadas referências para esta letra. Toque em † Ver todas para consultar o versículo completo.' : 'Esta entrada não possui passagens bíblicas relacionadas.'}</div>`;

  const noteItems=selectedLetter ? [] : Array.from(box.querySelectorAll('.ref-notas li')).map(li=>`<li>${li.innerHTML}</li>`);
  $('referenceNotes').innerHTML=noteItems.join('');
  $('referenceNotesBlock').hidden=!noteItems.length;
  studyPrepareFromCrossReference(verse);
  if(selectedLetter)$('referencePanelTitle').textContent='Referências · letra '+selectedLetter;
  $('referencePanelBody').scrollTop=0;
  $('referenceBackdrop').classList.add('open');
  $('referenceBackdrop').setAttribute('aria-hidden','false');
  document.body.classList.add('reference-is-open');
}
function closeReferenceDrawer(event){
  if(event&&event.target!==$('referenceBackdrop'))return;
  $('referenceBackdrop').classList.remove('open');
  $('referenceBackdrop').setAttribute('aria-hidden','true');
  document.body.classList.remove('reference-is-open');
  theologicalIndexRequest++;
  document.querySelector('.reference-return').textContent='← Voltar ao versículo de origem';
}
function returnToReferenceOrigin(){
  const origin=referenceOriginState;
  closeReferenceDrawer();
  if(origin&&origin.section===current&&origin.anchor)goToAnchor(origin.anchor);
}
function navigateToReference(href){
  const parsed=normalizeInternalHref(href);
  const idx=hrefMap.get(parsed.file);
  if(idx===undefined){toast('Passagem não encontrada no conteúdo deste leitor.');return;}
  historyStack.push(captureReaderPosition());
  closeReferenceDrawer();
  current=idx;page=0;renderSection(resolveReferenceAnchor(idx,parsed.anchor)||'topo');setHistoryButton();showView('reader');
}
function handleReaderInternalLink(event){
  const link=event.target.closest('a');if(!link)return;
  if(link.hasAttribute('data-open-chapter-picker')){
    event.preventDefault();openChapterPicker();return;
  }
  const href=link.getAttribute('href')||'';
  if(!href||/^(https?:|mailto:|tel:)/i.test(href))return;
  const parsed=normalizeInternalHref(href);
  if(/^referencias_[^/]+\.xhtml$/i.test(parsed.file)&&parsed.anchor){
    event.preventDefault();openReferenceDrawer(parsed.file+'#'+parsed.anchor,link);return;
  }
  const idx=parsed.file?hrefMap.get(parsed.file):current;
  if(idx!==undefined&&idx>=0){
    event.preventDefault();historyStack.push(captureReaderPosition());
    const resolvedAnchor=resolveReferenceAnchor(idx,parsed.anchor);
    if(idx===current){if(resolvedAnchor)goToAnchor(resolvedAnchor);}
    else{current=idx;page=0;renderSection(resolvedAnchor||'topo');}
    setHistoryButton();
  }else if(!parsed.file&&parsed.anchor){
    const sameAnchor=document.getElementById(parsed.anchor);
    if(sameAnchor&&$('readerContent').contains(sameAnchor)){
      event.preventDefault();historyStack.push(captureReaderPosition());goToAnchor(parsed.anchor);setHistoryButton();
    }
  }
}

function showView(view){
  document.querySelectorAll('main>section').forEach(el=>el.classList.toggle('active',el.id===view+'View'));
  document.querySelectorAll('.bottomnav button').forEach(el=>el.classList.toggle('active',el.dataset.view===view));
  if(view==='library')renderIndex();
  if(view==='chapterPicker')renderChapterPicker();
  if(view==='versePicker')renderVersePicker();
  if(view==='favorites')renderFavorites();
  if(view==='settings')syncSettings();
  if(view==='reader'){updateReaderNavigationButtons();setTimeout(layoutPages,30);}
}
function setHistoryButton(){ $('backLinkButton').hidden=historyStack.length===0; }
function openSection(index,anchor,afterLayout){
  if(index<0||index>=SECTIONS.length)return;
  historyStack=[];setHistoryButton();
  introToggleReturnPosition=null;
  current=index;page=0;renderSection(anchor,afterLayout);showView('reader');
}
function openByHref(href){const index=hrefMap.get(href);if(index!==undefined)openSection(index);}
function readerFlow(){return $('readerContent')?.querySelector('.reader-flow')||null;}
function captureReaderPosition(){
  return {section:current,page,pageOffset:0,anchor:readerAnchorFocus||''};
}
function updateHeaderChapter(){
  const label=$('sectionLabel');
  const section=SECTIONS[current];
  if(!label||!section)return;
  const flow=readerFlow();
  if(!section.href.startsWith('livro_')||!flow){
    label.textContent=section.title;
    return;
  }
  const start=pageStarts[page]??0;
  let chapter=null;
  // Selecionar o último cabeçalho que ocorre antes do início da página.
  // Assim páginas que começam no meio de um capítulo mantêm o número correto.
  for(const heading of flow.querySelectorAll('.capitulo-titulo[id^="cap_"]')){
    const top=elementTopWithinFlow(heading,flow);
    if(top>start+3)break;
    const match=/^cap_(\d+)$/.exec(heading.id);
    if(match)chapter=Number(match[1]);
  }
  if(chapter===null){
    const first=flow.querySelector('.capitulo-titulo[id^="cap_"]');
    const match=/^cap_(\d+)$/.exec(first?.id||'');
    if(match)chapter=Number(match[1]);
  }
  label.textContent=chapter?section.title+' '+chapter:section.title;
}
function updatePageLabel(){
  updateHeaderChapter();
  data.section=current;
  data.page=page;
  data.pageOffset=0;
  data.anchor=readerAnchorFocus||'';
  persist();
}
function clampReaderPage(value){
  const n=Number(value);
  return Math.max(0,Math.min(Math.max(0,pageCount-1),Number.isFinite(n)?Math.round(n):0));
}
function elementTopWithinFlow(target,flow){
  if(!target||!flow)return 0;
  const targetRect=target.getBoundingClientRect();
  const flowRect=flow.getBoundingClientRect();
  return Math.max(0,targetRect.top-flowRect.top);
}
function collectPageBreaks(flow,origin,height,total){
  // Quebras por linhas reais: não depende de um parágrafo inteiro caber na folha.
  const flowTop=flow.getBoundingClientRect().top;
  const positions=[];
  const headingSelector='.pericope,.capitulo-titulo,h1,h2,h3,h4,h5,h6';
  const isHeading=el=>el.matches(headingSelector);
  const blocks=[...flow.querySelectorAll('p,h1,h2,h3,h4,h5,h6,.pericope,.capitulo-titulo,.cap-links,li,blockquote,.intro-box,img')];
  const add=(top,kind='block')=>{
    if(Number.isFinite(top)&&top>origin+3&&top<total-2)positions.push({top,kind});
  };
  // Não deixar o título principal sozinho na primeira folha dos anexos.
  const firstTitle=flow.querySelector('h1');
  const firstLead=flow.querySelector('.intro-box')||flow.querySelector('.secao-apoio p,.secao-apoio blockquote,.secao-apoio li');
  const protectedUntil=firstTitle&&firstLead?firstLead.getBoundingClientRect().top-flowTop:origin;
  const lineTops=el=>{
    const result=[];
    const walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);
    const range=document.createRange();
    let node;
    while((node=walker.nextNode())){
      if(!node.textContent.trim())continue;
      range.selectNodeContents(node);
      for(const rect of range.getClientRects()){
        if(rect.width<.5||rect.height<.5)continue;
        const top=rect.top-flowTop;
        if(!result.some(v=>Math.abs(v-top)<2))result.push(top);
      }
    }
    range.detach?.();
    return result.sort((a,b)=>a-b);
  };
  for(let i=0;i<blocks.length;i++){
    const el=blocks[i],rect=el.getBoundingClientRect(),top=rect.top-flowTop;
    if(el===firstTitle||el.classList.contains('meta-autor'))continue;
    if(top<protectedUntil-2)continue;
    add(top,isHeading(el)?'heading':'block');
    // Mesmo parágrafos curtos podem atravessar a margem de uma folha.
    // Cada linha posterior torna-se um ponto de quebra seguro.
    if(el.matches('p,li,blockquote,.intro-box')){
      const lines=lineTops(el);
      for(let j=1;j<lines.length;j++)add(lines[j],'line');
    }
  }
  positions.sort((a,b)=>a.top-b.top);
  const unique=[];
  for(const item of positions){
    if(!unique.length||item.top-unique[unique.length-1].top>2)unique.push(item);
    else if(unique[unique.length-1].kind==='heading'&&item.kind==='line')unique[unique.length-1]=item;
  }
  const starts=[origin];
  let current=origin,guard=0;
  while(current+height<total-2&&guard++<20000){
    const target=current+height-3;
    // O candidato mais próximo do limite aproveita a área da página.
    let selected=null;
    for(const item of unique){
      if(item.top<=current+4)continue;
      if(item.top>target)break;
      selected=item;
    }
    if(!selected){
      // Segurança para elementos não quebráveis (imagens/tabelas grandes).
      starts.push(Math.min(total-1,current+height));
      current=starts[starts.length-1];
      continue;
    }
    // Um subtítulo precisa acompanhar pelo menos as primeiras linhas do texto.
    // Se o corte escolhido cair exatamente no início do próximo parágrafo,
    // verificar se a perícope anterior ficaria órfã na página atual.
    const chosen=selected.top;
    let next=chosen;
    const nextHeading=unique.find(item=>item.kind==='heading'&&item.top>current+4&&item.top<=chosen+2);
    if(nextHeading){
      const after=unique.filter(item=>item.top>nextHeading.top+3&&item.top<=target);
      const firstText=after.find(item=>item.kind==='block'||item.kind==='line');
      if(!firstText||firstText.top-nextHeading.top>height*.35||(firstText.kind==='block'&&Math.abs(firstText.top-chosen)<3&&!after.some(item=>item.kind==='line'&&item.top>firstText.top+3))){
        // Se não cabe texto suficiente depois do subtítulo, movê-lo inteiro.
        const previous=unique.filter(item=>item.top>current+4&&item.top<=nextHeading.top+1);
        if(previous.length)next=nextHeading.top;
      }
    }
    if(next<=current+3)next=Math.min(total-1,current+height);
    starts.push(next);
    current=next;
  }
  return starts;
}
function visibleHeightForPage(index,total){
  const start=pageStarts[index]??pageOriginOffset;
  const naturalEnd=pageStarts[index+1]??total;
  return Math.max(0,Math.min(pageHeight,naturalEnd-start));
}
function applyPagePosition(animate=false){
  const el=$('readerContent');
  const flow=readerFlow();
  if(!el||!flow)return;
  const start=pageStarts[page]??pageOriginOffset;
  const total=Math.max(flow.scrollHeight,flow.getBoundingClientRect().height);
  const visible=visibleHeightForPage(page,total);
  const move=()=>{
    flow.style.transition='none';
    flow.style.transform=`translate3d(0,${-start}px,0)`;
    el.style.setProperty('--reader-visible-height',visible+'px');
    void flow.offsetHeight;
    flow.style.transition='opacity .10s ease-out';
    flow.style.opacity='1';
  };
  if(animate){
    flow.style.transition='opacity .08s ease-out';
    flow.style.opacity='.72';
    requestAnimationFrame(move);
  }else{
    flow.style.transition='none';
    flow.style.opacity='1';
    flow.style.transform=`translate3d(0,${-start}px,0)`;
    el.style.setProperty('--reader-visible-height',visible+'px');
    void flow.offsetHeight;
    flow.style.transition='';
  }
}
function layoutPages(onReady){
  if(typeof onReady==='function')readerLayoutCallbacks.push(onReady);
  readerLayoutRequested=true;
  if(readerLayoutScheduled)return;
  const el=$('readerContent');
  const flow=readerFlow();
  if(!el||!flow)return;
  if(!el.clientHeight){
    requestAnimationFrame(()=>layoutPages());
    return;
  }
  readerLayoutScheduled=true;
  const epoch=++readerLayoutEpoch;
  readerLayoutRequested=false;

  requestAnimationFrame(()=>{
    if(epoch!==readerLayoutEpoch){readerLayoutScheduled=false;return;}
    if(!el.clientHeight){readerLayoutScheduled=false;requestAnimationFrame(()=>layoutPages());return;}
    // A paginação sempre começa no início do conteúdo. Links jamais alteram
    // o ponto de origem nem deslocam as quebras das páginas do mesmo livro.
    pageOriginOffset=0;
    const readingStyle=getComputedStyle(el);
    pageHeight=Math.max(1,el.clientHeight-parseFloat(readingStyle.paddingTop||0)-parseFloat(readingStyle.paddingBottom||0));
    const total=Math.max(flow.scrollHeight,flow.getBoundingClientRect().height);
    pageStarts=collectPageBreaks(flow,0,pageHeight,total);
    pageCount=Math.max(1,pageStarts.length);
    page=clampReaderPage(page);
    applyPagePosition(false);

    // Segunda medição após o navegador concluir layout, fontes e pintura.
    requestAnimationFrame(()=>{
      if(epoch!==readerLayoutEpoch){readerLayoutScheduled=false;return;}
      if(!el.clientHeight){readerLayoutScheduled=false;requestAnimationFrame(()=>layoutPages());return;}
      const readingStyleCheck=getComputedStyle(el);
      const usableHeight=el.clientHeight-parseFloat(readingStyleCheck.paddingTop||0)-parseFloat(readingStyleCheck.paddingBottom||0);
      if(Math.abs(usableHeight-pageHeight)>1){readerLayoutScheduled=false;layoutPages();return;}
      const finalTotal=Math.max(flow.scrollHeight,flow.getBoundingClientRect().height);
      pageStarts=collectPageBreaks(flow,0,pageHeight,finalTotal);
      pageCount=Math.max(1,pageStarts.length);
      page=clampReaderPage(page);
      applyPagePosition(false);
      updatePageLabel();
      readerLayoutScheduled=false;
      const callbacks=readerLayoutCallbacks.splice(0);
      callbacks.forEach(callback=>{try{callback();}catch(error){console.error('Erro ao concluir paginação:',error);}});
      if(readerLayoutRequested){readerLayoutRequested=false;layoutPages();}
    });
  });
}
function cancelGesturePageTransition(){
  gestureTransitionToken++;
  if(gestureTransitionTimer){clearTimeout(gestureTransitionTimer);gestureTransitionTimer=null;}
  const el=$('readerContent');
  if(el){el.querySelectorAll('.gesture-page-overlay').forEach(node=>node.remove());el.classList.remove('gesture-animating');}
  const flow=readerFlow();
  if(flow){flow.style.transition='';flow.style.opacity='1';flow.classList.remove('gesture-entering');}
  gestureTransitionBusy=false;
}
function turnPageByGesture(next,direction){
  clearNavigationHighlight();
  const el=$('readerContent');
  const flow=readerFlow();
  if(!el||!flow||gestureTransitionBusy)return;
  const target=clampReaderPage(next);
  if(target===page)return;

  // A cópia visual mantém a página anterior visível enquanto a nova entra
  // lateralmente. IDs são removidos para não duplicar âncoras do documento.
  const oldStart=pageStarts[page]??pageOriginOffset;
  const clone=flow.cloneNode(true);
  clone.removeAttribute('id');
  clone.querySelectorAll('[id]').forEach(node=>node.removeAttribute('id'));
  clone.querySelectorAll('a,button,input,select,textarea').forEach(node=>{
    node.setAttribute('tabindex','-1');
    node.setAttribute('aria-hidden','true');
  });
  clone.style.transition='none';
  clone.style.opacity='1';
  clone.style.transform=`translate3d(0,${-oldStart}px,0)`;

  const overlay=document.createElement('div');
  overlay.className='gesture-page-overlay';
  overlay.setAttribute('aria-hidden','true');
  overlay.appendChild(clone);
  el.appendChild(overlay);

  gestureTransitionBusy=true;
  el.classList.add('gesture-animating');
  const token=++gestureTransitionToken;
  page=target;
  readerAnchorFocus='';
  const newStart=pageStarts[page]??0;
  const total=Math.max(flow.scrollHeight,flow.getBoundingClientRect().height);
  const visible=visibleHeightForPage(page,total);
  const width=Math.max(1,el.clientWidth);
  const incomingX=direction*width;
  const outgoingX=-direction*width;

  flow.style.transition='none';
  flow.style.opacity='1';
  flow.classList.add('gesture-entering');
  flow.style.transform=`translate3d(${incomingX}px,${-newStart}px,0)`;
  el.style.setProperty('--reader-visible-height',visible+'px');
  void flow.offsetWidth;
  updatePageLabel();

  let finished=false;
  const finish=()=>{
    if(finished||token!==gestureTransitionToken)return;
    finished=true;
    if(gestureTransitionTimer){clearTimeout(gestureTransitionTimer);gestureTransitionTimer=null;}
    overlay.remove();
    el.classList.remove('gesture-animating');
    flow.style.transition='';
    flow.style.opacity='1';
    flow.classList.remove('gesture-entering');
    flow.style.transform=`translate3d(0,${-newStart}px,0)`;
    gestureTransitionBusy=false;
  };
  flow.addEventListener('transitionend',event=>{
    if(event.propertyName==='transform')finish();
  },{once:true});
  gestureTransitionTimer=setTimeout(finish,420);
  requestAnimationFrame(()=>{
    if(token!==gestureTransitionToken)return;
    flow.style.transition='transform .26s cubic-bezier(.22,.61,.36,1)';
    overlay.style.transition='transform .26s cubic-bezier(.22,.61,.36,1)';
    flow.style.transform=`translate3d(0,${-newStart}px,0)`;
    overlay.style.transform=`translate3d(${outgoingX}px,0,0)`;
  });
}

/* A dupla livro/introdução compartilha a mesma identificação no arquivo EPUB. */
function getBookIntroPair(index=current){
  const href=SECTIONS[index]?.href||'';
  const match=/^(livro_|intro_livro_)(\d{2}_[^/]+\.xhtml)$/.exec(href);
  if(!match)return null;
  const bookIndex=hrefMap.get('livro_'+match[2]);
  const introIndex=hrefMap.get('intro_livro_'+match[2]);
  if(bookIndex===undefined||introIndex===undefined)return null;
  return {bookIndex,introIndex,isIntro:match[1]==='intro_livro_'};
}
function isTopicDocument(section){
  return !!section && /^(intro_livro_|intro_bloco_|anexo_)/.test(section.href);
}
function ensureDocumentTopicAnchors(container){
  container.querySelectorAll('h2,h3,h4,h5').forEach((heading,index)=>{
    if(!heading.id)heading.id='topico_nav_'+(index+1);
  });
}
function getDocumentTopics(section){return section?.topics||[];}
function updateReaderNavigationButtons(){
  const section=SECTIONS[current];
  const pair=getBookIntroPair();
  const toggle=$('bookIntroButton');
  const chapters=$('headerChaptersButton');
  toggle.hidden=!pair;
  chapters.hidden=!(pair||isTopicDocument(section));
  if(pair){
    if(pair.isIntro){
      toggle.title='Ir para '+SECTIONS[pair.bookIndex].title;
      toggle.setAttribute('aria-label',toggle.title);
      toggle.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 7c-2.3-1.4-5.1-1.8-9-1.3v13c3.9-.5 6.7-.1 9 1.3"/><path d="M12 7c2.3-1.4 5.1-1.8 9-1.3v13c-3.9-.5-6.7-.1-9 1.3"/><path d="M12 7v13"/></svg>';
    }else{
      toggle.title='Ler introdução a '+SECTIONS[pair.bookIndex].title;
      toggle.setAttribute('aria-label',toggle.title);
      toggle.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/></svg>';
    }
  }
  if(section?.href.startsWith('livro_')){
    chapters.title='Capítulos de '+section.title;
    chapters.setAttribute('aria-label',chapters.title);
    chapters.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>';
  }else if(isTopicDocument(section)){
    chapters.title='Tópicos de '+section.title;
    chapters.setAttribute('aria-label','Navegar pelos tópicos deste documento');
    chapters.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6h12M9 12h12M9 18h12"/><path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01" stroke-width="3"/></svg>';
  }
}
function toggleBookIntroduction(){
  const pair=getBookIntroPair();
  if(!pair)return;
  cancelGesturePageTransition();
  if($('referenceBackdrop')?.classList.contains('open'))closeReferenceDrawer();
  const position=captureReaderPosition();
  let saved=null;
  if(pair.isIntro){
    if(introToggleReturnPosition?.introIndex===current){
      saved=introToggleReturnPosition.position;
    }
    introToggleReturnPosition=null;
    current=pair.bookIndex;
  }else{
    introToggleReturnPosition={introIndex:pair.introIndex,position};
    current=pair.introIndex;
  }
  historyStack.push(position);
  page=0;
  renderSection(null,saved?()=>restoreReaderPosition(saved):undefined);
  showView('reader');
  setHistoryButton();
}

async function renderSection(anchor, afterLayout){
  clearNavigationHighlight();
  cancelGesturePageTransition();
  const renderGeneration=++readerRenderGeneration;
  const section=SECTIONS[current];
  const el=$('readerContent');
  if(!section||!el)return;
  if(typeof section.content!=='string'){
    el.textContent='Carregando conteúdo…';
  }
  try{
    const book=/^livro_\d+_([^/]+)\.xhtml$/i.exec(section.href)?.[1];
    await Promise.all([ensureSectionLoaded(current),book&&window.__BIBLIA_CATALOGO.notes[book]
      ?ensureStudyBook(book):Promise.resolve(),
      book&&INLINE_REFERENCE_BOOKS[book] ? ensureInlineReferenceBook(book).catch(error=>{
        console.warn('Marcadores sobrescritos indisponíveis; botão † preservado.',error);
        return null;
      }):Promise.resolve()]);
  }catch(error){
    console.error('Falha no conteúdo',error);
    if(renderGeneration===readerRenderGeneration)el.textContent='Conteúdo não disponível. Verifique a conexão ou o download offline.';
    return;
  }
  if(renderGeneration!==readerRenderGeneration)return;
  const flow=document.createElement('div');
  flow.className='reader-flow';
  flow.innerHTML=section.content;
  // O cabeçalho reúne os atalhos: retirar os links redundantes somente na
  // apresentação, mantendo os capítulos originais em SECTIONS para o seletor.
  if(section.href.startsWith('livro_')){
    flow.querySelectorAll('.cap-links').forEach(node=>node.remove());
    const title=flow.querySelector('h1');
    const linkParagraph=title?.nextElementSibling;
    if(linkParagraph?.matches('p') &&
       linkParagraph.querySelector('a[href^="intro_livro_"]') &&
       /^\s*←?\s*Ler Introdução/.test(linkParagraph.textContent)){
      linkParagraph.remove();
    }
  }else if(section.href.startsWith('intro_livro_')){
    // "Ir para [livro]" era um atalho apenas no fim do documento.
    // Ele fica disponível no cabeçalho, em todas as páginas da introdução.
    flow.querySelectorAll('a[href^="livro_"]').forEach(link=>{
      if(/^Ir para\s/i.test(link.textContent.trim()) &&
         !link.getAttribute('href').includes('#')){
        const paragraph=link.closest('p');
        if(paragraph && paragraph.textContent.trim()===link.textContent.trim())paragraph.remove();
      }
    });
  }
  if(isTopicDocument(section)){ensureDocumentTopicAnchors(flow);studyLinkSupportDocument(flow,section);}
  insertStudyNoteMarkers(flow,section);
  insertInlineReferenceMarkers(flow,section);
  ensureInlineVerseDagger(flow,section);
  normalizeVerseActionPositions(flow);
  clearVerseSelection();
  el.replaceChildren(flow);
  $('sectionLabel').textContent=section.title;
  updateReaderNavigationButtons();
  page=0;
  pageOriginOffset=0;
  readerAnchorFocus='';
  pageStarts=[0];
  persist();
  setHistoryButton();
  layoutPages(()=>{
    if(renderGeneration!==readerRenderGeneration)return;
    if(anchor)goToAnchor(anchor,afterLayout);
    else{
      turnTo(0,false);
      if(typeof afterLayout==='function')afterLayout();
    }
  });
}
function turnTo(next,animate=true,retainAnchor=false){
  if(next!==page)clearNavigationHighlight();
  page=clampReaderPage(next);
  if(!retainAnchor)readerAnchorFocus='';
  applyPagePosition(animate);
  updatePageLabel();
}
function restoreReaderPosition(position,onReady){
  const flow=readerFlow();
  const anchor=position?.anchor||'';
  if(anchor&&flow&&document.getElementById(anchor)&&flow.contains(document.getElementById(anchor))){
    // Marcadores antigos também são migrados para a página estática correta.
    goToAnchor(anchor,onReady);
    return;
  }
  pageOriginOffset=0;
  readerAnchorFocus='';
  layoutPages(()=>{
    turnTo(position?.page||0,false);
    if(onReady)onReady();
  });
}
function nextPage(fromGesture=false){if(page<pageCount-1){if(fromGesture)turnPageByGesture(page+1,1);else turnTo(page+1);}else if(current<SECTIONS.length-1)openSection(current+1);}
function prevPage(fromGesture=false){
  if(page>0){if(fromGesture)turnPageByGesture(page-1,-1);else turnTo(page-1);return;}
  if(current>0)openSection(current-1,null,()=>turnTo(pageCount-1,false));
}
function findPageContainingOffset(offset){
  // Página canônica definida pelo início do livro, não pelo link.
  let low=0,high=pageStarts.length-1;
  while(low<high){
    const mid=Math.ceil((low+high)/2);
    if(pageStarts[mid]<=offset+1)low=mid;
    else high=mid-1;
  }
  return low;
}
function goToAnchor(anchor,onReady){
  cancelGesturePageTransition();
  const flow=readerFlow();
  const target=document.getElementById(anchor);
  if(!flow||!target||!flow.contains(target))return;
  pageOriginOffset=0;
  readerAnchorFocus=anchor;
  // Não refazer as quebras a partir do versículo: só localizar a página
  // em que ele está e abrir essa página sem mover seu conteúdo ao topo.
  layoutPages(()=>{
    const offset=elementTopWithinFlow(target,flow);
    turnTo(findPageContainingOffset(offset),false,true);
    if(typeof onReady==='function')onReady();
  });
}
function goBackLink(){
  if($('referenceBackdrop')?.classList.contains('open'))closeReferenceDrawer();
  const previous=historyStack.pop();
  if(!previous){toast('Nenhum ponto anterior.');setHistoryButton();return;}
  current=previous.section;page=0;
  renderSection(null,()=>restoreReaderPosition(previous,()=>setHistoryButton()));
  setHistoryButton();
}
function getBookChapterNumbers(section){return section?.chapters||[];}
function openChapterPicker(){
  clearNavigationHighlight();
  cancelGesturePageTransition();
  const section=SECTIONS[current];
  const pair=getBookIntroPair();
  if(section?.href.startsWith('livro_')&&pair){
    chapterPickerMode='chapters';
    chapterPickerBookIndex=pair.bookIndex;
    chapterPickerSourceIndex=pair.bookIndex;
  }else if(isTopicDocument(section)){
    chapterPickerMode='topics';
    chapterPickerBookIndex=null;
    chapterPickerSourceIndex=current;
  }else return;
  chapterPickerReturnPosition=captureReaderPosition();
  versePickerSelectedChapter=null;
  showView('chapterPicker');
}
function renderChapterPicker(){
  const index=chapterPickerSourceIndex;
  const section=index===null?null:SECTIONS[index];
  const grid=$('chapterNumberGrid');
  if(!section||!grid){if(grid)grid.replaceChildren();return;}
  grid.classList.toggle('topic-index-list',chapterPickerMode==='topics');
  $('chapterPickerTitle').textContent=(chapterPickerMode==='topics'?'Tópicos — ':'Capítulos — ')+section.title;
  $('chapterPickerSubtitle').textContent=chapterPickerMode==='topics'
    ?'Escolha uma seção para continuar a leitura do documento.'
    :'Escolha um capítulo para continuar a leitura.';
  if(chapterPickerMode==='topics'){
    const topics=getDocumentTopics(section);
    grid.innerHTML=`<button type="button" class="topic-entry topic-start" data-topic-anchor="topo">Início do documento</button>`+
      topics.map(topic=>`<button type="button" class="topic-entry" data-level="${topic.level}" data-topic-anchor="${safeText(topic.id)}">${safeText(topic.label)}</button>`).join('');
    return;
  }
  const chapters=getBookChapterNumbers(section);
  grid.innerHTML=chapters.map(number=>`<button type="button" class="chapter-number" data-chapter-number="${number}" aria-label="Capítulo ${number}">${number}</button>`).join('');
  if(!chapters.length)grid.innerHTML='<div class="empty-state">Nenhum capítulo encontrado para este livro.</div>';
}
/* Números dos versículos são obtidos das âncoras já existentes no catálogo.
   Não altera a paginação do livro nem suas quebras de texto. */
function bookVersesForChapter(section, chapter){
  if(!section || !Number.isInteger(chapter) || chapter < 1)return [];
  const prefix='cap_'+chapter+'_v_';
  const verses=new Set();
  for(const anchor of section.anchors||[]){
    if(!anchor.startsWith(prefix))continue;
    const n=Number(anchor.slice(prefix.length));
    if(Number.isSafeInteger(n)&&n>0)verses.add(n);
  }
  return [...verses].sort((a,b)=>a-b);
}
function renderVersePicker(){
  const index=chapterPickerBookIndex;
  const section=index===null?null:SECTIONS[index];
  const grid=$('verseNumberGrid');
  if(!grid)return;
  grid.replaceChildren();
  const chapter=versePickerSelectedChapter;
  if(!section||!chapter)return;
  $('versePickerTitle').textContent=section.title+' '+chapter;
  $('versePickerSubtitle').textContent='Escolha o versículo para abrir sua página de leitura.';
  const verses=bookVersesForChapter(section,chapter);
  if(!verses.length){
    grid.innerHTML='<div class="empty-state">Versículos não encontrados neste capítulo.</div>';
    $('versePickerStart').hidden=true;
    return;
  }
  $('versePickerStart').hidden=false;
  grid.innerHTML=verses.map(number=>`<button type="button" class="chapter-number" data-verse-number="${number}" aria-label="Versículo ${number}">${number}</button>`).join('');
}
function returnFromVersePicker(){
  if(chapterPickerBookIndex===null){returnFromChapterPicker();return;}
  showView('chapterPicker');
}
/* Destaque de localização: aplicado SOMENTE ao escolher Livro > Capítulo > Versículo.
   Classe visual em elemento inline, sem alterar layout ou a paginação canônica. */
function clearNavigationHighlight(){
  if(navigationHighlightedVerse){
    navigationHighlightedVerse.classList.remove('verse-navigation-highlight');
    navigationHighlightedVerse=null;
  }
  // Retirar o modo foco e a exceção dos contêineres: todas as cores retornam
  // imediatamente, inclusive quando o usuário toca fora do texto.
  if(navigationHighlightFlow){
    navigationHighlightFlow.classList.remove('verse-navigation-focus');
    navigationHighlightFlow=null;
  }
  navigationHighlightAncestors.forEach(node=>node.classList.remove('verse-navigation-keep'));
  navigationHighlightAncestors=[];
}
function highlightNavigatedVerse(anchor){
  clearNavigationHighlight();
  const flow=readerFlow();
  const verse=flow?.querySelector('.versiculo[id="'+anchor+'"]');
  if(!verse)return;
  // Conservar visíveis os pais do versículo (p. ex., parágrafo bíblico).
  // Esmaecer apenas os irmãos, nunca um ancestral que contém o verso-alvo.
  for(let node=verse.parentElement;node&&node!==flow;node=node.parentElement){
    node.classList.add('verse-navigation-keep');
    navigationHighlightAncestors.push(node);
  }
  verse.classList.add('verse-navigation-highlight');
  flow.classList.add('verse-navigation-focus');
  navigationHighlightFlow=flow;
  navigationHighlightedVerse=verse;
}
function dismissNavigationHighlightOnReaderClick(event){
  if(!navigationHighlightedVerse)return;
  clearNavigationHighlight();
  // No primeiro toque simples, apenas retire o destaque, sem selecionar texto.
  // Referências †, notas ⓘ e links continuam recebendo normalmente o clique.
  if(!event.target.closest('a,button,input,select,textarea,[role="button"]')){
    event.stopImmediatePropagation();
  }
}
function selectBookVerse(number){
  const chapter=versePickerSelectedChapter;
  const index=chapterPickerBookIndex;
  if(index===null||!Number.isInteger(chapter)||chapter<1||
     !Number.isInteger(number)||number<1)return;
  const section=SECTIONS[index];
  const verses=bookVersesForChapter(section,chapter);
  if(!verses.includes(number))return;
  const anchor='cap_'+chapter+'_v_'+number;
  clearNavigationHighlight();
  clearVerseSelection(); // A seleção anterior não se confunde com o novo localizador.
  chapterPickerBookIndex=null;
  chapterPickerSourceIndex=null;
  chapterPickerReturnPosition=null;
  versePickerSelectedChapter=null;
  introToggleReturnPosition=null;
  if(index!==current){
    current=index;page=0;
    renderSection(anchor,()=>highlightNavigatedVerse(anchor));
    showView('reader');return;
  }
  showView('reader');
  requestAnimationFrame(()=>requestAnimationFrame(()=>goToAnchor(anchor,()=>highlightNavigatedVerse(anchor))));
}
function returnFromChapterPicker(){
  const position=chapterPickerReturnPosition;
  versePickerSelectedChapter=null;
  chapterPickerReturnPosition=null;
  chapterPickerBookIndex=null;
  chapterPickerSourceIndex=null;
  showView('reader');
  requestAnimationFrame(()=>requestAnimationFrame(()=>{
    if(position)restoreReaderPosition(position);
  }));
}
function selectDocumentTopic(anchor){
  if(chapterPickerMode!=='topics'||!/^([a-zA-Z0-9_-]+)$/.test(anchor))return;
  const index=chapterPickerSourceIndex;
  chapterPickerSourceIndex=null;
  chapterPickerReturnPosition=null;
  chapterPickerBookIndex=null;
  showView('reader');
  if(index!==current){current=index;page=0;renderSection(anchor);return;}
  requestAnimationFrame(()=>requestAnimationFrame(()=>goToAnchor(anchor)));
}
function selectBookChapter(number){
  if(chapterPickerMode!=='chapters')return;
  const index=chapterPickerBookIndex;
  const section=index===null?null:SECTIONS[index];
  if(!section || !Number.isInteger(number) ||
     !getBookChapterNumbers(section).includes(number))return;
  versePickerSelectedChapter=number;
  showView('versePicker');
}

// Índice das notas teológicas: catálogo compacto, conteúdo carregado sob demanda.
let theologicalIndexRequest=0;
function theologicalIndexItems(){return window.__BIBLIA_CATALOGO.theologicalArticles?.itens||[];}
function theologicalIndexRows(){
  const rows=theologicalIndexItems();
  const present=rows.filter(a=>a.disponivel).length;
  return `<p class="theological-index-meta">${present} de ${rows.length} artigos disponíveis · ordem da edição impressa</p>`+rows.map((a,i)=>{
    const title=`<span>${safeText(a.titulo)}</span>${!a.disponivel?'<small>Não incorporado</small>':''}`;
    const passage=a.principal;
    const right=passage?`<button class="about-link theological-passage" type="button" onclick="openTheologicalPassage(${i})" aria-label="Abrir ${safeText(passage.rotulo)}">${safeText(passage.rotulo)}${a.vinculos.length>1?`<small>+${a.vinculos.length-1}</small>`:''}</button>`:`<span class="theological-no-passage">${a.disponivel?'Sem remissão':'Pág. '+a.pagina_indice}</span>`;
    return `<div class="book-row theological-row"><button class="book-open theological-title" type="button" ${a.disponivel?`onclick="openTheologicalArticle(${i})"`:'disabled'}>${title}</button>${right}</div>`;
  }).join('');
}
function openTheologicalPassage(i){
  const p=theologicalIndexItems()[i]?.principal;
  if(!p)return;
  theologicalIndexRequest++;
  const idx=hrefMap.get(normalizeInternalHref(p.href).file);
  if(idx!==undefined)openSection(idx,normalizeInternalHref(p.href).anchor);
}
async function openTheologicalArticle(i){
  const row=theologicalIndexItems()[i];if(!row?.disponivel)return;
  const req=++theologicalIndexRequest;
  try{
    const cached=await ensureStudyBook(row.livro);
    if(req!==theologicalIndexRequest||!$('libraryView').classList.contains('active'))return;
    const article=cached?.data.artigos?.find(a=>a.id===row.id);
    if(!article){toast('Artigo indisponível.');return;}
    studyDrawerOrigin=null;studyVisiblePassage=null;studyDrawerHistory=[];referenceOriginState=null;referenceFullHref='';
    $('referencePanelTitle').textContent='Artigo teológico';
    $('referenceOriginLabel').textContent='Fé Reformada · página '+row.pagina_impressa;
    $('referenceOriginText').textContent=row.titulo;
    $('referenceOriginalEntry').hidden=true;
    $('referenceStudyTabs').hidden=true;$('referenceCrossContent').hidden=true;$('referenceStudyContent').hidden=false;
    $('referenceStudyBack').hidden=true;$('referenceStudyHeading').textContent='';
    const paragraphs=(article.paragrafos||[]).map(p=>typeof p==='string'?p:[p.titulo,p.texto].filter(Boolean).join(' '));
    const body=(paragraphs.length?paragraphs:String(article.texto||'').split(/\n\s*\n/)).map(p=>`<p class="study-note-text">${studyLinkedText(p,{suppressAmbiguousJo:true})}</p>`).join('');
    const links=row.vinculos.map(p=>`<button type="button" data-reference-target="${safeText(p.href)}">${safeText(p.rotulo)}</button>`).join('');
    $('referenceStudyNotes').innerHTML=`<article class="study-note-card"><div class="editorial-copy-row">${editorialCopyButton(editorialNoteCopy(row.livro,{...article,pagina_impressa:row.pagina_impressa},'Fé Reformada','Artigo teológico',row.principal?.rotulo||'Índice de artigos'),'Copiar artigo teológico')}</div>${body}${links?`<div class="study-note-actions theological-linked"><strong>Passagens vinculadas no projeto:</strong>${links}</div>`:'<p class="fr-pending">Nenhuma remissão a versículo identificada no cadastro atual.</p>'}</article>`;
    document.querySelector('.reference-return').textContent='← Voltar ao índice';
    $('referencePanelBody').scrollTop=0;
    $('referenceBackdrop').classList.add('open');$('referenceBackdrop').setAttribute('aria-hidden','false');document.body.classList.add('reference-is-open');
  }catch(e){console.error(e);if(req===theologicalIndexRequest)toast('Artigo não disponível neste dispositivo.');}
}
function renderIndex(){
  const groups=[
    {title:'Pentateuco',intro:'intro_bloco_01.xhtml',books:[1,2,3,4,5]},
    {title:'Livros Históricos',intro:'intro_bloco_02.xhtml',books:[6,7,8,9,10,11,12,13,14,15,16,17]},
    {title:'Poesia Hebraica',intro:'intro_bloco_03.xhtml',books:[18,19]},
    {title:'Literatura de Sabedoria',intro:'intro_bloco_04.xhtml',books:[20,21,22]},
    {title:'Profetas Maiores',intro:'intro_bloco_05.xhtml',books:[23,24,25,26,27]},
    {title:'Profetas Menores',books:[28,29,30,31,32,33,34,35,36,37,38,39]},
    {title:'Período Intertestamentário',intro:'intro_bloco_06.xhtml',books:[]},
    {title:'Evangelhos e Atos',intro:'intro_bloco_07.xhtml',books:[40,41,42,43,44]},
    {title:'Epístolas',intro:'intro_bloco_08.xhtml',books:[45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65]},
    {title:'Apocalipse',books:[66]},
    {title:'Artigos teológicos',theological:true},
    {title:'Anexos Teológicos e Confessionais',appendices:true}
  ];
  const findBook=n=>SECTIONS.find(s=>s.href.startsWith('livro_'+String(n).padStart(2,'0')+'_'));
  const findIntro=n=>SECTIONS.find(s=>s.href.startsWith('intro_livro_'+String(n).padStart(2,'0')+'_'));
  $('indexList').innerHTML=groups.map((group,g)=>{
    let body='';
    if(group.intro){const intro=hrefMap.get(group.intro);if(intro!==undefined)body+=`<button class="group-intro" onclick="openSection(${intro})">${safeText(SECTIONS[intro].title)}</button>`;}
    if(group.books){
      body+=group.books.map(n=>{
        const book=findBook(n);if(!book)return '';
        const idx=hrefMap.get(book.href);const intro=findIntro(n);const introIdx=intro?hrefMap.get(intro.href):undefined;
        return `<div class="book-row"><button class="book-open" onclick="openSection(${idx})"><span>${safeText(book.title)}</span><small></small></button>${introIdx!==undefined?`<button class="about-link" onclick="openSection(${introIdx})">Sobre ${safeText(book.title)}</button>`:''}</div>`;
      }).join('');
    }
    if(group.theological)body+=theologicalIndexRows();
    if(group.appendices){
      body+=SECTIONS.filter(s=>/^anexo_\d+\.xhtml$/.test(s.href)).map(s=>`<button class="appendix-row" onclick="openByHref('${s.href}')">${safeText(s.title)}</button>`).join('');
    }
    return `<details class="index-group" ${g===0?'open':''}><summary>${safeText(group.title)}</summary><div class="group-body">${body}</div></details>`;
  }).join('');
  document.querySelectorAll('.index-group').forEach(details=>details.addEventListener('toggle',()=>{if(details.open)document.querySelectorAll('.index-group').forEach(other=>{if(other!==details)other.open=false;});}));
}
function clearVerseSelection(){
  const flow=readerFlow();
  if(flow)flow.querySelectorAll('.versiculo.verse-selected').forEach(el=>el.classList.remove('verse-selected'));
  selectedVerseIds.clear();
  updateVerseSelectionToolbar();
}
function getMarkedReferenceInfo(){
  const verses=getMarkedVerses();
  if(!verses.length)return null;
  const numbered=verses.map(v=>{
    const match=/^cap_(\d+)_v_(\d+)$/.exec(v.id||'');
    return match?{...v,chapter:Number(match[1]),number:Number(match[2])}:null;
  }).filter(Boolean);
  if(!numbered.length)return null;
  const byChapter=new Map();
  for(const verse of numbered){
    if(!byChapter.has(verse.chapter))byChapter.set(verse.chapter,[]);
    byChapter.get(verse.chapter).push(verse.number);
  }
  const parts=[];
  for(const [chapter,numbers] of byChapter){
    const groups=[];
    let first=null,last=null;
    function flush(){
      if(first!==null)groups.push(first===last?String(first):first+'-'+last);
    }
    for(const number of [...new Set(numbers)].sort((a,b)=>a-b)){
      if(first===null){first=last=number;continue;}
      if(number===last+1){last=number;continue;}
      flush();first=last=number;
    }
    flush();
    parts.push(chapter+':'+groups.join(','));
  }
  const suffix=parts.join('; ');
  const section=SECTIONS[current]||{};
  const abbr=/^livro_\d+_([A-Za-z0-9]+)\.xhtml$/.exec(section.href||'')?.[1]||section.title||'Bíblia';
  const full=(section.title||abbr)+' '+suffix;
  const short=abbr+' '+suffix;
  const body=numbered.map((v,i)=>{
    let content=v.text;
    // Quando se compartilha apenas um versículo, a vírgula final de
    // um período continuado não deve ficar solta na mensagem.
    if(numbered.length===1)content=content.replace(/[,;:]\s*$/,'');
    return v.number+'. '+content;
  }).join(' ');
  return {short,full,body,count:numbered.length};
}
function formatMarkedShareText(){
  const reference=getMarkedReferenceInfo();
  return reference?`${reference.full}\n\n${reference.body}\n\n— Bíblia de Estudo ARA`:'';
}
function updateVerseSelectionToolbar(){
  const info=getMarkedReferenceInfo();
  const toolbar=$('verseSelectionToolbar');
  if(!toolbar)return;
  toolbar.hidden=!info;
  const label=$('verseSelectionCount');
  label.textContent=info?.short||'';
  label.title=info?.full||'';
  label.setAttribute('aria-label',info?'Versículos selecionados: '+info.short:'Sem versículos selecionados');
}
function getMarkedVerses(){
  const flow=readerFlow();if(!flow)return [];
  const verses=[...selectedVerseIds].map(id=>document.getElementById(id))
    .filter(el=>el&&flow.contains(el));
  verses.sort((a,b)=>a===b?0:(a.compareDocumentPosition(b)&Node.DOCUMENT_POSITION_FOLLOWING)?-1:1);
  return verses.map(el=>{
    const match=/^cap_(\d+)_v_(\d+)$/.exec(el.id);
    const copy=el.cloneNode(true);
    copy.querySelectorAll('.num-vers,.ref-marker,.study-note-marker,.inline-ref-marker').forEach(node=>node.remove());
    const text=(copy.textContent||'').replace(/\s+/g,' ').trim();
    const ref=match?SECTIONS[current].title+' '+match[1]+':'+match[2]:SECTIONS[current].title;
    return {id:el.id,ref,text};
  });
}
function getMarkedVersesText(){
  return getMarkedVerses().map(v=>v.ref+' — '+v.text).join('\n');
}
function handleVerseClick(event){
  if(Date.now()<ignoreVerseClickUntil||event.target.closest('a,button,input,select'))return;
  const verse=event.target.closest('.versiculo[id^="cap_"]');
  if(!verse||!readerFlow()?.contains(verse))return;
  const selection=window.getSelection?.();
  if(selection&&!selection.isCollapsed&&selection.toString().trim().length>2)return;
  const id=verse.id;
  if(selectedVerseIds.has(id)){
    selectedVerseIds.delete(id);
    verse.classList.remove('verse-selected');
  }else{
    selectedVerseIds.add(id);
    verse.classList.add('verse-selected');
  }
  updateVerseSelectionToolbar();
}
function selectedPassage(){
  const marked=getMarkedVersesText();
  if(marked)return marked;

  const selection=window.getSelection?.();
  if(!selection||selection.isCollapsed)return '';
  const text=selection.toString().trim();
  return text&&$('readerContent').contains(selection.anchorNode)?text:'';
}
function toggleFavorite(){
  const quote=selectedPassage();
  const exists=data.bookmarks.findIndex(b=>b.section===current&&b.page===page&&(b.quote||'')===quote);
  if(exists>=0){data.bookmarks.splice(exists,1);toast('Removido dos salvos');}
  else{data.bookmarks.unshift({...captureReaderPosition(),title:SECTIONS[current].title,quote,created:Date.now()});toast(quote?'Trecho salvo':'Página salva');}
  persist();
}
function renderFavorites(){
  const items=data.bookmarks||[];
  $('favoriteList').innerHTML=items.length?items.map((item,i)=>{
    const reference=safeText(item.title||SECTIONS[item.section]?.title||'Leitura');
    const excerpt=item.quote?`<div class="favorite-quote">“${safeText(item.quote)}”</div>`:`<div class="favorite-quote">Página marcada para continuar a leitura.</div>`;
    return `<article class="favorite-item"><div class="favorite-title">${reference}</div>${excerpt}<div class="favorite-meta">Página ${Number(item.page||0)+1}</div><div class="favorite-actions"><button onclick="jumpFavorite(${i})">Abrir</button><button onclick="removeFavorite(${i})">Remover</button></div></article>`;
  }).join(''):'<div class="empty-state">Nenhum trecho ou página salvo ainda.<br>Durante a leitura, toque em um ou mais versículos e toque em ☆.</div>';
}
function jumpFavorite(i){const item=data.bookmarks[i];if(!item)return;current=Math.max(0,Math.min(SECTIONS.length-1,Number(item.section)||0));page=0;renderSection(null,()=>restoreReaderPosition(item));showView('reader');}
function removeFavorite(i){data.bookmarks.splice(i,1);persist();renderFavorites();toast('Salvo removido');}
async function shareSelection(){
  const quote=selectedPassage();
  if(!quote){toast('Toque nos versículos para selecionar; toque novamente para cancelar.');return;}
  const text=formatMarkedShareText()||`“${quote}”\n— ${SECTIONS[current].title} · Bíblia de Estudo ARA`;
  try{
    if(navigator.share){await navigator.share({title:'Bíblia de Estudo ARA',text});return;}
    if(navigator.clipboard?.writeText){await navigator.clipboard.writeText(text);toast('Trecho copiado');return;}
    throw new Error('clipboard indisponível');
  }catch(e){
    if(e?.name==='AbortError')return;
    const textarea=document.createElement('textarea');textarea.value=text;textarea.style.position='fixed';textarea.style.opacity='0';document.body.appendChild(textarea);textarea.select();
    try{document.execCommand('copy');toast('Trecho copiado');}catch(_){toast('Não foi possível compartilhar neste navegador.');}
    textarea.remove();
  }
}
function setTheme(theme){data.theme=theme;document.body.dataset.theme=theme;persist();}
function setFont(value){data.font=Number(value);document.documentElement.style.setProperty('--reader-font',data.font+'px');$('fontValue').textContent=data.font+' px';persist();layoutPages();}
function setLine(value){data.line=Number(value);document.documentElement.style.setProperty('--line',data.line);$('lineValue').textContent=data.line.toFixed(2).replace(/0+$/,'').replace(/\.$/,'');persist();layoutPages();}
function syncSettings(){
  $('themeSelect').value=data.theme;$('fontRange').value=data.font;$('fontValue').textContent=data.font+' px';
  $('lineRange').value=data.line;$('lineValue').textContent=Number(data.line).toFixed(2).replace(/0+$/,'').replace(/\.$/,'');
}
function resetProgress(){
  if(!confirm('Limpar o progresso salvo e voltar para Gênesis 1:1?'))return;
  introToggleReturnPosition=null;
  data.section=genesisIndex;data.page=0;data.pageOffset=0;data.anchor='';current=genesisIndex;page=0;pageOriginOffset=0;readerAnchorFocus='';historyStack=[];persist();renderSection();showView('reader');toast('Progresso de leitura reiniciado');
}
let installEventBible=null;
window.addEventListener('beforeinstallprompt',event=>{
  event.preventDefault();
  installEventBible=event;
  const button=document.getElementById('installBibleButton');
  if(button)button.textContent='Instalar Bíblia de Estudo';
});
window.addEventListener('appinstalled',()=>{
  installEventBible=null;
  const help=document.getElementById('installBibleHelp');
  if(help)help.textContent='Aplicativo instalado. Você já pode abri-lo pela tela inicial.';
});
async function installBibleApp(){
  const help=document.getElementById('installBibleHelp');
  if(!help)return;
  if(window.matchMedia?.('(display-mode: standalone)').matches||navigator.standalone){
    help.textContent='O aplicativo já está aberto em modo instalado.';return;
  }
  if(installEventBible){
    const event=installEventBible;
    installEventBible=null;
    await event.prompt();
    await event.userChoice;
    return;
  }
  const apple=/iPhone|iPad|iPod/i.test(navigator.userAgent);
  if(location.protocol==='file:'){
    help.textContent='Este HTML está aberto como arquivo local. Para instalação completa como aplicativo, use o pacote PWA publicado em HTTPS. Você também pode continuar lendo este arquivo offline.';
  }else if(apple){
    help.textContent='No Safari: toque em Compartilhar → Adicionar à Tela de Início → Adicionar (ative “Abrir como App”, se aparecer).';
  }else{
    help.textContent='No Chrome do Android: abra o menu ⋮ → Adicionar à tela inicial → Instalar app ou Adicionar.';
  }
}

function init(){
  document.body.dataset.theme=data.theme||'sepia';
  document.documentElement.style.setProperty('--reader-font',(data.font||20)+'px');
  document.documentElement.style.setProperty('--line',data.line||1.65);
  current=data.section;
  const savedPosition={section:current,page:Math.max(0,Number(data.page)||0),pageOffset:Math.max(0,Number(data.pageOffset)||0),anchor:data.anchor||''};
  page=0;
  renderSection(null,()=>restoreReaderPosition(savedPosition));
  $('readerContent').addEventListener('click',dismissNavigationHighlightOnReaderClick,true);
  // Tocando fora do texto (cabeçalho, navegação etc.) também elimina o destaque.
  document.addEventListener('click',event=>{
    if(navigationHighlightedVerse && !$('readerContent').contains(event.target))clearNavigationHighlight();
  },true);
  // Carrega artigos explicitamente remetidos a outro livro somente quando abertos.
  $('referenceStudyNotes').addEventListener('toggle',async event=>{
    const details=event.target;
    if(!details.matches?.('details[data-external-article]')||!details.open||details.dataset.loaded==='true')return;
    const [book,id]=details.dataset.externalArticle.split('|'), body=details.querySelector('.external-article-body');
    try{
      const cached=await ensureStudyBook(book), article=cached?.data.artigos?.find(a=>a.id===id);
      if(!article)throw new Error('Artigo não encontrado');
      body.innerHTML=`<div class="editorial-copy-row">${editorialCopyButton(editorialNoteCopy(book,article,'Fé Reformada','Artigo teológico','Remissão explícita'),'Copiar artigo teológico')}</div>`+
        (article.paragrafos||[]).map(p=>`<p class="study-note-text">${studyLinkedText(typeof p==='string'?p:[p.titulo,p.texto].filter(Boolean).join(' '),{suppressAmbiguousJo:true})}</p>`).join('');
      details.dataset.loaded='true';
    }catch(e){body.textContent='Artigo indisponível. Reabra com conexão para tentar novamente.';console.warn(e);}
  },true);
  $('readerContent').addEventListener('click',studyHandleReaderButton);
  $('readerContent').addEventListener('click',handleReaderInternalLink);
  $('readerContent').addEventListener('click',handleVerseClick);
  $('chapterPickerBack').addEventListener('click',returnFromChapterPicker);
  $('versePickerBack').addEventListener('click',returnFromVersePicker);
  $('versePickerStart').addEventListener('click',()=>selectBookVerse(1));
  $('verseNumberGrid').addEventListener('click',event=>{
    const button=event.target.closest('[data-verse-number]');
    if(button)selectBookVerse(Number(button.dataset.verseNumber));
  });
  $('chapterNumberGrid').addEventListener('click',event=>{
    const button=event.target.closest('[data-chapter-number]');
    if(button){selectBookChapter(Number(button.dataset.chapterNumber));return;}
    const topic=event.target.closest('[data-topic-anchor]');
    if(topic)selectDocumentTopic(topic.dataset.topicAnchor);
  });
  $('referenceDrawer').addEventListener('click',event=>{
    if(studyHandleDrawerControl(event))return;
    if(event.target.closest('#referenceShowAll')){
      event.preventDefault();
      const verse=referenceOriginState?.anchor ? document.getElementById(referenceOriginState.anchor) : null;
      const dagger=verse?.querySelector('.ref-marker a[href^="referencias_"]');
      if(referenceFullHref)openReferenceDrawer(referenceFullHref,dagger||null);
      return;
    }
    const target=event.target.closest('[data-reference-target]');
    if(target){event.preventDefault();navigateToReference(target.dataset.referenceTarget);return;}
    const link=event.target.closest('a[href]');
    if(link){event.preventDefault();navigateToReference(link.getAttribute('href'));}
  });
  let startX=0,startY=0;
  $('readerContent').addEventListener('touchstart',event=>{startX=event.changedTouches[0].clientX;startY=event.changedTouches[0].clientY;},{passive:true});
  $('readerContent').addEventListener('touchend',event=>{
    const dx=event.changedTouches[0].clientX-startX,dy=event.changedTouches[0].clientY-startY;
    if(Math.abs(dx)>55&&Math.abs(dx)>Math.abs(dy)*1.25){
      ignoreVerseClickUntil=Date.now()+450;
      dx<0?nextPage(true):prevPage(true);
    }
  },{passive:true});
  document.addEventListener('keydown',event=>{
    if($('referenceBackdrop').classList.contains('open')){
      if(event.key==='Escape'){event.preventDefault();closeReferenceDrawer();}
      return;
    }
    if(!$('readerView').classList.contains('active'))return;
    if(event.key==='ArrowRight'||event.key==='PageDown'){event.preventDefault();nextPage();}
    else if(event.key==='ArrowLeft'||event.key==='PageUp'){event.preventDefault();prevPage();}
  });
  const reflowPreservingLocation=()=>{
    const oldPage=page;
    pageOriginOffset=0;
    const anchor=readerAnchorFocus;
    layoutPages(()=>{
      if(anchor && readerFlow()?.contains(document.getElementById(anchor)))goToAnchor(anchor);
      else turnTo(oldPage,false);
    });
  };
  window.addEventListener('resize',reflowPreservingLocation,{passive:true});
  window.addEventListener('orientationchange',()=>setTimeout(reflowPreservingLocation,90),{passive:true});
  if(window.visualViewport)window.visualViewport.addEventListener('resize',reflowPreservingLocation,{passive:true});
  if('ResizeObserver' in window){
    const observer=new ResizeObserver(()=>{
      if($('readerView').classList.contains('active'))reflowPreservingLocation();
    });
    observer.observe($('readerShell'));
  }
  $('readerContent').addEventListener('load',event=>{
    if(event.target?.tagName==='IMG')reflowPreservingLocation();
  },true);
  if(document.fonts&&document.fonts.ready)document.fonts.ready.then(reflowPreservingLocation).catch(()=>{});
  if(document.fonts&&document.fonts.addEventListener)document.fonts.addEventListener('loadingdone',reflowPreservingLocation);
}

init();
