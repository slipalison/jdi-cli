---
name: yagni
description: YAGNI (You Aren't Gonna Need It). Construa apenas o que requisito atual pede. Generalizacao apos 3o caso real, nunca antes. Codigo nao escrito eh codigo sem bug, sem custo de manutencao, sem teste pendente. Aplica em qualquer linguagem.
triggers:
  - "YAGNI"
  - "codigo especulativo"
  - "future-proof"
  - "premature abstraction"
---

# Skill: YAGNI

> Voce nao vai precisar disso.

YAGNI eh disciplina contra **codigo especulativo**: features, abstracoes, parametros, hooks, layers, configs que existem "pra caso precise". Em 90% dos casos, nunca precisa — e quando precisa, o requisito eh diferente do que voce imaginou.

## Regras

### 1. Construa apenas o que requisito atual pede

Pergunte de cada linha de codigo nova:
- **Essa funcionalidade tem requisito hoje?**
- **Quem eh o caller que precisa disso AGORA?**

Se nao tem caller real, nao escreve. Codigo morto eh **dividido negativo**: bug latente, custo de manutencao, distracao em review, dificulta refactor.

### 2. Generalizacao depois do 3o caso real

Sandi Metz: "Duplication is far cheaper than the wrong abstraction."

- 1 caso: implementa especifico
- 2 casos: copia ou parametriza minimamente
- 3 casos: AI extrai padrao real (que voce **viu** acontecer, nao imaginou)

Generalizar antes acopla callers a interface errada. Refatorar dps pra interface certa eh barato; quebrar callers pra trocar interface generica errada eh caro.

### 3. Custos do codigo especulativo

Toda linha "pra caso precise" custa:

- **Manutencao**: alguem vai tocar quando refatorar vizinhanca
- **Confusao**: leitor pensa "isso ta sendo usado, deve ser importante"
- **Testes**: codigo nao testado vira bomba; testado, tempo perdido
- **Coupling**: callers vao acoplar a interface especulativa, dificultando remover
- **Scope creep**: feature simples vira feature complexa
- **Bug surface**: linha que nao existe nao tem bug

### 4. O que NAO eh YAGNI

YAGNI nao eh desculpa pra:
- **Hardcoded everywhere**: alguns extension points sao requisito real (i18n, logging, auth)
- **Cortar requisito real**: se ticket pede X, entrega X completo, nao a metade
- **Skip de seguranca/error handling**: sao requisitos universais, nao especulativos
- **Codigo cru e ilegivel**: clareza eh requisito, nao especulacao
- **Pular testes**: cobertura eh contrato

### 5. Sintomas de violacao

Codigo tem cheiro de YAGNI quebrado se:

- Parametros opcionais nunca passados (`fn(a, b, opts?: {...})` com opts sempre `undefined`)
- Hooks/eventos sem subscribers
- Plugin system sem plugins
- Config "pra caso queiramos mudar" que ngm nunca mudou
- Interface com 1 impl (overlap com KISS)
- Generic `<T>` usado com 1 tipo so
- "Future-proof" arquitetura escrita pra escalar 100x antes de validar requisito atual
- Branches no codigo pra cenarios que ngm consegue descrever

### 6. Como remover

Apos descobrir codigo especulativo:
1. Confirma que ngm chama (`grep` nos callers)
2. Deleta. Sim, deleta direto. Git guarda historia.
3. Nao deixa "// removido em XX/YY" — mais lixo.
4. Se descobrir que precisa dps, adiciona quando precisar (aposta certa: dps voce sabe o requisito real, nao imaginado).

## Anti-patterns

| Anti-pattern | Por que viola |
|---|---|
| Parametro opcional nunca usado | Adiciona surface area sem benefit |
| Funcao "generica" usada por 1 caller | Generalizou cedo demais |
| Plugin/extension point sem extensores | Codigo morto carrega manutencao |
| Config "configurable" que ngm muda | Falsa flexibilidade — vira hardcode dps |
| Try/catch pra excecao impossivel | Indica medo, nao requisito |
| Validacao defensiva pra valor que vem de tipo seguro | TypeScript/C#/Python types ja garantem |
| `for/while` em lugar de retorno direto pra "futuro looping" | Inventa repeticao especulativa |
| Layer "pra ficar generico" sem 2a impl | Especulacao com custo de pass-through |
| Comentario "TODO: extender pra X dps" sem ticket | Mensagem pro nada |
| Abstracao com 1 implementacao concreta | Generic abstraction sem segundo caso |
| `enum` com 1 valor "vai crescer" | Adicione valor quando aparecer |

## Procedure

### Doer (antes/durante implementacao)

Antes de adicionar:

1. **Tem requisito atual?** (ticket, conversa, regra de negocio explicita) Senao, nao adiciona.
2. **Quem chama isso hoje?** Se ngm, nao adiciona.
3. **Vou usar essa flexibilidade quando?** Se "nao sei", nao adiciona.

Apos escrever, perguntar:
- Existe parametro/config/branch que poderia sumir sem perder requisito?

### Reviewer (gate 5)

Heuristicas:

```bash
# Parametros opcionais nunca passados
# (depende de stack — exemplos)
grep -RnE 'function \w+\([^)]*opts\?:' src/  # TS
grep -RnE '\([^)]*=\s*null\)' src/            # opcional default null

# Codigo "TODO: extend"
grep -RnE 'TODO.*(extend|future|reserved|placeholder|pra caso)' src/

# Try/catch sem motivo claro
grep -RnA3 'try\s*{' src/ | grep -B1 'catch.*:.*ignore'

# Variaveis declaradas e nao usadas
# (linter ja pega — confirma no review)

# Plugin/extension points
grep -RnE 'register|registerPlugin|EventEmitter|hook(' src/
# Cross-check: ha callers de fato?
```

3+ matches sem caller real -> WARN.

## Inputs

- Diff do file (foco em adicoes)
- Lista de callers se houver

## Outputs

NAO produz arquivo. Modifica julgamento — doer evita escrever, reviewer marca WARN.

## Examples

### Exemplo 1: Param opcional especulativo

Errado:
```python
def send_email(to: str, subject: str, body: str,
               cc: list[str] = None,
               bcc: list[str] = None,
               attachments: list[Path] = None,
               priority: str = "normal",
               retry_count: int = 3,
               on_failure: Callable = None):
    ...
```

Requisito atual eh enviar email simples (`to, subject, body`). Os outros 5 params sao especulativos.

Certo:
```python
def send_email(to: str, subject: str, body: str):
    ...
```

Adiciona `cc`, `bcc` etc **quando** chegar requisito real, nao antes.

### Exemplo 2: Plugin system sem plugins

Errado:
```typescript
class PaymentProcessor {
  private plugins: Plugin[] = []
  registerPlugin(p: Plugin) { this.plugins.push(p) }
  process(...) {
    this.plugins.forEach(p => p.beforeProcess())
    // logic
    this.plugins.forEach(p => p.afterProcess())
  }
}
```

Tem 0 plugins registrados. Plugin system inteiro eh codigo morto.

Certo:
```typescript
class PaymentProcessor {
  process(...) { /* logic */ }
}
```

Quando 1o plugin real aparecer, ai sim. Nao antes.

### Exemplo 3: Config string nao usada

Errado: `config.json -> "DEFAULT_LANGUAGE": "pt-BR"` mas ngm le isso. Codigo usa `"pt-BR"` direto.

Certo: deleta a config. Adiciona quando a feature de multi-language for de fato implementada.
