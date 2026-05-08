import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { AppModule } from "./app.module";

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

  const corsOrigins = (config.get<string>("CORS_ORIGINS") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  app.enableCors({
    origin: corsOrigins.length ? corsOrigins : true,
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }),
  );
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
