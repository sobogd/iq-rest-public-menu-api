import { BadRequestException, Body, Controller, HttpCode, HttpStatus, Post, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { z } from "zod";
import crypto from "crypto";
import { PrismaService } from "../prisma/prisma.service";

const trackSchema = z.object({
  slug: z.string().min(1),
  page: z.string().min(1),
  language: z.string().min(2).max(5),
  referrer: z.string().nullable().optional(),
});

const SESSION_COOKIE = "sqr_session_id";

@Controller("analytics")
export class AnalyticsController {
  constructor(private readonly prisma: PrismaService) {}

  @Post("track")
  @HttpCode(HttpStatus.OK)
  async track(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() body: unknown) {
    const parsed = trackSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message || "invalid input");
    const { slug, page, language, referrer } = parsed.data;

    const cookies = (req.cookies as Record<string, string | undefined> | undefined) ?? {};
    let sessionId = cookies[SESSION_COOKIE];
    let isNew = false;
    if (!sessionId) {
      sessionId = crypto.randomUUID();
      isNew = true;
    }

    const restaurant = await this.prisma.restaurant.findFirst({
      where: { slug },
      select: { companyId: true },
    });
    if (!restaurant) return { success: false };

    const userAgent = (req.headers["user-agent"] as string) ?? null;
    const ip =
      ((req.headers["cf-connecting-ip"] as string) || "").trim() ||
      ((req.headers["x-forwarded-for"] as string) || "").split(",")[0]?.trim() ||
      null;

    await this.prisma.pageView.create({
      data: {
        companyId: restaurant.companyId,
        sessionId,
        page,
        language,
        referrer: referrer || null,
        userAgent,
        ip,
      },
    });

    if (isNew) {
      res.cookie(SESSION_COOKIE, sessionId, { path: "/", httpOnly: true, sameSite: "lax", secure: req.secure });
    }
    return { success: true };
  }
}
