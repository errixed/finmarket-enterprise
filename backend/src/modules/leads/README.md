# Lead Management (CRM)

Lead Management stores each advisor's prospective clients in MongoDB. The module owns lead validation, lifecycle changes, marketing consent, advisor scoping, search, and pagination. Campaign, delivery, and automation behavior remains in the corresponding modules.

## Run and verify

Start the shared MongoDB and backend from the repository root with `docker compose up --build`. For the lead HTTP tests, set `MONGO_URI` to a disposable MongoDB database whose name contains `_test`, configure the JWT environment variables, then run `npm run test:leads` from `backend/`. The test helper creates a unique database for the suite and drops it at the end.

## API

All endpoints require a valid Bearer JWT. The caller must have the `ADVISOR` role and an associated AdvisorProfile. Administrators have no implicit CRM bypass; marketing specialists cannot access private leads through these routes.

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/v1/leads` | Create a lead for the authenticated advisor |
| GET | `/api/v1/leads` | Search and list only the authenticated advisor's leads |
| GET | `/api/v1/leads/:id` | Retrieve an owned lead |
| PATCH | `/api/v1/leads/:id` | Update an owned lead |

Creation requires `name`, `email`, and `interest`. Optional fields are `phone`, `status`, `marketingConsent`, `source`, and `notes`. Unknown fields, client-supplied consent timestamps, and empty update objects are rejected. `advisorId` may be sent for compatibility only when it matches the authenticated advisor profile; ownership is always derived from the JWT context.

## Schema and identifiers

The `leads` collection uses the `Lead` Mongoose model. It stores contact details, interest, lifecycle status, source, marketing consent, consent and unsubscribe timestamps, plus timestamps managed by Mongoose. **`advisorId` references `AdvisorProfile._id`, not `User._id`.** The reference is checked against the Identity module before creation.

Email addresses are trimmed and lowercased before storage. A unique compound index on `{ advisorId, email }` prevents duplicate email addresses for the same advisor while allowing different advisors to manage the same contact independently. Advisor/status, advisor/source, and advisor/interest indexes support common queries.

## Lifecycle

Statuses are `NEW`, `CONTACTED`, `CONSULTATION_REQUESTED`, and `CONVERTED`. Allowed changes are `NEW → CONTACTED → CONSULTATION_REQUESTED → CONVERTED`. Keeping the current status is allowed; skipping a stage or moving backward is rejected.

## Consent

Consent defaults to `false`. Explicit consent records `consentRecordedAt`; withdrawal sets `unsubscribedAt`. Re-consent records a fresh consent time and clears the unsubscribe time. Unrelated lead edits do not change consent. Campaign audience lookup only returns leads with consent and no unsubscribe timestamp. Delivery checks consent again before processing.

## Query parameters

`GET /api/v1/leads` supports `status`, `marketingConsent=true|false`, `source`, `interest`, `search`, `page`, and `limit`. `advisorId` is accepted only when it matches the caller's profile. Filters run in MongoDB, sort by newest first, and paginate there. Defaults are page `1` and limit `20`; the maximum limit is `100`.

The response contains `data` and `pagination` with `page`, `limit`, `total`, and `totalPages`.

## Internal contracts

The service exports `findLeadForDelivery(leadId, advisorId)` for an ownership-scoped lookup and `findMarketingEligibleLeads(advisorId, filters)` for consent-eligible campaign targeting. These functions return no lead outside the requested advisor scope. Campaign audience selection and delivery processing remain owned by their respective modules.

Lead API tests cover MongoDB persistence, consent, lifecycle, duplicate handling, input validation, pagination, missing authentication, role restrictions, and cross-advisor access. Integration tests exercise campaign and delivery use of the Lead contracts.
