# CONTEXT.md template

```yaml
---
phase: {NN-slug}
created: {date ISO 8601}
asker_iterations: {N}
---

# Context — Phase {N}: {Name}

## Domain
{1 linha descrevendo o que essa phase entrega}

## Decisoes locked
- D-{X} — {decisao curta, max 1 linha}
- D-{Y} — {decisao curta}

## Canonical refs
- {path absoluto para spec/ADR/doc citado pelo user}

## Deferred
- {scope creep capturado, com motivo do deferimento}

## Notas
- {qualquer observacao do user que nao virou D-XX mas eh relevante}
```

## Regras

- Decisoes locked = NUNCA voltam. Phase futura que precisa mudar = nova D-XX que cancela a anterior.
- Canonical refs: paths absolutos. Se for url, prefixa com URL: `URL:https://...`.
- Deferred: registra com data e razao. Vai pra `.jdi/todos.md` tambem.
- Tamanho total do CONTEXT.md: max 1500 token. Phase grande demais -> sugere split.
