---
name: anti-tell-copy
description: Use when writing or reviewing any prose in this repository (docs/, README, skill files, website copy, PR bodies, release notes) to remove the statistical tells of LLM-written text. Carries the catalogued tells with sources, the house replacement rules, the repo's own contract-word exceptions, and a review procedure. Pairs with the deterministic gate `npm run test:copy-tells`.
---

# Anti-Tell Copy

Maintainer skill. It does not ship in the `@ax-llm/ax` package.

The goal is not "sound human". The goal is copy that says the specific thing a
reader needs, in the fewest words that stay true. Most LLM tells are what
filler looks like when a model has nothing specific to say, so removing a tell
usually means finding the fact that belongs there.

The deterministic half of this rule lives in `scripts/copy-tells-check.mjs`
(`npm run test:copy-tells`). The lint catches the mechanical tells. This skill
covers the ones no regex can see.

## Sources

1. Simon Willison, "My current policy on AI writing for my blog"
   <https://simonwillison.net/2026/Mar/1/ai-writing/>
2. Simon Willison, "Tool: Curly Quote and Em Dash Highlighter"
   <https://simonwillison.net/2026/May/21/curly-emdash/> and "Em dash"
   <https://simonwillison.net/2026/Feb/15/em-dashes/>
3. Simon Willison, "Slop is the new name for unwanted AI-generated content"
   <https://simonwillison.net/2024/May/8/slop/>
4. Wikipedia:Signs of AI writing (WikiProject AI Cleanup)
   <https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing>
5. `adewale/anti-slop-writing`, `skills/anti-slop-writing/SKILL.md`
   <https://github.com/adewale/anti-slop-writing>
6. `jalaalrd/anti-ai-slop-writing`, `skills/anti-ai-slop-writing/SKILL.md`
   <https://github.com/jalaalrd/anti-ai-slop-writing>

Source 4 states the caveat this skill inherits: these signs do not prove a text
was machine-written. Humans write this way too. They are edit targets, not
accusations.

## Vocabulary Tells

Each word below is either filler or an intensifier standing in for a fact.
Cut it or replace it with the fact. Sources: 4 (the "AI vocabulary" list), 5
(watch-list words), 6.

| Tell | Replace with |
|---|---|
| delve, delve into, deep dive | the verb you mean: read, measure, trace |
| tapestry, testament, landscape, realm | the concrete noun |
| crucial, pivotal, vital, key | say what breaks without it, or drop it |
| robust | the property: bounded, retried, digest-checked |
| seamless, seamlessly, effortless, effortlessly | delete; if true, show the step count |
| streamline, elevate, unlock, empower, foster | the actual verb: remove, raise, allow |
| leverage (as a verb) | use, or the specific mechanism |
| harness (as a verb) | use |
| navigate the landscape, ever-evolving, game-changer | delete the sentence |
| showcase, highlight, underscore, emphasize | shows, is, or nothing |
| meticulous, intricate, comprehensive, vibrant | delete |
| moreover, furthermore, notably, importantly | delete; the next sentence stands alone |
| in today's fast-paced X, at its core, it's worth noting | delete the clause |
| serves as, stands as, functions as, represents | is |
| boasts, features, offers (of a system) | has, or name the field |

## Structural Tells

- The "it's not X, it's Y" contrast, and its family: "not just X but Y",
  "not only X but also Y". Source 4 calls this negative parallelism; source 5
  calls it staccato contrast. It reads as insight while asserting nothing.
  Say Y. If X is a real misconception a reader holds, say so and cite it.
- Tricolons and triads. Three parallel clauses, three parallel bullets, three
  adjectives. Sources 4 and 6. When the real count is two or five, write two or
  five.
- Rhetorical-question openers. "What makes this different?" Answer the question
  as a statement instead.
- "Here's the thing", "Let's dive in", "Let's take a look".
- "In conclusion", "In summary", "Key takeaways", and any closing paragraph
  that restates the section above it. Source 4 lists outline-like conclusions
  as a top structural sign. A reader who got that far does not need the recap.
