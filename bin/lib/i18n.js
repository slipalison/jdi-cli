'use strict';

// =================================================================
// i18n — catalogo de mensagens do CLI (en / pt-BR), zero deps
// =================================================================
//
// Cobre so o "chrome" do CLI (bin/jdi.js + bin/lib/ui.js): banners,
// help, sumarios de sucesso/erro, next-steps. Nomes de comando, flags,
// caminhos de arquivo e valores literais de estado ficam em ingles nos
// dois idiomas (mesma convencao adotada em README.pt-BR.md).
//
// Selecao via `--lang <en|pt-BR>` (ver resolveLang). Sem flag, default
// e `en`.

const { format } = require('node:util');

const DEFAULT_LANG = 'en';
const SUPPORTED = ['en', 'pt-BR'];

// Aliases aceitos em --lang, normalizados pro id canonico.
const LANG_ALIASES = {
  en: 'en',
  'en-us': 'en',
  pt: 'pt-BR',
  'pt-br': 'pt-BR',
  pt_br: 'pt-BR',
};

const CATALOG = {
  en: {
    // Shared labels
    'label.directory': 'Directory',
    'label.scope': 'Scope',
    'label.platform': 'Platform',
    'label.source': 'Source',
    'label.output': 'Output',
    'label.runtime': 'Runtime',
    'label.exit_code': 'Exit code',

    // Errors / validation
    'error.runtime_required': 'Runtime is required.',
    'error.runtimes_label': 'Runtimes',
    'error.runtime_invalid': 'Invalid runtime: %s',
    'error.valid_options': 'Valid',
    'error.scope_invalid': 'Invalid scope: %s',
    'error.unknown_command': 'Unknown command: %s',
    'error.see_help': 'Use %s to see available commands.',
    'error.script_not_found': 'Script not found: %s',
    'error.invalid_lang': 'Invalid --lang "%s". Supported: %s',

    // install
    'install.header': 'Installing JDI for %s',
    'install.spinner': 'Installing adapters for %s...',
    'install.success_title': 'JDI installed successfully',
    'install.next1': 'Open your runtime (%s) in the project directory',
    'install.next2': 'Run %s to initialize',
    'install.next2_cmd': '/jdi-new "<project description>"',
    'install.next3': 'Then %s to create per-project specialists',
    'install.next4': 'Run %s for diagnostics',
    'install.fail_title': 'Installation failed',
    'install.fail_hint': 'Try %s for diagnostics',

    // build
    'build.header': 'Building JDI runtimes',
    'build.success_title': 'Build complete',
    'build.success_line1': '4 runtimes generated (claude, copilot, antigravity, opencode)',
    'build.success_line2': 'Adapters in %s',
    'build.next1': 'Install in project: %s',
    'build.next2': 'Diagnostics: %s',
    'build.fail_title': 'Build failed',

    // update / uninstall / doctor headers
    'update.header': 'JDI Update',
    'uninstall.header': 'JDI Uninstall',
    'doctor.header': 'JDI Doctor',
    'doctor.dir_label': 'Current directory',

    // install-playwright
    'playwright.header': 'JDI: Install Playwright + MCP',
    'playwright.success_title': 'Playwright + MCP ready',
    'playwright.line_installed': '@playwright/test installed',
    'playwright.line_browser_installed': 'chromium browser installed',
    'playwright.line_browser_skipped': 'chromium browser skipped',
    'playwright.line_mcp_injected': 'MCP config injected (where runtime present)',
    'playwright.line_mcp_skipped': 'MCP config skipped',
    'playwright.next1': 'Restart your runtime to pick up MCP changes',
    'playwright.next2': 'Claude Code: %s to verify',
    'playwright.next3': 'OpenCode: %s',
    'playwright.fail_title': 'Playwright install failed',

    // install-caveman
    'caveman.header': 'JDI: Install Caveman plugin',
    'caveman.success_title': 'Caveman ready',
    'caveman.line_cloned': 'Plugin cloned',
    'caveman.line_restart': 'Restart Claude Code to load',
    'caveman.next1': 'Verify: %s',
    'caveman.next2': 'Toggle mode: %s',
    'caveman.fail_title': 'Caveman install failed',

    // help
    'help.usage_label': 'Usage:',
    'help.usage_line': 'npx jdi-cli <command> [options]',
    'help.commands_label': 'Commands:',
    'help.cmd.install': 'Installs JDI in the current project',
    'help.cmd.update': 'Updates an already-installed JDI (preserves state)',
    'help.cmd.uninstall': 'Removes JDI from the project (preserves .jdi/ by default)',
    'help.cmd.build': 'Rebuilds runtimes/ from core/',
    'help.cmd.doctor': 'Project + JDI diagnostics',
    'help.cmd.install_playwright': 'Installs @playwright/test + chromium + MCP config',
    'help.cmd.install_caveman': 'Installs the caveman plugin (ultra-compressed mode)',
    'help.cmd.help': 'Shows this help',
    'help.cmd.version': 'Shows version',
    'help.helpers_label': 'Helpers (plumbing used by slash commands):',
    'help.helper.resolve_phase': 'Resolves phase id -> slug/dir/position',
    'help.helper.validate_slug': 'Validates slug shape',
    'help.helper.validate_phase': 'Validates phase artifacts (mechanical gate for CI and agents)',
    'help.helper.truncate': 'Truncates file while preserving structure',
    'help.helper.monitor': 'Deprecated: estimates the size of the given files (not the session)',
    'help.helper.render': 'Regenerates .jdi/ views (conflict-free layout v3)',
    'help.helper.migrate_layout': 'Migrates legacy .jdi/ to the conflict-free layout (v3)',
    'help.helper.sync_specialists': 'Materializes .jdi/agents/ specialists into the runtime agent dirs',
    'help.helper.cost': 'Token cost of this project from local Claude Code transcripts (--targets, --json)',
    'help.helper.template': 'Prints a template shipped in the package (dod-schema, specialists, config)',
    'help.helper.learnings': 'Learnings of the N most recently shipped phases, by ship date',
    'help.helper.decisions': 'Locked decisions: index, by id, by phase or recent — never the whole view',
    'help.helper.next': 'Next command for the phase, derived from its artifacts (--status: the status screen)',
    'help.helper.add_phase': 'Adds a phase to the v3 roadmap (slug, order, created_with, audit decision)',
    'help.helper.ship': 'Ships a phase: guards, SHIPPED.md, learnings, archive',
    'help.helper.dod': 'Definition of Done as data: parse, lint, extract long Verify into scripts, bait (mutation check)',
    'help.helper.brief': 'Capped starting context of an agent, written to .jdi/cache/briefs/',
    'help.helper.gates': 'Runs build/test/coverage/lint and the DoD once, outside agent context',
    'help.helper.review': 'Worst-case verdict of REVIEW.md; blockers; incremental verify plan/merge; freshness',
    'help.helper.loop': 'Ralph loop bookkeeping: record a verify, reset, status',
    'help.helper.budgets': 'Token budgets of the phase artifacts',
    'help.helper.known_errors': 'Known errors per entry: query by files and stage, migrate, render',
    'help.helper.specialists': 'Updates the JDI-managed blocks of the specialists; lint',
    'help.helper.critic': 'DoD critic: which rows to examine (lean cadence); fold findings into REVIEW.md',
    'help.helper.size': 'lite or full, from the plan (one doer spawn for small phases)',
    'help.runtimes_label': 'Runtimes (install):',
    'help.runtime.all': 'All 4',
    'help.options_label': 'Options:',
    'help.opt.scope': 'Scope (install default: project; uninstall default: both)',
    'help.opt.githooks': 'Install: copies no-op hooks to .githooks/ (opt-in)',
    'help.opt.lang': 'CLI output language (default: en)',
    'help.opt.verbose': 'Detailed output (doctor only)',
    'help.opt.dry_run': 'Shows what would happen without applying it (update, uninstall)',
    'help.opt.purge': 'Uninstall: also removes .jdi/ (DESTRUCTIVE)',
    'help.opt.yes': 'Uninstall: skips interactive confirmations',
    'help.opt.force_specialists': 'Update: points pre-0.17 specialists to /jdi-bootstrap (Recreate)',
    'help.opt.skip_specialists': 'Update: leaves specialists untouched (managed blocks included)',
    'help.opt.no_color': 'Disables ANSI colors',
    'help.opt.help': 'This help',
    'help.examples_label': 'Examples:',
    'help.example.install': '# Install in the current project',
    'help.example.update': '# Update an already-installed project to the latest version',
    'help.example.update_dry_run': '# Preview what update would do',
    'help.example.uninstall': '# Uninstall (preserves .jdi/ state)',
    'help.example.uninstall_purge': '# Uninstall everything, including state files',
    'help.example.doctor': '# Diagnostics',
    'help.more_info_label': 'Learn more:',

    // ui.js
    'ui.tagline': 'Cut through the chaos. Ship the work. [Just do it]',
    'ui.igniting': 'igniting...',
    'ui.next_steps_title': 'Next steps:',
  },

  'pt-BR': {
    // Shared labels
    'label.directory': 'Diretório',
    'label.scope': 'Escopo',
    'label.platform': 'Plataforma',
    'label.source': 'Fonte',
    'label.output': 'Saída',
    'label.runtime': 'Runtime',
    'label.exit_code': 'Exit code',

    // Errors / validation
    'error.runtime_required': 'Runtime obrigatório.',
    'error.runtimes_label': 'Runtimes',
    'error.runtime_invalid': 'Runtime inválido: %s',
    'error.valid_options': 'Válidos',
    'error.scope_invalid': 'Scope inválido: %s',
    'error.unknown_command': 'Comando desconhecido: %s',
    'error.see_help': 'Use %s pra ver os comandos disponíveis.',
    'error.script_not_found': 'Script não encontrado: %s',
    'error.invalid_lang': '--lang inválido "%s". Suportados: %s',

    // install
    'install.header': 'Instalando JDI para %s',
    'install.spinner': 'Instalando adapters em %s...',
    'install.success_title': 'JDI instalado com sucesso',
    'install.next1': 'Abra seu runtime (%s) no diretório do projeto',
    'install.next2': 'Rode %s pra inicializar',
    'install.next2_cmd': '/jdi-new "<descrição do projeto>"',
    'install.next3': 'Depois %s pra criar os specialists per-project',
    'install.next4': 'Rode %s pra diagnóstico',
    'install.fail_title': 'Instalação falhou',
    'install.fail_hint': 'Tente %s pra diagnóstico',

    // build
    'build.header': 'Compilando runtimes do JDI',
    'build.success_title': 'Build completo',
    'build.success_line1': '4 runtimes gerados (claude, copilot, antigravity, opencode)',
    'build.success_line2': 'Adapters em %s',
    'build.next1': 'Instalar no projeto: %s',
    'build.next2': 'Diagnóstico: %s',
    'build.fail_title': 'Build falhou',

    // update / uninstall / doctor headers
    'update.header': 'JDI Update',
    'uninstall.header': 'JDI Uninstall',
    'doctor.header': 'JDI Doctor',
    'doctor.dir_label': 'Diretório atual',

    // install-playwright
    'playwright.header': 'JDI: Instalar Playwright + MCP',
    'playwright.success_title': 'Playwright + MCP prontos',
    'playwright.line_installed': '@playwright/test instalado',
    'playwright.line_browser_installed': 'navegador chromium instalado',
    'playwright.line_browser_skipped': 'navegador chromium pulado',
    'playwright.line_mcp_injected': 'config MCP injetada (onde o runtime existir)',
    'playwright.line_mcp_skipped': 'config MCP pulada',
    'playwright.next1': 'Reinicie seu runtime pra aplicar as mudanças do MCP',
    'playwright.next2': 'Claude Code: %s pra verificar',
    'playwright.next3': 'OpenCode: %s',
    'playwright.fail_title': 'Instalação do Playwright falhou',

    // install-caveman
    'caveman.header': 'JDI: Instalar plugin Caveman',
    'caveman.success_title': 'Caveman pronto',
    'caveman.line_cloned': 'Plugin clonado',
    'caveman.line_restart': 'Reinicie o Claude Code pra carregar',
    'caveman.next1': 'Verifique: %s',
    'caveman.next2': 'Alternar modo: %s',
    'caveman.fail_title': 'Instalação do Caveman falhou',

    // help
    'help.usage_label': 'Uso:',
    'help.usage_line': 'npx jdi-cli <comando> [opções]',
    'help.commands_label': 'Comandos:',
    'help.cmd.install': 'Instala o JDI no projeto atual',
    'help.cmd.update': 'Atualiza um JDI já instalado (preserva o state)',
    'help.cmd.uninstall': 'Remove o JDI do projeto (preserva .jdi/ por padrão)',
    'help.cmd.build': 'Reconstrói runtimes/ a partir de core/',
    'help.cmd.doctor': 'Diagnóstico do projeto + JDI',
    'help.cmd.install_playwright': 'Instala @playwright/test + chromium + config do MCP',
    'help.cmd.install_caveman': 'Instala o plugin caveman (modo ultra-compresso)',
    'help.cmd.help': 'Mostra esta ajuda',
    'help.cmd.version': 'Mostra a versão',
    'help.helpers_label': 'Helpers (plumbing usado pelos slash commands):',
    'help.helper.resolve_phase': 'Resolve o id da phase -> slug/dir/position',
    'help.helper.validate_slug': 'Valida o formato do slug',
    'help.helper.validate_phase': 'Valida os artefatos da phase (gate mecânico pra CI e agents)',
    'help.helper.truncate': 'Trunca o arquivo preservando a estrutura',
    'help.helper.monitor': 'Obsoleto: estima o tamanho dos arquivos dados (nao a sessao)',
    'help.helper.render': 'Regenera as views de .jdi/ (layout conflict-free v3)',
    'help.helper.migrate_layout': 'Migra .jdi/ legado pro layout conflict-free (v3)',
    'help.helper.sync_specialists': 'Materializa os specialists de .jdi/agents/ nos dirs de agents do runtime',
    'help.helper.cost': 'Custo de tokens deste projeto pelos transcripts locais do Claude Code (--targets, --json)',
    'help.helper.template': 'Imprime um template do pacote (dod-schema, specialists, config)',
    'help.helper.learnings': 'Learnings das N fases entregues mais recentes, pela data do ship',
    'help.helper.decisions': 'Decisoes travadas: indice, por id, por fase ou recentes — nunca a visao inteira',
    'help.helper.next': 'Proximo comando da fase, derivado dos artefatos (--status: a tela de status)',
    'help.helper.add_phase': 'Adiciona fase ao roadmap v3 (slug, order, created_with, decisao de auditoria)',
    'help.helper.ship': 'Entrega a fase: guardas, SHIPPED.md, learnings, arquivo',
    'help.helper.dod': 'Definition of Done como dado: le, valida, extrai Verify longo para script, bait (mutacao)',
    'help.helper.brief': 'Contexto inicial de um agente, com teto, em .jdi/cache/briefs/',
    'help.helper.gates': 'Roda build/teste/cobertura/lint e o DoD uma vez, fora do contexto do agente',
    'help.helper.review': 'Pior veredito do REVIEW.md; bloqueios; plano/merge do verify incremental; frescor',
    'help.helper.loop': 'Contabilidade do ralph loop: registra um verify, reset, status',
    'help.helper.budgets': 'Orcamentos em tokens dos artefatos da fase',
    'help.helper.known_errors': 'Erros conhecidos por entrada: consulta por arquivos e etapa, migra, renderiza',
    'help.helper.specialists': 'Atualiza os blocos gerenciados pelo JDI nos specialists; lint',
    'help.helper.critic': 'Critico do DoD: quais itens examinar (cadencia enxuta); aplica os achados no REVIEW.md',
    'help.helper.size': 'lite ou full, a partir do plano (um unico doer para fases pequenas)',
    'help.runtimes_label': 'Runtimes (install):',
    'help.runtime.all': 'Todos os 4',
    'help.options_label': 'Opções:',
    'help.opt.scope': 'Escopo (default do install: project; default do uninstall: both)',
    'help.opt.githooks': 'Install: copia hooks no-op pra .githooks/ (opt-in)',
    'help.opt.lang': 'Idioma da saída do CLI (default: en)',
    'help.opt.verbose': 'Output detalhado (só no doctor)',
    'help.opt.dry_run': 'Mostra o que aconteceria sem aplicar (update, uninstall)',
    'help.opt.purge': 'Uninstall: remove também .jdi/ (DESTRUTIVO)',
    'help.opt.yes': 'Uninstall: pula as confirmações interativas',
    'help.opt.force_specialists': 'Update: indica /jdi-bootstrap (Recriar) para specialists anteriores a 0.17',
    'help.opt.skip_specialists': 'Update: não altera os specialists (nem os blocos gerenciados)',
    'help.opt.no_color': 'Desabilita as cores ANSI',
    'help.opt.help': 'Esta ajuda',
    'help.examples_label': 'Exemplos:',
    'help.example.install': '# Instalação no projeto atual',
    'help.example.update': '# Atualizar um projeto já instalado pra versão mais recente',
    'help.example.update_dry_run': '# Preview do que o update faria',
    'help.example.uninstall': '# Desinstalar (preserva o state de .jdi/)',
    'help.example.uninstall_purge': '# Desinstalar tudo, incluindo os arquivos de state',
    'help.example.doctor': '# Diagnóstico',
    'help.more_info_label': 'Saiba mais:',

    // ui.js
    'ui.tagline': 'Corte o caos. Entregue o trabalho. [Just do it]',
    'ui.igniting': 'acendendo...',
    'ui.next_steps_title': 'Próximos passos:',
  },
};

