/* Bootstrap: catalogo e indice de notas antes de inicializar o leitor. */
(async function bootstrap(){
  try {
    const catalogResponse=await fetch('./dados/catalogo.json');
    if(!catalogResponse.ok)throw new Error('Catálogo indisponível');
    window.__BIBLIA_CATALOGO=await catalogResponse.json();
    const noteIndexPath=window.__BIBLIA_CATALOGO.noteIndex;
    if(!noteIndexPath)throw new Error('Índice de notas não configurado');
    const notesResponse=await fetch('./'+noteIndexPath);
    if(!notesResponse.ok)throw new Error('Índice de notas indisponível');
    window.__BIBLIA_NOTES_INDEX=await notesResponse.json();
    const script=document.createElement('script');
    script.src='./js/leitor.js';
    script.onerror=()=>mostrarFalha('Não foi possível carregar o leitor.');
    document.body.appendChild(script);
  }catch(error){console.error(error);mostrarFalha('Não foi possível carregar os dados. Verifique sua conexão ou o cache offline.');}
  function mostrarFalha(message){
    const node=document.getElementById('readerContent')||document.body;
    node.textContent=message;
  }
})();
if('serviceWorker' in navigator && (location.protocol==='https:'||['localhost','127.0.0.1'].includes(location.hostname))){
  window.addEventListener('load',()=>navigator.serviceWorker.register('./service-worker.js').catch(console.warn));
}
