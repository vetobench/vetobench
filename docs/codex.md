# OpenAI Codex CLI: research note

**Status: a research note. No code ships.** There is no `vetobench codex` command. Codex CLI keeps a transcript of every session. Each transcript records which tool calls ran and the approval policy in force for each turn. It does not record who approved each call. A Codex card would have to guess its main number, how many actions a person approved, so vetobench prints none.

Everything here comes from the Codex source at commit [`9f3cb25`](https://github.com/openai/codex/tree/9f3cb259535c72de6960cc837ac705a780c62995) (main, 2026-11-25) and from the public docs. Paths are relative to `codex-rs/` in [github.com/openai/codex](https://github.com/openai/codex). Codex changes quickly, so line numbers drift. The links under [Sources](#sources) are pinned to that commit. No real Codex sessions were read for this note.

## Research note

### What Codex records

- **One transcript per session**, called a rollout, at `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-YYYY-MM-DDThh-mm-ss-<thread id>.jsonl`. `CODEX_HOME` defaults to `~/.codex`. The date folders and the timestamp in the name use local time. Archived sessions move to `$CODEX_HOME/archived_sessions/`. `$CODEX_HOME/history.jsonl` holds only the prompt history.
- **The policy in force for each turn.** A `turn_context` record gives the approval policy, who reviews approval requests (you, or the auto-review agent), the sandbox and the model.
- **Every tool call and its output.** This includes the model's request to run a command outside the sandbox (`sandbox_permissions`), with its justification.
- **The text the model got back when an action was refused.** When you deny a command, the model receives "exec command rejected by user", and that text is stored as the command's output.

### What Codex does not record

- **The approval prompt.** The events for an approval request (`exec_approval_request`, `apply_patch_approval_request`, `request_permissions`) are on Codex's list of transient events and are never written to the rollout.
- **Your answer.** Approve, approve for this session, approve and add a rule, deny, or abort is sent back to Codex as a command, not as an event, and is not written either.
- **The auto-review verdict.** `guardian_assessment` is transient too.
- **Who decided.** Codex tracks this in memory as one of three values: a hook, the auto-reviewer, or you. It sends the value to OpenTelemetry as the `codex.tool_decision` event, together with the decision. That event is exactly the record vetobench needs. It never reaches the disk:
  - It is logged under the `codex_otel.log_only` target, and Codex's local log database explicitly drops that target.
  - OpenTelemetry export is off by default (`exporter = "none"`). The only exporters are OTLP over HTTP or gRPC, so the event can only be read by running a collector, which is network code.

## Format

Each line of a rollout is one JSON object: `{"timestamp": "…", "ordinal": n, "type": "…", "payload": {…}}`. `ordinal` is optional. `type` is one of `session_meta`, `turn_context`, `response_item`, `event_msg`, `compacted`, `token_usage_record`, `world_state`, `retained_context`, `security_risk_score`, `dynamic_tools_updated`, `inter_agent_communication`, `inter_agent_communication_metadata` and `realtime_item`.

The records that matter here:

| `type` | Fields | Notes |
|---|---|---|
| `session_meta` | `id`, `timestamp`, `cwd`, `originator`, `cli_version`, `source` | One per file. `source` tells interactive CLI, `exec`, IDE and subagent sessions apart. |
| `turn_context` | `approval_policy`, `approvals_reviewer`, `permission_profile` (older files: `sandbox_policy`), `model`, `cwd` | Once per user turn, and again after compaction. |
| `response_item` with `payload.type` `function_call` | `name`, `arguments` (a JSON string), `call_id` | The shell tool is `exec_command`. Rollouts from other versions can carry `shell_command`, or a `local_shell_call` record instead. The arguments of `exec_command` include `sandbox_permissions` (`use_default`, `require_escalated`, `with_additional_permissions`), `justification` and `prefix_rule`. |
| `response_item` with `payload.type` `function_call_output`, `custom_tool_call_output` | `call_id`, `output` | The text the model received. Patches use the custom tool `apply_patch`. |
| `event_msg` | `payload.type`: `turn_started`, `turn_complete`, `turn_aborted`, `token_count`, … | Only a short list of events is kept. `turn_aborted.reason` is `interrupted`, `replaced`, `review_ended` or `budget_limited`. |

Values:

- `approval_policy`: `untrusted`, `on-request`, `never`, or `{"granular": {…}}`. `on-failure` is still accepted, but Codex now reads it as `on-request`. The docs say current clients no longer support `untrusted`, but the source still parses it.
- `approvals_reviewer`: `user` (the default) or `auto_review` (older spelling: `guardian_subagent`).
- `sandbox_policy.type`: `read-only`, `workspace-write`, `danger-full-access` or `external-sandbox`.
- The decision itself (`ReviewDecision`) is `approved`, `approved_execpolicy_amendment`, `approved_for_session`, `approved_mcp_policy_amendment`, `network_policy_amendment`, `denied`, `timed_out` or `abort`. It exists only in memory and in telemetry.

Two changes are under way, both behind feature flags that are off by default:

- **Compressed rollouts.** Rollouts older than 7 days are recompressed to `rollout-….jsonl.zst` (zstd). `node:zlib` decodes zstd only from Node 22.15 and 23.8, so a zero-dependency reader on Node 18 could not open these files.
- **A "paginated" history mode.** It also keeps completed command items, with `status` `completed`, `failed` or `declined`. `declined` still does not say who declined. Codex warns that the status also covers some failures that were not user decisions (see below).

## Mapping to gates

How each vetobench gate would map, if it can be read from a rollout at all:

| vetobench gate | Codex outcome | In the rollout? |
|---|---|---|
| Static rule / sandbox, no prompt | Exec-policy `allow` rule, or a sandboxed command under `on-request` that needed no approval | **No.** It looks the same as every row below that ran. |
| You, through a prompt | You approved, or approved for this session | **No.** A call approved earlier "for this session" runs again with no prompt and looks the same. |
| AI classifier | The auto-reviewer approved (`approvals_reviewer = auto_review`) | **No.** The verdict is transient. The turn's `approvals_reviewer` shows auto-review was on, not that it ran. |
| Hook | A `PermissionRequest` hook allowed or denied | **No** when it allowed. When it denied, the output holds the hook's own message. |
| Rejected by you | Denied at the prompt | **Text only:** "exec command rejected by user" or "patch rejected by user" in the output. |
| Rejected by you (abort) | Aborted at the prompt | **No.** The turn ends, and none of the abort reasons Codex records (`interrupted`, `replaced`, `review_ended`, `budget_limited`) means "aborted at a prompt". At best it looks like an interrupt. |
| Blocked by the AI classifier | The auto-reviewer denied or timed out | **Text only.** The text holds the reviewer model's own rationale and instructions that come with the model's settings, so it can change without a Codex release. |
| Blocked by policy | `never` (or `granular`) turned a prompt into a refusal, or an exec-policy `forbidden` rule matched | **Text only:** fixed refusal strings, plus the rule's own reason. |

Codex's own code says the refusal channel is overloaded. From `core/src/tools/events.rs:448`: "ToolError::Rejected is currently used for both user-declined approvals and some operational/runtime rejection paths … a subset of non-user failures may be reported as Declined. TODO: We should add a new ToolError variant for user-declined approvals."

From a rollout alone, vetobench could count:

- tool calls by tool name;
- the policy, reviewer and sandbox in force for each call, from the latest `turn_context`;
- how many calls asked to leave the sandbox (`sandbox_permissions` other than `use_default`);
- refusals, by matching the output text.

It could not count approvals of any kind, or tell a prompt you answered from a call that never asked. An escalation request does not always mean a prompt either. An exec-policy rule, an earlier "approve for this session" or a hook can approve it silently. After a sandbox denial, Codex can also ask to retry outside the sandbox without the model asking, for example when a network host is blocked under `on-request`. The call's arguments do not show that prompt.

## Limits

- **No human count.** The headline of the Claude Code card ("you approved N actions") has no Codex equivalent on disk. Calling the remainder "ran without asking" would be wrong: approvals hide inside it.
- **Refusals are matched on model-facing text.** That text is not a stable format. Part of it comes from the reviewer model and the model's settings, and Codex flags the overlap with non-user failures itself.
- **Not tested on real sessions.** This note is built from source and docs only.
- **A moving target.** The rollout format has two history modes, optional compression and more than one shell record (`exec_command`, `shell_command`, `local_shell_call`). A reader would need fixtures for each.

## What would be needed

Any one of these would allow a confident Codex card:

1. **Codex writes the decision to the rollout.** It already has every field: `call_id`, the decision and its source (hook, auto-reviewer, user). Persisting the record that `record_resolution` sends to telemetry, and the commands that need no approval (`source = Config`), would map one to one onto vetobench's gates. This is an upstream change: a feature request to openai/codex.
2. **The user exports OpenTelemetry to a local file** through their own collector (for example an OpenTelemetry Collector with a file exporter). vetobench could then read `codex.tool_decision` records from that file without any network code. This depends on infrastructure the user runs, and on Codex keeping the event's fields stable.
3. **A partial card, labelled as such:** tool calls by the policy in force, escalation requests and text-matched refusals, with no approval or human count. This is possible from today's rollouts. It would not be comparable with the Claude Code card.

An unverified lead: the auto-reviewer runs as its own Codex thread (thread source `guardian_review`, paginated history), and Codex can write that thread as a rollout. If it does by default, that transcript would hold each of the reviewer's assessments. It would cover auto-review only, not your own approvals, and the final decision can still differ from the assessment (fail-closed errors, timeouts, cached approvals). This note did not check whether that file is written by default.

## Sources

Codex source at commit `9f3cb259535c72de6960cc837ac705a780c62995`:

- Rollout path and file name: [`rollout/src/recorder.rs:1668`](https://github.com/openai/codex/blob/9f3cb259535c72de6960cc837ac705a780c62995/codex-rs/rollout/src/recorder.rs#L1668-L1690), [`rollout/src/rollout_file_name.rs:62`](https://github.com/openai/codex/blob/9f3cb259535c72de6960cc837ac705a780c62995/codex-rs/rollout/src/rollout_file_name.rs#L62-L75), [`rollout/src/lib.rs:88`](https://github.com/openai/codex/blob/9f3cb259535c72de6960cc837ac705a780c62995/codex-rs/rollout/src/lib.rs#L88-L89)
- Line envelope and record types: [`history/src/lib.rs:672`](https://github.com/openai/codex/blob/9f3cb259535c72de6960cc837ac705a780c62995/codex-rs/history/src/lib.rs#L672-L679), [`history/src/rollout_payload.rs:51`](https://github.com/openai/codex/blob/9f3cb259535c72de6960cc837ac705a780c62995/codex-rs/history/src/rollout_payload.rs#L51-L95)
- What is persisted and what is transient (approval requests at lines 202, 203 and 208, `guardian_assessment` at 169, `exec_command_end` at 170): [`rollout/src/policy.rs:84-232`](https://github.com/openai/codex/blob/9f3cb259535c72de6960cc837ac705a780c62995/codex-rs/rollout/src/policy.rs#L84-L232)
- `turn_context`, `session_meta`, approval policy, sandbox, decision and abort enums: [`protocol/src/protocol.rs:3726`](https://github.com/openai/codex/blob/9f3cb259535c72de6960cc837ac705a780c62995/codex-rs/protocol/src/protocol.rs#L3726-L3791), [`:3547`](https://github.com/openai/codex/blob/9f3cb259535c72de6960cc837ac705a780c62995/codex-rs/protocol/src/protocol.rs#L3547-L3627), [`:1171`](https://github.com/openai/codex/blob/9f3cb259535c72de6960cc837ac705a780c62995/codex-rs/protocol/src/protocol.rs#L1171-L1194), [`:1258`](https://github.com/openai/codex/blob/9f3cb259535c72de6960cc837ac705a780c62995/codex-rs/protocol/src/protocol.rs#L1258-L1306), [`:4621`](https://github.com/openai/codex/blob/9f3cb259535c72de6960cc837ac705a780c62995/codex-rs/protocol/src/protocol.rs#L4621-L4656), [`:4747`](https://github.com/openai/codex/blob/9f3cb259535c72de6960cc837ac705a780c62995/codex-rs/protocol/src/protocol.rs#L4747-L4752), [`:953`](https://github.com/openai/codex/blob/9f3cb259535c72de6960cc837ac705a780c62995/codex-rs/protocol/src/protocol.rs#L953-L957)
- Reviewer setting: [`protocol/src/config_types.rs:183`](https://github.com/openai/codex/blob/9f3cb259535c72de6960cc837ac705a780c62995/codex-rs/protocol/src/config_types.rs#L183-L191)
- Tool-call records and `sandbox_permissions`: [`protocol/src/models.rs:68`](https://github.com/openai/codex/blob/9f3cb259535c72de6960cc837ac705a780c62995/codex-rs/protocol/src/models.rs#L68-L77), [`core/src/tools/handlers/shell_spec.rs:220`](https://github.com/openai/codex/blob/9f3cb259535c72de6960cc837ac705a780c62995/codex-rs/core/src/tools/handlers/shell_spec.rs#L220-L252)
- Who decided, and where it goes: [`core/src/tools/approvals.rs:460`](https://github.com/openai/codex/blob/9f3cb259535c72de6960cc837ac705a780c62995/codex-rs/core/src/tools/approvals.rs#L460-L523), [`:985`](https://github.com/openai/codex/blob/9f3cb259535c72de6960cc837ac705a780c62995/codex-rs/core/src/tools/approvals.rs#L985-L997), [`core/src/tools/orchestrator.rs:166`](https://github.com/openai/codex/blob/9f3cb259535c72de6960cc837ac705a780c62995/codex-rs/core/src/tools/orchestrator.rs#L166-L224), [`otel/src/events/session_telemetry.rs:1252`](https://github.com/openai/codex/blob/9f3cb259535c72de6960cc837ac705a780c62995/codex-rs/otel/src/events/session_telemetry.rs#L1252-L1279), [`otel/src/lib.rs:62`](https://github.com/openai/codex/blob/9f3cb259535c72de6960cc837ac705a780c62995/codex-rs/otel/src/lib.rs#L62-L66), [`otel/src/events/shared.rs:14`](https://github.com/openai/codex/blob/9f3cb259535c72de6960cc837ac705a780c62995/codex-rs/otel/src/events/shared.rs#L14-L32), [`state/src/log_db.rs:74`](https://github.com/openai/codex/blob/9f3cb259535c72de6960cc837ac705a780c62995/codex-rs/state/src/log_db.rs#L60-L75), [`config/src/types.rs:640`](https://github.com/openai/codex/blob/9f3cb259535c72de6960cc837ac705a780c62995/codex-rs/config/src/types.rs#L640-L660)
- Auto-review verdict and rejection text: [`ext/guardian-reviewer/src/completion.rs:185`](https://github.com/openai/codex/blob/9f3cb259535c72de6960cc837ac705a780c62995/codex-rs/ext/guardian-reviewer/src/completion.rs#L185-L228), the review thread's history mode: [`core/src/guardian/review_session_setup.rs:136`](https://github.com/openai/codex/blob/9f3cb259535c72de6960cc837ac705a780c62995/codex-rs/core/src/guardian/review_session_setup.rs#L136)
- The text a decline sends back from the interactive client ("rejected by user", or "approval request failed" when the prompt fails): [`app-server/src/bespoke_event_handling.rs:2024`](https://github.com/openai/codex/blob/9f3cb259535c72de6960cc837ac705a780c62995/codex-rs/app-server/src/bespoke_event_handling.rs#L2020-L2060), [`:2138`](https://github.com/openai/codex/blob/9f3cb259535c72de6960cc837ac705a780c62995/codex-rs/app-server/src/bespoke_event_handling.rs#L2130-L2150)
- Refusal text and the overload warning: [`core/src/tools/events.rs:444`](https://github.com/openai/codex/blob/9f3cb259535c72de6960cc837ac705a780c62995/codex-rs/core/src/tools/events.rs#L444-L470), [`core/src/exec_policy.rs:225`](https://github.com/openai/codex/blob/9f3cb259535c72de6960cc837ac705a780c62995/codex-rs/core/src/exec_policy.rs#L225-L247)
- Retry outside the sandbox after a denial: [`core/src/tools/orchestrator.rs:429`](https://github.com/openai/codex/blob/9f3cb259535c72de6960cc837ac705a780c62995/codex-rs/core/src/tools/orchestrator.rs#L429-L540)
- Completed command items and `declined`: [`protocol/src/items.rs:239`](https://github.com/openai/codex/blob/9f3cb259535c72de6960cc837ac705a780c62995/codex-rs/protocol/src/items.rs#L239-L244), [`:282`](https://github.com/openai/codex/blob/9f3cb259535c72de6960cc837ac705a780c62995/codex-rs/protocol/src/items.rs#L282-L319)
- Compression (`.zst`, 7-day minimum age, flag off by default): [`rollout/src/compression.rs:26`](https://github.com/openai/codex/blob/9f3cb259535c72de6960cc837ac705a780c62995/codex-rs/rollout/src/compression.rs#L26), [`:371`](https://github.com/openai/codex/blob/9f3cb259535c72de6960cc837ac705a780c62995/codex-rs/rollout/src/compression.rs#L371), [`core/src/thread_store_builder.rs:62`](https://github.com/openai/codex/blob/9f3cb259535c72de6960cc837ac705a780c62995/codex-rs/core/src/thread_store_builder.rs#L62-L64), [`features/src/lib.rs:1576`](https://github.com/openai/codex/blob/9f3cb259535c72de6960cc837ac705a780c62995/codex-rs/features/src/lib.rs#L1576-L1591)

Docs, read 2026-11-25:

- [Advanced configuration](https://learn.chatgpt.com/docs/config-file/config-advanced): OpenTelemetry is off by default; `codex.tool_decision` is listed as "approved/denied and whether the decision came from config vs user"; history persistence.
- [Agent approvals and security](https://learn.chatgpt.com/docs/agent-approvals-security): approval policies, sandbox modes, auto-review, and the note that `untrusted` is no longer supported.
