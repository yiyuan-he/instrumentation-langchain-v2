import type * as CallbackManagerModuleV02 from "@langchain/core/callbacks/manager";
import { OpenTelemetryCallbackHandler } from "./callback-handler";
import { Tracer } from "@opentelemetry/api";

export function addTracerToHandlers(
  tracer: Tracer,
  handlers?: CallbackManagerModuleV02.Callbacks,
): CallbackManagerModuleV02.Callbacks;
export function addTracerToHandlers(
  tracer: Tracer,
  handlers?: CallbackManagerModuleV02.Callbacks,
): CallbackManagerModuleV02.Callbacks {
  if (handlers == null) {
    return [new OpenTelemetryCallbackHandler(tracer)];
  }
  if (Array.isArray(handlers)) {
    const tracerAlreadyRegistered = handlers.some(
      (handler) => handler instanceof OpenTelemetryCallbackHandler,
    );
    if (!tracerAlreadyRegistered) {
      handlers.push(new OpenTelemetryCallbackHandler(tracer) as any);
    }
    return handlers;
  }

  return handlers;
}
