# JDI — Just Do It

Workflow enxuto pra dev solo + AI assistant. Loop adaptativo, atomic commits, file-based state, fresh context per agent, wave-based parallelism. Agents per-project que sabem a stack.

## Por que existe

Workflows AI completos (33+ agents, 60+ comandos, 100+ subworkflows) custam caro em token e ceremony pra projeto solo. JDI cobre o que importa e corta o resto:

- 5 agents core, 6 comandos no loop principal, 1 meta
- Doer/reviewer **per-project** (gerados pelo `/jdi-bootstrap`) que ja sabem stack/build/test/lint
- File-based state em `.jdi/`, decisoes locked imutaveis (D-XX)
- Multi-runtime: Claude Code, GitHub Copilot, Antigravity, OpenCode

Em vez de doer generico que descobre stack a cada execucao, voce tem `jdi-doer-{slug}` que JA SABE.

## Loop em 7 etapas

```
/jdi-new "<descricao>"   <- entry: research + PROJECT.md + ROADMAP.md
/jdi-bootstrap           <- gera doer + reviewer per-project
/jdi-discuss <N>         <- captura decisoes locked (CONTEXT.md)
/jdi-plan <N>            <- decompoe em tasks + waves (PLAN.md)
/jdi-do <N>              <- executa via doer specialist (SUMMARY.md)
/jdi-verify <N>          <- gates via reviewer (REVIEW.md)
/jdi-ship <N>            <- atualiza ROADMAP, avanca phase
```

## Quickstart — `npx` em 30 segundos

```bash
cd /path/to/seu/projeto
npx jdi-cli@latest install opencode
```

Pronto. Substitui `opencode` por `claude`, `copilot`, `antigravity` ou `all` conforme runtime ativo.

> Sem `cd` antes? `npx` roda no diretorio atual. Sempre confirme com `pwd` (Linux/Mac) ou `Get-Location` (Windows).

### Pre-requisitos

- **Node.js 18+** (pra `npx`)
- **git**
- Pelo menos 1 runtime: Claude Code, GitHub Copilot, Antigravity, OpenCode

Zero dependencias Node — JDI usa stdlib only.

### Comandos npx

```bash
# Install (default scope: project)
npx jdi-cli@latest install claude
npx jdi-cli@latest install copilot
npx jdi-cli@latest install antigravity --scope user
npx jdi-cli@latest install opencode
npx jdi-cli@latest install all                    # todos runtimes ao mesmo tempo

# Diagnostico
npx jdi-cli@latest doctor
npx jdi-cli@latest doctor --verbose

# Versao
npx jdi-cli@latest --version

# Help
npx jdi-cli@latest help
```

> Use `@latest` pra forcar pull da versao mais recente. Sem `@latest`, npx usa a primeira versao bem-conhecida em cache (que pode estar desatualizada).

### Install global (opcional)

Se voce vai usar JDI varias vezes:

```bash
npm i -g jdi-cli
jdi install opencode
jdi doctor
```

Depois disso `jdi` funciona direto sem `npx`.

### Update pra versao mais recente

```bash
cd /path/to/seu/projeto
npx jdi-cli@latest install <runtime>
```

State em `.jdi/` eh preservado. Specialists em `.jdi/agents/` tambem.

### Primeiro projeto

Apos install, abre teu runtime favorito no diretorio do projeto e roda:

```
/jdi-new "TODO app .NET 10 + React 19"
```

Researcher faz 4 perguntas (visao, stack, code design, MVP features). Gera `PROJECT.md` + `ROADMAP.md`.

```
/jdi-bootstrap
```

Architect modo specialist faz 6-9 perguntas (test framework, build/test commands, coverage, lint, conventions, **e — se detectar UI — dev server, URL e rotas criticas**). Gera `.jdi/agents/jdi-doer-{slug}.md` + `.jdi/agents/jdi-reviewer-{slug}.md` customizados pra TUA stack.

```
/jdi-discuss 1
/jdi-plan 1
/jdi-do 1
/jdi-verify 1
/jdi-ship 1
```

Phase 1 entregue. Repete pra phase 2, 3, etc.

### Power users — scripts shell direto (sem Node)

Se voce nao quer Node (containers minimal, ambientes restritos, etc), JDI shipa scripts standalone.

```bash
git clone https://github.com/slipalison/jdi-cli.git
cd jdi-cli

# Build adapters
./bin/jdi-build.sh                 # Linux/Mac
.\bin\jdi-build.ps1                # Windows

# Install no projeto
cd /path/to/seu/projeto
/path/to/jdi-cli/bin/jdi-install.sh claude --scope project          # Linux/Mac
C:\path\to\jdi-cli\bin\jdi-install.ps1 -Runtime claude -Scope project   # Windows
```

