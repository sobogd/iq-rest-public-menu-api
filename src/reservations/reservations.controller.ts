import { BadRequestException, Body, Controller, Get, HttpCode, HttpStatus, Logger, NotFoundException, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { PrismaService } from "../prisma/prisma.service";
import { MailService } from "../mail/mail.service";
import { OrdersNotifierService } from "../orders/orders-notifier.service";

const reservationSchema = z.object({
  restaurantId: z.string().min(1),
  tableId: z.string().optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  startTime: z.string().regex(/^\d{2}:\d{2}$/),
  guestName: z.string().trim().min(1).max(100),
  guestEmail: z.string().trim().email().max(200),
  guestPhone: z.string().trim().max(40).nullable().optional(),
  guestsCount: z.number().int().min(1).max(50),
  notes: z.string().max(500).nullable().optional(),
  locale: z.string().min(2).max(5).optional(),
});

interface ScheduleDay {
  closed: boolean;
  from: string;
  to: string;
  lunchFrom: string | null;
  lunchTo: string | null;
}

function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function isTableBooked(
  tableId: string,
  startTime: string,
  slotDuration: number,
  rs: { tableId: string; startTime: string; duration: number }[],
): boolean {
  const reqStart = timeToMinutes(startTime);
  const reqEnd = reqStart + slotDuration;
  for (const r of rs) {
    if (r.tableId !== tableId) continue;
    const bookedStart = timeToMinutes(r.startTime);
    const bookedEnd = bookedStart + r.duration;
    if (reqStart < bookedEnd && reqEnd > bookedStart) return true;
  }
  return false;
}

/** Return the restaurant's current local date/time as a plain object,
 *  independent of the Node process's TZ. Used so "is slot in the past"
 *  checks compare against the restaurant's clock, not the server's UTC. */
function nowInTz(tz: string): { todayStr: string; currentMinutes: number } {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date());
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    const year = get("year");
    const month = get("month");
    const day = get("day");
    let hour = get("hour");
    if (hour === "24") hour = "00";
    const minute = get("minute");
    return {
      todayStr: `${year}-${month}-${day}`,
      currentMinutes: Number(hour) * 60 + Number(minute),
    };
  } catch {
    const now = new Date();
    return {
      todayStr: `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")}`,
      currentMinutes: now.getUTCHours() * 60 + now.getUTCMinutes(),
    };
  }
}

function getScheduleDay(
  raw: unknown,
  date: Date,
  fallbackFrom: string,
  fallbackTo: string,
): { openWindows: { start: number; end: number }[] } | null {
  const weekday = (date.getUTCDay() + 6) % 7;
  let day: ScheduleDay;
  if (Array.isArray(raw) && raw.length === 7 && raw[weekday] && typeof raw[weekday] === "object") {
    day = raw[weekday] as ScheduleDay;
  } else {
    day = { closed: false, from: fallbackFrom, to: fallbackTo, lunchFrom: null, lunchTo: null };
  }
  if (day.closed) return null;
  const start = timeToMinutes(day.from);
  const end = timeToMinutes(day.to);
  if (!(start < end)) return null;
  if (day.lunchFrom && day.lunchTo) {
    const lStart = timeToMinutes(day.lunchFrom);
    const lEnd = timeToMinutes(day.lunchTo);
    if (lStart > start && lEnd < end && lStart < lEnd) {
      return { openWindows: [{ start, end: lStart }, { start: lEnd, end }] };
    }
  }
  return { openWindows: [{ start, end }] };
}

@Controller("public/reservations")
export class ReservationsController {
  private readonly logger = new Logger(ReservationsController.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly notifier: OrdersNotifierService,
  ) {}

