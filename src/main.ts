import "reflect-metadata";
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  const port = Number(process.env.PORT) || 4100;
  const host = process.env.HOST || "0.0.0.0"; // set HOST=127.0.0.1 to keep the control plane localhost-only (e.g. behind nginx / on a shared box)
  await app.listen(port, host);
  // eslint-disable-next-line no-console
  console.log(`hara-control listening on ${host}:${port}`);
}
void bootstrap();
