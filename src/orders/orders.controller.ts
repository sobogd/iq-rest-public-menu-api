import { BadRequestException, Body, Controller, HttpCode, HttpStatus, NotFoundException, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";
import { PrismaService } from "../prisma/prisma.service";

const orderSchema = z.object({
  slug: z.string().min(1),
  // Items are stored as JSON; the dashboard expects per-unit rows with
  // dish snapshot + per-item kitchen status. We accept any shape and let
  // the client (public-menu OrderForm) build the canonical payload.
  items: z.array(z.record(z.string(), z.unknown())).max(500).optional(),
  total: z.number().min(0).max(999999.99).nullable().optional(),
  customerName: z.string().max(200).nullable().optional(),
  customerPhone: z.string().max(50).nullable().optional(),
  customerAddress: z.string().max(500).nullable().optional(),
  comment: z.string().max(1000).nullable().optional(),
  tableNumber: z.number().int().nullable().optional(),
  isPreview: z.boolean().optional(),
});

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60 * 60 * 1000;

function isRateLimited(ip: string, slug: string): boolean {
  const key = `${ip}:${slug}`;
  const now = Date.now();
  const entry = rateLimitMap.get(key);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  entry.count++;
  return entry.count > RATE_LIMIT;
}

@Controller("public/orders")
export class OrdersController {
  constructor(private readonly prisma: PrismaService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async create(@Req() req: Request, @Body() body: unknown) {
    const parsed = orderSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message || "invalid input");
    const { slug, items, total, customerName, customerPhone, customerAddress, comment, tableNumber, isPreview } = parsed.data;

    const ip =
      ((req.headers["cf-connecting-ip"] as string) || "").trim() ||
      ((req.headers["x-forwarded-for"] as string) || "").split(",")[0]?.trim() ||
      req.socket.remoteAddress ||
      "unknown";

    if (!isPreview && isRateLimited(ip, slug)) {
      throw new BadRequestException("Too many orders. Please try again later.");
    }

    const restaurant = await this.prisma.restaurant.findFirst({
      where: { slug },
      select: {
        id: true,
        companyId: true,
        ordersEnabled: true,
        orderMode: true,
        currency: true,
      },
    });
    if (!restaurant || !restaurant.ordersEnabled) throw new NotFoundException("not_found");

    const mode = restaurant.orderMode;
    if ((mode === "internal" || mode === "both") && items && items.length > 0) {
      await this.prisma.order.create({
        data: {
          restaurantId: restaurant.id,
          companyId: restaurant.companyId,
          items: items as object[],
          total: total ?? 0,
          currency: restaurant.currency,
          customerName: customerName ? String(customerName).slice(0, 200) : null,
          customerPhone: customerPhone ? String(customerPhone).slice(0, 50) : null,
          customerAddress: customerAddress ? String(customerAddress).slice(0, 500) : null,
          comment: comment ? String(comment).slice(0, 1000) : null,
          tableNumber: tableNumber ?? null,
          status: "new",
        },
      });
    }

    return { ok: true, mode };
  }
}
