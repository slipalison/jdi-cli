# Skills Registry

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
