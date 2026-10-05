import type { PoolClient } from "pg";

export type OrderState =
  | "pending_payment"
  | "paid_held"
  | "shipped"
  | "delivered_confirmed"
  | "disputed"
  | "released"
  | "refunded"
  | "cancelled";

export type ActorType = "buyer" | "artist" | "admin" | "system";
export type FulfillmentType = "physical" | "digital";

interface Rule {
  actors: ActorType[];
  only?: FulfillmentType;
}

// The single source of truth for what is legal. Anything not listed here is rejected.
const TRANSITIONS: Record<OrderState, Partial<Record<OrderState, Rule>>> = {
  pending_payment: {
    paid_held: { actors: ["system"] },
    cancelled: { actors: ["buyer", "system"] },
  },
  paid_held: {
    shipped: { actors: ["artist"], only: "physical" },
    delivered_confirmed: { actors: ["system"], only: "digital" },
    refunded: { actors: ["admin", "system"] },
  },
  shipped: {
    delivered_confirmed: { actors: ["buyer", "system"] },
    disputed: { actors: ["buyer"] },
  },
  delivered_confirmed: {
    released: { actors: ["system", "admin"] },
    disputed: { actors: ["buyer"] },
  },
  disputed: {
    refunded: { actors: ["admin"] },
    released: { actors: ["admin"] },
  },
  released: {},
  refunded: {},
  cancelled: {},
};

const RELEASE_WINDOW: Record<FulfillmentType, string> = {
  physical: "72 hours",
  digital: "48 hours",
};

export class InvalidTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTransitionError";
  }
}

export interface TransitionArgs {
  orderId: string;
  to: OrderState;
  actorType: ActorType;
  actorId?: string;
  note?: string;
  trackingNumber?: string;
}

// Call inside withTransaction. The row lock means two simultaneous requests
// (say a buyer dispute and the auto-confirm job) are processed one at a time.
export async function transitionOrder(
  client: PoolClient,
  args: TransitionArgs,
): Promise<{ from: OrderState; fulfillmentType: FulfillmentType }> {
  const { rows } = await client.query<{ state: OrderState; fulfillment_type: FulfillmentType }>(
    `SELECT o.state, a.fulfillment_type
       FROM orders o JOIN artworks a ON a.id = o.artwork_id
      WHERE o.id = $1
        FOR UPDATE OF o`,
    [args.orderId],
  );
  const row = rows[0];
  if (!row) throw new InvalidTransitionError(`Order ${args.orderId} not found`);

  const rule = TRANSITIONS[row.state][args.to];
  if (!rule) throw new InvalidTransitionError(`${row.state} -> ${args.to} is not allowed`);
  if (!rule.actors.includes(args.actorType)) {
    throw new InvalidTransitionError(`${args.actorType} cannot move ${row.state} -> ${args.to}`);
  }
  if (rule.only && rule.only !== row.fulfillment_type) {
    throw new InvalidTransitionError(`${row.state} -> ${args.to} is ${rule.only}-only`);
  }
  if (args.to === "shipped" && !args.trackingNumber) {
    throw new InvalidTransitionError("A tracking number is required to mark an order shipped");
  }

  // Everything interpolated below comes from constants in this file, never from user input.
  let extra = "";
  switch (args.to) {
    case "shipped":
      extra = ", shipped_at = now()";
      break;
    case "delivered_confirmed":
      extra = `, delivered_confirmed_at = now(), release_eligible_at = now() + interval '${RELEASE_WINDOW[row.fulfillment_type]}'`;
      break;
    case "released":
      extra = ", released_at = now()";
      break;
    case "refunded":
      extra = ", refunded_at = now()";
      break;
    case "cancelled":
      extra = ", cancelled_at = now()";
      break;
    default:
      break;
  }

  await client.query(`UPDATE orders SET state = $2${extra} WHERE id = $1`, [args.orderId, args.to]);

  if (args.to === "shipped") {
    await client.query(`UPDATE orders SET tracking_number = $2 WHERE id = $1`, [args.orderId, args.trackingNumber]);
  }

  // A cancelled digital order gives its edition back. Refunded digital orders keep it consumed, the file is out.
  if (args.to === "cancelled" && row.fulfillment_type === "digital") {
    await client.query(
      `UPDATE artworks SET editions_sold = editions_sold - 1
        WHERE id = (SELECT artwork_id FROM orders WHERE id = $1)`,
      [args.orderId],
    );
  }

  await client.query(
    `INSERT INTO order_events (order_id, from_state, to_state, actor_type, actor_id, note)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [args.orderId, row.state, args.to, args.actorType, args.actorId ?? null, args.note ?? null],
  );

  return { from: row.state, fulfillmentType: row.fulfillment_type };
}
