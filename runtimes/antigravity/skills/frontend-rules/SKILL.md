---
name: frontend-rules
description: Regras universais de UI/UX e acessibilidade pra qualquer interface web. Framework-agnostica - vale React, Vue, Svelte, Solid, Angular, Blazor, Razor, Twig, Jinja, ERB, Blade, e qualquer template engine. Baseada em WCAG 2.2 AA, Nielsen heuristics, Material/Apple HIG.
triggers:
  - "regras de frontend"
  - "padroes de UI"
  - "acessibilidade web"
  - "WCAG"
  - "boas praticas de UX"
  - "validar interface"
---

# Skill: jdi-frontend-rules

Padroes de UI/UX que NAO podem ser violados - independente de stack. Conceitos > sintaxe. Vale pra SPA, SSR, MPA, hybrid, qualquer template engine.

## Quando aplicar

Sempre que codigo toque interface humana visivel:

- Arquivos `.tsx, .jsx, .vue, .svelte, .astro, .qwik, .solid` (componentes JS-based)
- Arquivos `.razor, .cshtml` (Blazor / Razor Pages / MVC)
- Arquivos `.html, .twig, .jinja, .j2, .erb, .blade.php, .hbs, .liquid, .mustache, .ejs, .pug` (template engines)
- CSS/Tailwind/SCSS/Less que afetem layout, contraste, foco, ou acessibilidade
- ARIA / semantic HTML em qualquer linguagem

NAO aplica em: API-only backends, CLI tools, servicos sem UI.

## Regras universais (gates duros)

### 1. Acessibilidade - WCAG 2.2 nivel AA

Todas obrigatorias. Violacao = BLOCK no review.

- **Contraste de cor**:
  - Texto normal: minimo 4.5:1 contra fundo
  - Texto grande (18pt+ ou 14pt+ bold): minimo 3:1
  - Componentes UI e graficos: minimo 3:1
  - Verificar em estados hover/focus/disabled tambem
- **Foco visivel**: nunca `outline: none` ou `outline: 0` sem substituto. Foco precisa ser perceptivel em luz forte e em monitor barato. `:focus-visible` eh o padrao
- **Keyboard navigation**: 100% das interacoes alcancaveis via teclado. Tab segue ordem visual logica. Sem armadilha (modal sem Esc, dropdown sem Escape/setas)
- **Semantic HTML primeiro**:
  - `<button>` pra acao (mesmo se estilizado como link)
  - `<a href>` pra navegacao (mesmo se estilizado como botao)
  - `<form>` pra forms (Enter submeter, validacao nativa funcionar)
  - Headings em ordem (`h1` -> `h2` -> `h3`, sem pular niveis)
  - `<nav>, <main>, <header>, <footer>, <aside>, <section>, <article>` quando apropriado
  - `<ul>/<ol>` pra listas, nao `<div>` repetidos
- **ARIA quando necessario**:
  - Botao com so icone: `aria-label="acao descritiva"`
  - Erro de form: `role="alert"` ou `aria-live="assertive"`
  - Loading regiao: `aria-busy="true"` + `aria-live="polite"`
  - Toggle/expand: `aria-expanded="true|false"` + `aria-controls`
  - Modal: `role="dialog"` + `aria-modal="true"` + `aria-labelledby`
  - Tooltip: `aria-describedby`
  - ARIA NUNCA SUBSTITUI semantic HTML. ARIA so complementa
- **Skip link**: primeira ordem de tab oferece "Pular pra conteudo principal"
- **Touch target minimo**: 44x44 CSS px (Apple HIG / WCAG 2.5.5). Aumenta em mobile com `padding`, nao margin
- **Cor nao eh o unico indicador**:
  - Erro vermelho precisa icone OU texto explicito
  - Link colorido precisa underline OU peso visual diferente
  - Estado ativo de nav precisa borda/peso, nao so cor
  - Daltonismo afeta 8% homens. Sempre cor + forma + texto
- **Form labels**: todo `<input>, <textarea>, <select>` com:
  - `<label htmlFor="id">` associado, OU
  - `aria-label="..."`, OU
  - `aria-labelledby="id-de-outro-elemento"`
  - Placeholder NAO conta como label (some quando user digita)
