# Skills Registry

> **Layout v3 (0.13.0+):** este arquivo eh uma VIEW gerada por `npx -y jdi-cli render` a partir de `.jdi/registry/R-{date}-{slug}.md` (um arquivo por bootstrap//jdi-create, secoes fenced `<!-- jdi:... -->`). Nunca edite a view nem faca append nela — escreva o arquivo per-entry e rode render. Em projetos legados (sem `.jdi/registry/`) o append direto continua valendo.

Skills disponiveis pros agents JDI carregarem on-demand.

Skill = procedimento reusavel. Sem decision loop proprio. Carregado inline pelo agent pai.

## Format

```markdown
| Skill | Path | Quando aplicar | Loaded by |
|---|---|---|---|
| {nome} | core/skills/{nome}/ | {trigger} | {lista de agents} |
```

## Como agents carregam

Cada agent tem uma secao `<skills_to_load>` no prompt:

```markdown
<skills_to_load>
- {skill-nome}: aplica quando {condicao}
- {outra-skill}: aplica quando {condicao}
</skills_to_load>
```

Agent le essa secao, carrega skill via Read no path correspondente, segue o procedure.

## Entries

| Skill | Path | Quando aplicar | Loaded by |
|---|---|---|---|
<!-- Append abaixo via /jdi-create -->
