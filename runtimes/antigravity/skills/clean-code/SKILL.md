---
name: clean-code
description: Clean Code. Codigo legivel pra humano, optimizado pra leitura (10x mais lido que escrito). Nomes que revelam intencao, funcoes pequenas, sem comentarios redundantes, error handling explicito, sem magic numbers. Aplica em qualquer linguagem.
triggers:
  - "Clean Code"
  - "codigo limpo"
  - "code smells"
  - "legibilidade de codigo"
---

# Skill: Clean Code

> Codigo eh lido 10x mais que escrito. Otimize pra leitura.

Nao eh sobre estilo bonito. Eh sobre **fazer leitor entender em 1 passada**, sem precisar simular execucao mental.

## Regras

### 1. Nomes revelam intencao

- **Variavel**: o que **eh**, nao como esta armazenado (`elapsedSeconds` > `t` > `time`)
- **Funcao**: o que **faz**, verbo + objeto (`calculateTax(order)`, nao `tax(order)`)
- **Boolean**: pergunta sim/nao (`isActive`, `hasPermission`, `canSubmit`)
- **Classe/modulo**: substantivo (`OrderRepository`, `EmailValidator`)
- **Interface**: papel/capability (`Repository`, `Cacheable`) — nao prefixo `I`/`Abstract` se a linguagem nao exige

### Anti-nomes

| Errado | Certo |
|---|---|
| `data`, `info`, `value`, `temp`, `result` | algo descritivo do contexto |
| `processData()` | `parseUserPayload()`, `applyDiscount()`, etc |
| `Manager`, `Helper`, `Util` | nome da responsabilidade real |
| `flag`, `status` | `isComplete`, `paymentStatus` |
| `obj`, `item`, `thing` | tipo real |
| Abreviacoes: `usr`, `ctx`, `mgr`, `cfg` | `user`, `context` (excecao: convencao do dominio bem estabelecida) |
| Variaveis com `_2`, `_new`, `_old` | refatora ate 1 ficar |

### 2. Funcoes pequenas

- **Tamanho**: idealmente < 20 linhas. Se passa de 50, quase certeza esta fazendo coisa demais.
- **1 nivel de abstracao**: dentro da funcao, todas operacoes no mesmo nivel. Mistura de "abrir conexao" + "calcular imposto" = nao.
- **3-4 parametros max**: mais que isso indica ou objeto faltando ou responsabilidade demais.
- **1 saida logica**: early return eh OK; multiplos return em meio a logica complexa eh ruim.

### 3. Funcoes fazem **uma** coisa

Se voce descreve a funcao como "faz X **e** Y", quebra em duas. Nome da funcao deve ser preciso.

Exceção: orchestrators (controllers, command handlers) coordenam — esta OK descrever como "valida, salva, notifica" se cada passo eh chamada pra outra funcao.

### 4. Comentarios

**Default: NAO escrever**.

Codigo bem nomeado nao precisa explicar **o que** faz. Se voce sente vontade de escrever comentario, primeira tentativa: renomear funcao/variavel.

### Comentario eh OK quando:

- **Por que** nao-obvio: workaround pra bug especifico, decisao de design surpreendente, constraint externa
- **Invariante critico**: "este array DEVE estar ordenado pra binary search funcionar"
- **Marcacao de TODO/FIXME** com link pra ticket: `// TODO(#1234): handle UTF-16 surrogate`
- **Aviso de pegadinha**: "// dont call this in a loop, O(n^2)"
- **Doc de API publica**: contrato pro caller (parametros, retornos, exceptions)

### Comentario eh ruim quando:

- Explica o **o que** (o codigo ja diz)
- Repete o nome da funcao em ingles
- Comentario fica desatualizado em relacao ao codigo
- Comentario "removido em XX/YY" deixado na arvore
- "// hack" sem explicar
- "// not sure why this works" — investigue, nao adivinhe

### 5. Error handling explicito

- **Nunca silencie excecao**: `try { ... } catch {}` eh **bug latente**
- **Tratamento explicito**: log estruturado + rethrow OU retorna Result/Either
- **Erros sao parte do contrato**: documenta o que pode falhar
- **Boundary**: trata erro na borda (controller, top-level handler), nao em cada chamada interna
- **Validacao**: na entrada (boundary), nao espalhada

### 6. Sem magic numbers/strings

- Numero ou string com significado vira **constante nomeada**
- `if (status === 3)` vira `if (status === OrderStatus.Shipped)`
- `setTimeout(fn, 86400000)` vira `setTimeout(fn, MS_PER_DAY)`
- Excecao: 0, 1, -1, casos universalmente claros

### 7. Command-Query Separation (CQS)

- **Query**: retorna info, **nao** muta estado
- **Command**: muta estado, **nao** retorna (ou retorna void/ack minimo)

`function getUser(id)` que **tambem** atualiza last_access viola CQS — caller nao espera side-effect. Separa.

### 8. Boy Scout Rule

> Deixe o acampamento mais limpo do que encontrou.

Tocou num arquivo? Pequena melhoria de cleanness eh OK no mesmo commit:
- Renomear variavel obscura
- Quebrar funcao gigante que voce ja teve que ler
- Remover comentario desatualizado
- Apagar codigo morto

Sem refactor pesado nao-relacionado — atomic commit ainda manda.