- **Erro associado**: erro de campo conectado via `aria-describedby="id-do-erro"`. Texto do erro tem `id` correspondente
- **Idioma**: `<html lang="pt-BR">` declarado. Sem isso screen reader le ingles pra texto pt-BR
- **prefers-reduced-motion**: respeitar. Animacoes devem desabilitar via `@media (prefers-reduced-motion: reduce)`

### 2. Estados obrigatorios em toda UI surface

Toda tela/componente que carrega ou muta dado precisa cobrir os 5:

- **Loading**:
  - Skeleton com shape igual ao conteudo real (evita layout shift)
  - OU spinner/progress se shape imprevisivel
  - Visivel minimo 200ms (evita flash que pisca)
  - Maximo 10s sem feedback adicional - depois disso explica "quase la" ou oferece cancelar
- **Empty**:
  - Nunca tela vazia. Sempre mensagem + icone + CTA acionavel
  - Texto orienta proximo passo: "Crie seu primeiro X clicando em Y"
  - Nao confundir empty com error (empty eh sucesso, error eh falha)
- **Error**:
  - Mensagem especifica: o que falhou + como corrigir
  - NUNCA "Algo deu errado" / "Erro inesperado" como mensagem final pro user
  - Acao de recuperacao visivel: retry, voltar, contatar suporte
  - Erros de validacao inline + mensagem geral se necessario
- **Success**:
  - Confirmacao visivel - toast eh OK pra acoes nao-destrutivas
  - Acao destrutiva (delete, transferencia) precisa undo OU confirmacao previa
  - Toast some em 4-6s; acoes destrutivas com undo tem 5-10s
- **Disabled**:
  - SEMPRE com motivo visivel: tooltip, helper text, ou hint
  - Disabled silencioso = bug ("por que nao consigo clicar?")
  - Considere alternativa: nao desabilitar, deixar clicar e mostrar erro especifico

### 3. Feedback timing - heuristicas Nielsen

- **< 100ms**: parece instantaneo. Sem indicador necessario
- **100ms a 1s**: aceitavel sem indicador. Cursor pode mudar pra waiting
- **1s a 10s**: progress indicator obrigatorio. Spinner ou barra
- **> 10s**: progress + tempo estimado OU permitir cancelar
- **Indeterminado e > 30s**: oferecer notificacao em background, liberar UI
- **Optimistic UI**: like/save/toggle - atualizar UI imediato, rollback se falhar

### 4. Forms - patterns universais

- **Validacao**:
  - On blur pra campo individual (depois user sair do campo)
  - On submit pra validacao geral
  - On change SO pra feedback positivo (ex: forca de senha)
  - NUNCA on keypress de erro ("falta caractere") - cansa
- **Erros inline**: ao lado/abaixo do campo errado, COM mensagem geral no topo opcional. Nunca so topo
- **Required**:
  - Asterisco vermelho NAO basta - adiciona texto "(obrigatorio)" ou marca clara antes do submit
  - Indicar required no momento do design, nao depois do erro
  - Alternativa moderna: indicar opcionais ("Telefone (opcional)")
- **Autocomplete**: atributo `autocomplete` correto: `email, current-password, new-password, name, given-name, family-name, tel, postal-code, etc`. Habilita autofill do browser
- **Inputmode + type**:
  - `type="email"` mostra teclado com @ em mobile
  - `inputmode="numeric"` pra OTP/PIN/CEP
  - `type="tel"` pra telefone
  - `type="url"` pra URL
  - `type="date"` pra data (com fallback se browser nao suporta)
- **Submit**:
  - NAO desabilita o botao antes do user tentar - ensina errado e esconde causa
  - Desabilitar SO durante request em andamento (evita double submit)
  - Loading state no botao (texto + spinner inline)
- **Password**:
  - Toggle "mostrar senha" (icone olho)
  - Forca HTTPS sempre - nunca send password em plain HTTP
  - Mostra requisitos antes do user digitar (8+ chars, etc)
