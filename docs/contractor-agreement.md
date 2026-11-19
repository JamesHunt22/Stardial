# Stardial Contractor Agreement Terms

This document defines the baseline terms Stardial expects in contractor agreements.
It covers quality standards, acceptance and sign-off, security obligations, and
subcontractor management. Individual contracts may add stricter terms, but should
not weaken the ones below.

## 1. Quality Standards

Every deliverable must state its acceptance criteria before work starts. A
deliverable is only complete when all of the following hold:

| Area | Measurable standard |
| --- | --- |
| Functionality | All acceptance criteria in the statement of work pass |
| Tests | New or changed behaviour is covered by automated tests that pass in CI |
| Review | The pull request is approved by a Stardial reviewer |
| Documentation | User-facing behaviour changes are reflected in the `docs/` folder |
| Style | Existing lint, format, and repository conventions are followed |
| Security | No new high or critical findings from dependency or secret scanning |

Numeric targets (latency, uptime, test coverage) are only binding when the
statement of work lists them explicitly. Anything unmeasured is treated as not
agreed.

## 2. Review, Acceptance, and Sign-Off

1. The contractor submits the deliverable as a pull request or shared artifact
   with a short summary of what changed and how it was verified.
2. The Stardial reviewer acknowledges the submission within **2 business days**
   and either approves it or returns written comments.
3. The contractor has **5 business days** to respond to review comments. Silence
   from the reviewer past the acknowledgement window counts as a request for an
   update, not an approval.
4. Sign-off is complete when the reviewer records approval in writing (a GitHub
   approval, or an email confirming acceptance). Informal comments such as
   "looks fine" in chat are not sign-off.
5. If the reviewer raises blocking comments, the contractor gets **2 rework
   cycles** at no extra cost. A third cycle, or a scope change, requires a
   written change order with revised effort and dates.
6. If no sign-off decision is made within **10 business days** of a complete
   submission, the deliverable is deemed accepted and may be invoiced.

## 3. Security Obligations

The contractor must:

- Follow secure development practices: no secrets or credentials in code or
  logs, input validation on all external data, and dependency updates for
  known vulnerabilities.
- Keep access to Stardial systems limited to what the work requires, use
  individual accounts (never shared logins), and enable multi-factor
  authentication wherever available.
- Revoke all access within **5 business days** of the engagement ending or on
  request.
- Report any suspected security incident, data exposure, or leaked credential
  to the Stardial maintainers within **24 hours** of discovery, and cooperate
  with containment and remediation.
- Not copy, retain, or reuse Stardial data or code outside the engagement
  without written permission.

Stardial may audit access and repository activity related to the engagement.

## 4. Subcontractors

- The contractor remains fully responsible to Stardial for all work performed
  by a subcontractor.
- Subcontractors must be disclosed in writing before they start work, and must
  accept the security and confidentiality terms in this document (flow-down
  obligations).
- The contractor must oversee subcontractor output, review it before submission,
  and ensure it meets the quality standards in section 1.
- If a subcontractor fails to deliver or introduces a defect, the contractor
  must provide a remediation plan within **5 business days** and fix the issue
  at no additional cost to Stardial.
- Stardial may object to a subcontractor for security or conflict-of-interest
  reasons, and the contractor must replace them.

## Questions

Open an issue or contact the maintainers if any term here is unclear or conflicts
with a statement of work.
