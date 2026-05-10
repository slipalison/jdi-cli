---
name: kiss
description: KISS (Keep It Simple, Stupid). A solucao mais simples que resolve o problema vence. Complexidade so se justifica por dor real medida. Cada layer/abstracao precisa pagar o proprio custo. Aplica em qualquer linguagem.
type: skill
applies_to: |
  Carregada por doer ao desenhar nova feature/modulo.
  Carregada por reviewer no gate 5 pra detectar over-engineering.
loaded_by:
  - jdi-doer-{slug}
  - jdi-reviewer-{slug}
runtime_overrides:
  antigravity:
    triggers:
      - "KISS"
      - "manter simples"
      - "over-engineering"
      - "simplicidade"
---

# Skill: KISS

> A simplicidade eh o melhor design. Toda complexidade precisa pagar o proprio custo.

KISS nao eh "codigo idiota". Eh **rejeitar complexidade nao-justificada**. Cada interface, cada layer, cada abstracao tem custo de manutencao — so vale se resolve dor real.

## Regras

### 1. Default eh o mais simples

Pergunta antes de adicionar:
- **Funcao** vs classe vs framework?
- **Variavel** vs config vs feature flag?
- **If/else** vs strategy pattern vs plugin system?
- **Sync** vs async vs queue vs event bus?
- **Inline** vs helper vs lib?

Comeca pelo mais a esquerda. So sobe se tiver requisito real.

### 2. Complexidade precisa justificar dor

**Permitido:**
- Padrao novo se tem 3+ casos reais usando
- Layer de abstracao se tem 2+ implementacoes que existem hoje
- Cache se medicao mostra hot path
- Async se tem latencia inaceitavel sincrono
- Plugin system se tem extensores externos confirmados

**Proibido:**
- "Vai escalar mais tarde" sem requisito atual
- "Outras pessoas podem precisar" sem outras pessoas
- "Pra ficar generico" sem 2o caso de uso
- "Vai ficar mais limpo" trocando 5 linhas claras por 50 linhas elegantes
- Pattern enterprise em codebase pequeno (Repository + UoW + Mediator + CQRS pra app de 10 controllers)

### 3. Cognitive load eh metrica real

Codigo que voce le 10x e escreve 1x. Otimize pra leitura:
- **Variaveis nomeadas** > expressao composta
- **Early return** > if/else aninhado
- **Funcao linear** > pulos entre callbacks
- **Tipos explicitos** > inferencia magica em codebase grande
- **Codigo procedural simples** > OOP rebuscado pra 50 linhas

Regra: codigo que precisa de comentario explicando "por que tao complexo" eh complexo demais.

### 4. Indicadores de over-engineering

Sinais que o codigo passou da conta:

- Interface com 1 implementacao
- Factory/Builder pra coisa instanciada 1x
- Generic <T> que so eh usado com 1 tipo
- Config com chave que nunca mudou
- Layer de abstracao que so encapsula chamada de outra layer (pass-through)
- Hierarquia de heranca > 2 niveis
- Arquivo com mais setup do que logica
- Test que precisa de 30 linhas de mock pra rodar 5 linhas de logica

### 5. Refactor eh ao contrario

Tendencia natural: codigo cresce em complexidade. Refatorar = REMOVER complexidade que nao paga mais.

Pergunte:
- Esse layer ainda existe pra resolver problema, ou virou tradicao?
- Essa abstracao tem 2+ implementacoes hoje?
- Se eu deletar isso, o que quebra?
- Da pra resolver com 5 linhas em vez de 50?

## Anti-patterns

| Anti-pattern | Sintoma |
|---|---|
| Interface + 1 implementacao | `IUserService` + `UserService` (so 1) — deleta a interface, usa a classe |
| Generic `<T>` usado com 1 tipo | `Repository<User>` mas nunca `Repository<Order>` — concretiza |
| Factory pra new() | `UserFactory.create()` que so faz `return new User()` |
| Config string que nunca mudou | `MAX_RETRIES: 3` em config + ngm nunca mudou — hardcoda |
| Heranca > 2 niveis | `BaseEntity -> AuditableEntity -> SoftDeletableEntity -> User` — flatten via composition |
| Pass-through layer | `Controller -> Service -> Repository -> DbContext` onde Service so chama Repository sem logica — deleta Service |
| Pattern enterprise sem demanda | Mediator/CQRS em app pequeno — substitui por chamada direta |
| Comentario explicando o "por que tao complexo" | Codigo perdeu a guerra — refatora |
| Mock setup > logic test | Test fica frageil; codigo testado eh acoplado demais |
| Future-proof params nao usados | `(opts?: { future?: boolean })` sem caller passando — remove |

## Procedure

### Doer (antes de escrever)

1. Pergunta: "Qual a versao **mais simples** que resolve o requisito atual?"
2. Escreve essa versao.
3. So sobe complexidade se topar em dor real.
4. Apos escrever, pergunta: "Da pra deletar alguma layer/parametro/abstracao sem perder funcionalidade?"

### Reviewer (gate 5)

Heuristicas de over-engineering:

```bash
# Interfaces com 1 implementacao
grep -RnE '^(public |export )?interface I?[A-Z]\w+' src/ | while read iface; do
  name=$(echo "$iface" | grep -oE '[A-Z]\w+\b' | head -1)
  count=$(grep -RnE "class \w+\s*:\s*$name|implements $name" src/ | wc -l)
  [[ $count -eq 1 ]] && echo "WARN: $iface tem so 1 implementacao"
done

# Heranca profunda (> 2 niveis)
# (depende de stack — heuristica especifica)

# Funcoes muito grandes ou aninhadas
grep -cE '^\s{20,}\S' src/**/*  # linhas com 20+ espacos = aninhamento profundo
```

Match -> WARN com sugestao de simplificar.

## Inputs

- Diff/conteudo do file
- Context: tamanho do codebase (over-engineering eh relativo)

## Outputs

NAO produz arquivo. Modifica julgamento.

## Examples

### Exemplo 1: Interface com 1 impl

Errado:
```typescript
interface ILogger { log(msg: string): void }
class ConsoleLogger implements ILogger { log(msg) { console.log(msg) } }
const logger: ILogger = new ConsoleLogger()
```

Certo (KISS):
```typescript
function log(msg: string) { console.log(msg) }
// ou
class Logger { static log(msg: string) { console.log(msg) } }
```

Adiciona interface quando 2a impl chegar, nao antes.

### Exemplo 2: Pass-through service

Errado:
```csharp
public class UserService {
  public User GetById(int id) => _repo.GetById(id);  // so chama repo
}
```

Certo: usa o `_repo` direto no controller. Adiciona Service quando tiver logica real (validacao, multi-step, transacao, evento).

### Exemplo 3: Config hardcodavel

Errado: `appsettings.json -> "MaxItemsPerPage": 50` que ngm nunca mudou em 2 anos.

Certo: `const MAX_ITEMS_PER_PAGE = 50` no codigo. Volta pra config se algum cliente realmente precisar customizar.