- Sycophantic and hedging openers ("Great question", "It's important to
  understand that") and closing offers ("Let me know if you'd like me to").
- Uniform sentence length. Source 6 calls three consecutive sentences of the
  same length the strongest single signal.

## Formatting Tells

- No em dashes and no en dashes, ever. Not one. This is the house rule with no
  exception and no escape hatch: the lint treats U+2014 and U+2013 as errors
  with no threshold, no allowlist, and no inline escape. Sources 2, 4 and 6 all
  name dash density as the most cited marker. Use a period, a comma, a colon,
  or parentheses. Write numeric ranges with a hyphen (`2-4`, `1-10,000`).
- Bolded lead-ins stamped on every bullet in a list. Bold the two bullets that
  carry the load, not all seven. Source 4 calls this an inline-header vertical
  list.
- Emoji as section markers or bullets. Sources 4 and 6.
- Headings in a document short enough not to need them, and title case on every
  heading. Source 4.
- Curly quotes and non-breaking spaces pasted in from elsewhere. Source 2.
- "X: Y" label bullets used as a substitute for a table. If every bullet has
  the same shape, it is a table; write the table.

## Tone Tells

- Over-hedging: "may potentially", "can sometimes help to". State the
  condition under which it holds.
- False balance: giving a rejected option equal paragraph weight. Source 5
  calls this the hedging seesaw. Pick, and say why.
- Breathless superlatives and puffery: groundbreaking, renowned, powerful,
  incredibly. Source 4.
- Significance inflation: "underscores the importance of", "plays a pivotal
  role in", "leaves an indelible mark". Source 4 and source 5's core rule:
  sharp detail beats inflated significance.

## House Replacement Rules

1. Say the specific thing. A mechanism, a field name, a number, a file. If
   there is no specific thing, delete the sentence.
2. One idea per sentence. Split before you hedge.
3. Numbers and repeated-shape facts go in a table, not in bullets.
4. Prefer verbs to nominalizations. "The reducer rejects it" over "rejection
   occurs at the reducer".
5. No closing offers, no restating, no "in conclusion".
6. No em dashes or en dashes, ever. See above.
7. Name a file or symbol only when the reader has to go there.
8. Keep contractions where the surrounding voice already uses them.
9. Never invent a number, benchmark, or quote to make a sentence concrete.
   Source 6. If the fact is missing, say it is missing.

## Exceptions: The Repo's Own Contract Words

These are not tells here, and the lint exempts them:

- **harness**. The domain noun for the code that carries an agent's runtime
  authority (`axHarnessEvolve`, harness tree, harness-owned path). Always
  exempt as a noun. As a verb it is still a tell.
- **leverage**. Exempt in the motto "You get more leverage with the wedge on a
  halligan" and in any sentence about the mechanical sense (near "wedge",
  "bar", "fulcrum", or "halligan"). As a verb meaning "use", it is a tell.
- **robust** only where it is a defined term with a stated meaning in the same
  document. Elsewhere, name the property.
- Technical labels in tables, enum members, error codes, and field names are
  never rewritten. The lint reads prose only: fenced code blocks, inline code
  spans, and link targets are excluded.
- Quoted external text stays verbatim. Quote it, do not launder it.

## Review Procedure

Run this on any doc, README section, skill file, or PR body before it lands.

1. Run the gate: `npm run test:copy-tells`. Fix every error. A warning stays
   only with an entry in `scripts/copy-tells-allow.json` carrying a reason,
   and dashes take no entry at all.
2. Read the first and last paragraph of each section. The last is usually a
   restatement; delete it. The first usually warms up for two sentences before
   the fact; delete those.
3. Check every bullet list: is the count real, or was it rounded to three? Is
   it secretly a table?
4. Check every claim of significance for a number, a mechanism, or a file
   behind it. No backing means the claim goes.
5. Check the honesty clauses. Every sentence that says what a mechanism does
   NOT prove, does NOT measure, or does NOT cover is a contract. Keep those
   verbatim. Removing a limitation to tighten prose is the one edit that is
   never allowed.
6. Diff-read the result against the original and confirm no fact, number,
   symbol name, invariant, or code block changed.

## Do Not Generate

- Do not add a summary, a "key takeaways" block, or a closing offer.
- Do not add adjectives to make a claim feel stronger.
- Do not shorten a doc by dropping a limitation, a failure mode, or a number.
- Do not rewrite quoted material, code, error strings, or field names.
- Do not use this skill to argue that a document was machine-written. It edits
  copy; it does not detect authorship.