function normalizeLang(raw) {
  return LANG_ALIASES[String(raw).toLowerCase()] || null;
}

// Resolve o idioma a partir das flags parseadas por bin/jdi.js. Sem
// `--lang`, cai no default. `--lang` sem valor (bloqueado por outra flag
// logo depois) chega aqui como `true` — tratado como invalido.
function resolveLang(flags) {
  const raw = flags?.lang;
  if (raw === undefined) return DEFAULT_LANG;

  const normalized = typeof raw === 'string' ? normalizeLang(raw) : null;
  if (!normalized) {
    throw new RangeError(t(DEFAULT_LANG, 'error.invalid_lang', String(raw), SUPPORTED.join(', ')));
  }
  return normalized;
}

// Busca `key` no catalogo de `lang`, com fallback pro default (e daí pra
// chave crua, se nem o default tiver — bug de catalogo, nao deve quebrar
// o CLI). `%s`-style placeholders sao resolvidos via node:util.format.
function t(lang, key, ...args) {
  const table = CATALOG[lang] || CATALOG[DEFAULT_LANG];
  const template = table[key] !== undefined ? table[key] : CATALOG[DEFAULT_LANG][key];
  const resolved = template === undefined ? key : template;
  return args.length ? format(resolved, ...args) : resolved;
}

module.exports = {
  SUPPORTED,
  DEFAULT_LANG,
  resolveLang,
  t,
};
