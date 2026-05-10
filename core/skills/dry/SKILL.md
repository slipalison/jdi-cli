---
name: dry
description: DRY (Don't Repeat Yourself). 1 fonte de verdade por conhecimento. Detecta duplicacao real (mesma decisao em 2+ lugares) e separa de duplicacao aparente (mesmo codigo, motivos diferentes). Aplica em qualquer linguagem.
type: skill
applies_to: |
  Carregada por doer antes de escrever codigo novo.
  Carregada por reviewer no gate 5 pra detectar duplicacao em diff.
loaded_by:
  - jdi-doer-{slug}
  - jdi-reviewer-{slug}
runtime_overrides:
  antigravity:
    triggers:
      - "DRY"
      - "duplicacao de codigo"
      - "Don't Repeat Yourself"
      - "refactor duplicado"
---

# Skill: DRY

> Cada conhecimento tem **uma** representacao autoritativa, nao-ambigua, no sistema.

DRY nao eh sobre copiar codigo. Eh sobre **conhecimento duplicado** — regra de negocio, formula, formato, decisao, presentes em 2+ lugares e que mudam **juntos** quando o requisito muda.

## Regras

### 1. Knowledge duplication != code coincidence

**Knowledge duplication (DRY viola):**
- Calculo de imposto em 2 lugares
- Validacao de CPF em 3 services
- Schema de date format espalhado pelo app
- Mesma constante de timeout em 4 arquivos

Quando regra muda, voce muda em N lugares — esquece um, sistema fica inconsistente.

**Code coincidence (DRY NAO viola):**
- 2 funcoes com 5 linhas iguais mas dominios diferentes
- Boilerplate de framework repetido (cada controller tem `[Authorize]`)
- Loop de iteracao parecido em 2 contextos sem relacao

Forcar abstracao aqui acopla coisas que nao deviam estar acopladas.

### 2. Regra dos 3

- 1 ocorrencia: deixe
- 2 ocorrencias: preste atencao, mas nao abstraia ainda
- 3 ocorrencias: abstrai (provavelmente eh knowledge duplication real)

Pular essa regra produz **abstracao prematura** — pior que duplicacao porque ja tem callers acoplados a interface errada.

### 3. Tipos de DRY

**Code DRY:** funcoes/classes reusaveis pra logica repetida
**Data DRY:** 1 schema fonte (gera DTO + validator + DB + docs)
**Process DRY:** 1 build script que serve dev + CI + prod
**Documentation DRY:** docs geradas de codigo, nao escritas em paralelo

### 4. Single Source of Truth (SSoT)

Pra cada peca de conhecimento, identifique:
- **Onde mora a verdade** (DB schema, env config, business rule)
- **Quem deriva dela** (DTOs, types, docs, UI)
- **Ferramenta de derivacao** (codegen, schema migration, type inference)

Nunca: editar manualmente tanto a fonte quanto o derivado.

### 5. Quando NAO aplicar DRY

- **Premature abstraction**: 2 callers parecidos mas com evolucoes futuras divergentes -> deixa duplicado
- **Cross-boundary**: duplicar entre microservicos > acoplar via lib compartilhada
- **Test setup**: testes redundantes legiveis > helpers magicos compartilhados
- **Wrong abstraction**: melhor duplicar que extrair errado (Sandi Metz: "duplication is far cheaper than the wrong abstraction")

## Anti-patterns

| Anti-pattern | Por que viola |
|---|---|
| Copy-paste sem extracao apos 3a ocorrencia | Knowledge duplicado, cada caller diverge silenciosamente |
| Helper utilitario com 15 funcoes nao-relacionadas | "DRY" virou ball of mud — junta coisas sem relacao |
| Abstracao apos 2a duplicacao com hooks de extensao "pra caso" | Premature abstraction + YAGNI violado junto |
| Mesma constante hardcoded em 4 arquivos | Single source of truth ausente — extrai pra config |
| Logica de validacao duplicada client + server | Code OK, mas devia compartilhar schema (Zod, Pydantic, JSON Schema) |
| Comentario explicando o que codigo faz | Doc duplica codigo, vai dessincronizar |

## Procedure

### Doer (antes de escrever)

1. Tem regra/calculo/constante igual em outro lugar do codebase? Se sim, refer/import. Nao duplique.
2. Vai criar 2a ocorrencia? OK, mas marca mentalmente.
3. Vai criar 3a? Para. Refatora primeiro pra abstracao, depois usa.

### Reviewer (gate 5)

Greps especificos por linguagem (exemplos):

```bash
# Constantes magicas duplicadas
grep -RnE '\b86400\b|\b3600\b|\b1024\b' src/

# Mesma string em 3+ lugares
sort src/ | uniq -c | sort -rn | head -20  # heuristica grosseira

# Validacao de email/CPF/etc duplicada
grep -RnE 'regex.*@|EmailRegex|CpfValidator|cpf_pattern' src/

# Hardcoded URLs/endpoints
grep -RnE 'https?://[a-z0-9.-]+\.[a-z]{2,}' src/ --include='*.ts' --include='*.cs' --include='*.py'
```

3+ matches do mesmo pattern em files diferentes -> WARN.

## Inputs

- Diff ou conteudo do file modificado
- Context: stack do projeto pra greps adaptados

## Outputs

NAO produz arquivo. Modifica julgamento:
- Doer escolhe reusar/extrair
- Reviewer marca WARN com pointer pra refactor

## Examples

### Exemplo 1: 3 services calculando imposto

Errado:
```
service A: total * 0.18
service B: amount * 0.18
service C: value * 0.18
```

Certo: extrai `TaxCalculator.applyVat(amount)` ou `const VAT_RATE = 0.18` em config compartilhada.

Reviewer marca WARN: "imposto 0.18 hardcoded em 3 services. Extrai pra `config/tax.{ts,cs,py}`."

### Exemplo 2: Code coincidence (NAO viola DRY)

```
function findUser(id) { return db.query(...) }
function findOrder(id) { return db.query(...) }
```

Estrutura igual, dominios diferentes. **Nao** extrai `findEntity(id, table)` — vai forcar abstracao que vai divergir (user tem soft-delete, order tem cache, etc).

Reviewer ignora — code coincidence eh OK.
