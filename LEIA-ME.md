# Bíblia de Estudo ARA — Mini app com Notas de Genebra

Esta versão inclui os 66 livros, 66 introduções, 8 introduções gerais, 24 anexos,
referências cruzadas (†) e 4.198 notas de estudo de Genebra (ⓘ) para os 27 livros do NT.

## Como instalar

1. Extraia **todos** os arquivos do ZIP e publique-os juntos em um endereço HTTPS,
   conservando `index.html`, `manifest.webmanifest`, `service-worker.js` e os ícones.
2. Abra esse endereço no Chrome (Android) e use o menu **Adicionar à tela inicial** ou **Instalar**.
   No iPhone, abra no Safari e escolha **Compartilhar → Adicionar à Tela de Início**.
3. Abra o aplicativo com internet uma vez para que os arquivos sejam armazenados localmente.
   Em seguida, teste sem internet.

Abrir `index.html` diretamente do gerenciador de arquivos permite leitura offline,
mas **não** efetua a instalação PWA completa.

## Atualização de uma instalação anterior

Use o mesmo endereço HTTPS do aplicativo original; publique os novos arquivos de uma vez.
O `service-worker.js` mudou de versão e atualiza o cache. Os favoritos e as preferências
ficam no armazenamento local do navegador e devem ser preservados, desde que o endereço
(origem) permaneça o mesmo. Como a paginação mudou, a página exata pode se deslocar.

## Notas

- ⓘ Abre comentários da Bíblia de Estudo de Genebra.
- † Abre referências cruzadas. Quando ambos existem, a gaveta permite alternar.
- Citações explícitas com destino verificável são links internos; referências relativas
  não recebem hiperlink automático quando a identificação não é segura.
- Notas com ambiguidades ainda recomendadas para revisão permanecem como na base validada.

A redistribuição pública dos comentários depende de verificar as permissões de reprodução.
