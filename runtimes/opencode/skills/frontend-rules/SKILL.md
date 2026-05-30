---
name: frontend-rules
description: Universal UI/UX and accessibility rules for any web interface. Framework-agnostic - works for React, Vue, Svelte, Solid, Angular, Blazor, Razor, Twig, Jinja, ERB, Blade, and any template engine. Based on WCAG 2.2 AA, Nielsen heuristics, Material/Apple HIG.
---

# Skill: jdi-frontend-rules

UI/UX standards that CANNOT be violated - regardless of stack. Concepts > syntax. Works for SPA, SSR, MPA, hybrid, any template engine.

## When to apply

Whenever code touches a visible human interface:

- Files `.tsx, .jsx, .vue, .svelte, .astro, .qwik, .solid` (JS-based components)
- Files `.razor, .cshtml` (Blazor / Razor Pages / MVC)
- Files `.html, .twig, .jinja, .j2, .erb, .blade.php, .hbs, .liquid, .mustache, .ejs, .pug` (template engines)
- CSS/Tailwind/SCSS/Less affecting layout, contrast, focus, or accessibility
- ARIA / semantic HTML in any language

Does NOT apply to: API-only backends, CLI tools, services without UI.

## Universal rules (hard gates)

### 1. Accessibility - WCAG 2.2 level AA

All mandatory. Violation = BLOCK on review.

- **Color contrast**:
  - Normal text: minimum 4.5:1 against background
  - Large text (18pt+ or 14pt+ bold): minimum 3:1
  - UI components and graphics: minimum 3:1
  - Verify in hover/focus/disabled states too
- **Visible focus**: never `outline: none` or `outline: 0` without a replacement. Focus must be perceptible in strong light and on a cheap monitor. `:focus-visible` is the standard
- **Keyboard navigation**: 100% of interactions reachable via keyboard. Tab follows logical visual order. No trap (modal without Esc, dropdown without Escape/arrows)
- **Semantic HTML first**:
  - `<button>` for action (even if styled as a link)
  - `<a href>` for navigation (even if styled as a button)
  - `<form>` for forms (Enter submits, native validation works)
  - Headings in order (`h1` -> `h2` -> `h3`, no level skipping)
  - `<nav>, <main>, <header>, <footer>, <aside>, <section>, <article>` when appropriate
  - `<ul>/<ol>` for lists, not repeated `<div>`
- **ARIA when needed**:
  - Icon-only button: `aria-label="descriptive action"`
  - Form error: `role="alert"` or `aria-live="assertive"`
  - Loading region: `aria-busy="true"` + `aria-live="polite"`
  - Toggle/expand: `aria-expanded="true|false"` + `aria-controls`
  - Modal: `role="dialog"` + `aria-modal="true"` + `aria-labelledby`
  - Tooltip: `aria-describedby`
  - ARIA NEVER REPLACES semantic HTML. ARIA only complements
- **Skip link**: first tab order offers "Skip to main content"
- **Minimum touch target**: 44x44 CSS px (Apple HIG / WCAG 2.5.5). Increase on mobile with `padding`, not margin
- **Color is not the only indicator**:
  - Red error needs icon OR explicit text
  - Colored link needs underline OR different visual weight
  - Active nav state needs border/weight, not just color
  - Color blindness affects 8% of men. Always color + shape + text
- **Form labels**: every `<input>, <textarea>, <select>` with:
  - Associated `<label htmlFor="id">`, OR
  - `aria-label="..."`, OR
  - `aria-labelledby="id-of-another-element"`
  - Placeholder DOES NOT count as label (disappears when user types)
- **Associated error**: field error connected via `aria-describedby="error-id"`. Error text has matching `id`
- **Language**: `<html lang="pt-BR">` declared. Without this screen reader reads English for pt-BR text
- **prefers-reduced-motion**: respect. Animations should disable via `@media (prefers-reduced-motion: reduce)`

### 2. Mandatory states on every UI surface

Every screen/component that loads or mutates data must cover all 5:

- **Loading**:
  - Skeleton with shape matching real content (avoids layout shift)
  - OR spinner/progress if shape unpredictable
  - Visible minimum 200ms (avoids flash that flickers)
  - Maximum 10s without extra feedback - after that explain "almost there" or offer cancel
- **Empty**:
  - Never empty screen. Always message + icon + actionable CTA
  - Text orients next step: "Create your first X by clicking Y"
  - Don't confuse empty with error (empty is success, error is failure)