### 9. Formatacao

- **Auto-format**: linter/formatter no projeto (prettier, dotnet format, ruff format, gofmt) — sem decisoes humanas
- **Ordem de membros**: convencao consistente (publicos antes de privados, ou agrupar por feature)
- **Linha em branco**: separa blocos logicos. Funcao toda colada eh dificil de escanear.
- **Indentacao consistente**: respeita convencao do projeto

### 10. Symmetry e consistencia

- Funcoes do mesmo "nivel" tem assinatura parecida
- `getUserById, getUserByEmail` — ordem de params consistente
- Excecao "as` is" vs "throws" vs Result — escolhe **um** estilo no projeto
- `null` vs `undefined` vs `Option` — escolhe **um**
- Naming convention consistente (camelCase, PascalCase, snake_case) seguindo a linguagem

## Code smells classicos

| Smell | Sintoma |
|---|---|
| **Long function** | > 50 linhas |
| **Long parameter list** | > 4 params |
| **God class** | 1 classe faz tudo |
| **Feature envy** | metodo usa mais dados de **outra** classe que da propria |
| **Data clump** | mesmos 3-4 params juntos em varios lugares -> objeto |
| **Primitive obsession** | tudo eh string/int, sem value objects |
| **Switch statements espalhados** | OCP violado |
| **Shotgun surgery** | mudanca simples toca N arquivos |
| **Divergent change** | 1 classe muda por 5 motivos diferentes (SRP) |
| **Dead code** | funcao/parametro/var nunca usado |
| **Speculative generality** | flexibility sem caller (YAGNI) |
| **Comments compensando codigo ruim** | refatora codigo, deleta comentario |
| **Magic numbers** | 86400, 1024 sem nome |
| **Silenced exceptions** | `catch {}`, `catch (Exception _) { }` |
| **Long if/else chains** | usa polymorphism/strategy |
| **Inconsistent naming** | `getUser` aqui, `fetchAccount` ali, `loadOrder` la |
| **Boolean parameter** | `fn(true)` no caller — ngm sabe o que `true` significa |

## Procedure

### Doer

Apos escrever:
1. **Revisao de nomes**: cada variavel/funcao tem nome que se sustenta sem comentario? Renomeia se nao.
2. **Tamanho**: alguma funcao > 30 linhas? Quebra.
3. **Magic**: algum numero/string sem significado obvio? Constante.
4. **Comentarios redundantes**: algum comentario que so repete o codigo? Deleta.
5. **Error handling**: algum `catch {}` silencioso? Loga ou rethrow.

### Reviewer (gate 5)

```bash
# Funcoes longas
awk '/^(function|def|public |private |protected |async )/ { start=NR; name=$0 }
     /^}$|^\s{0,2}}\s*$/ { if (NR-start > 50) print FILENAME":"start": funcao com "(NR-start)" linhas: "name }' src/**/*.{ts,cs,py,go,java}

# Magic numbers (tipicos suspeitos)
grep -RnE '\b(86400|3600|1024|65535|1000000)\b' src/

# Catch silencioso
grep -RnE 'catch\s*(\([^)]*\))?\s*\{\s*\}' src/
grep -RnE 'except.*:\s*pass\s*$' src/
grep -RnE 'catch.*:.*ignore' src/

# TODO sem ticket
grep -RnE 'TODO(?!.*#\d+)|FIXME(?!.*#\d+)' src/

# Boolean params suspeitos
grep -RnE 'function \w+\([^)]*: bool|: boolean' src/

# Nome generico
grep -RnE '\b(data|info|value|temp|tmp|result|obj|item|thing)\b\s*[:=]' src/ | head -20

# Dead code (linter pega — confirma)

# Comentarios obvios
grep -RnE '^\s*//\s*(get|set|return|increment|decrement|loop|iterate)\b' src/
```

Match relevante -> WARN ou BLOCK conforme severity.

## Inputs

- Diff/conteudo do file
- Convencao do projeto (linter config, naming convention de PROJECT.md)

## Outputs

NAO produz arquivo. Modifica julgamento.

## Examples

### Exemplo 1: nomes ruins

Errado:
```python
def calc(d, t):
    r = d * t * 0.18
    return r
```

Certo:
```python
VAT_RATE = 0.18

def calculate_vat(amount: Decimal, qty: int) -> Decimal:
    return amount * qty * VAT_RATE
```

### Exemplo 2: funcao gigante

Errado: 1 funcao de 120 linhas validando, salvando, enviando email, logando.

Certo: 4 funcoes de 20 linhas cada + 1 orchestrator de 15 linhas que coordena.

### Exemplo 3: silenced exception

Errado:
```typescript
try {
  await sendNotification(user)
} catch {}
```

Bug latente — falha de notificacao some.

Certo:
```typescript
try {
  await sendNotification(user)
} catch (err) {
  logger.error("notification failed", { userId: user.id, err })
  // intencional: notification eh best-effort, nao bloqueia fluxo
}
```

Comentario aqui justifica o "por que" do nao-rethrow.

### Exemplo 4: boolean param

Errado: `createUser("alice", "alice@x.com", true, false)`

Certo: `createUser({ name: "alice", email: "alice@x.com", admin: true, sendWelcome: false })`

Caller fica auto-documentado.
