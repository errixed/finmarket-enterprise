# Automation & Analytics module (Phase II)

Owner: Member 5 (Godwin). Directory: `backend/src/modules/automation/`.

This module stores automation rules and activity events in MongoDB, matches
events to rules, schedules delayed follow-ups, hands delivery work to the
Delivery module, and reports analytics. Phase I (in-memory) endpoints and
response shapes are preserved; `PATCH /automations/:id` and two read-only
endpoints are new.

## Identifier conventions

These are the shared project conventions and the module follows them exactly.

| Field | References |
| --- | --- |
| `ownerId` | `User._id` of the advisor who owns the rule or event |
| `advisorId` | `AdvisorProfile._id` (used when talking to Campaigns, Leads, Delivery) |
| `campaignId` | `Campaign._id` |
| `entityId` | the collection chosen by `entityType` (`LEAD` -> Lead, `CAMPAIGN` -> Campaign, `DELIVERY_JOB` -> DeliveryJob, `AUTOMATION_RULE` -> AutomationRule) |
| `eventId` | the **deduplication id** of an event. It is a client/producer supplied string and is **not** the same as `ActivityEvent._id` |
| `automationRuleId` | `AutomationRule._id` |

`ownerId` is never trusted from a request body. It always comes from the JWT;
a body value that differs is rejected with `403 OWNER_MISMATCH`.

## Collections

* **AutomationRule** - `ownerId`, `name`, `description`, `trigger`, `action`,
  `campaignId`, `delayMinutes` (integer 0-43200), `enabled` (default `false`),
  `actionConfig {subject, body}`, `allowSpecialistToggle`, `executionCount`,
  `lastExecutedAt`, timestamps.
* **ActivityEvent** - `eventId` (**unique index**), `eventType`, `entityId`,
  `entityType`, `ownerId`, `campaignId` (derived), `occurredAt`, `metadata`,
  `source` (`SIMULATION` | `INTERNAL`), `processingStatus`
  (`RECEIVED` -> `PROCESSING` -> `PROCESSED` | `FAILED`), `matchedRuleCount`.
* **AutomationExecution** - one row per (event, rule): `eventId`,
  `automationRuleId`, `idempotencyKey` (`eventId:ruleId`), `status`
  (`PENDING`, `PROCESSING`, `COMPLETED`, `FAILED`, `UNCERTAIN`, `SKIPPED`,
  `SIMULATED`), `scheduledFor`, `attemptCount`, lease fields, `result`, `error`.
  **Unique index on (`eventId`, `automationRuleId`)**; index on
  (`status`, `scheduledFor`) for the worker.

Layering is route -> controller -> service -> repository -> model. Only
`automationRepository.js` (and the adapters for other modules) query MongoDB.

## Authentication and authorization

* The module uses the **shared** `authenticate` middleware
  (`src/middleware/authMiddleware.js`, Identity module). It does not implement
  JWT itself. `automationAuth.js` adopts the shared middleware as soon as it
  exists and **fails closed** (`503 AUTH_UNAVAILABLE`) until then, so the
  endpoints can never be reached unauthenticated.
* Roles (`ROLES` from Identity):

| Role | Rules | Events / executions | Analytics |
| --- | --- | --- | --- |
| `ADVISOR` | create, read, update, enable/disable **own** rules | own | own data |
| `MARKETING_SPECIALIST` | read rules of campaigns they are assigned to; toggle `enabled` only if the owner set `allowSpecialistToggle` | events/executions of those campaigns | those campaigns only, **no lead data** |
| `ADMIN` | read all; **cannot modify** (explicit read-only policy) | read all | platform totals |

* **Specialist access requires an accepted advisor-specialist relationship
  AND a campaign assignment.** Either one alone grants nothing. Revoking the
  relationship removes access immediately (checked on every request).
* Only advisors can create rules or simulate events. Admins cannot trigger an
  advisor's rules.

## Endpoints

