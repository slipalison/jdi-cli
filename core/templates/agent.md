---
name: jdi-{NAME}
description: {ONE_LINE_DESCRIPTION}
runtime_intent:
  role: {ROLE}
  reasoning: {cheap|medium|deep}
  privileges: {read|read+write|read+write+edit|read+write+edit+bash}
tools_canonical:
  {TOOLS_LIST}
triggers:
  {TRIGGERS_LIST}
runtime_overrides:
  claude:
    model: {CLAUDE_MODEL}
    tools: {CLAUDE_TOOLS}
  copilot:
    model: {COPILOT_MODEL}
    tools: {COPILOT_TOOLS}
  antigravity:
    triggers_extra:
      {EXTRA_TRIGGERS_LIST}
---

<role>
{DETAILED_ROLE_DESCRIPTION}

Spawned by: {WHO_INVOKES}

Responsibilities:
- {LIST}

NOT this agent's responsibility:
- {BOUNDARY_LIST}
</role>

<inputs>
- {REQUIRED_ARGS}
- (optional) {OPTIONAL_ARGS}
- Read access on: {REQUIRED_FILES}
</inputs>

<skills_to_load>
{SKILLS_AGENT_USES}
</skills_to_load>

<process>

### Step 1: {STEP_NAME}
{DESCRIPTION}

### Step 2: {STEP_NAME}
{DESCRIPTION}

### Step 3: {STEP_NAME}
{DESCRIPTION}

</process>

<rules>
- {LIST_OF_INVIOLABLE_RULES}
</rules>

<fallbacks>
- No {TOOL_X}: {ALTERNATIVE}
- {OTHER_FALLBACKS}
</fallbacks>

<output>
- {ARTIFACT_PRODUCED}
- {SIDE_EFFECTS}
- Final message to user: {EXAMPLE}
</output>
