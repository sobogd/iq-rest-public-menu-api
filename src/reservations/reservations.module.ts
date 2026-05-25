import { Module } from "@nestjs/common";
import { OrdersModule } from "../orders/orders.module";
import { ReservationsController } from "./reservations.controller";

@Module({ imports: [OrdersModule], controllers: [ReservationsController] })
export class ReservationsModule {}
