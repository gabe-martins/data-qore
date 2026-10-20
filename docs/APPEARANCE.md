# Aparência e navegação

O Web App oferece **Light**, **Dark** e **System**. O padrão é System e acompanha
mudanças do sistema operacional enquanto selecionado. O botão **Theme** fica no
rodapé da lateral, acima de Sign out, e também no login. A seleção tem efeito
imediato; Escape ou o botão de fechar retornam o foco ao controle de abertura.

O menu começa expandido em desktop, com 256 px. **Collapse sidebar** recolhe
para 80 px e **Expand sidebar** restaura os nomes. Ícones recolhidos oferecem
rótulos acessíveis e tooltips por mouse/foco, dispensáveis por Escape. A lateral
mantém #172C3C nos dois temas; o resto da aplicação usa tokens semânticos. O logo
inverso preserva a geometria do SVG original.

Até 850 px, **Toggle navigation** abre um painel modal sobre a página, com foco
contido. Escolher uma página, usar Escape, Close navigation ou clicar fora fecha
o painel e devolve foco ao botão. A preferência desktop é independente: o
painel móvel começa fechado e não altera expanded/collapsed. Em telas baixas,
os links rolam e Theme/Sign out permanecem acessíveis.

Somente duas preferências são guardadas no localStorage:

- `dataqore.ui.theme`: `light`, `dark` ou `system`.
- `dataqore.ui.sidebar`: `expanded` ou `collapsed`.

Preferências são locais ao navegador. Não contêm tokens, credenciais, dados de
fontes ou rascunhos. Armazenamento bloqueado mantém os controles funcionais em
memória; valores inválidos usam System e menu expandido. Mudanças em outra aba
são refletidas por eventos de storage. O tema é inicializado antes do React,
para evitar um flash claro, e alcança portais de modais/tooltips. Animações de
largura respeitam prefers-reduced-motion e não são usadas na mudança para móvel.

O sistema de cores continua em `web/src/color-system.json`; primitivos são
estáveis e as variantes escuras sobrescrevem os tokens semânticos. O gerador
preserva aliases CSS para que cards, ações e gráficos acompanhem o tema:

```bash
npm run tokens:generate --prefix web
npm run build --prefix web
```

Não há novas dependências, APIs, migrations ou variáveis de ambiente. Com Vite
ativo, o frontend recebe os arquivos atualizados; recarregue a página para
carregar também a inicialização do tema. Alterar Theme ou o menu depois disso
não exige recarga ou reinício. Os processos do motor, worker e controller
permanecem independentes. A conferência visual pessoal usa o login normal.

Validação em 20/10/2026: build TypeScript/Vite aprovado; fixture completa com
PostgreSQL descartável, fontes SQLite e Databricks simulado, login normal do
administrador de teste, 10 testes de navegador, 7 do controller e 5 de
agendamentos aprovados. Os quatro cenários específicos de aparência cobrem
inicialização antes do React, sistema/persistência, contraste semântico e dos
rótulos dos gráficos, tooltips, formulários preservados, foco móvel,
redimensionamento e armazenamento inválido/bloqueado. Capturas desktop e móvel
ficam em `web/test-results/` (não versionadas). Nenhuma sessão de QA é criada no
banco pessoal.