  @Get("availability")
  async availability(
    @Query("slug") slug: string,
    @Query("date") dateStr: string,
    @Query("time") time?: string,
    @Query("guests") guestsRaw?: string,
  ) {
    if (!slug || !dateStr) throw new BadRequestException("slug + date required");
    const guestsCount = parseInt(guestsRaw || "2", 10);

    const restaurant = await this.prisma.restaurant.findFirst({
      where: { slug },
      select: {
        id: true,
        reservationsEnabled: true,
        reservationSlotMinutes: true,
        workingHoursStart: true,
        workingHoursEnd: true,
        reservationSchedule: true,
        timezone: true,
      },
    });
    if (!restaurant) throw new NotFoundException("not_found");
    if (!restaurant.reservationsEnabled) throw new BadRequestException("reservations_disabled");

    const tables = await this.prisma.table.findMany({
      where: { restaurantId: restaurant.id, isActive: true, deletedAt: null },
      select: { id: true, number: true, capacity: true, zone: true, translations: true, imageUrl: true },
      orderBy: { sortOrder: "asc" },
    });
    const suitable = tables.filter((t) => t.capacity >= guestsCount);
    if (suitable.length === 0) {
      return { timeSlots: [], tables: [], message: "No tables available for the requested number of guests" };
    }

    const reservationDate = new Date(dateStr);
    const existing = await this.prisma.reservation.findMany({
      where: { restaurantId: restaurant.id, date: reservationDate, status: { in: ["pending", "confirmed"] } },
      select: { tableId: true, startTime: true, duration: true },
    });
    const slotDuration = restaurant.reservationSlotMinutes;
    const day = getScheduleDay(
      restaurant.reservationSchedule,
      reservationDate,
      restaurant.workingHoursStart,
      restaurant.workingHoursEnd,
    );

    const timeSlots: { time: string; available: boolean; availableTables: number }[] = [];
    if (day) {
      // Compare "is slot in the past" against the restaurant's local clock,
      // not the server's UTC. Italian restaurant at 19:55 (UTC+2 summer) ≠
      // 17:55 UTC — without tz-aware now, 18:00 would still look "future".
      const { todayStr, currentMinutes } = nowInTz(restaurant.timezone || "UTC");
      const isToday = dateStr === todayStr;
      for (const window of day.openWindows) {
        for (let m = window.start; m + slotDuration <= window.end; m += 30) {
          if (isToday && m <= currentMinutes) continue;
          const timeStr = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
          const free = suitable.filter((t) => !isTableBooked(t.id, timeStr, slotDuration, existing)).length;
          timeSlots.push({ time: timeStr, available: free > 0, availableTables: free });
        }
      }
    }

    let tablesAvailability: Array<{
      id: string;
      number: number;
      capacity: number;
      zone: string | null;
      translations: Record<string, { zone?: string }> | null;
      imageUrl: string | null;
      available: boolean;
    }> = [];
    if (time) {
      tablesAvailability = suitable.map((t) => ({
        ...t,
        translations: t.translations as Record<string, { zone?: string }> | null,
        available: !isTableBooked(t.id, time, slotDuration, existing),
      }));
    }
    return { timeSlots, tables: tablesAvailability, slotDuration };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() body: unknown) {
    const parsed = reservationSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message || "invalid input");
    const { restaurantId, tableId, date, startTime, guestName, guestEmail, guestPhone, guestsCount, notes, locale } = parsed.data;

    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: {
        id: true,
        title: true,
        defaultLanguage: true,
        reservationsEnabled: true,
        reservationSlotMinutes: true,
        reservationMode: true,
        company: {
          select: {
            users: { select: { user: { select: { email: true } } } },
          },
        },
      },
    });
    if (!restaurant) throw new NotFoundException("not_found");
    if (!restaurant.reservationsEnabled) throw new BadRequestException("reservations_disabled");

    const reservationDate = new Date(date);
    const slotDuration = restaurant.reservationSlotMinutes;
    const status = restaurant.reservationMode === "auto" ? "confirmed" : "pending";

    const tables = await this.prisma.table.findMany({
      where: { restaurantId, isActive: true, deletedAt: null, capacity: { gte: guestsCount } },
      select: { id: true, number: true, capacity: true },
    });

    const existing = await this.prisma.reservation.findMany({
      where: { restaurantId, date: reservationDate, status: { in: ["pending", "confirmed"] } },
      select: { tableId: true, startTime: true, duration: true },
    });

    let chosenTableId = tableId;
    if (chosenTableId) {
      const tbl = tables.find((t) => t.id === chosenTableId);
      if (!tbl) throw new BadRequestException("table_not_suitable");
      if (isTableBooked(chosenTableId, startTime, slotDuration, existing)) {
        throw new BadRequestException("table_taken");
      }
    } else {
      const free = tables.find((t) => !isTableBooked(t.id, startTime, slotDuration, existing));
      if (!free) throw new BadRequestException("no_tables_at_time");
      chosenTableId = free.id;
    }

    const reservation = await this.prisma.reservation.create({
      data: {
        restaurantId,
        tableId: chosenTableId,
        date: reservationDate,
        startTime,
        duration: slotDuration,
        guestName,
        guestEmail,
        guestPhone: guestPhone || null,
        guestsCount,
        notes: notes || null,
        status,
      },
    });

    {
      const tableNumber = tables.find((t) => t.id === chosenTableId)?.number ?? 0;
      const ownerEmails = restaurant.company.users
        .map((u) => u.user.email)
        .filter((e): e is string => !!e);
      const lang = locale || restaurant.defaultLanguage || "en";
      const baseParams = {
        restaurantTitle: restaurant.title,
        date,
        startTime,
        guestsCount,
        tableNumber,
        notes: notes || null,
        status,
        locale: lang,
      };
      this.mail
        .sendGuestEmail({ ...baseParams, email: guestEmail, guestName })
        .catch((err) => this.logger.warn(`guest email failed: ${err?.message || err}`));
      if (ownerEmails.length > 0) {
        this.mail
          .sendOwnerEmail({
            ...baseParams,
            guestName,
            ownerEmails,
            guestEmail,
            guestPhone: guestPhone || null,
          })
          .catch((err) => this.logger.warn(`owner email failed: ${err?.message || err}`));
      }
    }

    // Fire-and-forget SSE notify so a paired RESERVATION kiosk shows the
    // new booking live. Never blocks or fails the diner's request.
    void this.notifier.publishBookingCreated(restaurantId, reservation);

    return reservation;
  }
}
