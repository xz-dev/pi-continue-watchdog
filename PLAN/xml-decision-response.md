# XML decision response migration

Status: implemented and verified
Baseline: `94c3deffb10aa47c76955253fcd553b417182dad`

## Goal

Keep Pi's ordinary active tools and system-prompt prefix stable while the watchdog asks the main agent whether work should continue. Replace only the two temporary decision tool calls with a final structured XML answer.

## Accepted behavior

1. A watchdog decision request keeps the ordinary active tool set unchanged. The extension no longer registers or activates `continue_watchdog` / `unlock_continue_watchdog` as Pi tools.
2. The hidden decision prompt tells the agent to decide quickly from existing conversation knowledge and not call tools. It may explain first or output only XML, but it must put exactly one watchdog XML block at the very end of the response and must not output multiple watchdog blocks.
3. The final assistant text is parsed after ignoring thinking blocks and trimming surrounding spaces and line breaks. The trimmed text must end with `</watchdog>`, contain exactly one `<watchdog>` and one `</watchdog>`, and the XML is the suffix beginning at that sole opening tag.
4. The XML root is `<watchdog>`. Its direct decision field is `<function>`.
5. `continue_watchdog` is equivalent to the former empty-argument continue tool call. `<reason_type>` and `<reason_content>` are optional and ignored when present.
6. `unlock_continue_watchdog` requires `<reason_type>` and `<reason_content>`. Existing configured reason-type matching and the nonblank, at-most-500-Unicode-code-point reason rule remain unchanged.
7. During an active watchdog decision, any ordinary Pi tool call is blocked before execution. Its blocked tool result reminds the agent to answer directly with the watchdog XML. The run is not deliberately terminated; the final assistant answer is still the decision.
8. Malformed or semantically invalid XML follows the existing invalid-response rule: the full failed exchange remains available to the immediate re-ask, with the existing maximum of three invalid responses.
9. Every terminal watchdog outcome gets a fold marker. Future model-bound context removes the complete decision exchange, including invalid replies, blocked calls/results, and re-asks. A valid continue inserts only the configured compact `continuePrompt`; valid unlock and `decision-failed` insert nothing.
10. Raw session history may retain the protocol records for audit; folding remains model-bound only.

## XML suffix rules

Accepted examples:

```xml
<watchdog><function>continue_watchdog</function></watchdog>
```

```xml
<watchdog>
  <function>continue_watchdog</function>
  <reason_type>anything</reason_type>
  <reason_content>anything</reason_content>
</watchdog>
```

```xml
<watchdog>
  <function>unlock_continue_watchdog</function>
  <reason_type>JOB_DONE</reason_type>
  <reason_content>All requested work is complete.</reason_content>
</watchdog>
```

The response may contain narration before the XML, or consist only of XML. After outer whitespace is trimmed, it must end with `</watchdog>` and contain exactly one `<watchdog>...</watchdog>` block; multiple watchdog blocks are invalid. The parser extracts from the sole `<watchdog>` opening tag through the final closing tag. Normal XML entity escaping is decoded. The root has no attributes or namespaces. Extra simple child keys are ignored; required fields may not repeat. For unlock, `function`, `reason_type`, and `reason_content` are required. For continue, `function` is required and reason fields are ignored if present.

## Delivery slices

- [x] Add/replace protocol tests and demonstrate the old tool-call implementation fails them.
- [x] Implement XML parsing and decision finalization without temporary tool activation.
- [x] Block ordinary tool execution only while a decision is active.
- [x] Generalize context folding and add a terminal fold for `decision-failed`.
- [x] Remove obsolete tool registration/rendering code and tests.
- [x] Update behavior documentation.
- [x] Run focused tests, full checks, packed E2E, and independent final review.