**Nota Windows:** se PowerShell bloquear `.ps1`:
```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
# Ou:
pwsh -ExecutionPolicy Bypass -File .\bin\jdi-build.ps1
```

## Frontend support — UI/UX gates + Playwright

Se teu projeto tem interface web, JDI ativa automaticamente um conjunto extra de gates focados em UI/UX. Detecta frontend olhando `package.json` (React, Vue, Svelte, Solid, Angular, Astro, Next, Nuxt, Remix, SvelteKit, Qwik), arquivos Razor/Blazor (`*.razor, *.cshtml`), templates Django/Flask (`templates/*.html`), Rails (`app/views/*.erb`), Laravel (`resources/views/*.blade.php`), ou `index.html` solto.

### O que liga automaticamente

**Skill `frontend-rules`** — checklist universal de UI/UX baseado em **WCAG 2.2 AA + Nielsen heuristics + Material/Apple HIG**. Framework-agnostica — vale React, Vue, Blazor, Razor, Twig, ERB, Blade, qualquer template engine. Cobre:

- Acessibilidade (contraste 4.5:1, foco visivel, keyboard nav, ARIA, semantic HTML, touch targets, labels)
- Estados obrigatorios (loading / empty / error / success / disabled)
- Forms (validacao, autocomplete, inputmode, password toggle, confirmacao destrutiva)
- Performance UX (CLS < 0.1, LCP < 2.5s, INP < 200ms, optimistic UI)
- Responsivo mobile-first
- i18n + l10n + RTL
- Seguranca UI (token nunca em localStorage, CSP, CSRF, target=_blank com noopener)
- Tabela de **anti-patterns BLOCK** com regra WCAG citada

Doer aplica antes de escrever codigo. Reviewer usa como checklist no gate 5.

**Skill `frontend-validator`** — gate 7 do reviewer. Roda Playwright + axe-core em browser real:

1. Detecta Playwright. Se ausente, **pergunta antes de instalar** (4 opcoes: Chromium / todos browsers / pular gate 7 / cancelar review)
2. Detecta package manager via lockfile (npm / pnpm / yarn / bun)
3. Spawna teu dev server, aguarda ready (poll 60s timeout)
4. Pra cada rota critica × **mobile (375×667)** + **desktop (1280×720)**:
   - Captura console errors
   - Captura network failures (4xx, 5xx, requestfailed)
   - Roda axe-core (WCAG 2.0/2.1/2.2 AA + best-practices)
   - Detecta horizontal scroll
   - Screenshot fullpage
5. Mata dev server (sempre, mesmo em erro)
6. Output JSON em `.jdi/cache/ui-findings.json`

### Classificacao de findings

| Finding | Severity |
|---|---|
| Console error em qualquer route | BLOCK |
| Network 5xx em rota critica | BLOCK |
| A11y violation `critical` ou `serious` | BLOCK |
| Horizontal scroll mobile | BLOCK |
| A11y violation `moderate`, network 4xx | WARN |
| A11y violation `minor`, scroll desktop | INFO |
| Dev server timeout | INCONCLUSIVE (warn) |
| User recusou Playwright install | SKIPPED (warn) |

Nunca BLOCK por motivo tecnico — so por findings reais. `.jdi/cache/` eh gitignored automaticamente.

### Como ligar

Voce nao precisa fazer nada. Quando rodar `/jdi-bootstrap` em projeto com UI:

1. Auto-detect dispara
2. Bootstrap pergunta: "Detectei React em `package.json`. Confirmar que tem frontend?"
3. Se sim, 3 perguntas extras: dev server command (default por framework), frontend URL (default por framework), critical paths (default `/`)
4. Persiste secao `frontend:` em `PROJECT.md`
5. Injeta `<skills_to_load>` no doer + reviewer

Daqui em diante, `/jdi-do` carrega `frontend-rules` quando tarefa toca arquivo de UI; `/jdi-verify` roda gate 7 com Playwright.

### Como desligar

Edita `PROJECT.md`:
```yaml
frontend:
  has_frontend: false
```

Gate 7 pula com `SKIPPED`. Skill nao carrega.

## Estrutura final apos install

```
seu-projeto/
+-- .jdi/                            <- state files do JDI
|   +-- PROJECT.md, ROADMAP.md, STATE.md, DECISIONS.md
|   +-- specialists.md, reviewers.md, registry.md
|   +-- agents/                      <- specialists per-project
|   |   +-- jdi-doer-{slug}.md
|   |   +-- jdi-reviewer-{slug}.md
|   +-- phases/{NN-slug}/
|       +-- CONTEXT.md, PLAN.md, SUMMARY.md, REVIEW.md
+-- .claude/                          (se runtime=claude)
|   +-- agents/jdi-*.md
|   +-- commands/jdi-*.md
|   +-- settings.example.json
+-- .githooks/                        (no-op por padrao)
+-- .gitattributes                    (normaliza CRLF)
+-- CLAUDE.md                         (instrucoes pro runtime)
+-- {seu codigo}
```

