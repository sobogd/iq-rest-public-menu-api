import { Module } from "@nestjs/common";
import { OrdersController } from "./orders.controller";
import { OrdersNotifierService } from "./orders-notifier.service";

@Module({
  controllers: [OrdersController],
  providers: [OrdersNotifierService],
})
export class OrdersModule {}