- **Error**:
  - Specific message: what failed + how to fix
  - NEVER "Something went wrong" / "Unexpected error" as final message to user
  - Visible recovery action: retry, go back, contact support
  - Inline validation errors + general message if needed
- **Success**:
  - Visible confirmation - toast is OK for non-destructive actions
  - Destructive action (delete, transfer) needs undo OR prior confirmation
  - Toast disappears in 4-6s; destructive actions with undo have 5-10s
- **Disabled**:
  - ALWAYS with visible reason: tooltip, helper text, or hint
  - Silent disabled = bug ("why can't I click?")
  - Consider alternative: don't disable, let click and show specific error

### 3. Feedback timing - Nielsen heuristics

- **< 100ms**: feels instant. No indicator needed
- **100ms to 1s**: acceptable without indicator. Cursor may change to waiting
- **1s to 10s**: progress indicator required. Spinner or bar
- **> 10s**: progress + estimated time OR allow cancel
- **Indeterminate and > 30s**: offer background notification, free up UI
- **Optimistic UI**: like/save/toggle - update UI immediately, rollback if it fails

### 4. Forms - universal patterns

- **Validation**:
  - On blur for individual field (after user leaves field)
  - On submit for general validation
  - On change ONLY for positive feedback (e.g., password strength)
  - NEVER on keypress for error ("missing character") - tiring
- **Inline errors**: next to/below the wrong field, WITH optional general top-of-form message. Never just top
- **Required**:
  - Red asterisk is NOT enough - add text "(required)" or a clear mark before submit
  - Indicate required at design time, not after the error
  - Modern alternative: mark optionals ("Phone (optional)")
