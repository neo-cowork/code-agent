# English copy glossary

One English name per concept. Chinese uses 协作空间 (pinned by `tests/unit/i18n/zhCollabSpaceNaming.test.ts`).

| Use | Where |
|-----|-------|
| **Space** / **Spaces** | The feature and its container: sidebar, list, archived notice, tool descriptions, approval text, assistant wording |
| **cloud Space** | The upgraded form (capital S): upgrade button/dialog/toast, sign-in and not-cloud errors |

Retired spellings (gated by `tests/unit/i18n/enSpaceNaming.test.ts`):
- "collaboration space(s)" — any case
- lowercase "cloud space(s)"

Stays as is:
- "collaboration service" — it names the backend service, not the Space.
- Sidebar tier labels ("Local spaces"), search aliases in `deferredToolsData.ts`, the `<collaboration_space_context>` XML tag, logs and comments.