All routes are under `/api/v1` and require `Authorization: Bearer <jwt>`.

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/automations` | create rule (validated, owner from JWT) |
| GET | `/automations` | list; filters `ownerId`, `enabled`, `trigger`, `action`, `campaignId`, `page`, `limit` |
| GET | `/automations/:id` | single rule (ownership/scope checked) |
| PATCH | `/automations/:id` | **new**; allowed fields only |
| POST | `/automations/simulate-event` | advisors only; never reaches Delivery |
| GET | `/automations/events` | history; filters `eventType`, `entityType`, `entityId`, `campaignId`, `processingStatus`, `source`, `from`, `to`, pagination |
| GET | `/automations/executions` | **new**; persisted executions and schedule |
| GET | `/analytics/summary` | aggregation-backed summary |

Errors use the shared shape `{ "success": false, "error": { "code", "message" } }`.
Lists return `{ success, count, pagination, data }`. Unknown query parameters,
repeated parameters and operator-style values are rejected with `400`.

Triggers: `LEAD_CREATED`, `LEAD_STATUS_CHANGED`, `CONSULTATION_REQUESTED`,
`CAMPAIGN_ACTIVATED`, `CAMPAIGN_CREATED`, `CAMPAIGN_COMPLETED`,
`DELIVERY_QUEUED`, `DELIVERY_SENT`, `DELIVERY_FAILED`.
Actions: `SEND_EMAIL`, `SCHEDULE_FOLLOW_UP`, `CREATE_NOTIFICATION`.
`AUTOMATION_EXECUTED` / `AUTOMATION_FAILED` are audit events only and can never
be triggers.

**Loop guard.** Email actions may only react to lead triggers; campaign and
delivery events can only run `CREATE_NOTIFICATION`. A delivery event therefore
can never queue another delivery. An enabled email rule must name a campaign.

## Event processing

1. The event is validated (type, entity type/id, owner, campaign, metadata).
2. Ownership of the referenced lead/campaign/delivery is verified.
3. It is stored with its unique `eventId` (a duplicate returns
   `409 EVENT_ALREADY_PROCESSED` for simulation; trusted duplicates are
   reported as `duplicate: true`, and an unfinished event is resumed).
4. Enabled rules of the same owner with the same trigger (and the same
   campaign, if the rule has one) match.
5. One execution is created per matching rule, `scheduledFor = occurredAt +
   delayMinutes`; due executions run right away, the rest wait for the worker.
6. The event is marked `PROCESSED` (or `FAILED`).

`POST /automations/simulate-event` creates `SIMULATED` executions only and
returns `{ event, simulatedActions }` exactly as in Phase I. In production it
is refused unless `AUTOMATION_SIMULATION_ENABLED=true`.

Other modules publish real events through the trusted in-process API
`publishEvent(event)` (exported by `automationService`); it is not an HTTP
route. Metadata is sanitised: credential-like keys, JWT/email-like values,
`$`/`.` keys and oversized or deeply nested objects are rejected, and
sensitive keys already stored are redacted on read.

## Duplicate prevention

* Duplicate events: unique `eventId` index; concurrent submissions create one
  event and one `409`-style duplicate result.
* Duplicate executions: unique (`eventId`, `automationRuleId`) index.
* Workers claim an execution with an atomic `PENDING -> PROCESSING` update, so
  several workers or instances never run the same execution.
* Delivery receives `idempotencyKey = eventId:automationRuleId`.
* Outcomes: `COMPLETED`; `FAILED` for a definite 4xx rejection; a `503`
  or `retryable` error is retried with exponential backoff (5 min base, 3
  attempts, then `FAILED / RETRIES_EXHAUSTED`); an unknown outcome or an
  abandoned `PROCESSING` lease becomes **`UNCERTAIN` and is never retried
  automatically**, to avoid sending an email twice.

## Scheduled follow-ups

The schedule is the set of `PENDING` executions in MongoDB, not in-memory
timers. `automationWorker.js` polls every `AUTOMATION_WORKER_INTERVAL_MS`
(default 30000), never overlaps its own passes and survives restarts. A rule
disabled (or removed) before an execution is due makes that execution
`SKIPPED`. The worker starts from `initializeAutomation()` in `server.js` and
can be disabled with `AUTOMATION_WORKER_ENABLED=false`.

## Delivery integration

Automation never sends email. `automationAdapters.js` calls Delivery's
`queueDelivery` through one adapter. Request:

```
{ idempotencyKey, source: "AUTOMATION", automationRuleId, eventId,
  advisorId, campaignId, leadId, channel: "EMAIL",
  content: { subject, body }, scheduledAt }
```

Response: `{ deliveryJobId, status }`. Delivery signals `4xx` for a definite
refusal (consent, campaign state), `503` for a temporary outage. Only the
fields Delivery accepts are forwarded.

## Analytics

`GET /analytics/summary` is computed with MongoDB `$facet`/`$group`; no
collection is loaded into memory.

* `rules`: total, enabled, disabled, by trigger, by action
* `events`: total, `withMatchingRules`, by type, by processing status
* `simulatedActions` and `executedActions` (separate, with status breakdown)
* `business.leads` (omitted -> `null` for specialists): total, by status,
  consultation requests, converted, `conversionRate` = converted / total x 100,
  two decimals, `0` with no leads
* `business.campaigns` and `business.deliveries`: totals and key statuses

Scope follows the role table above.

## Setup

```
cd backend
npm install
# .env (never commit it): MONGO_URI, JWT_SECRET (>=32 bytes), JWT_ISSUER, JWT_AUDIENCE
npm start
```

Optional: `AUTOMATION_WORKER_ENABLED`, `AUTOMATION_WORKER_INTERVAL_MS`,
`AUTOMATION_SIMULATION_ENABLED`.

## Tests

The tests use a **real MongoDB** (no mocked database). Point `MONGO_URI` at a
database whose name contains `_test`; each suite creates and drops its own
database. Docker is not required.

```
MONGO_URI='mongodb://127.0.0.1:27017/finmarket_test' npm run test:automation
npm run validate:models
```

Suites map to the Phase II guide: `persistence` (8.1), `auth` (8.2), `rules`
(8.3), `events` (8.4), `duplicates` (8.5), `scheduling` (8.6), `analytics`
(8.7), `contracts` (8.8). The Postman collection is
`postman/FinMarket-Enterprise_PhaseII_Automation.postman_collection.json`
(set the token and id variables listed in its description).

The test kit uses a small stand-in JWT verifier with the same `req.auth`
contract as the shared middleware; the suites were also run against Member
1's real `authenticate` with a real signed JWT.

## Known limitations

* Until Member 1's shared `authenticate` is merged to `main`, the endpoints
  return `503 AUTH_UNAVAILABLE` (by design, fail closed).
* Leads are still in-memory on `main`; lead metrics read the `Lead` collection
  and show `0` until Member 2 persists leads.
* Delivery does not yet accept `idempotencyKey`; Automation sends it, and a
  dedicated key on `DeliveryJob` is needed to make a crash between "queued"
  and "recorded" fully safe. Until then such a case is marked `UNCERTAIN`.
* `CREATE_NOTIFICATION` records the execution only; there is no notification
  service yet.
* `publishEvent` must be called by the other modules; until they do, only
  simulated events exist.
* `server.js` gained a small `initializeAutomation()` call (worker and index
  creation); coordinate this with Member 1.
