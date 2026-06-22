import { Global, Module } from "@nestjs/common";
import { GATEWAY_ADAPTER } from "./gateway-adapter";
import { LiteLLMAdapter } from "./litellm.adapter";
import { MockGatewayAdapter } from "./mock.adapter";

// GATEWAY_ADAPTER=litellm in prod; defaults to the mock so dev/test/CI run with no LiteLLM.
@Global()
@Module({
  providers: [
    {
      provide: GATEWAY_ADAPTER,
      useClass: process.env.GATEWAY_ADAPTER === "litellm" ? LiteLLMAdapter : MockGatewayAdapter,
    },
  ],
  exports: [GATEWAY_ADAPTER],
})
export class GatewayModule {}
