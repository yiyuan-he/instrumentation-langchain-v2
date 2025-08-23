import { addTracerToHandlers } from "../src/instrumentationUtils";
import { OpenTelemetryCallbackHandler } from "../src/callback-handler";
import { Tracer } from "@opentelemetry/api";

describe("addTracerToHandlers", () => {
  it("should add a tracer if there are no handlers", () => {
    const tracer = {} as Tracer;

    const result = addTracerToHandlers(tracer);

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1);
    if (Array.isArray(result)) {
      expect(result[0]).toBeInstanceOf(OpenTelemetryCallbackHandler);
    }
  });

  it("should add a handler to a pre-existing array of handlers", () => {
    const tracer = {} as Tracer;
    const handlers = [{}];

    const result = addTracerToHandlers(tracer, handlers);

    expect(result).toBe(handlers);
    expect(result).toHaveLength(2);
    if (Array.isArray(result)) {
      expect(result[1]).toBeInstanceOf(OpenTelemetryCallbackHandler);
    }
  });

  it("should not add a handler if it already exists in an array of handlers", () => {
    const tracer = {} as Tracer;
    const callbackHandler = new OpenTelemetryCallbackHandler(tracer);
    const handlers = [callbackHandler];

    const result = addTracerToHandlers(tracer, handlers);

    expect(result).toBe(handlers);
    expect(result).toHaveLength(1);
    if (Array.isArray(result)) {
      expect(result[0]).toBeInstanceOf(OpenTelemetryCallbackHandler);
    }
  });
});