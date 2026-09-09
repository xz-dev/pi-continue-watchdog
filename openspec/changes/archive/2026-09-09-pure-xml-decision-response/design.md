# Design: pure-xml-decision-response

## Context

`buildDecisionPrompt`'s fixed suffix grants "You may explain your decision first, or output only XML." The assistant's decision response is then neutralized (`neutralizeDecisionAssistant`) and cleared from context; only the parsed fields drive the controller. The preamble was intended as slow-thinking space for models without thinking blocks, but in practice it produces the opposite: the model states conclusions in prose, disagrees with its own XML, overruns the shared non-thinking-text cap, or forgets the block—each triggering the three-attempt invalid cycle. The decision window is the extension's highest-frequency model call, so the waste and failure modes multiply.

The sibling project pi-reflect-watchdog has the identical wording flaw and receives the same fix in its own change; `MAX_REFLECTION_REASKS`' cross-project comment stays accurate.

## Goals / Non-Goals

**Goals:**

- Fixed suffix demands the entire response be the one `<watchdog>` XML document.
- Reasoning is explicitly assigned to `reason_content` and the other fields.
- Reask errors and the tool-block reason echo the same contract.
- Keep parser, controller transitions, reask count, budgets, and folding untouched.

**Non-Goals:**

- Changing `parseWatchdogDecisionXml`, `extractTrailingXml`, or field validation rules.
- Changing the configurable `decisionPrompt` plumbing or its validation.
- Adding new enforcement beyond wording.

## Decisions

### Decision 1: Teach strictly, parse leniently

The suffix switches from "you may explain first... block at the very end" to "your entire response must be exactly one `<watchdog>` XML document; no text before or after it." `extractTrailingXml` already accepts a pure-XML response, so no parser change is needed; a weak model that still emits stray prose before a valid block keeps parsing successfully. Leniency is the safety net for partial compliance, not the teaching surface.

### Decision 2: reason_content is the named slow-thinking space

The suffix explicitly names the structured fields—above all `reason_content` (up to 500 Unicode characters)—as where reasoning goes. This preserves the original design intent (slow thinking for weak models) while removing the unstructured preamble that leaked conclusions out of the harvestable fields.

### Decision 3: Corrective strings mirror the contract

The three error constants that surface in reask prompts and the tool-block reason are reworded to the entire-response phrasing, so a corrective attempt is not re-taught the prose-first habit. Their diagnostic specifics (which validation failed) are preserved where present.

## Risks / Notes

- Models without thinking blocks lose the unstructured scratchpad. Mitigation: fields are free text sized for reasoning; reask x3 catches shape failures; parser leniency accepts partial compliance.
- Prompt-string tests assert current wording and must be updated in the same change.
- `DECISION_TOOL_BLOCK_REASON` reaches the model as a block reason; its wording change is part of the same contract, not a behavioral change.
