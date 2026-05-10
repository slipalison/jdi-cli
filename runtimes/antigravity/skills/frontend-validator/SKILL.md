---
name: frontend-validator
description: Valida UI viva via Playwright + axe-core. Detecta Playwright; instala se ausente (com consent do user). Spawna dev server, navega rotas criticas em mobile+desktop, captura console errors, network failures, a11y violations, screenshots, layout shifts. Output JSON estruturado pro reviewer parsear.
triggers:
  - "validar UI"
  - "rodar playwright"
  - "checar acessibilidade"
  - "smoke test frontend"
  - "validar interface viva"
---

# Skill: jdi-frontend-validator

Roda validacao UI em browser real. Sem Playwright instalado, instala com consent. Output sempre JSON em `.jdi/cache/ui-findings.json` pro reviewer pai consumir.

## Quando aplicar

Reviewer chama no gate 7. Pre-condicoes em PROJECT.md:

```yaml
frontend:
  has_frontend: true
  frontend_url: http://localhost:5173
  dev_command: pnpm dev
  critical_paths:
    - /
    - /login
    - /dashboard
```

Sem alguma chave -> aborta com erro descritivo.

## Procedure

### Passo 1: Pre-flight

```bash
# bash
test -d .jdi/ || { echo "Sem .jdi/. Rode /jdi-new"; exit 1; }
test -f .jdi/PROJECT.md || { echo "PROJECT.md ausente"; exit 1; }

# Le frontend.has_frontend, frontend_url, dev_command, critical_paths
# (parse YAML simples - assume formato bem-definido)

# Cria cache
mkdir -p .jdi/cache/screenshots

# .gitignore garantia
grep -q '^\.jdi/cache/' .gitignore 2>/dev/null || echo '.jdi/cache/' >> .gitignore
```

```powershell
# PowerShell
if (-not (Test-Path .jdi)) { Write-Error "Sem .jdi/. Rode /jdi-new"; exit 1 }
if (-not (Test-Path .jdi/PROJECT.md)) { Write-Error "PROJECT.md ausente"; exit 1 }

New-Item -ItemType Directory -Force -Path .jdi/cache/screenshots | Out-Null

if (-not (Test-Path .gitignore) -or -not (Select-String -Path .gitignore -Pattern '^\.jdi/cache/' -Quiet)) {
  Add-Content .gitignore '.jdi/cache/'
}
```

### Passo 2: Detecta gerenciador de pacote

Lockfile detection (mais confiavel que `which`):

```bash
# bash
if [ -f pnpm-lock.yaml ]; then PKG_MGR=pnpm
elif [ -f yarn.lock ]; then PKG_MGR=yarn
elif [ -f bun.lockb ] || [ -f bun.lock ]; then PKG_MGR=bun
elif [ -f package-lock.json ]; then PKG_MGR=npm
else PKG_MGR=npm  # fallback
fi
```

```powershell
# PowerShell
if (Test-Path pnpm-lock.yaml) { $PKG_MGR = "pnpm" }
elseif (Test-Path yarn.lock) { $PKG_MGR = "yarn" }
elseif ((Test-Path bun.lockb) -or (Test-Path bun.lock)) { $PKG_MGR = "bun" }
elseif (Test-Path package-lock.json) { $PKG_MGR = "npm" }
else { $PKG_MGR = "npm" }
```

Comando install correspondente:

| Pkg mgr | Install dev dep | Run binario |
|---|---|---|
| npm | `npm install --save-dev <pkg>` | `npx <bin>` |
| pnpm | `pnpm add -D <pkg>` | `pnpm exec <bin>` ou `pnpm dlx <bin>` |
| yarn | `yarn add -D <pkg>` | `yarn <bin>` |
| bun | `bun add -d <pkg>` | `bunx <bin>` |

### Passo 3: Detecta Playwright

