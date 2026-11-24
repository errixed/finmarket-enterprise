$readme = @'
# Delivery Module (Member 4 — Phase II)

Manages persistent `DeliveryJob` scheduling, authorization, marketing-consent enforcement, atomic processing, provider dispatch, and delivery history for Email and Facebook channels.

## Architecture

- **Model (`models/DeliveryJob.js`)**: Persists jobs in the `deliveryJobs` collection with references to `AdvisorProfile`, `Campaign`, `Lead`, and `User`, lifecycle status tracking (`PENDING`, `PROCESSING`, `SENT`, `FAILED`, `CANCELLED`), provider metadata, attempt counts, and indexes (including a partial unique `idempotencyKey` index).
- **Repository (`repositories/deliveryRepository.js`)**: MongoDB CRUD, filtered/paginated listing, atomic `findOneAndUpdate` job claiming (`PENDING` → `PROCESSING`), strict status-transition enforcement, and explicit failure retries.
- **Contracts (`contracts/deliveryContracts.js`)**: Mockable boundary for Identity, Leads, Campaigns, and Automation event listeners (`DELIVERY_QUEUED`, `DELIVERY_SENT`, `DELIVERY_FAILED`) without modifying external modules.
- **Eligibility (`services/deliveryEligibility.js`)**: Enforces payload allowlisting (anti-mass-assignment), Campaign `ACTIVE` & channel matching, Advisor/Marketing Specialist authorization, and recipient marketing-consent checks.
- **Providers (`providers/`)**:
  - `mockProvider.js` (`MOCK_EMAIL`, `MOCK_FACEBOOK`) — default safe simulation mode.
  - `gmailProvider.js` (`GMAIL_SMTP`) — Nodemailer Gmail SMTP with credential redaction.
  - `facebookProvider.js` (`META_FACEBOOK`) — Meta Graph API Page publishing with token redaction.
  - `providerRegistry.js` — backend env-controlled provider routing.
  - `deliveryRateLimiter.js` — sliding-window rate limit and max-concurrency cap.
- **Service & Worker (`services/deliveryService.js`, `services/deliveryWorker.js`)**: Queueing, revalidation before dispatch, manual processing, explicit retries (capped at 3 attempts), Automation-safe queueing (`queueDeliveryForAutomation`), and a singleton due-job worker (`processDueDeliveries`).
- **Auth Adapter (`middleware/deliveryAuth.js`)**: Automatically delegates to shared `src/middleware/authMiddleware.js` and `roleMiddleware.js` once Member 1's branch is merged, with an HS256 JWT + MongoDB fallback matching `req.auth` for independent testing.

## API Endpoints (`/api/v1/deliveries`)

All endpoints require a valid `Authorization: Bearer <JWT>` header.

| Method | Path | Allowed Roles | Description |
| --- | --- | --- | --- |
| `POST` | `/` | `ADVISOR`, `MARKETING_SPECIALIST` | Queue a new Email or Facebook delivery job |
| `GET` | `/` | `ADVISOR`, `MARKETING_SPECIALIST`, `ADMIN` | Scoped, filtered, paginated delivery history |
| `GET` | `/:id` | `ADVISOR`, `MARKETING_SPECIALIST`, `ADMIN` | Fetch a single authorized delivery job |
| `POST` | `/:id/process` | `ADVISOR`, `MARKETING_SPECIALIST` | Process a due `PENDING` job atomically |
| `POST` | `/:id/retry` | `ADVISOR`, `MARKETING_SPECIALIST` | Reset a `FAILED` job back to `PENDING` (up to 3 attempts) |

**Supported History Query Parameters:** `campaignId`, `leadId`, `channel`, `deliveryStatus`, `provider`, `advisorId` (`ADMIN` or matching `ADVISOR` only), `createdFrom`, `createdTo`, `scheduledFrom`, `scheduledTo`, `page`, `limit` (max 100).

## Security & Consent Rules

- **Advisor ownership**: `advisorId` is always derived from the verified `Campaign`; spoofed client `advisorId` values are rejected (`403`).
- **Marketing Specialists**: Require both an `ACCEPTED` `AdvisorSpecialistAssignment` and assignment to the target Campaign. Revoking the relationship immediately blocks access.
- **Email consent revalidation**: Checked at **both** queue creation and processing time—Lead must exist, belong to the Campaign's Advisor, have `marketingConsent: true`, have `unsubscribedAt: null`, match `recipientEmail`, and belong to the Campaign audience.
- **Concurrency & scheduling**: Future `scheduledAt` jobs return `409 DELIVERY_NOT_DUE`; concurrent process calls use atomic MongoDB claims so only one send executes.

## Environment Variables

Defaults to mock providers if omitted:

- `DELIVERY_EMAIL_PROVIDER`: `mock` (default) | `gmail`
- `DELIVERY_FACEBOOK_PROVIDER`: `mock` (default) | `meta`
- `GMAIL_USER`, `GMAIL_APP_PASSWORD`: Required only when `DELIVERY_EMAIL_PROVIDER=gmail`
- `META_PAGE_ID`, `META_ACCESS_TOKEN`, `META_GRAPH_API_VERSION`: Required only when `DELIVERY_FACEBOOK_PROVIDER=meta`
- `DELIVERY_RATE_LIMIT_MAX` (default `10`), `DELIVERY_RATE_LIMIT_WINDOW_MS` (default `60000`), `DELIVERY_MAX_CONCURRENT_SENDS` (default `3`)
- `DELIVERY_WORKER_INTERVAL_MS` (default `30000`)

## Testing

```bash
# Shared Mongoose model validation
cd backend
npm run validate:models

# Delivery Phase II MongoDB & HTTP test suite (uses isolated test DB)
node --test tests/delivery/delivery.test.js

# Seed local dev fixtures for Postman / Newman
node tests/delivery/seedDeliveryFixtures.js
```

Import `postman/FinMarket-Enterprise_PhaseII_M4_Delivery.postman_collection.json` into Postman or run it via Newman against `http://localhost:8080/api/v1`.
'@

[System.IO.File]::WriteAllText((Join-Path (Get-Location) "backend\src\modules\delivery\README.md"), $readme)
Write-Host "Created backend/src/modules/delivery/README.md"