- **Confirmacao destrutiva**:
  - Acoes irreversiveis (delete account, drop data) precisam digitar nome/palavra ou checkbox explicito
  - Modal "tem certeza?" simples eh insuficiente pra acao realmente destrutiva

### 5. Navegacao

- **Localizacao atual**: nav ativo destacado (peso + cor + indicador). Breadcrumbs em hierarquia profunda
- **Back button do browser**: respeitar historico. Modal nao usa `pushState` sem motivo. Single-page nav usa router que emita historico real
- **404 customizado**: pagina amigavel com search ou sitemap, nao tela branca
- **Logo linka home**: convencao universal
- **Search**: se app tem busca, atalho de teclado `/` ou `Ctrl+K` (convencao)

### 6. Responsivo - mobile-first

- **Design comeca em 320px** e cresce - nao o oposto
- **Breakpoints baseados em conteudo**, nao em devices: ponto onde layout quebra, nao "iPhone 12"
- **Sem scroll horizontal em mobile** (exceto carrossel intencional). Audita com viewport 375px
- **Touch-friendly spacing**: minimo 8px entre alvos clicaveis
- **Hover-only e ruim em mobile**: tudo que precisa hover precisa fallback (long press, tap to reveal)
- **Densidade**: mobile precisa mais espaco que desktop pra mesma legibilidade

### 7. Performance UX - Core Web Vitals

- **CLS < 0.1** (Cumulative Layout Shift):
  - `width` + `height` em todo `<img>` (evita pulo quando carrega)
  - `font-display: swap` com fallback metric-compatible
  - Reserva espaco pra ads/embeds/skeletons
- **LCP < 2.5s** (Largest Contentful Paint):
  - Imagem hero otimizada (WebP/AVIF + responsive `srcset`)
  - Critical CSS inline
  - Preload de recurso critico (`<link rel="preload">`)
- **INP < 200ms** (Interaction to Next Paint):
  - Sem JS pesado bloqueando main thread durante interacao
  - Debounce em input handlers
  - Web Workers pra computacao pesada
- **TTFB < 800ms** (Time To First Byte):
  - Cache estatico, CDN, lazy loading
- **Optimistic UI**: ja mencionado - atualizar imediato

### 8. Hierarquia visual

- **1 acao primaria por view**. Multiplas = decisao paralisada (Hicks Law)
- **Secundaria visualmente menor**: ghost, outline, ou link
- **Whitespace separa grupos** - sem caixinha (border) pra tudo
- **Spacing scale fixo**: 4/8/16/24/32/48/64 (multiplos de 4 ou 8). Sem `margin: 13px`
- **Type scale**: maximo 5-6 tamanhos no app inteiro. Mais que isso = caos visual
- **Color palette**:
  - Regra 60-30-10: 60% neutro (fundo), 30% complementar, 10% accent (CTA)
  - Maximo 1 cor de marca + 1 ou 2 acentos
  - Estados (success/warn/error) sao paleta separada
- **Alinhamento**: todo elemento alinhado a uma grid - nao "olho"

### 9. i18n + l10n

- **Zero string hardcoded em markup**. Sempre key de traducao
  - JSX/TSX: nao escrever texto pt-BR direto, usar `t("key")` ou equivalente
  - Templates: usar tag de translate (`{% trans %}`, `<t>`, `@Localize`)
  - HTML: separar conteudo de marcacao
- **RTL ready** (arabe, hebraico):
  - Logical properties: `margin-inline-start` em vez de `margin-left`
  - `padding-block` em vez de `padding-top`
  - `text-align: start/end` em vez de `left/right`
  - `dir="auto"` em campos que aceitam input em qualquer idioma
- **Format por locale**:
  - Datas: `Intl.DateTimeFormat` ou equivalente backend
  - Numeros: `Intl.NumberFormat`
  - Moeda: nunca hardcoded "$" - moeda vem do locale + valor
- **Pluralizacao**: ICU MessageFormat ou equivalente. Linguas tem 1, 2, 3+ ou mais formas (russo tem 4)

