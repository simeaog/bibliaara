# Bíblia de Estudo ARA — Aplicativo instalável

Este pacote contém o mini app integral, com Gênesis atualizado, seleção e compartilhamento de versículos, links de referências, introduções e anexos, e suporte a instalação PWA/offline.

## Arquivos
- `index.html`: leitor completo e totalmente autocontido em HTML, CSS e JavaScript.
- `manifest.webmanifest`: identidade e instruções para instalação na tela inicial.
- `service-worker.js`: cache offline de todos os arquivos, depois da primeira visita.
- `icon-180.png`, `icon-192.png`, `icon-512.png`: ícones do aplicativo.

## Como instalar
1. Descompacte o ZIP e publique **todos os arquivos juntos** em hospedagem estática que forneça HTTPS (por exemplo, GitHub Pages, Cloudflare Pages ou Netlify).
2. Abra o endereço publicado no navegador do celular **enquanto estiver conectado à internet**; a primeira visita pode demorar porque o leitor possui aproximadamente 19 MB.
3. No Android/Chrome: menu ⋮ > *Adicionar à tela inicial* > *Instalar app* (o texto pode variar).
4. No iPhone/Safari: botão Compartilhar > *Adicionar à Tela de Início* > *Adicionar*, com *Abrir como App*, quando disponível.
5. Após a primeira visita completa, abra o aplicativo sem internet para confirmar que foi armazenado.

**Importante:** abrir `index.html` diretamente por `file://` não permite instalar um PWA completo nem ativar o service worker. O HTML único funciona como leitor offline; já o ZIP é destinado a ser publicado em HTTPS.

Favoritos e progresso ficam salvos **no navegador/dispositivo e na origem do site**, não são transferidos automaticamente do arquivo local para o endereço publicado. Não exclua a versão anterior sem salvar o que for importante.

## Testes funcionais sugeridos
- Índice → Colossenses → selecionar 1:1, 1:1-2 e 1:1,3,5; conferir a barra e a cópia/compartilhamento.
- Índice → Gênesis → Introdução → Tópicos → Gênero e Esboço de Gênesis, verificando os subitens numerados.
- Abrir notas † de Colossenses; escolher uma referência, voltar e usar a seleção sem interferência.
- Abrir a versão publicada sem internet depois de visitar uma vez online.
