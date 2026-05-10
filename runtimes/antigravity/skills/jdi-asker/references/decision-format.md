# Formato de D-XX (decisao)

Append-only em `.jdi/DECISIONS.md`.

```markdown
## D-{N} ({date ISO 8601}, phase {NN-slug})
**Decisao:** {decisao concreta}
**Por que:** {1-2 linhas justificando}
**Alternativas:** {opcoes rejeitadas + motivo curto}
**Cancela:** {D-N anterior, se sobrescreve}
**Cancelada por:** {fica vazio inicialmente, preenche quando outra D-X cancela}
```

## Regras

- Numero sequencial global. Nao reseta por phase.
- Nunca apaga, nunca edita prosa de D-XX existente.
- Se decisao precisar mudar -> nova D-X com `**Cancela:** D-Y`. Edita D-Y so o campo `**Cancelada por:**`.
- Linguagem: pt-BR. Termos tecnicos em ingles.