### 10. Seguranca UI - overlap com regras gerais

- **Tokens NUNCA em localStorage/sessionStorage**:
  - Vulneravel a XSS. Qualquer script malicioso le tudo
  - Padrao seguro: httpOnly cookie + SameSite=Strict
  - Token em memoria com refresh via cookie eh OK pra SPAs
- **CSP estrito**:
  - `script-src 'self'` no minimo - sem `unsafe-inline`, sem `unsafe-eval`
  - `frame-ancestors 'none'` ou whitelist - previne clickjacking
- **HTTPS only**:
  - Redirect HTTP -> HTTPS no servidor
  - HSTS header com `includeSubDomains`
  - Sem mixed content (HTTP em pagina HTTPS)
- **CSRF**:
  - Token CSRF em todo form com side-effect autenticado
  - SameSite=Strict cookie ajuda mas nao basta
- **External links**:
  - `target="_blank"` SEMPRE com `rel="noopener noreferrer"` (previne tabnabbing)
- **dangerouslySetInnerHTML / v-html / @Html.Raw**:
  - Nunca com input user sem sanitizacao (DOMPurify ou backend sanitizer)
  - Preferir parsing semantico (markdown -> AST -> render)
- **Form action externo**: nunca aceitar `action` URL controlavel por user

## Anti-patterns - lista BLOCK pra reviewer

Cada item abaixo eh violacao automatica. Reviewer marca BLOCK + cita regra.

| Anti-pattern | Por que eh BLOCK |
|---|---|
| Botao que parece link / link que parece botao | Confunde modelo mental, viola convencao |
| `<div onclick>` em vez de `<button>` | Sem keyboard, sem ARIA, sem semantica |
| `<a href="#">` ou `<a href="javascript:">` pra acao | Vira link sem destino - usar `<button>` |
| Modal sem fechar com Esc | Armadilha de keyboard - WCAG 2.1.2 |
| Modal sem botao close visivel | Mesmo motivo |
| Spinner infinito sem timeout/fallback | User nao sabe se travou |
| Auto-play media com som | WCAG 1.4.2 |
| Toast como UNICA confirmacao de acao destrutiva | Toast some - destrutivo precisa persistente |
| Disabled state sem motivo visivel | "Por que nao funciona?" - bug de UX |
| Erro generico "Algo deu errado" | Nao acionavel |
| Cor como UNICO indicador de estado | Daltonismo - WCAG 1.4.1 |
| Required marcado SO por cor (red border) | Mesmo motivo |
| Required mostrado SO depois do submit | User nao sabia que era obrigatorio |
| Form sem `<label>` ou `aria-label` | WCAG 3.3.2 |
| Placeholder substituindo label | Some quando user digita - WCAG 3.3.2 |
| Heading skip (h1 -> h3 sem h2) | WCAG 1.3.1 |
| `<img>` sem `alt` | WCAG 1.1.1 |
| `<img alt="image">` ou alt redundante "image of X" | Bom alt descreve conteudo, nao midia |
| Texto sobre imagem sem overlay/contraste garantido | WCAG 1.4.3 |
| Animacao > 400ms em interacao direta | Lenta percebida |
| `prefers-reduced-motion` ignorado | WCAG 2.3.3 |
| Outline removido sem substituto | WCAG 2.4.7 |
| `tabindex` positivo arbitrario (`tabindex="5"`) | Quebra ordem natural - so usar 0 e -1 |
| `lang` ausente em `<html>` | Screen reader pronuncia errado |
| Form action ou href com input user direto | Risco de XSS/redirect aberto |
| `localStorage.setItem('token', ...)` ou similar pra credencial | Risco XSS - usar httpOnly cookie |

## Procedure (uso por agent)

### Doer (escrita/edicao)

#### Passo 1: Detecta tipo de mudanca
Se task toca files de UI, carregue checklist em mente antes de escrever.

#### Passo 2: Para cada componente/template novo
Aplique a checklist de regras 1-10. Em particular:
- Cobre os 5 estados (loading/empty/error/success/disabled)?
- Semantic HTML primeiro?
- Foco visivel mantido?
- Contraste OK em estados claro/escuro?
- Strings via i18n key?

