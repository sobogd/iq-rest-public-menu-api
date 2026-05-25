import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Pool } from "pg";

// Public-menu-api never listens — it only fires NOTIFY events when a diner
// places an order. A small connection pool keeps NOTIFY queries fast without
// holding a long-lived dedicated connection.
@Injectable()
export class OrdersNotifierService implements OnModuleDestroy {
  private readonly logger = new Logger(OrdersNotifierService.name);
  private pool: Pool | null = null;
  private static readonly CHANNEL = "orders_events";

  constructor(private readonly config: ConfigService) {
    const url = this.config.get<string>("DATABASE_URL");
    if (!url) {
      this.logger.error("DATABASE_URL missing — order NOTIFY disabled");
      return;
    }
    this.pool = new Pool({ connectionString: url, max: 2 });
    this.pool.on("error", (err) => this.logger.error(`pg pool error: ${err.message}`));
  }

  async onModuleDestroy(): Promise<void> {
    if (this.pool) await this.pool.end().catch(() => {});
  }

  // Publishes `created` action with the full new order so subscribers do not
  // need a follow-up fetch for fresh data.
  async publishCreated(restaurantId: string, order: unknown): Promise<void> {
    if (!this.pool) return;
    const payload = JSON.stringify({ action: "created", restaurantId, order });
    const safe =
      payload.length > 7800
        ? JSON.stringify({ action: "created", restaurantId })
        : payload;
    try {
      await this.pool.query(`SELECT pg_notify($1, $2)`, [
        OrdersNotifierService.CHANNEL,
        safe,
      ]);
    } catch (e) {
      this.logger.warn(`pg_notify failed: ${(e as Error).message}`);
    }
  }

  // Same channel, distinct action — a new diner reservation. Paired
  // RESERVATION kiosks pick it up via dashboard-api's SSE listener.
  async publishBookingCreated(restaurantId: string, booking: unknown): Promise<void> {
    if (!this.pool) return;
    const payload = JSON.stringify({ action: "booking-created", restaurantId, booking });
    const safe =
      payload.length > 7800
        ? JSON.stringify({ action: "booking-created", restaurantId })
        : payload;
    try {
      await this.pool.query(`SELECT pg_notify($1, $2)`, [
        OrdersNotifierService.CHANNEL,
        safe,
      ]);
    } catch (e) {
      this.logger.warn(`booking pg_notify failed: ${(e as Error).message}`);
    }
  }
}