Pra outros runtimes, troca `.claude/` por `.github/`, `.gemini/antigravity/`, ou `.opencode/`. Ver [PORTABILITY.md](PORTABILITY.md).

## Agents (5 core + 2 per-project) e Skills (2 condicionais)

Core agents (shipped):
- `jdi-researcher` (Opus) — discover pre-roadmap
- `jdi-bootstrap` (Sonnet) — wrapper que gera specialists
- `jdi-asker` (Sonnet) — loop de perguntas
- `jdi-planner` (Opus) — decompose phase em tasks + waves
- `jdi-architect` (Opus) — meta (modos create + specialist)

Per-project (gerados):
- `jdi-doer-{slug}` (Sonnet) — executor que sabe a stack
- `jdi-reviewer-{slug}` (Sonnet) — gates de qualidade da stack (read-only)

Skills condicionais (carregadas se `has_frontend=true`):
- `frontend-rules` — checklist universal WCAG 2.2 AA + UX heuristics, framework-agnostico
- `frontend-validator` — gate 7 do reviewer com Playwright + axe-core

Detalhes em [AGENTS.md](AGENTS.md).

## Commands (8 total)

Loop principal: `jdi-new`, `jdi-bootstrap`, `jdi-discuss`, `jdi-plan`, `jdi-do`, `jdi-verify`, `jdi-ship`.

Meta: `jdi-create` (so contributors no repo JDI fonte).

Detalhes em [COMMANDS.md](COMMANDS.md).

## Runtimes suportados

| Runtime | Status | npx (cross-platform) |
|---|---|---|
| Claude Code | tier 1 | `npx jdi-cli install claude` |
| GitHub Copilot | tier 1 | `npx jdi-cli install copilot` |
| Google Antigravity | tier 2 | `npx jdi-cli install antigravity --scope user` |
| OpenCode | tier 1 | `npx jdi-cli install opencode` |
| Todos | — | `npx jdi-cli install all` |

Default scope: `project`. Pra global: `--scope user`.

**Power users (scripts shell direto):**

| Runtime | Bash | PowerShell |
|---|---|---|
| Claude | `jdi-install.sh claude` | `jdi-install.ps1 -Runtime claude` |
| OpenCode | `jdi-install.sh opencode --scope user` | `jdi-install.ps1 -Runtime opencode -Scope user` |

> Detalhes de portabilidade em [PORTABILITY.md](PORTABILITY.md).

## Update

```bash
cd /path/to/seu/projeto
npx jdi-cli@latest install <runtime>
```

`@latest` forca pull da versao mais recente do npm. State em `.jdi/` eh preservado. Specialists em `.jdi/agents/` tambem (so regerados se voce roda `/jdi-bootstrap` de novo).

**Power users (clone fonte):**

Linux/Mac:
```bash
cd /path/to/jdi-cli && git pull
./bin/jdi-build.sh
cd /path/to/seu/projeto
/path/to/jdi-cli/bin/jdi-install.sh claude
```

Windows:
```powershell
cd C:\path\to\jdi-cli; git pull
.\bin\jdi-build.ps1
cd C:\path\to\seu\projeto
C:\path\to\jdi-cli\bin\jdi-install.ps1 -Runtime claude
```

## Verify (doctor)

```bash
npx jdi-cli doctor              # ou: jdi doctor (se instalado global)
npx jdi-cli doctor --verbose
```

**Power users:**

Linux/Mac:
```bash
/path/to/jdi-cli/bin/jdi-doctor.sh
```

Windows:
```powershell
C:\path\to\jdi-cli\bin\jdi-doctor.ps1
```

Roda 9 secoes de verificacao:
1. Dependencias (git, bash detection)
2. Runtimes instalados (claude, copilot, antigravity, opencode)
3. Tooling opcional (ctx7, gh)
4. Repo JDI integro (core/)
5. Adapters buildados (runtimes/)
6. Projeto atual (.jdi/ files)
7. Runtime instalado no projeto
8. Git hooks configurados
9. Working tree limpo

## Desinstalar

```bash
rm -rf .claude/ .github/ .gemini/antigravity/ .opencode/ .jdi/ .githooks/ CLAUDE.md AGENTS.md
git checkout -- .gitattributes  # ou rm se voce criou so pra JDI
```

State files em `.jdi/` removidos perdem decisoes locked. Faca backup se importante.

## Reset total (apaga tudo + reinicia)

```
/jdi-new --reset "<nova descricao>"
```

