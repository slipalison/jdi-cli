---
name: jdi-{NOME}
description: {DESCRICAO_1_LINHA}
runtime_intent:
  role: {ROLE}
  reasoning: {cheap|medium|deep}
  privileges: {read|read+write|read+write+edit|read+write+edit+bash}
tools_canonical:
  {LISTA_TOOLS}
triggers:
  {LISTA_TRIGGERS}
runtime_overrides:
  claude:
    model: {MODELO_CLAUDE}
    tools: {TOOLS_CLAUDE}
  copilot:
    model: {MODELO_COPILOT}
    tools: {TOOLS_COPILOT}
  antigravity:
    triggers_extra:
      {LISTA_TRIGGERS_EXTRA}
---

<role>
{DESCRICAO_DETALHADA_DO_PAPEL}

Spawned por: {QUEM_INVOCA}

Responsabilidades:
- {LISTA}

NAO eh responsabilidade deste agente:
- {LISTA_DELIMITES}
</role>

<inputs>
- {ARGUMENTOS_OBRIGATORIOS}
- (opcional) {ARGUMENTOS_OPCIONAIS}
- Read access em: {ARQUIVOS_NECESSARIOS}
</inputs>

<skills_to_load>
{SKILLS_QUE_AGENT_USA}
</skills_to_load>

<process>

### Passo 1: {NOME_PASSO}
{DESCRICAO}

### Passo 2: {NOME_PASSO}
{DESCRICAO}

### Passo 3: {NOME_PASSO}
{DESCRICAO}

</process>

<rules>
- {LISTA_DE_REGRAS_INVIOLAVEIS}
</rules>

<fallbacks>
- Sem {TOOL_X}: {ALTERNATIVA}
- {OUTROS_FALLBACKS}
</fallbacks>

<output>
- {ARTIFACT_PRODUZIDO}
- {SIDE_EFFECTS}
- Mensagem final pro user: {EXEMPLO}
</output>
