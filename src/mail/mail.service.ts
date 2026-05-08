import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Transporter } from "nodemailer";
import * as fs from "node:fs";
import * as path from "node:path";

interface ReservationT {
  guestSubject: string;
  guestGreeting: string;
  guestConfirmed: string;
  guestPending: string;
  details: string;
  date: string;
  time: string;
  guests: string;
  table: string;
  notes: string;
  guestOutro: string;
  signature: string;
  ownerSubject: string;
  ownerGreeting: string;
  ownerBody: string;
  ownerCta: string;
  ownerSignature: string;
}

interface ReservationParams {
  email: string;
  guestName: string;
  restaurantTitle: string;
  date: string;
  startTime: string;
  guestsCount: number;
  tableNumber: number;
  notes: string | null;
  status: string;
  locale: string;
}

interface OwnerParams extends Omit<ReservationParams, "email"> {
  ownerEmails: string[];
  guestEmail: string;
  guestPhone: string | null;
}

function detailRow(label: string, value: string): string {
  return `<tr><td style="padding:8px 12px;font-size:15px;color:#666;white-space:nowrap;">${label}</td><td style="padding:8px 12px;font-size:15px;font-weight:600;color:#1a1a1a;">${value}</td></tr>`;
}

@Injectable()
export class MailService implements OnModuleDestroy {
  private readonly logger = new Logger(MailService.name);
  private transporter: Transporter | null = null;
  private readonly localesDir = path.resolve(__dirname, "locales");
  private readonly cache = new Map<string, ReservationT>();

  constructor(private readonly config: ConfigService) {}

  onModuleDestroy(): void {
    if (this.transporter) this.transporter.close();
  }

  private cfg() {
    const host = this.config.get<string>("SMTP_HOST");
    const port = Number(this.config.get<string>("SMTP_PORT") || 587);
    const user = this.config.get<string>("SMTP_USER");
    const pass = this.config.get<string>("SMTP_PASS");
    const from = this.config.get<string>("FROM_EMAIL") || user;
    if (!host || !user || !pass || !from) return null;
    return { host, port, user, pass, from };
  }

  private async getTransporter() {
    if (this.transporter) return this.transporter;
    const c = this.cfg();
    if (!c) return null;
    const nm = (await import("nodemailer")).default;
    this.transporter = nm.createTransport({
      host: c.host,
      port: c.port,
      secure: c.port === 465,
      auth: { user: c.user, pass: c.pass },
      pool: true,
      maxConnections: 5,
    });
    return this.transporter;
  }

  private loadT(locale: string): ReservationT {
    if (this.cache.has(locale)) return this.cache.get(locale)!;
    let p = path.join(this.localesDir, `${locale}.json`);
    if (!fs.existsSync(p)) p = path.join(this.localesDir, "en.json");
    const t = JSON.parse(fs.readFileSync(p, "utf8")) as ReservationT;
    this.cache.set(locale, t);
    return t;
  }

  private dashboardUrl(p: string) {
    const base = (this.config.get<string>("DASHBOARD_URL") || "https://dashboard.iq-rest.com").replace(/\/$/, "");
    return base + p;
  }

  async sendGuestEmail(params: ReservationParams): Promise<void> {
    const transporter = await this.getTransporter();
    if (!transporter) {
      this.logger.warn("SMTP not configured — guest reservation email skipped");
      return;
    }
    const c = this.cfg()!;
    const t = this.loadT(params.locale);
    const subject = t.guestSubject.replace("{restaurant}", params.restaurantTitle);
    const greeting = t.guestGreeting.replace("{name}", params.guestName);
    const statusText = params.status === "confirmed" ? t.guestConfirmed : t.guestPending;
    const sig = t.signature.replace("{restaurant}", params.restaurantTitle);

    let rows = "";
    rows += detailRow(t.date, params.date);
    rows += detailRow(t.time, params.startTime);
    rows += detailRow(t.guests, String(params.guestsCount));
    rows += detailRow(t.table, String(params.tableNumber));
    if (params.notes) rows += detailRow(t.notes, params.notes);

    await transporter.sendMail({
      from: c.from,
      to: params.email,
      subject,
      html: `
        <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:520px;margin:0 auto;padding:32px 20px;color:#1a1a1a">
          <p style="font-size:20px;font-weight:600;line-height:1.5;margin:0 0 20px">${greeting}</p>
          <p style="font-size:17px;line-height:1.7;margin:0 0 20px">${statusText}</p>
          <p style="font-size:15px;font-weight:600;margin:0 0 8px">${t.details}</p>
          <table style="border-collapse:collapse;margin:0 0 24px;background:#f5f5f5;border-radius:12px;overflow:hidden;width:100%">${rows}</table>
          <p style="font-size:15px;line-height:1.7;margin:0 0 24px;color:#666">${t.guestOutro}</p>
          <p style="font-size:15px;margin:0;color:#1a1a1a">${sig}</p>
        </div>
      `,
      text: `${greeting}\n\n${statusText}\n\n${t.details}\n${t.date}: ${params.date}\n${t.time}: ${params.startTime}\n${t.guests}: ${params.guestsCount}\n${t.table}: ${params.tableNumber}${params.notes ? `\n${t.notes}: ${params.notes}` : ""}\n\n${t.guestOutro}\n\n${sig.replace("<br>", "\n")}`,
    });
  }

  async sendOwnerEmail(params: OwnerParams): Promise<void> {
    const transporter = await this.getTransporter();
    if (!transporter) return;
    const c = this.cfg()!;
    const t = this.loadT(params.locale);

    const subject = t.ownerSubject.replace("{name}", params.guestName);

    let rows = "";
    rows += detailRow(t.date, params.date);
    rows += detailRow(t.time, params.startTime);
    rows += detailRow(t.guests, String(params.guestsCount));
    rows += detailRow(t.table, String(params.tableNumber));
    rows += detailRow("Email", params.guestEmail);
    if (params.guestPhone) rows += detailRow("Phone", params.guestPhone);
    if (params.notes) rows += detailRow(t.notes, params.notes);

    const [primary, ...rest] = params.ownerEmails;
    await transporter.sendMail({
      from: c.from,
      to: primary,
      bcc: rest.length > 0 ? rest : undefined,
      subject,
      html: `
        <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:520px;margin:0 auto;padding:32px 20px;color:#1a1a1a">
          <p style="font-size:20px;font-weight:600;line-height:1.5;margin:0 0 20px">${t.ownerGreeting}</p>
          <p style="font-size:17px;line-height:1.7;margin:0 0 20px">${t.ownerBody}</p>
          <table style="border-collapse:collapse;margin:0 0 24px;background:#f5f5f5;border-radius:12px;overflow:hidden;width:100%">${rows}</table>
          <p style="font-size:17px;line-height:1.7;margin:0 0 24px"><a href="${this.dashboardUrl("/dashboard/reservations?from=email")}" style="color:#0066cc">${t.ownerCta}</a></p>
          <p style="font-size:15px;margin:0;color:#1a1a1a">${t.ownerSignature}</p>
        </div>
      `,
      text: `${t.ownerGreeting}\n\n${t.ownerBody}\n\n${t.date}: ${params.date}\n${t.time}: ${params.startTime}\n${t.guests}: ${params.guestsCount}\n${t.table}: ${params.tableNumber}\nEmail: ${params.guestEmail}${params.notes ? `\n${t.notes}: ${params.notes}` : ""}\n\n${t.ownerCta}: ${this.dashboardUrl("/dashboard/reservations?from=email")}\n\n${t.ownerSignature.replace("<br>", "\n")}`,
    });
  }
}
