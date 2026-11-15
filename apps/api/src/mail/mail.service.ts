import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { Resend } from "resend";
import * as nodemailer from "nodemailer";
import { SettingsService } from "../settings/settings.service";
import { smtpTransportOptions, resolveSmtpSecurity } from "./smtp-security";
import type { SmtpConfig } from "./smtp-security";
import { SMTP_SECURITY } from "@atrium/shared";

const MAX_CONCURRENT_SENDS = 2;

/** Runs at most `max` tasks at once; a finished task hands its slot straight to the next waiter. */
function createLimiter(max: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active < max) active++;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

@Injectable()
export class MailService {
  private static sendTimeoutMs = 30_000;
  private readonly limitSend = createLimiter(MAX_CONCURRENT_SENDS);
  private resend: Resend | null;
  private from: string;
  private static readonly SMTP_CACHE_TTL_MS = 5 * 60 * 1000;
  private smtpTransporters = new Map<string, { transporter: nodemailer.Transporter; createdAt: number }>();

  constructor(
    private config: ConfigService,
    private settingsService: SettingsService,
    @InjectPinoLogger(MailService.name) private readonly logger: PinoLogger,
  ) {
    // Initialize default Resend client from env vars (fallback)
    const apiKey = this.config.get("RESEND_API_KEY");
    this.resend = apiKey ? new Resend(apiKey) : null;
    this.from = this.config.get("EMAIL_FROM", "noreply@atrium.local");
  }

  private getSmtpTransporter(smtp: SmtpConfig, organizationId?: string): nodemailer.Transporter {
    const key = `${organizationId ?? "default"}:${smtp.host}:${smtp.port}:${smtp.user}:${smtp.security}`;
    const cached = this.smtpTransporters.get(key);
    if (cached && Date.now() - cached.createdAt < MailService.SMTP_CACHE_TTL_MS) {
      return cached.transporter;
    }
    if (cached) {
      this.smtpTransporters.delete(key);
    }
    const transporter = nodemailer.createTransport(smtpTransportOptions(smtp));
    this.smtpTransporters.set(key, { transporter, createdAt: Date.now() });
    return transporter;
  }

  /** Sends are capped at MAX_CONCURRENT_SENDS at a time so a burst stays under provider rate limits. */
  send(
    to: string,
    subject: string,
    html: string,
    organizationId?: string,
  ): Promise<{ sent: boolean; viaOrgConfig: boolean }> {
    return this.limitSend(() => this.deliverWithTimeout(to, subject, html, organizationId));
  }

  /**
   * A hung provider call must not hold a send slot forever: give up on it and free the slot.
   * The abandoned send may still complete, so a timeout means "unknown"; callers must not retry on it.
   */
  private async deliverWithTimeout(
    to: string,
    subject: string,
    html: string,
    organizationId?: string,
  ): Promise<{ sent: boolean; viaOrgConfig: boolean }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<{ sent: boolean; viaOrgConfig: boolean }>((resolve) => {
      timer = setTimeout(() => {
        this.logger.error({ to, subject }, `Email send timed out after ${MailService.sendTimeoutMs} ms; giving up`);
        resolve({ sent: false, viaOrgConfig: false });
      }, MailService.sendTimeoutMs);
    });
    try {
      return await Promise.race([this.deliver(to, subject, html, organizationId), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async deliver(
    to: string,
    subject: string,
    html: string,
    organizationId?: string,
  ): Promise<{ sent: boolean; viaOrgConfig: boolean }> {
    if (organizationId) {
      try {
        const emailConfig = await this.settingsService.getEffectiveEmailConfig(organizationId);

        if (
          emailConfig.isOrgConfigured &&
          emailConfig.provider === "resend" &&
          emailConfig.apiKey
        ) {
          const resend = new Resend(emailConfig.apiKey);
          const { error } = await resend.emails.send({
            from: emailConfig.from,
            to,
            subject,
            html,
          });
          if (error) {
            this.logResendError(error, to, subject, "DB-configured Resend failed, falling back to env vars");
          } else {
            this.logger.info({ to, subject }, "Email sent via DB-configured Resend");
            return { sent: true, viaOrgConfig: true };
          }
        }

        if (
          emailConfig.isOrgConfigured &&
          emailConfig.provider === "smtp" &&
          emailConfig.smtp
        ) {
          const transporter = this.getSmtpTransporter(emailConfig.smtp, organizationId);
          await transporter.sendMail({
            from: emailConfig.from,
            to,
            subject,
            html,
          });
          this.logger.info({ to, subject }, "Email sent via DB-configured SMTP");
          return { sent: true, viaOrgConfig: true };
        }
      } catch (err) {
        this.logger.warn(
          { error: err instanceof Error ? err.message : String(err) },
          "Failed to send via DB email config, falling back to env vars",
        );
      }
    }

    const smtpHost = this.config.get("SMTP_HOST");
    if (smtpHost) {
      try {
        const smtpPort = parseInt(this.config.get("SMTP_PORT", "587"), 10);
        const smtpUser = this.config.get("SMTP_USER");
        const smtpPass = this.config.get("SMTP_PASS");
        const smtpSecurity = this.config.get("SMTP_SECURE") === "true"
          ? SMTP_SECURITY.TLS
          : this.config.get("SMTP_SECURE") === "false"
          ? SMTP_SECURITY.NONE
          : resolveSmtpSecurity(null, null, smtpPort);
        const transporter = nodemailer.createTransport(
          smtpTransportOptions({
            host: smtpHost,
            port: smtpPort,
            user: smtpUser,
            pass: smtpPass,
            security: smtpSecurity,
          }),
        );
        await transporter.sendMail({
          from: this.from,
          to,
          subject,
          html,
        });
        this.logger.info({ to, subject }, "Email sent via env-var SMTP");
        return { sent: true, viaOrgConfig: false };
      } catch (smtpErr) {
        this.logger.error(
          { error: smtpErr instanceof Error ? smtpErr.message : String(smtpErr), to, subject },
          "Email not sent: env-var SMTP failed",
        );
        return { sent: false, viaOrgConfig: false };
      }
    }

    if (!this.resend) {
      this.logger.info({ to, subject }, "Email not sent (no email provider configured)");
      return { sent: false, viaOrgConfig: false };
    }

    const { error } = await this.resend.emails.send({
      from: this.from,
      to,
      subject,
      html,
    });
    if (error) {
      this.logResendError(error, to, subject, "Email not sent: env-var Resend failed");
      return { sent: false, viaOrgConfig: false };
    }
    this.logger.info({ to, subject }, "Email sent via env-var Resend");
    return { sent: true, viaOrgConfig: false };
  }

  /** Resend v4 reports failures in the return value instead of throwing. */
  private logResendError(error: { name: string; message: string }, to: string, subject: string, msg: string): void {
    this.logger.error({ errorName: error.name, error: error.message, to, subject }, msg);
  }
}
