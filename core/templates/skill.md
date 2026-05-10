---
name: {NOME}
description: {DESCRICAO_1_LINHA}
type: skill
applies_to:
  {QUANDO_APLICAR}
loaded_by:
  {AGENTS_QUE_CARREGAM}
runtime_overrides:
  antigravity:
    triggers:
      {TRIGGERS_PARA_DISCOVERY}
---

# Skill: {NOME}

{DESCRICAO_DETALHADA}

## Quando aplicar

{CONDICOES_DE_USO}

## Procedure

### Passo 1: {NOME}
{DESCRICAO}

### Passo 2: {NOME}
{DESCRICAO}

### Passo 3: {NOME}
{DESCRICAO}

## Inputs esperados

{O_QUE_O_AGENT_PAI_FORNECE}

## Outputs

{O_QUE_VOLTA_PRO_AGENT_PAI}

NAO produz arquivos proprios. Modifica trabalho do agent pai.

## References

- `references/{X}.md` — {DESCRICAO}
- `references/{Y}.md` — {DESCRICAO}

## Anti-patterns

- {COISA_QUE_NAO_DEVE_FAZER}
- {COISA_QUE_NAO_DEVE_FAZER}

## Examples

### Exemplo 1: {CENARIO}

Input:
```
{EXEMPLO_INPUT}
```

Saida (no contexto do agent pai):
```
{EXEMPLO_OUTPUT}
```
