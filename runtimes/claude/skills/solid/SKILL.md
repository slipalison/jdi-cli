---
name: solid
description: SOLID. Os 5 principios de design OO de Robert C. Martin - SRP, OCP, LSP, ISP, DIP. Aplicaveis em qualquer linguagem com tipos/classes/interfaces (C#, Java, TS, Python, Go, Rust, Kotlin, Swift, etc). Resumo direto + anti-patterns + heuristicas de detecao.
---

# Skill: SOLID

5 principios de design — **S**ingle Responsibility, **O**pen/Closed, **L**iskov Substitution, **I**nterface Segregation, **D**ependency Inversion.

Aplicaveis em qualquer linguagem com classes ou interfaces. Em FP/procedural, principios mapeiam pra modulos e funcoes (SRP: 1 funcao 1 responsabilidade; ISP: parametros minimos; DIP: dependency injection via parametro).

## S - Single Responsibility Principle (SRP)

> Uma classe/modulo deve ter **1 motivo pra mudar**.

**1 motivo = 1 stakeholder ou 1 eixo de mudanca**, nao "1 acao".

`UserService` que faz auth + persistencia + envia email viola — sao 3 motivos pra mudar (security team muda auth, DBA muda persistencia, marketing muda email).

### Sintomas de violacao
- Classe com nome generico (`Manager`, `Helper`, `Service`, `Util`)
- Metodos sem coerencia tematica
- Multiple imports de bibliotecas sem relacao (DB + email + crypto na mesma classe)
- Diff de uma classe afeta dominios separados em sprints diferentes

### Fix
Extrai responsabilidades em classes separadas:
- `UserAuthenticator` (auth)
- `UserRepository` (persistencia)
- `UserNotifier` (email)

Compose numa coordinator se preciso, mas cada peca tem 1 motivo.

## O - Open/Closed Principle (OCP)

> Aberto pra **extensao**, fechado pra **modificacao**.

Adicionar comportamento novo nao deveria exigir editar codigo testado. Use polimorfismo, strategy, plugins, ou config — nao if/else infinito.

### Sintomas de violacao
- `switch (type)` que cresce a cada feature nova
- `if (provider === "x") ... else if ... else if ...`
- Cada feature nova edita N classes existentes em vez de adicionar 1 nova

### Fix
- **Strategy pattern**: cada caso vira impl de interface
- **Polimorfismo**: subclass override em vez de switch externo
- **Registry**: `registry.register("x", handler)` — feature nova so adiciona
- **Visitor**: pra hierarquias de tipos fechadas

### Quando ignorar
OCP eh aspiracional, nao absoluto. Aplicar em pontos de variacao **conhecida** (estrategias de pagamento sao multiplas), nao especular (KISS + YAGNI).

## L - Liskov Substitution Principle (LSP)

> Subtipo deve ser **substituivel** pelo supertipo sem quebrar comportamento.

Se `Bird` tem metodo `fly()`, `Penguin extends Bird` viola LSP — penguin nao voa. Caller que recebe `Bird` quebra ao receber `Penguin`.

### Sintomas de violacao
- Subclass que **lanca excecao** em metodo herdado ("not supported")
- Subclass que **fortalece pre-condicao** (`base aceita >= 0`, sub aceita `> 0`)
- Subclass que **fraqueja pos-condicao** (base garante "ordenado", sub nao garante)
- Caller precisa de `if (instanceof Subtype)` pra tratar caso especial

### Fix
- Repensa hierarquia: `Penguin` nao eh `Bird` voador, eh `Bird` que anda. Cria `FlyingBird : Bird` e `Penguin : Bird` sem fly.
- Composition over inheritance: prefira interfaces compostas a hierarquias profundas.
- Refactor pra capabilities: `Flyable`, `Swimmable`, `Walkable` (overlap com ISP).

## I - Interface Segregation Principle (ISP)

> Clients nao deveriam ser forcados a depender de interfaces que **nao usam**.

Interfaces grandes ("fat interfaces") forcam impls a stub metodos sem sentido (lancando NotImplemented), e callers a importar dependencias amplas.

### Sintomas de violacao
- Interface com 15 metodos, cada caller usa 2-3
- Impl com varios metodos jogando `throw new NotImplementedException()`
- Mock de teste enorme pra usar 1 metodo da interface

### Fix
Quebra em interfaces menores e coesas:
```
IFileReader { read() }
IFileWriter { write() }
// callers escolhem o subset que precisam
```

Em FP/Go, mesmo principio: parametros minimos, structural typing nao forca implementar tudo.

## D - Dependency Inversion Principle (DIP)

> Modulos de alto nivel **nao** dependem de baixo nivel. Ambos dependem de **abstracoes**.

Logica de negocio nao importa "PostgreSQL", "AWS S3", "SendGrid". Importa abstracoes (`UserRepository`, `BlobStorage`, `EmailSender`). Implementacoes concretas vivem em camadas externas.

### Sintomas de violacao
- Classe de dominio importa `pg`, `aws-sdk`, `sendgrid`, `axios`
- Logica de negocio testavel so com infra real (DB up, S3 mockado, etc)
- Trocar provider exige rewrite de logica de negocio

### Fix
- **Dependency injection** (constructor / property / parameter)
- Defina interfaces no modulo de dominio; impls vivem em infra/adapter layer (overlap com Hexagonal/Clean Architecture)
- Composition root injeta a impl certa

### DIP != IoC container
DIP eh principio. IoC container eh **uma** ferramenta. Pode aplicar DIP com construtor manual, factory simples, ou parameter injection — sem framework.

## Resumo dos 5

| Letra | Foco | Pergunta-chave |
|---|---|---|
| **S** | Coesao da unidade | Quantos motivos pra mudar essa classe/modulo? (>1 = viola) |
| **O** | Estabilidade frente a extensao | Adicionar feature nova edita codigo testado ou adiciona codigo novo? |
| **L** | Contrato de heranca | Substituir o pai pelo filho quebra algum caller? |
| **I** | Tamanho de interface | Toda impl/caller usa todos os metodos? |
| **D** | Direcao de dependencia | Dominio importa infra ou infra importa dominio? |

## Anti-patterns gerais

| Anti-pattern | Principio violado |
|---|---|
| `God class` com 30+ metodos heterogeneos | SRP |
| `switch (kind)` em N callers, cresce a cada feature | OCP |
| Subclasse com `throw NotSupportedException()` | LSP |
| `IRepository` com 20 metodos genericos | ISP |
| Service de dominio importando ORM concreto | DIP |
| Heranca > 3 niveis | LSP + SRP (geralmente) |
| Construtor com 8+ parametros | SRP (responsabilidades demais) |
| Util class com 50 funcoes nao-relacionadas | SRP |

## Procedure

### Doer

Antes de criar classe/modulo/interface:
- **SRP**: descreve em 1 frase. Se precisar "e", quebra.
- **ISP**: lista os callers previstos. Cada um precisa de **todos** os metodos? Se nao, quebra.
- **DIP**: o que isso depende? Concretudes (DB, HTTP, FS) -> injeta como abstracao.

Antes de fazer subclass:
- **LSP**: substituicao pelo pai funciona em todos os callers? Se nao, hierarquia errada.

Antes de adicionar `if/switch` em ponto que cresce:
- **OCP**: vale strategy/registry?

### Reviewer (gate 5)

```bash
# SRP — classes muito grandes
find src/ -name '*.cs' -o -name '*.ts' -o -name '*.py' | while read f; do
  loc=$(wc -l < "$f")
  [[ $loc -gt 400 ]] && echo "WARN SRP: $f tem $loc linhas, possivel god class"
done

# OCP — switches grandes em hot paths
grep -RnE 'switch\s*\(' src/ | head
# (manualmente: avaliar se cresce a cada feature)

# LSP — NotImplemented em subclass
grep -RnE 'NotImplemented|UnsupportedOperation|throw new.*not (implemented|supported)' src/

# ISP — interfaces gigantes
grep -RnA50 '^(public |export )?interface' src/ | grep -cE '^\s+\w+\s*\(' | sort -rn
# count > 10 metodos -> WARN

# DIP — modulo de dominio importando concretudes
grep -RnE 'from.*pg|from.*aws-sdk|using Npgsql|using AWSSDK' src/domain/ src/core/
```

Match relevante -> WARN com principio citado.

## Inputs

- Diff/conteudo do file
- Estrutura do projeto (pra detectar dominio vs infra)

## Outputs

NAO produz arquivo. Modifica julgamento.

## Examples

### Exemplo 1: SRP violado

Errado:
```csharp
public class OrderService {
  public Order Create(...) { /* validar + salvar + email + log + audit */ }
}
```

5 motivos pra mudar.

Certo:
```csharp
public class OrderValidator { }
public class OrderRepository { }
public class OrderNotifier { }
public class OrderService {
  public Order Create(...) {
    _validator.Validate(...)
    var order = _repo.Save(...)
    _notifier.Notify(order)
    return order;
  }
}
```

### Exemplo 2: OCP violado

Errado:
```typescript
function calcDiscount(type: string, amount: number) {
  if (type === "vip") return amount * 0.2
  else if (type === "newcomer") return amount * 0.1
  else if (type === "blackfriday") return amount * 0.5
  return 0
}
```

Cada novo tipo edita essa funcao.

Certo:
```typescript
const strategies: Record<string, (amount: number) => number> = {
  vip: a => a * 0.2,
  newcomer: a => a * 0.1,
  blackfriday: a => a * 0.5,
}
function calcDiscount(type: string, amount: number) {
  return strategies[type]?.(amount) ?? 0
}
```

Tipo novo: registra no `strategies`, nao toca `calcDiscount`.

### Exemplo 3: DIP violado

Errado:
```python
# domain/order.py
import psycopg2
class OrderService:
  def get(self, id):
    conn = psycopg2.connect(...)
    ...
```

Dominio acoplado a Postgres.

Certo:
```python
# domain/order.py
class OrderService:
  def __init__(self, repo: OrderRepository):  # abstracao
    self._repo = repo
  def get(self, id): return self._repo.get(id)

# infra/postgres_order_repo.py
class PostgresOrderRepository(OrderRepository):
  def get(self, id): ...  # impl concreta
```

Dominio nao sabe que existe Postgres.
