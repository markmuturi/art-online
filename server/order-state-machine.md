# Order / Escrow State Machine

Governs a single `orders` row from checkout to artist payout. Paired with `schema.sql`.

## States

| State | Meaning |
|---|---|
| `pending_payment` | Order created, buyer hasn't paid yet |
| `paid_held` | Paystack charge succeeded, funds sit in your platform Paystack account, not yet transferred to the artist |
| `shipped` | Artist marked it shipped, added tracking |
| `delivered_confirmed` | Buyer confirmed receipt, or the fallback timer fired |
| `disputed` | Buyer flagged a problem before release |
| `released` | Paystack Transfer to the artist succeeded, escrow closed |
| `refunded` | Buyer got their money back |
| `cancelled` | Order died before any money moved |

## Transitions

| From | To | Trigger | Actor | Side effect |
|---|---|---|---|---|
| `pending_payment` | `paid_held` | Paystack webhook `charge.success`, reference matches `payments.paystack_reference` | system | write `payments` row, set `orders.state` |
| `pending_payment` | `cancelled` | buyer cancels, or payment link expires unpaid after 30 min | buyer / system | none, no money moved |
| `paid_held` | `shipped` | artist enters tracking number | artist | set `shipped_at`, notify buyer |
| `paid_held` | `refunded` | artist hasn't shipped within SLA (default 7 days) | system → admin review | Paystack refund, notify both parties |
| `shipped` | `delivered_confirmed` | buyer taps "confirm received," OR fallback timer fires 10 days after `shipped_at` with no dispute | buyer / system | set `delivered_confirmed_at`, compute `release_eligible_at = now() + 72h` |
| `shipped` | `disputed` | buyer opens a dispute before confirming | buyer | freeze auto-transitions, notify admin |
| `delivered_confirmed` | `disputed` | buyer disputes within the 72h window | buyer | pause the release job for this order |
| `delivered_confirmed` | `released` | release job starts a Paystack Transfer once `release_eligible_at <= now()` with no dispute. The order moves only when the `transfer.success` webhook arrives | system | job writes a `pending` `payouts` row, webhook sets it `success` and sets `released_at` |
| `disputed` | `refunded` | admin resolves in buyer's favor | admin | Paystack refund |
| `disputed` | `released` | admin resolves in artist's favor | admin | Paystack Transfer, same as above |

No other transitions are valid. Enforce this in application code with a lookup table, not scattered if-statements, so an invalid transition is a rejected function call, not a silent bad write.

## Design assumptions I made, tune as needed

- **7-day shipping SLA.** If an artist sits on a paid order past this, the system should flag it for you rather than silently waiting. Kenyan postal/courier timelines may push this longer for you.
- **10-day auto-confirm fallback.** This is a real weak point: without courier delivery-proof integration, this timer can't tell the difference between "buyer received it and forgot to confirm" and "artist shipped an empty box." [This is the honest limitation, not something a longer timer fixes.] Mitigate by requiring tracking numbers and, once you have volume, integrating a courier's delivery-confirmation webhook instead of relying purely on the timer.
- **72-hour post-confirmation dispute window** before the release job is allowed to fire. Gives a buyer who confirmed too fast a short grace period.

## Idempotency and webhooks (ties to earlier security point)

Paystack can and will send the same webhook more than once. Before processing any webhook:

1. Verify the signature header against your Paystack secret.
2. Check `webhook_events` for an existing row with that `(provider, event_id)`. If it exists, return 200 and do nothing.
3. Do the insert, the handling and the `processed_at` update inside ONE database transaction. A crash rolls all of it back, so Paystack's retry is processed from scratch, and a committed row always means fully handled. (The first version of this doc said to insert first and process afterwards. That order loses the event if the process dies in between, because the retry then looks like a duplicate.)

## Background jobs you need

- **Release job** — runs every 5 minutes, selects `orders` where `state = 'delivered_confirmed' AND release_eligible_at <= now()` and no `payouts` row exists. It claims the order by inserting a `pending` payout row (the UNIQUE `order_id` makes double-claims impossible), then calls Paystack Transfer with the deterministic reference `payout-<orderId>`. A failed or ambiguous transfer alerts an admin and is never auto-retried.
- **Expire-unpaid job** — runs every 5 minutes, cancels `pending_payment` orders older than 30 minutes, which frees the physical piece or the digital edition for the next buyer.
- **Auto-confirm job** — runs daily, selects `orders` where `state = 'shipped' AND shipped_at < now() - interval '10 days'`, transitions to `delivered_confirmed`.
- **SLA job** — runs daily, selects `orders` where `state = 'paid_held' AND created_at < now() - interval '7 days'`, flags for admin review (don't auto-refund without a human looking, an artist could just be slow, not fraudulent).

## Digital orders

Same states, different triggers. The webhook that moves an order to `paid_held` also creates the `download_grants` row and immediately moves a digital order to `delivered_confirmed`, with a 48 hour release window instead of 72. That window catches a wrong or corrupted upload. It does not protect against a card chargeback weeks later. The `download_events` trail is the defense for that.

## Inventory

`003_inventory_guards.sql` adds a unique index so a one-of-a-kind physical piece can have only one live order. Digital editions are reserved with a guarded `UPDATE ... WHERE editions_sold < edition_size` at checkout, and given back when an unpaid order is cancelled.

## Payout prerequisites (verify against your own Paystack account)

- Transfers draw from your Paystack Balance, not from buyer payments directly. Fund it, and monitor it, or payouts fail.
- API-initiated transfers need OTP confirmation disabled in the dashboard, otherwise the transfer sits in an `otp` status.
- Kenya M-PESA Paybill and Till transfers need an `account_reference`. Wallet and bank transfers do not.
