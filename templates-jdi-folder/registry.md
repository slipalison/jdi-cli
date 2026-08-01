# JDI — Registry

> **Layout v3 (0.13.0+):** este arquivo eh uma VIEW gerada por `npx -y jdi-cli render` a partir de `.jdi/registry/R-{date}-{slug}.md` (um arquivo por bootstrap//jdi-create, secoes fenced `<!-- jdi:... -->`). Nunca edite a view nem faca append nela — escreva o arquivo per-entry e rode render. Em projetos legados (sem `.jdi/registry/`) o append direto continua valendo.

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