```bash
# bash
PW_BIN="npx --no-install playwright"
[ "$PKG_MGR" = "pnpm" ] && PW_BIN="pnpm exec playwright"
[ "$PKG_MGR" = "yarn" ] && PW_BIN="yarn playwright"
[ "$PKG_MGR" = "bun" ] && PW_BIN="bunx playwright"

if ! $PW_BIN --version >/dev/null 2>&1; then
  PLAYWRIGHT_MISSING=1
fi

# Verifica axe-core/playwright separado
if [ -f package.json ] && ! grep -q '@axe-core/playwright' package.json; then
  AXE_MISSING=1
fi
```

```powershell
# PowerShell - simplificado
$pwExists = $false
try {
  $null = & npx --no-install playwright --version 2>$null
  if ($LASTEXITCODE -eq 0) { $pwExists = $true }
} catch {}
if (-not $pwExists) { $env:PLAYWRIGHT_MISSING = "1" }

$axeExists = $false
if (Test-Path package.json) {
  if (Select-String -Path package.json -Pattern '@axe-core/playwright' -Quiet) { $axeExists = $true }
}
if (-not $axeExists) { $env:AXE_MISSING = "1" }
```

### Passo 4: Se ausente, pede consent + instala

Use AskUserQuestion (ou prompt fallback se runtime sem suporte):

```
Playwright nao instalado neste projeto.

Instalar agora?
- [Sim, instalar com Chromium] (~150MB, 2-5min, recomendado)
- [Sim, instalar com todos browsers] (~500MB, 5-10min)
- [Nao, pular gate 7 desta vez] (gate retorna SKIPPED)
- [Cancelar review inteiro]
```

Mapeamento de escolha:

**Sim, Chromium:**
```bash
$INSTALL_CMD @playwright/test @axe-core/playwright
$PLAYWRIGHT_INSTALL chromium
```

Onde:
- `$INSTALL_CMD` = `pnpm add -D` / `npm install --save-dev` / etc baseado no PKG_MGR
- `$PLAYWRIGHT_INSTALL` = `$PW_BIN install`

**Sim, todos browsers:**
```bash
$INSTALL_CMD @playwright/test @axe-core/playwright
$PLAYWRIGHT_INSTALL
```

**Nao, pular:**
Retorna `{ "status": "SKIPPED", "reason": "user declined Playwright install" }` - reviewer marca gate 7 como SKIPPED (nao BLOCK).

**Cancelar review:**
Retorna codigo de erro, reviewer aborta.

### Passo 5: Gera spec Playwright temporario

Cria `.jdi/cache/playwright-check.spec.js` (gitignored). Conteudo:

