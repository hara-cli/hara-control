import "reflect-metadata";
import { join } from "node:path";
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { NestExpressApplication } from "@nestjs/platform-express";
import type { NextFunction, Request, Response } from "express";
import { AppModule } from "./app.module";
import { assertProductionRuntime } from "./config/runtime-security";

async function bootstrap() {
  assertProductionRuntime();
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Content-Security-Policy", [
      "default-src 'self'",
      "base-uri 'none'",
      "connect-src 'self'",
      "font-src 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "img-src 'self' data:",
      "object-src 'none'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
    ].join("; "));
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    if (/^\/(?:admin|auth|v1)\//.test(req.path)) {
      res.setHeader("Cache-Control", "no-store");
    }
    next();
  });

  // Static admin console — vanilla HTML/JS, no framework, served by Nest's built-in Express adapter.
  // Reachable at /console/ (the page calls the JWT-protected API with the token in localStorage).
  // Intentionally NOT guarded — it's a login page; the API behind it is what's gated.
  app.useStaticAssets(join(process.cwd(), "public", "console"), { prefix: "/console" });

  const port = Number(process.env.PORT) || 4100;
  const host = process.env.HOST || "0.0.0.0"; // set HOST=127.0.0.1 to keep the control plane localhost-only (e.g. behind nginx / on a shared box)
  await app.listen(port, host);
  // eslint-disable-next-line no-console
  console.log(`hara-control listening on ${host}:${port}  (console: http://${host === "0.0.0.0" ? "localhost" : host}:${port}/console/)`);
}
void bootstrap();
