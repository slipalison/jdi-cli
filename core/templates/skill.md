---
name: {NAME}
description: {ONE_LINE_DESCRIPTION}
type: skill
applies_to:
  {WHEN_TO_APPLY}
loaded_by:
  {AGENTS_THAT_LOAD}
runtime_overrides:
  antigravity:
    triggers:
      {DISCOVERY_TRIGGERS}
---

# Skill: {NAME}

{DETAILED_DESCRIPTION}

## When to apply

{USAGE_CONDITIONS}

## Procedure

### Step 1: {NAME}
{DESCRIPTION}

### Step 2: {NAME}
{DESCRIPTION}

### Step 3: {NAME}
{DESCRIPTION}

## Expected inputs

{WHAT_THE_PARENT_AGENT_PROVIDES}

## Outputs

{WHAT_GOES_BACK_TO_PARENT_AGENT}

Does NOT produce own files. Modifies parent agent's work.

## References

- `references/{X}.md` — {DESCRIPTION}
- `references/{Y}.md` — {DESCRIPTION}

## Anti-patterns

- {THING_NOT_TO_DO}
- {THING_NOT_TO_DO}

## Examples

### Example 1: {SCENARIO}

Input:
```
{EXAMPLE_INPUT}
```

Output (in parent agent context):
```
{EXAMPLE_OUTPUT}
```
