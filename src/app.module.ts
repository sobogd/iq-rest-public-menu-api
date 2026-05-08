import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { ThrottlerModule, ThrottlerGuard } from "@nestjs/throttler";
import { APP_GUARD } from "@nestjs/core";
import { PrismaModule } from "./prisma/prisma.module";
import { MailModule } from "./mail/mail.module";
import { MenuModule } from "./menu/menu.module";
import { OrdersModule } from "./orders/orders.module";
import { ReservationsModule } from "./reservations/reservations.module";
import { AnalyticsModule } from "./analytics/analytics.module";
import { HealthController } from "./health/health.controller";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRoot([{ name: "default", ttl: 60_000, limit: 600 }]),
    PrismaModule,
    MailModule,
    MenuModule,
    OrdersModule,
    ReservationsModule,
    AnalyticsModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
