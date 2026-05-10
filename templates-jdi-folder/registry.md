# JDI — Registry

Audit trail de tudo que o `jdi-architect` cria. Append-only.

2 fontes:
- `/jdi-create` (modo create) — agent/skill generico em `core/`
- `/jdi-bootstrap` (modo specialist) — doer + reviewer per-project em `.jdi/agents/`

Cada entrada documenta: o que, por que, quando, como invocar.

## Format

```markdown
## R-{N} ({date ISO})
**Tipo:** {agent | skill | composite | specialist}
**Nome ou slug:** {jdi-{nome}} ou {todo-app}
**Criado por:** /jdi-create | /jdi-bootstrap | manual
**Por que:** {razao em 1-2 linhas}
**Substitui:** {agent/skill anterior, se refactor}
**Files:**
- {path 1}
- {path 2}
**Integration:**
- {arquivo atualizado}
- {arquivo atualizado}
**Removido em:** {data + razao, se foi removido depois}
```

## Entries

<!-- Append abaixo. Mais recente no fim. -->