Apaga `.jdi/` apos confirmacao. Recria do zero. **CUIDADO** — perde DECISIONS.md, ROADMAP.md, etc.

## Filosofia

1. **Fresh context per agent** — cada spawn tem janela limpa
2. **Thin orchestrator** — comando carrega contexto, spawn agente, roteia
3. **File-based state** — `.jdi/` em md/json, sem DB
4. **Decisao locked = imutavel** — D-XX nunca volta
5. **1 task = 1 commit atomico**
6. **Per-project specialists** — doer/reviewer customizados, nao genericos
7. **Wave-based parallelism** — paralelo dentro da wave, sequencial entre
8. **Security > Perf > Best Practices**

## Troubleshooting

### Build script falha em Linux/Mac

Verifique deps: `bash --version`, `awk --version`, `sed --version`. Use bash >= 4.

### Windows: scripts .sh nao rodam em PowerShell

Use os equivalentes `.ps1`:
- `bin/jdi-build.sh` -> `bin/jdi-build.ps1`
- `bin/jdi-install.sh` -> `bin/jdi-install.ps1`
- `bin/jdi-doctor.sh` -> `bin/jdi-doctor.ps1`

Ou rode em Git Bash / WSL.

### Windows: PowerShell bloqueia execucao do .ps1

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
# OU
pwsh -ExecutionPolicy Bypass -File .\bin\jdi-build.ps1
```

Apos download, pode precisar `Unblock-File`:
```powershell
Get-ChildItem .\bin\*.ps1 | Unblock-File
```

### Windows: git hooks (.githooks/pre-commit) nao executam

Hooks sao bash scripts. Em Windows, precisa de Git for Windows (traz bash.exe). Sem ele, hooks sao silenciosamente ignorados.

JDI default: hooks sao no-op. Se voce nao customizar, isso nao bloqueia nada.

### Slash command nao aparece no runtime

```bash
ls .claude/commands/        # ou .github/prompts/, .opencode/commands/
```

Se vazio, reinstale:

Linux/Mac:
```bash
/path/to/jdi-cli/bin/jdi-install.sh <runtime> --scope project
```

Windows:
```powershell
C:\path\to\jdi-cli\bin\jdi-install.ps1 -Runtime <runtime> -Scope project
```

### Specialist nao foi gerado pelo /jdi-bootstrap

Verifique `PROJECT.md` tem stack/code-design completos. Edita manual e rode bootstrap de novo:

```
/jdi-bootstrap
```

Idempotente — pergunta antes de sobrescrever.

### Phase BLOCKED no /jdi-verify, nao consigo /jdi-ship

REVIEW.md mostra blockers. Corrige codigo, roda `/jdi-do <N>` de novo (re-executa tasks afetadas), depois `/jdi-verify <N>`. Quando veredicto != BLOCKED, ship libera.

### Tokens muito altos em phase grande

PLAN.md com >8 tasks indica phase grande demais. Split:
1. Edita ROADMAP.md, divide phase atual em 2 ou 3
2. Roda `/jdi-discuss <N>` em cada (cada uma vira CONTEXT.md menor)

## Veja tambem

- [ARCHITECTURE.md](ARCHITECTURE.md) — visao tecnica
- [AGENTS.md](AGENTS.md) — agents detalhados
- [COMMANDS.md](COMMANDS.md) — comandos detalhados
- [MEMORY.md](MEMORY.md) — schema dos files em `.jdi/`
- [EXTENSION.md](EXTENSION.md) — criar specialists/agents/skills
- [CREATE.md](CREATE.md) + [CREATE-EXAMPLE.md](CREATE-EXAMPLE.md) — `/jdi-create` walkthrough
- [PORTABILITY.md](PORTABILITY.md) — multi-runtime detalhado

## Licenca

MIT.

## Contribuindo

Rode `/jdi-create` dentro do repo JDI fonte pra adicionar agents/skills genericos. Roda no template `core/templates/{agent,skill}.md` + integration automatica.

Pull requests: descreve o problema (quem precisa? quantos users?) antes de adicionar agent novo. JDI cresce **com cuidado** — soft cap 5 agents core, 25 skills core. Veja [EXTENSION.md](EXTENSION.md).

## Publishing pro npm (mantenedores)

```bash
# 1. Bump versao no package.json
# 2. Rebuild runtimes/
node bin/jdi.js build

# 3. Test local antes de publicar
npm pack
npx ./jdi-cli-X.Y.Z.tgz install opencode --scope project   # smoke test em dir vazio

# 4. Publish
npm login
npm publish --access public

# 5. Tag git
git tag vX.Y.Z
git push --tags
```

`package.json` `files:` controla o que vai pro tarball. Excluido por default: `node_modules/`, `.git/`, testes locais, `*.tgz` gerados.