#### Passo 3: Em duvida arquitetural
Consulte references:
- WCAG completo: `references/wcag-checklist.md`
- Estados: `references/state-coverage.md`
- Forms: `references/forms-patterns.md`
- Anti-patterns explicados: `references/anti-patterns.md`

### Reviewer (gate 5)

#### Passo 1: Para cada file modificado em frontend
Roda greps especificos baseados no tipo:

**JSX/TSX/Vue/Svelte:**
```bash
# Boto sem aria-label e sem texto interno
grep -RnE '<button[^>]*>(\s*<[^>]+/?>\s*)+</button>' src/

# Input sem label
grep -RnE '<input(?![^>]*aria-label)(?![^>]*id=)' src/

# href="#" pra acao
grep -RnE 'href="#"' src/

# localStorage com token
grep -RnE 'localStorage\.(set|get)Item.*[Tt]oken' src/

# Outline removido
grep -RnE 'outline\s*:\s*(none|0)' src/
```

**Templates server-side (Razor/Twig/Blade/ERB/Jinja):**
Greps similares adaptados ao syntax.

#### Passo 2: Classifica
- Match em violacao listada na tabela acima -> BLOCK
- Padrao suspeito mas nao certeza -> WARN
- Sem match -> PASS no gate 5

## Inputs esperados

- Path do arquivo modificado
- Diff ou conteudo completo do arquivo

## Outputs

NAO produz arquivo proprio. Modifica julgamento do agent pai:
- Doer escolhe NAO introduzir violation - escreve codigo correto desde o inicio
- Reviewer marca BLOCK/WARN com regra citada

## References

- `references/wcag-checklist.md` - WCAG 2.2 AA expandido com exemplos de codigo
- `references/state-coverage.md` - Padroes pra loading/empty/error/success/disabled em diferentes engines
- `references/forms-patterns.md` - Patterns universais de validacao e UX de form
- `references/anti-patterns.md` - Galeria de anti-patterns com exemplo errado + correcao

## Anti-patterns desta skill

- Aplicar so a stacks JS - regras valem pra qualquer template engine
- Tornar regra de framework especifica (ex: "use React.useState") - skill eh agnostica
- Substituir code review humano de design - skill cobre o tecnicamente quebrado, nao o esteticamente medio
- Bloquear MVP por minor a11y - severity matters, minor eh INFO/WARN

## Examples

### Exemplo 1: Doer recebe task "adicionar botao de delete em ItemCard"

Aplica skill antes de escrever:
- Acao destrutiva precisa: confirmacao explicita, foco volta pro botao origin apos modal fechar, label descritivo (`aria-label="Excluir item Pedido #123"`), undo se possivel
- Estado loading durante request
- Estado error com retry
- Estado success com undo (5s timer)
- Use `<button>`, nao `<a>` ou `<div>`
- Tab order: botao -> modal abre -> botoes do modal navegaveis -> Esc fecha -> foco volta

Codigo escrito ja sai conforme.

### Exemplo 2: Reviewer encontra `<input>` sem label

Marca gate 5 como BLOCK:
```
[BLOCK] src/components/LoginForm.tsx:42
Regra: Forms - Form labels (WCAG 1.3.1, 3.3.2)
Violacao: <input type="email" /> sem <label>, aria-label, ou aria-labelledby
Fix: <label htmlFor="email">Email</label><input id="email" type="email" />
```

### Exemplo 3: Reviewer encontra `localStorage.setItem('access_token', token)`

Marca gate 5 como BLOCK:
```
[BLOCK] src/auth/store.ts:18
Regra: Seguranca UI - Tokens em storage
Violacao: localStorage.setItem com token de autenticacao
Por que: vulneravel a XSS - qualquer script malicioso na pagina le o token
Fix: backend seta httpOnly cookie SameSite=Strict; frontend nao toca em token
```

### Exemplo 4: Backend-only API (Python FastAPI)

Skill nao eh carregada. PROJECT.md tem `frontend.has_frontend: false`. Nada acontece.