```javascript
// Auto-gerado pelo jdi-frontend-validator. NAO edite manualmente.
// @ts-check
const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const fs = require('fs');
const path = require('path');

const URL = process.env.JDI_FRONTEND_URL;
const ROUTES = (process.env.JDI_ROUTES || '/').split(',').map(r => r.trim()).filter(Boolean);
const OUT = process.env.JDI_OUT || '.jdi/cache/ui-findings.json';
const SCREENSHOT_DIR = process.env.JDI_SCREENSHOT_DIR || '.jdi/cache/screenshots';

const VIEWPORTS = [
  { name: 'mobile', width: 375, height: 667 },
  { name: 'desktop', width: 1280, height: 720 }
];

const findings = {
  metadata: { url: URL, routes: ROUTES, timestamp: new Date().toISOString() },
  console: [],
  network: [],
  a11y: [],
  layout: [],
  screenshots: [],
  navigationFailures: []
};

for (const route of ROUTES) {
  for (const viewport of VIEWPORTS) {
    test(`${route} @ ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });

      page.on('console', msg => {
        if (msg.type() === 'error') {
          findings.console.push({
            route,
            viewport: viewport.name,
            text: msg.text(),
            location: msg.location()
          });
        }
      });

      page.on('requestfailed', req => {
        findings.network.push({
          route,
          viewport: viewport.name,
          url: req.url(),
          method: req.method(),
          failure: req.failure()?.errorText,
          severity: 'requestfailed'
        });
      });

      page.on('response', res => {
        if (res.status() >= 500) {
          findings.network.push({
            route,
            viewport: viewport.name,
            url: res.url(),
            status: res.status(),
            severity: '5xx'
          });
        } else if (res.status() >= 400 && res.status() !== 404) {
          findings.network.push({
            route,
            viewport: viewport.name,
            url: res.url(),
            status: res.status(),
            severity: '4xx'
          });
        }
      });

      const targetUrl = `${URL}${route}`;
      let response;
      try {
        response = await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 30000 });
      } catch (err) {
        findings.navigationFailures.push({
          route,
          viewport: viewport.name,
          error: err.message
        });
        return;
      }

      if (!response || !response.ok()) {
        findings.navigationFailures.push({
          route,
          viewport: viewport.name,
          status: response?.status() ?? 'no-response',
          url: targetUrl
        });
        return;
      }

      // Detect horizontal scroll
      const hasHScroll = await page.evaluate(() => {
        return document.documentElement.scrollWidth > document.documentElement.clientWidth + 1;
      });
      if (hasHScroll) {
        findings.layout.push({
          route,
          viewport: viewport.name,
          issue: 'horizontal_scroll'
        });
      }

      // axe-core a11y scan
      try {
        const axeResults = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag22aa', 'best-practice'])
          .analyze();

        for (const v of axeResults.violations) {
          findings.a11y.push({
            route,
            viewport: viewport.name,
            id: v.id,
            impact: v.impact,
            help: v.help,
            helpUrl: v.helpUrl,
            nodes: v.nodes.length,
            sample: v.nodes.slice(0, 3).map(n => ({
              target: n.target,
              html: n.html.slice(0, 200)
            }))
          });
        }
      } catch (err) {
        // axe-core falha nao bloqueia run
        findings.a11y.push({
          route,
          viewport: viewport.name,
          error: `axe-core failed: ${err.message}`
        });
      }

      // Screenshot
      const safeName = (route === '/' ? 'root' : route.replace(/^\//, '').replace(/\//g, '_'));
      const screenshotPath = path.join(SCREENSHOT_DIR, `${safeName}_${viewport.name}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });
      findings.screenshots.push({ route, viewport: viewport.name, path: screenshotPath });
    });
  }
}

test.afterAll(() => {
  fs.writeFileSync(OUT, JSON.stringify(findings, null, 2));
});
```

E config inline `.jdi/cache/playwright.config.js`:

```javascript
module.exports = {
  testDir: '.jdi/cache',
  testMatch: 'playwright-check.spec.js',
  timeout: 60000,
  retries: 0,
  workers: 1,
  reporter: [['line']],
  use: {
    headless: true,
    ignoreHTTPSErrors: true
  }
};
```

### Passo 6: Spawna dev server

```bash
# bash
DEV_LOG=.jdi/cache/dev-server.log
DEV_PID_FILE=.jdi/cache/dev-server.pid

# Spawna em background, redirecionando log
nohup $DEV_COMMAND > $DEV_LOG 2>&1 &
echo $! > $DEV_PID_FILE

# Aguarda ready (poll URL, timeout 60s)
READY=0
for i in $(seq 1 60); do
  if curl -sSf -o /dev/null --max-time 2 "$FRONTEND_URL"; then
    READY=1
    break
  fi
  sleep 1
done

if [ $READY -eq 0 ]; then
  # Cleanup
  kill $(cat $DEV_PID_FILE) 2>/dev/null
  echo '{"status":"INCONCLUSIVE","reason":"dev server failed to start in 60s","logs":"'$DEV_LOG'"}' > .jdi/cache/ui-findings.json
  exit 0  # nao falha o reviewer - INCONCLUSIVE eh WARN
fi
```

```powershell
# PowerShell
$DEV_LOG = ".jdi/cache/dev-server.log"
$DEV_PID_FILE = ".jdi/cache/dev-server.pid"

$proc = Start-Process -FilePath pwsh -ArgumentList "-NoProfile", "-Command", $DEV_COMMAND `
  -RedirectStandardOutput $DEV_LOG -RedirectStandardError $DEV_LOG `
  -PassThru -WindowStyle Hidden
$proc.Id | Out-File -FilePath $DEV_PID_FILE

$ready = $false
for ($i = 0; $i -lt 60; $i++) {
  try {
    $r = Invoke-WebRequest -Uri $FRONTEND_URL -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
    if ($r.StatusCode -eq 200) { $ready = $true; break }
  } catch {}
  Start-Sleep -Seconds 1
}

if (-not $ready) {
  Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
  $err = @{ status="INCONCLUSIVE"; reason="dev server failed to start in 60s"; logs=$DEV_LOG } | ConvertTo-Json
  $err | Out-File .jdi/cache/ui-findings.json
  exit 0
}
```

### Passo 7: Roda Playwright

```bash
# bash
JDI_FRONTEND_URL="$FRONTEND_URL" \
JDI_ROUTES="$(echo $CRITICAL_PATHS | tr '\n' ',')" \
JDI_OUT=".jdi/cache/ui-findings.json" \
JDI_SCREENSHOT_DIR=".jdi/cache/screenshots" \
  $PW_BIN test --config=.jdi/cache/playwright.config.js 2>&1 | tee .jdi/cache/playwright.log

# Exit code do Playwright nao importa - findings ja escritos pelo afterAll
```

```powershell
# PowerShell
$env:JDI_FRONTEND_URL = $FRONTEND_URL
$env:JDI_ROUTES = ($CRITICAL_PATHS -join ',')
$env:JDI_OUT = ".jdi/cache/ui-findings.json"
$env:JDI_SCREENSHOT_DIR = ".jdi/cache/screenshots"

& npx playwright test --config=.jdi/cache/playwright.config.js 2>&1 | Tee-Object -FilePath .jdi/cache/playwright.log
```

### Passo 8: Mata dev server (sempre, mesmo se falhou)

```bash
# bash
if [ -f $DEV_PID_FILE ]; then
  PID=$(cat $DEV_PID_FILE)
  # Kill processo + filhos (dev server geralmente tem children: node, esbuild, vite, etc)
  pkill -P $PID 2>/dev/null
  kill $PID 2>/dev/null
  # Garantia em portas comuns (caso PID errado)
  # Vite: 5173, Next: 3000, etc - skip cleanup agressiva
  rm $DEV_PID_FILE
fi
```

```powershell
# PowerShell
if (Test-Path $DEV_PID_FILE) {
  $pid = Get-Content $DEV_PID_FILE
  # Kill filhos primeiro
  Get-CimInstance Win32_Process -Filter "ParentProcessId=$pid" -ErrorAction SilentlyContinue |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  # Kill o pai
  Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
  Remove-Item $DEV_PID_FILE
}
```

### Passo 9: Retorna pra reviewer pai

Skill nao escreve REVIEW.md. So escreve `.jdi/cache/ui-findings.json` + screenshots.

Reviewer le o JSON, classifica severities, e escreve secao "UI Validation" no REVIEW.md.

## Classificacao de findings (referencia pro reviewer)

| Finding | Severity |
|---|---|
| `console.error` em qualquer route | BLOCK |
| `network.5xx` em critical_path | BLOCK |
| `network.4xx` em critical_path | WARN |
| `network.requestfailed` (CORS/abort/etc) | WARN |
| `navigationFailures` (404/timeout/etc em critical_path) | BLOCK |
| `a11y.impact=critical` | BLOCK |
| `a11y.impact=serious` | BLOCK |
| `a11y.impact=moderate` | WARN |
| `a11y.impact=minor` | INFO |
| `layout.horizontal_scroll` em mobile | BLOCK |
| `layout.horizontal_scroll` em desktop | INFO |
| `axe-core failed` (erro tecnico) | WARN |
| `INCONCLUSIVE` (dev server timeout) | WARN |
| `SKIPPED` (user recusou install) | WARN |

## Inputs esperados

Do PROJECT.md (passados como variaveis de ambiente pelo reviewer):
- `frontend.frontend_url` -> `FRONTEND_URL`
- `frontend.dev_command` -> `DEV_COMMAND`
- `frontend.critical_paths` -> `CRITICAL_PATHS` (lista)

## Outputs

Files criados em `.jdi/cache/` (gitignored):
- `ui-findings.json` - findings estruturados
- `screenshots/*.png` - 1 por route x viewport
- `dev-server.log` - log do dev server
- `playwright.log` - log do Playwright run
- `playwright-check.spec.js` - spec gerado
- `playwright.config.js` - config gerado

NUNCA commita `.jdi/cache/`.

## Anti-patterns

- Rodar contra prod URL - so dev local. Prod fica fora deste gate
- Testar fluxos que requerem login - MVP nao suporta auth setup. Critical paths devem ser publicos OU pre-autenticados manualmente (cookie/session passado via PROJECT.md em followup)
- Travar review se Playwright install falhar - degrade pra SKIPPED
- Deixar dev server vivo apos gate - sempre kill, mesmo em erro
- Commitar screenshots - .gitignore garantido em pre-flight
- Rodar paralelo (workers > 1) - dev server local nao escala, e race conditions confundem findings
- Usar `--headed` em CI - sempre headless
- Confiar no exit code do Playwright - findings vem do afterAll, mesmo com test failure

## References

- `references/playwright-setup.md` - Install detalhado por package manager + troubleshoot
- `references/dev-server-detection.md` - Heuristicas de detect ready (curl, wait-on, polling)
- `references/axe-rules.md` - Mapeamento axe rule IDs -> WCAG -> severity
- `references/auth-flows.md` - Roadmap pra fluxos autenticados (futuro)

## Examples

### Exemplo 1: Vite + React, Playwright ausente, user aceita install

```
1. Reviewer dispara gate 7
2. Skill detecta `npx playwright --version` -> exit 1
3. Lockfile = pnpm-lock.yaml -> PKG_MGR=pnpm
4. AskUserQuestion -> user escolhe "Sim, Chromium"
5. pnpm add -D @playwright/test @axe-core/playwright
6. pnpm exec playwright install chromium
7. Spawna `pnpm dev` em bg, PID 12345
8. Aguarda http://localhost:5173 -> ready em 4s
9. Roda Playwright em /, /login, /dashboard x mobile + desktop = 6 navegacoes
10. Findings:
    - 1 console error (uncaught promise) em /dashboard mobile + desktop
    - 0 network errors
    - 2 a11y serious em /login (label faltando + contraste)
    - 1 horizontal scroll em /dashboard mobile
11. Kill PID 12345 + filhos
12. Escreve .jdi/cache/ui-findings.json
13. Reviewer le JSON, marca gate 7 = BLOCK (3 issues), escreve REVIEW.md
```

### Exemplo 2: API-only, has_frontend=false

Skill nem eh carregada. Reviewer pula gate 7 com SKIPPED.

### Exemplo 3: Dev server falha em iniciar

```
1. Spawna `pnpm dev` -> processo morre apos 2s (porta 5173 ocupada)
2. Poll de 60s expira sem 200 OK
3. Cleanup do PID
4. Escreve {"status":"INCONCLUSIVE","reason":"dev server failed to start in 60s"}
5. Reviewer marca gate 7 = WARN com link pro dev-server.log
6. Review nao bloqueado, mas usuario alerta
```

### Exemplo 4: User recusa instalar Playwright

```
1. AskUserQuestion -> "Nao, pular gate 7"
2. Escreve {"status":"SKIPPED","reason":"user declined Playwright install"}
3. Reviewer marca gate 7 = SKIPPED (warn nao block)
4. REVIEW.md anota "UI Validation: SKIPPED - rode /jdi-verify novamente quando aceitar instalar"
```
