import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { AppModule } from "./app.module";
import { AllExceptionsFilter } from "./common/all-exceptions.filter";

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const config = app.get(ConfigService);

  app.use(
    helmet({
      contentSecurityPolicy: false,
      strictTransportSecurity: false,
      crossOriginResourcePolicy: false,
    }),
  );
  app.use(cookieParser());

  // Allow every <slug>.iq-rest.com (and the apex), plus any explicit origins
  // listed in CORS_ORIGINS (comma-separated, e.g. local dev URLs). Custom
  // domains in the future can be added by extending CORS_PATTERN.
  const explicitOrigins = (config.get<string>("CORS_ORIGINS") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const pattern = new RegExp(
    config.get<string>("CORS_PATTERN") || "^https?://([a-z0-9-]+\\.)?iq-rest\\.com(:\\d+)?$",
    "i",
  );

  app.enableCors({
    credentials: true,
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // server-to-server / curl
      if (explicitOrigins.includes(origin)) return cb(null, true);
      if (pattern.test(origin)) return cb(null, true);
      return cb(new Error(`CORS: origin ${origin} not allowed`), false);
    },
  });

  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  app.setGlobalPrefix("api");

  const port = Number(config.get<string>("PORT") ?? 8131);
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`[public-menu-api] listening on http://localhost:${port}`);
}

bootstrap().catch((e) => {
  // eslint-disable-next-line no-console
  console.error("Failed to start app", e);
  process.exit(1);
});