- **Autocomplete**: correct `autocomplete` attribute: `email, current-password, new-password, name, given-name, family-name, tel, postal-code, etc`. Enables browser autofill
- **Inputmode + type**:
  - `type="email"` shows keyboard with @ on mobile
  - `inputmode="numeric"` for OTP/PIN/ZIP
  - `type="tel"` for phone
  - `type="url"` for URL
  - `type="date"` for date (with fallback if browser doesn't support)
- **Submit**:
  - DO NOT disable button before user tries - teaches wrong and hides cause
  - Disable ONLY during in-flight request (avoids double submit)
  - Loading state on the button (text + inline spinner)
- **Password**:
  - "Show password" toggle (eye icon)
  - Always force HTTPS - never send password in plain HTTP
  - Show requirements before user types (8+ chars, etc)
- **Destructive confirmation**:
  - Irreversible actions (delete account, drop data) require typing name/word or explicit checkbox
  - Plain "are you sure?" modal is insufficient for truly destructive action

### 5. Navigation

- **Current location**: active nav highlighted (weight + color + indicator). Breadcrumbs in deep hierarchy
- **Browser back button**: respect history. Modal doesn't use `pushState` without reason. Single-page nav uses router that emits real history
- **Custom 404**: friendly page with search or sitemap, not blank screen
- **Logo links home**: universal convention
- **Search**: if app has search, keyboard shortcut `/` or `Ctrl+K` (convention)

### 6. Responsive - mobile-first

- **Design starts at 320px** and grows - not the other way around
- **Breakpoints based on content**, not devices: point where layout breaks, not "iPhone 12"
- **No horizontal scroll on mobile** (except intentional carousel). Audit with viewport 375px
- **Touch-friendly spacing**: minimum 8px between clickable targets
- **Hover-only is bad on mobile**: anything needing hover needs fallback (long press, tap to reveal)
- **Density**: mobile needs more space than desktop for the same legibility

### 7. UX performance - Core Web Vitals

- **CLS < 0.1** (Cumulative Layout Shift):
  - `width` + `height` on every `<img>` (avoids jump on load)
  - `font-display: swap` with metric-compatible fallback
  - Reserve space for ads/embeds/skeletons
- **LCP < 2.5s** (Largest Contentful Paint):
  - Optimized hero image (WebP/AVIF + responsive `srcset`)
  - Critical CSS inline
  - Preload critical resource (`<link rel="preload">`)
- **INP < 200ms** (Interaction to Next Paint):
  - No heavy JS blocking main thread during interaction
  - Debounce on input handlers
  - Web Workers for heavy computation
- **TTFB < 800ms** (Time To First Byte):
  - Static cache, CDN, lazy loading
- **Optimistic UI**: already mentioned - update immediately

### 8. Visual hierarchy

- **1 primary action per view**. Multiple = paralyzed decision (Hicks Law)
- **Secondary visually smaller**: ghost, outline, or link
- **Whitespace separates groups** - no little box (border) for everything
- **Fixed spacing scale**: 4/8/16/24/32/48/64 (multiples of 4 or 8). No `margin: 13px`
- **Type scale**: max 5-6 sizes in the entire app. More than that = visual chaos
- **Color palette**:
  - 60-30-10 rule: 60% neutral (background), 30% complementary, 10% accent (CTA)
  - Max 1 brand color + 1 or 2 accents
  - States (success/warn/error) are a separate palette
- **Alignment**: every element aligned to a grid - not "eyeball"

### 9. i18n + l10n

- **Zero hardcoded string in markup**. Always a translation key
  - JSX/TSX: don't write pt-BR text directly, use `t("key")` or equivalent
  - Templates: use translate tag (`{% trans %}`, `<t>`, `@Localize`)
  - HTML: separate content from markup
- **RTL ready** (Arabic, Hebrew):
  - Logical properties: `margin-inline-start` instead of `margin-left`
  - `padding-block` instead of `padding-top`
  - `text-align: start/end` instead of `left/right`
  - `dir="auto"` on fields accepting input in any language
- **Format by locale**:
  - Dates: `Intl.DateTimeFormat` or backend equivalent
  - Numbers: `Intl.NumberFormat`
  - Currency: never hardcoded "$" - currency comes from locale + value
- **Pluralization**: ICU MessageFormat or equivalent. Languages have 1, 2, 3+ or more forms (Russian has 4)

### 10. UI security - overlap with general rules

- **Tokens NEVER in localStorage/sessionStorage**:
  - Vulnerable to XSS. Any malicious script reads everything
  - Safe pattern: httpOnly cookie + SameSite=Strict
  - Token in memory with refresh via cookie is OK for SPAs
- **Strict CSP**:
  - `script-src 'self'` at minimum - no `unsafe-inline`, no `unsafe-eval`
  - `frame-ancestors 'none'` or whitelist - prevents clickjacking
- **HTTPS only**:
  - Redirect HTTP -> HTTPS on the server
  - HSTS header with `includeSubDomains`
  - No mixed content (HTTP on HTTPS page)
- **CSRF**:
  - CSRF token on every form with authenticated side-effect
  - SameSite=Strict cookie helps but isn't enough
- **External links**:
  - `target="_blank"` ALWAYS with `rel="noopener noreferrer"` (prevents tabnabbing)
- **dangerouslySetInnerHTML / v-html / @Html.Raw**:
  - Never with user input without sanitization (DOMPurify or backend sanitizer)
  - Prefer semantic parsing (markdown -> AST -> render)
- **External form action**: never accept a user-controllable `action` URL

## Anti-patterns - BLOCK list for reviewer

Each item below is automatic violation. Reviewer marks BLOCK + cites rule.

| Anti-pattern | Why it is BLOCK |
|---|---|
| Button that looks like a link / link that looks like a button | Confuses mental model, violates convention |
| `<div onclick>` instead of `<button>` | No keyboard, no ARIA, no semantics |
| `<a href="#">` or `<a href="javascript:">` for action | Becomes a destinationless link - use `<button>` |
| Modal without Esc close | Keyboard trap - WCAG 2.1.2 |
| Modal without visible close button | Same reason |
| Infinite spinner without timeout/fallback | User doesn't know if it's stuck |
| Auto-play media with sound | WCAG 1.4.2 |
| Toast as ONLY confirmation of destructive action | Toast disappears - destructive needs persistent |
| Disabled state without visible reason | "Why doesn't it work?" - UX bug |
| Generic error "Something went wrong" | Not actionable |
| Color as ONLY state indicator | Color blindness - WCAG 1.4.1 |
| Required marked ONLY by color (red border) | Same reason |
| Required shown ONLY after submit | User didn't know it was required |
| Form without `<label>` or `aria-label` | WCAG 3.3.2 |
| Placeholder replacing label | Disappears when user types - WCAG 3.3.2 |
| Heading skip (h1 -> h3 without h2) | WCAG 1.3.1 |
| `<img>` without `alt` | WCAG 1.1.1 |
| `<img alt="image">` or redundant alt "image of X" | Good alt describes content, not media |
| Text over image without overlay/guaranteed contrast | WCAG 1.4.3 |
| Animation > 400ms on direct interaction | Perceived as slow |
| `prefers-reduced-motion` ignored | WCAG 2.3.3 |
| Outline removed without replacement | WCAG 2.4.7 |
| Arbitrary positive `tabindex` (`tabindex="5"`) | Breaks natural order - only use 0 and -1 |
| `lang` absent on `<html>` | Screen reader pronounces wrong |
| Form action or href with direct user input | Risk of XSS/open redirect |
| `localStorage.setItem('token', ...)` or similar for credential | XSS risk - use httpOnly cookie |

## Procedure (use by agent)

### Doer (write/edit)

#### Step 1: Detect type of change
If task touches UI files, load checklist in mind before writing.

#### Step 2: For each new component/template
Apply the checklist of rules 1-10. In particular:
- Does it cover the 5 states (loading/empty/error/success/disabled)?
- Semantic HTML first?
- Visible focus maintained?
- Contrast OK in light/dark states?
- Strings via i18n key?

#### Step 3: When in architectural doubt
Consult references:
- Full WCAG: `references/wcag-checklist.md`
- States: `references/state-coverage.md`
- Forms: `references/forms-patterns.md`
- Anti-patterns explained: `references/anti-patterns.md`

### Reviewer (gate 5)

#### Step 1: For each modified file in frontend
Run specific greps based on the type:

**JSX/TSX/Vue/Svelte:**
```bash
# Button without aria-label and without inner text
grep -RnE '<button[^>]*>(\s*<[^>]+/?>\s*)+</button>' src/

# Input without label
grep -RnE '<input(?![^>]*aria-label)(?![^>]*id=)' src/

# href="#" for action
grep -RnE 'href="#"' src/

# localStorage with token
grep -RnE 'localStorage\.(set|get)Item.*[Tt]oken' src/

# Outline removed
grep -RnE 'outline\s*:\s*(none|0)' src/
```

**Server-side templates (Razor/Twig/Blade/ERB/Jinja):**
Similar greps adapted to the syntax.

#### Step 2: Classify
- Match on violation listed in the table above -> BLOCK
- Suspicious pattern but not certain -> WARN
- No match -> PASS on gate 5

## Expected inputs

- Path of the modified file
- Diff or complete content of the file

## Outputs

Does NOT produce its own file. Modifies the parent agent's judgement:
- Doer chooses NOT to introduce a violation - writes correct code from the start
- Reviewer marks BLOCK/WARN with rule cited

## References

- `references/wcag-checklist.md` - WCAG 2.2 AA expanded with code examples
- `references/state-coverage.md` - Patterns for loading/empty/error/success/disabled across engines
- `references/forms-patterns.md` - Universal patterns for form validation and UX
- `references/anti-patterns.md` - Gallery of anti-patterns with wrong example + fix

## Anti-patterns of this skill

- Applying only to JS stacks - rules work for any template engine
- Making a rule framework-specific (e.g., "use React.useState") - skill is agnostic
- Replacing human design code review - skill covers the technically broken, not the aesthetically mediocre
- Blocking MVP for minor a11y - severity matters, minor is INFO/WARN

## Examples

### Example 1: Doer receives task "add delete button to ItemCard"

Applies skill before writing:
- Destructive action needs: explicit confirmation, focus returns to origin button after modal closes, descriptive label (`aria-label="Delete item Order #123"`), undo if possible
- Loading state during request
- Error state with retry
- Success state with undo (5s timer)
- Use `<button>`, not `<a>` or `<div>`
- Tab order: button -> modal opens -> modal buttons navigable -> Esc closes -> focus returns

Code written comes out compliant.

### Example 2: Reviewer finds `<input>` without label

Marks gate 5 as BLOCK:
```
[BLOCK] src/components/LoginForm.tsx:42
Rule: Forms - Form labels (WCAG 1.3.1, 3.3.2)
Violation: <input type="email" /> without <label>, aria-label, or aria-labelledby
Fix: <label htmlFor="email">Email</label><input id="email" type="email" />
```

### Example 3: Reviewer finds `localStorage.setItem('access_token', token)`

Marks gate 5 as BLOCK:
```
[BLOCK] src/auth/store.ts:18
Rule: UI Security - Tokens in storage
Violation: localStorage.setItem with authentication token
Why: vulnerable to XSS - any malicious script on the page reads the token
Fix: backend sets httpOnly cookie SameSite=Strict; frontend doesn't touch token
```

### Example 4: Backend-only API (Python FastAPI)

Skill is not loaded. PROJECT.md has `frontend.has_frontend: false`. Nothing happens.
